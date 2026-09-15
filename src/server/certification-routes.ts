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

// Vendor certification surface (Phase 2).
//
// Two ways to run, and the difference between them is the whole point:
//
//   mode: 'double'  — probe OUR conformance double. Proves the client: the auth
//                     flow signs correctly, discovery reconciles against a real
//                     CapabilityStatement, the ladder engages on a refused write.
//                     It can never certify a vendor, because we wrote both sides.
//   mode: 'sandbox' — probe a CONFIGURED connection, i.e. the vendor. This is the
//                     only run that can produce a certification.
//
// `sandbox` therefore needs a saved connection whose base URL is reachable, and
// it will honestly refuse when there is none rather than quietly downgrading to
// the double. A silent downgrade would be the worst outcome available: it would
// report success against a system we control and let a live write path be
// enabled on that basis.
//
// Records are durable because the platform's fail-closed write check reads them.

import type { FastifyInstance } from 'fastify';
import { generateKeyPairSync } from 'node:crypto';
import { getSwarmWorkspace } from './swarm-routes.js';
import type { WorkspaceDoc, SwarmWorkspaceStore } from '../swarm/workspace.js';
import { InMemorySecretsProvider } from '../control-plane/secrets.js';
import { fhirSecretsProvider } from '../control-plane/file-secrets.js';
import { createConformanceDouble, type ConformanceDouble } from '../fhir/conformance-double.js';
import { isVendorId, vendorProfile, type VendorId } from '../fhir/vendor-profile.js';
import {
  buildVendorCertification, certificationMatrix, sandboxCertifiedVendors,
  type CertificationMode, type VendorCertification,
} from '../fhir/vendor-certification.js';
import type { FhirIntegration } from '../swarm/workspace.js';
import type { FetchLike } from '../fhir/http.js';
import { runContractTest } from './fhir-integration-routes.js';

/** The workspace row: the certification wrapped in the durable envelope. */
interface CertificationDoc extends WorkspaceDoc {
  readonly certification: VendorCertification;
}

export interface CertificationRouteOptions {
  /** Encrypted secret store for the real-connection path. Defaults to `.harness`. */
  storeDir?: string;
}

/** The secrets a double needs to be probed through its own auth flow. */
interface DoubleTarget {
  readonly double: ConformanceDouble;
  readonly integration: FhirIntegration;
  readonly secrets: InMemorySecretsProvider;
}

/**
 * Build a connection that exercises the vendor's auth mode against the double.
 *
 * The private key is generated per run and never leaves this process, so a
 * double run exercises the real signing path without a committed credential.
 */
async function doubleTarget(vendor: VendorId): Promise<DoubleTarget> {
  const profile = vendorProfile(vendor);
  const keys = profile.authMode === 'smart-backend-services'
    ? generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      })
    : undefined;

  const double = createConformanceDouble({
    vendor,
    ...(keys ? { clientPrivateKeyPem: keys.privateKey } : {}),
  });
  const secrets = new InMemorySecretsProvider();

  let authMode: FhirIntegration['authMode'] = 'none';
  const auth: Record<string, unknown> = {};
  if (profile.authMode === 'smart-backend-services' && keys) {
    await secrets.set('CONFORMANCE_CLIENT_KEY', keys.privateKey);
    authMode = 'smart-backend-services';
    auth['clientId'] = 'conformance-client';
    auth['tokenEndpoint'] = double.tokenEndpoint;
    auth['privateKeyRef'] = 'binding:CONFORMANCE_CLIENT_KEY';
    auth['vendorHeaders'] = Object.fromEntries(profile.requiredHeaders.map((h) => [h, 'conformance-client']));
  } else if (profile.authMode !== 'none') {
    // Athena's delegated OAuth2 is not reproducible without the marketplace, so
    // we present the token the double accepts and say nothing about the vendor.
    await secrets.set('CONFORMANCE_TOKEN', double.accessToken);
    authMode = 'bearer';
    auth['tokenRef'] = 'binding:CONFORMANCE_TOKEN';
  }

  const integration = {
    id: 'conformance-double',
    label: `${profile.label} conformance double`,
    realmId: '',
    baseUrl: double.baseUrl,
    vendor,
    authMode,
    readEnabled: true,
    status: 'not-configured',
    ...auth,
  } as unknown as FhirIntegration;

  return { double, integration, secrets };
}

function certificationId(vendor: VendorId, ranAt: string): string {
  return `cert:${vendor}:${ranAt}`;
}

