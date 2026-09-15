/******************************************************************************
 *
 * Copyright (c) 2026 AnantHQ Inc.
 * All Rights Reserved.
 *
 * This software is licensed, not sold.
 *
 * The contents of this file constitute confidential and proprietary
 * information belonging exclusively to AnantHQ Inc.
 *
 * This source code incorporates proprietary algorithms, software architecture,
 * business logic, computational methods, optimization techniques,
 * workflows, data structures, APIs, and implementation details that are
 * protected by copyright law, patent law, trade secret law, and
 * international intellectual property treaties.
 *
 * Except as expressly permitted by a written license agreement,
 * no person or organization may:
 *
 *   • Copy or reproduce this software.
 *   • Modify or create derivative works.
 *   • Reverse engineer, decompile, or disassemble.
 *   • Benchmark or publicly disclose performance.
 *   • Redistribute, sublicense, lease, rent, or sell.
 *   • Use this software for competitive analysis.
 *   • Disclose any implementation details.
 *
 * Any unauthorized use is strictly prohibited and may result in
 * civil damages, injunctive relief, criminal prosecution,
 * and all other remedies available under applicable law.
 *
 ******************************************************************************/

/******************************************************************************
 * Phase 2 — vendor certification.
 *
 * Two things are proved here, and the second matters more than the first.
 *
 *  1. The conformance double is a SERVER, so `runContractTest` runs its
 *     unmodified code path against it: the real SMART Backend Services signing
 *     flow, the real capability negotiator, the real write guards. A stubbed
 *     CLIENT would prove nothing about our client.
 *
 *  2. A double run may NEVER certify a vendor; only a real sandbox may. The last
 *     block drives that distinction into the platform's fail-closed write check,
 *     because conflating the two is what would let a `bound` write path — a path
 *     that writes to a patient's chart — go live on the strength of our own
 *     test double.
 ******************************************************************************/

import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { runContractTest } from '../src/server/fhir-integration-routes.js';
import { InMemorySecretsProvider } from '../src/control-plane/secrets.js';
import { buildHardeningReport } from '../src/control-plane/index.js';
import type { FhirIntegration } from '../src/swarm/workspace.js';
import { createConformanceDouble, vendorCapabilityStatement } from '../src/fhir/conformance-double.js';
import {
  CERTIFIABLE_VENDORS, buildVendorCertification, certificationMatrix, sandboxCertifiedVendors,
  type VendorCertification,
} from '../src/fhir/vendor-certification.js';
import type { CapabilityReport } from '../src/fhir/capability.js';

/**
 * Generated per run and never committed.
 *
 * A checked-in private key is a real credential whatever the comment above it
 * says, so the double derives its public key from this at construction time.
 */