/** Read every stored certification, newest write wins per vendor at read time. */
export async function listCertifications(ws: SwarmWorkspaceStore): Promise<VendorCertification[]> {
  const docs = await ws.list<CertificationDoc>('vendor-certification');
  return docs.map((d) => d.certification).filter((c): c is VendorCertification => Boolean(c));
}

/**
 * The vendors whose SANDBOX certification is recorded — what the platform's
 * fail-closed write check consumes. A double run is excluded by construction.
 */
export async function certifiedVendors(ws: SwarmWorkspaceStore): Promise<string[]> {
  return sandboxCertifiedVendors(await listCertifications(ws));
}

/** Persist a record. Keyed by vendor + instant so a re-run never overwrites history. */
async function storeCertification(ws: SwarmWorkspaceStore, record: VendorCertification): Promise<void> {
  await ws.create<CertificationDoc>('vendor-certification', certificationId(record.vendor, record.ranAt), {
    certification: record,
  });
}

export async function registerCertificationRoutes(
  app: FastifyInstance,
  opts: CertificationRouteOptions = {},
): Promise<void> {
  const ws = (): SwarmWorkspaceStore => {
    const w = getSwarmWorkspace();
    if (!w) throw new Error('swarm-workspace-not-ready');
    return w;
  };

  /** The matrix: one row per certifiable vendor, absences included. */
  app.get('/admin/platform/certification', async () => {
    const ranAt = new Date().toISOString();
    const records = await listCertifications(ws());
    return { matrix: certificationMatrix(records, ranAt), records, certifiedVendors: sandboxCertifiedVendors(records) };
  });

  app.get<{ Params: { vendor: string } }>('/admin/platform/certification/:vendor', async (req, reply) => {
    const vendor = req.params.vendor;
    if (!isVendorId(vendor)) {
      return reply.code(400).send({ error: 'unknown-vendor', allowed: ['epic', 'cerner', 'athena', 'generic'] });
    }
    const records = (await listCertifications(ws())).filter((r) => r.vendor === vendor).sort((a, b) => (a.ranAt < b.ranAt ? 1 : -1));
    return { vendor, latest: records[0] ?? null, records };
  });

  /**
   * Run a certification.
   *
   * `double` always works and can never certify. `sandbox` needs a saved
   * connection for that vendor and refuses rather than falling back.
   */
  app.post<{ Params: { vendor: string }; Body: { mode?: string } }>(
    '/admin/platform/certification/:vendor/run',
    async (req, reply) => {
      const vendor = req.params.vendor;
      if (!isVendorId(vendor)) {
        return reply.code(400).send({ error: 'unknown-vendor', allowed: ['epic', 'cerner', 'athena', 'generic'] });
      }
      const mode = (req.body?.mode ?? 'double') as CertificationMode;
      if (mode !== 'double' && mode !== 'sandbox') {
        return reply.code(400).send({ error: 'invalid-mode', allowed: ['double', 'sandbox'] });
      }
      const ranAt = new Date().toISOString();

      /* ------------------------------------------------------------ sandbox */

      if (mode === 'sandbox') {
        const stored = await ws().getFhirIntegration();
        if (!stored.baseUrl || stored.vendor !== vendor) {
          // Refuse. Falling back to the double here would report a vendor
          // certification won for a system we control.
          return reply.code(409).send({
            error: 'no-sandbox-connection',
            detail: `Certifying ${vendor} needs a saved connection whose vendor is ${vendor} and whose base URL is reachable. Configure it under Integrations first, then re-run with mode "sandbox".`,
          });
        }
        const result = await runContractTest(stored, opts.storeDir ? fhirSecretsProvider(opts.storeDir) : fhirSecretsProvider('.harness'));
        const record = buildVendorCertification({
          vendor,
          mode: 'sandbox',
          ranAt,
          ...(result.report ? { report: result.report } : {}),
          steps: result.steps,
          requestCount: result.requests.length,
          contractOk: result.ok,
        });
        await storeCertification(ws(), record);
        return { certification: record };
      }

      /* ------------------------------------------------------------- double */

      const target = await doubleTarget(vendor);
      const result = await runContractTest(target.integration, target.secrets, { fetch: target.double.fetch as FetchLike });
      const record = buildVendorCertification({
        vendor,
        mode: 'double',
        ranAt,
        ...(result.report ? { report: result.report } : {}),
        steps: result.steps,
        requestCount: target.double.requests.length,
        contractOk: result.ok,
      });
      await storeCertification(ws(), record);
      return {
        certification: record,
        // The raw exchange, so the operator can see what the double answered.
        requests: target.double.requests,
      };
    },
  );
}