function keypair(): { publicKey: string; privateKey: string } {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

type Double = ReturnType<typeof createConformanceDouble>;

function integrationAgainst(baseUrl: string, over: Partial<FhirIntegration> = {}): FhirIntegration {
  return {
    id: 'default', createdAt: '2026-01-01', updatedAt: '2026-01-01',
    label: 'Conformance', realmId: '', readEnabled: true, status: 'not-configured',
    vendor: 'generic', baseUrl, authMode: 'none',
    ...over,
  } as FhirIntegration;
}

/** Drive the real contract test against the double. */
async function probe(double: Double, integration: FhirIntegration, secrets = new InMemorySecretsProvider()) {
  return runContractTest(integration, secrets, { fetch: double.fetch });
}

/** An Epic connection wired for SMART Backend Services against a double. */
function epicAgainst(double: Double, keys: { privateKey: string }, withHeader: boolean): FhirIntegration {
  return integrationAgainst(double.baseUrl, {
    vendor: 'epic',
    authMode: 'smart-backend-services',
    clientId: 'conformance-client',
    tokenEndpoint: double.tokenEndpoint,
    privateKeyRef: 'binding:CONFORMANCE_KEY',
    ...(withHeader ? { vendorHeaders: { 'Epic-Client-ID': 'conformance-client' } } : {}),
  });
}

async function secretsWith(key: string, value: string): Promise<InMemorySecretsProvider> {
  const secrets = new InMemorySecretsProvider();
  await secrets.set(key, value);
  return secrets;
}

/** A minimal negotiated report, for the pure judgement tests. */
function fakeReport(over: Partial<CapabilityReport> = {}): CapabilityReport {
  return {
    vendor: 'epic',
    confidence: 'vendor-documented',
    discoveredAt: '2026-09-14T00:00:00.000Z',
    server: { softwareName: 'Conformance' },
    flows: [],
    essentialBlocked: [],
    accuracy: { overstated: [], understated: [], claimedCount: 0, discoveredCount: 40, profileOverstates: false },
    headline: 'all required flows available',
    ...over,
  } as CapabilityReport;
}

const RAN_AT = '2026-09-14T00:00:00.000Z';

/* ====================================================== the conformance double */

describe('conformance double — a server, not a stub', () => {
  it('answers the whole contract test for a no-auth vendor', async () => {
    const double = createConformanceDouble({ vendor: 'generic' });
    const result = await probe(double, integrationAgainst(double.baseUrl));

    expect(result.ok).toBe(true);
    expect(result.status).toBe('contract-verified');
    // The server name comes from the double's own statement, which proves
    // discovery ran rather than the profile simply being assumed.
    expect(result.capabilities?.softwareName).toBe('FhirEmulator');
    expect(result.capabilities?.fhirVersion).toBe('4.0.1');
    expect(result.report?.essentialBlocked).toEqual([]);
  });

  it('verifies a real RS384 client_assertion for SMART Backend Services', async () => {
    const keys = keypair();
    const double = createConformanceDouble({ vendor: 'epic', clientPrivateKeyPem: keys.privateKey });
    const result = await probe(double, epicAgainst(double, keys, true), await secretsWith('CONFORMANCE_KEY', keys.privateKey));

    expect(result.ok).toBe(true);
    expect(result.steps.find((s) => s.id === 'credential')?.status).toBe('ok');

    const tokenCall = double.requests.find((r) => r.path === '/token');
    expect(tokenCall?.status).toBe(200);
    expect(tokenCall?.note).toBe('token issued');

    // Assert against the SERVER's log: `result.requests` is redacted for PHI
    // safety, so `/metadata` is normalised to `metadata` there and it is the
    // wrong place to prove which route was called.
    expect(double.requests.some((r) => r.path === '/metadata' && r.status === 200)).toBe(true);
  });

  it('refuses Epic when its required header is missing, and says which one', async () => {
    const keys = keypair();
    const double = createConformanceDouble({ vendor: 'epic', clientPrivateKeyPem: keys.privateKey });
    const result = await probe(double, epicAgainst(double, keys, false), await secretsWith('CONFORMANCE_KEY', keys.privateKey));

    expect(result.ok).toBe(false);
    expect(result.steps.find((s) => s.id === 'capability')?.status).toBe('failed');
    // The audit note must name the missing header, not merely report a refusal.
    expect(double.requests.some((r) => r.status === 401 && (r.note ?? '').includes('Epic-Client-ID'))).toBe(true);
  });

  it('rejects an assertion signed by the wrong key', async () => {
    const keys = keypair();
    const attacker = keypair();
    const double = createConformanceDouble({ vendor: 'epic', clientPrivateKeyPem: keys.privateKey });
    // The client holds a different key than the one the server trusts.
    const result = await probe(double, epicAgainst(double, keys, true), await secretsWith('CONFORMANCE_KEY', attacker.privateKey));

    expect(result.ok).toBe(false);
    expect(double.requests.find((r) => r.path === '/token')?.note).toContain('signature does not verify');
  });

  it('rejects an expired assertion', async () => {
    const keys = keypair();
    // The server's clock is far enough ahead that a five-minute assertion is stale.
    const double = createConformanceDouble({
      vendor: 'epic',
      clientPrivateKeyPem: keys.privateKey,
      now: () => Date.now() + 30 * 60 * 1000,
    });
    const result = await probe(double, epicAgainst(double, keys, true), await secretsWith('CONFORMANCE_KEY', keys.privateKey));

    expect(result.ok).toBe(false);
    expect(double.requests.find((r) => r.path === '/token')?.note).toContain('expired');
  });

  it('refuses a write the vendor does not declare, so the ladder has to engage', async () => {
    const double = createConformanceDouble({ vendor: 'athena' });
    // Athena authenticates by delegated OAuth2 in production. A static bearer
    // token is enough here because this test is about the WRITE SURFACE; the
    // SMART flow itself is covered by the Epic tests above.
    const secrets = await secretsWith('CONFORMANCE_TOKEN', double.accessToken);
    const result = await probe(double, integrationAgainst(double.baseUrl, {
      vendor: 'athena', authMode: 'bearer', tokenRef: 'binding:CONFORMANCE_TOKEN',
    }), secrets);

    // Athena's profile declares no create, and discovery confirms it.
    const medication = result.report?.flows.find((f) => f.flow.id === 'proposal-medication-request');
    expect(medication?.verdict).toBe('degraded');
    expect(medication?.rung).toBe('cds-card');

    // The genuine blocker for Athena: D3's episode Encounter cannot be opened
    // over FHIR, so the session model does not round-trip.
    expect(result.report?.essentialBlocked).toContain('episode-encounter-write');

    // And the server really refused, rather than the negotiator merely predicting it.
    const res = await double.fetch(`${double.baseUrl}/MedicationRequest`, {
      method: 'POST',
      headers: { accept: 'application/fhir+json', authorization: `Bearer ${double.accessToken}` },
      body: '{}',
    });
    expect(res.status).toBe(405);
    const body = (await res.json()) as { issue?: { code?: string }[] };
    expect(body.issue?.[0]?.code).toBe('not-supported');
  });

  it('reports a server with no /metadata rather than inventing capability', async () => {
    const keys = keypair();
    const double = createConformanceDouble({ vendor: 'epic', serveMetadata: false, clientPrivateKeyPem: keys.privateKey });
    const result = await probe(double, epicAgainst(double, keys, true), await secretsWith('CONFORMANCE_KEY', keys.privateKey));

    expect(result.ok).toBe(false);
    expect(result.steps.find((s) => s.id === 'capability')?.status).toBe('failed');
    // With no discovery we must NOT claim the profile was confirmed.
    expect(result.report).toBeUndefined();
  });

  it('serves a statement limited to what the vendor declares', () => {
    const statement = vendorCapabilityStatement('athena', { Patient: ['read', 'search'], MedicationRequest: ['read'] });
    const rest = (statement['rest'] as { resource: { type: string; interaction: { code: string }[] }[] }[])[0];
    expect(rest?.resource.map((r) => r.type)).toEqual(['Patient', 'MedicationRequest']);
    expect(rest?.resource.flatMap((r) => r.interaction.map((i) => i.code))).not.toContain('create');
  });
});

/* ============================================== what we are entitled to claim */

describe('certification judgement', () => {
  it('NEVER certifies a vendor from a double run', () => {
    const record = buildVendorCertification({ vendor: 'epic', mode: 'double', ranAt: RAN_AT, report: fakeReport() });
    expect(record.verdict).toBe('harness-verified');
    expect(record.verdict).not.toBe('certified');
    expect(record.headline).toContain('NOT certified');
    expect(record.blockedReason).toBeTruthy();
  });

  it('certifies a vendor only from a real sandbox run', () => {
    const record = buildVendorCertification({ vendor: 'epic', mode: 'sandbox', ranAt: RAN_AT, report: fakeReport() });
    expect(record.verdict).toBe('certified');
    expect(record.headline).toContain('real sandbox');
  });

  it('fails a sandbox run that cannot carry an essential flow', () => {
    const record = buildVendorCertification({
      vendor: 'athena', mode: 'sandbox', ranAt: RAN_AT,
      report: fakeReport({ vendor: 'athena', essentialBlocked: ['episode-encounter-write'] }),
    });
    expect(record.verdict).toBe('failed');
    expect(record.essentialBlocked).toContain('episode-encounter-write');
  });

  it('treats an absent probe as absence of evidence, not as success', () => {
    const record = buildVendorCertification({
      vendor: 'cerner', mode: 'not-run', ranAt: RAN_AT, blockedReason: 'no sandbox credentials',
    });
    expect(record.verdict).toBe('not-run');
    expect(record.blockedReason).toBe('no sandbox credentials');
    expect(record.flows).toEqual([]);
  });

  it('excludes harness-verified vendors from the sandbox-certified list', () => {
    const doubleRun = buildVendorCertification({ vendor: 'epic', mode: 'double', ranAt: RAN_AT, report: fakeReport() });
    const sandbox = buildVendorCertification({
      vendor: 'cerner', mode: 'sandbox', ranAt: RAN_AT, report: fakeReport({ vendor: 'cerner' }),
    });
    expect(sandboxCertifiedVendors([doubleRun, sandbox])).toEqual(['cerner']);
    expect(sandboxCertifiedVendors([doubleRun])).toEqual([]);
  });
});

describe('certification matrix', () => {
  it('gives every certifiable vendor a row, including the untested ones', () => {
    const matrix = certificationMatrix([], RAN_AT);
    expect(matrix.vendors.map((v) => v.vendor)).toEqual([...CERTIFIABLE_VENDORS]);
    expect(matrix.notRun).toBe(CERTIFIABLE_VENDORS.length);
    expect(matrix.anyCertified).toBe(false);
    // Silence must not read as success.
    expect(matrix.headline).toContain('no vendor has been certified');
  });

  it('reports a double-only position honestly', () => {
    const records = CERTIFIABLE_VENDORS.map((vendor) => buildVendorCertification({
      vendor, mode: 'double', ranAt: RAN_AT, report: fakeReport({ vendor }),
    }));
    const matrix = certificationMatrix(records, RAN_AT);
    expect(matrix.certified).toBe(0);
    expect(matrix.harnessVerified).toBe(CERTIFIABLE_VENDORS.length);
    expect(matrix.headline).toContain('sandbox-certified');
    expect(matrix.anyCertified).toBe(false);
  });

  it('keeps the most recent record per vendor', () => {
    const older: VendorCertification = buildVendorCertification({
      vendor: 'epic', mode: 'double', ranAt: '2026-09-01T00:00:00.000Z', report: fakeReport(),
    });
    const newer = buildVendorCertification({
      vendor: 'epic', mode: 'sandbox', ranAt: RAN_AT, report: fakeReport(),
    });
    const matrix = certificationMatrix([older, newer], RAN_AT);
    expect(matrix.vendors.find((v) => v.vendor === 'epic')?.verdict).toBe('certified');
    expect(matrix.sandboxCertified).toEqual(['epic']);
  });
});

/* ================================== the property that protects a patient's chart */

describe('a double run cannot unlock a live write path', () => {
  const writeSafety = (certifiedVendors: readonly string[]) => buildHardeningReport({
    kafka: { status: 'contract-verified' },
    fhir: { status: 'contract-verified', writePolicy: { 'order-med': 'bound' } },
    packs: [], releases: [], openIncidents: 0, deadOutbox: 0, userCount: 1,
    certifiedVendors,
  }).checks.find((c) => c.id === 'write-policy-safety');

  it('passes only when nothing is bound', () => {
    const check = buildHardeningReport({
      kafka: { status: 'contract-verified' },
      fhir: { status: 'contract-verified', writePolicy: { 'order-med': 'shadow' } },
      userCount: 1,
    }).checks.find((c) => c.id === 'write-policy-safety');
    expect(check?.status).toBe('pass');
  });

  it('FAILS a bound kind when only a double run is recorded', async () => {
    // Produce a genuine harness-verified record by probing the double through
    // the real SMART Backend Services flow.
    const keys = keypair();
    const double = createConformanceDouble({ vendor: 'epic', clientPrivateKeyPem: keys.privateKey });
    const result = await probe(double, epicAgainst(double, keys, true), await secretsWith('CONFORMANCE_KEY', keys.privateKey));

    // The probe must have really produced a report, or the verdict would be
    // `not-run` and this test would prove nothing.
    expect(result.report).toBeDefined();

    const record = buildVendorCertification({
      vendor: 'epic', mode: 'double', ranAt: RAN_AT,
      ...(result.report ? { report: result.report } : {}),
      contractOk: result.ok, requestCount: result.requests.length,
    });
    expect(record.verdict).toBe('harness-verified');

    // A double run contributes NO certified vendor.
    const certified = sandboxCertifiedVendors([record]);
    expect(certified).toEqual([]);

    const check = writeSafety(certified);
    expect(check?.status).toBe('fail');
    expect(check?.remediation).toContain('sandbox certification');
  });

  it('downgrades to warn once a sandbox certification exists', () => {
    const check = writeSafety(['epic']);
    expect(check?.status).toBe('warn');
    expect(check?.detail).toContain('epic');
  });
});
