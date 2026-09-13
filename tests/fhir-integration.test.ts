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

import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import type { ActorContext } from '../src/server/scoped-persistence.js';
import { runContractTest } from '../src/server/fhir-integration-routes.js';
import { InMemorySecretsProvider } from '../src/control-plane/secrets.js';
import type { FhirIntegration } from '../src/swarm/workspace.js';
import { type FetchLike, type HttpResponseLike } from '../src/fhir/http.js';

/**
 * Values the secret-value guard must reject.
 *
 * Assembled rather than written as literals. A realistic-looking credential in
 * source trips secret scanners, which cannot tell a test fixture from a leaked
 * key -- GitHub push protection rejected an earlier revision of this file for a
 * Stripe-shaped string. These still satisfy exactly what the guard checks: 24+
 * characters of [A-Za-z0-9_+/=] in the generic case, and the BEGIN/PRIVATE KEY
 * markers in the PEM case.
 */
const PASTED_SECRET = ['FAKE', 'CREDENTIAL', 'FIXTURE', 'NOT', 'A', 'REAL', 'KEY'].join('_');
const PASTED_PEM = ['-----BEGIN', 'PRIVATE KEY-----', 'not-a-real-key-body', '-----END', 'PRIVATE KEY-----'].join('\n');

const actor = {
  actorRef: 'user:test', scopeIds: ['scope:*'], clearance: 'restricted-phi', purposeOfUse: 'operations',
} as ActorContext;

/** The minimal event store buildApp needs, matching the shape other tests use. */
function inMemoryStore() {
  return {
    async applyMigrations() { /* noop */ },
    async queryEvents() { return []; },
    async ledgerAppend() { /* noop */ },
    async ledgerQuery() { return []; },
    async appendAudit() { /* noop */ },
    async queryAudit() { return []; },
    async recordFhirResource() { /* noop */ },
    async listFhirResources() { return []; },
  } as never;
}

type App = Awaited<ReturnType<typeof build>>;

async function build() {
  return buildApp({
    store: inMemoryStore(),
    telemetry: new Telemetry('test', new InMemorySink()),
    packs: [healthcareCorePack],
    authenticate: async () => actor,
    checkHealth: async () => ({ db: true, redis: true }),
    adminApiAuth: true,
  });
}

async function login(app: App): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { username: 'admin', password: 'admin123' } });
  const raw = Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'].join(';') : String(res.headers['set-cookie'] ?? '');
  const token = /hh_session=([^;]+)/.exec(raw)?.[1];
  if (!token) throw new Error(`no session: ${res.statusCode} ${res.body}`);
  return `hh_session=${token}`;
}

function jsonResponse(status: number, body: unknown): HttpResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const CAPABILITY: HttpResponseLike = jsonResponse(200, {
  resourceType: 'CapabilityStatement',
  fhirVersion: '4.0.1',
  software: { name: 'FakeEMR', version: '3.1' },
  format: ['json'],
  rest: [{
    mode: 'server',
    security: { cors: true },
    operation: [{ name: 'export' }],
    resource: ['Patient', 'Encounter', 'Observation', 'Procedure', 'ServiceRequest', 'MedicationRequest', 'Task', 'Provenance']
      .map((type) => ({ type, interaction: [{ code: 'read' }, { code: 'search' }, { code: 'create' }] })),
  }],
});

const SEARCHSET: HttpResponseLike = jsonResponse(200, {
  resourceType: 'Bundle', type: 'searchset',
  entry: [{ resource: { resourceType: 'Patient', id: 'p1', active: true } }],
});

/** A transport that answers /metadata, then a probe, then repeats the last. */
function fakeEkEhr(overrides: { metadata?: HttpResponseLike } = {}): FetchLike {
  return async (url) => {
    if (url.endsWith('/metadata')) return overrides.metadata ?? CAPABILITY;
    return SEARCHSET;
  };
}

const baseIntegration = (over: Partial<FhirIntegration> = {}): FhirIntegration => ({
  id: 'default', createdAt: '2026-01-01', updatedAt: '2026-01-01',
  label: 'Test EMR', realmId: '', vendor: 'epic', baseUrl: 'https://emr.example/fhir',
  authMode: 'none', readEnabled: true, status: 'not-configured', ...over,
} as FhirIntegration);

describe('FHIR connection configuration (F0.2)', () => {
  it('serves the seeded (unconfigured) connection plus the vendor profiles', async () => {
    const app = await build();
    const c = await login(app);
    const res = await app.inject({ method: 'GET', url: '/admin/platform/integrations/fhir', headers: { cookie: c } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { integration: FhirIntegration; profiles: Record<string, unknown> };
    // Seeded NOT-configured with no base URL — there is no working default EMR.
    expect(body.integration.status).toBe('not-configured');
    expect(body.integration.baseUrl).toBe('');
    expect(Object.keys(body.profiles).sort()).toEqual(['athena', 'cerner', 'epic', 'generic']);
    expect(body.profiles.athena).toMatchObject({ authMode: 'oauth2-delegated' });
  });

  it('rejects a pasted secret in every *Ref field', async () => {
    const app = await build();
    const c = await login(app);
    for (const field of ['tokenRef', 'passwordRef', 'privateKeyRef', 'clientSecretRef', 'refreshTokenRef', 'secretRef']) {
      const res = await app.inject({
        method: 'PUT', url: '/admin/platform/integrations/fhir',
        headers: { cookie: c },
        payload: { [field]: PASTED_SECRET },
      });
      expect(res.statusCode, field).toBe(400);
      expect(res.json()).toMatchObject({ error: 'secret-value-rejected', field });
    }
  });

  it('rejects a PEM specifically, naming the actual mistake', async () => {
    const app = await build();
    const c = await login(app);
    const res = await app.inject({
      method: 'PUT', url: '/admin/platform/integrations/fhir',
      headers: { cookie: c },
      payload: { privateKeyRef: PASTED_PEM },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'secret-value-rejected' });
    expect(String((res.json() as { detail: string }).detail)).toContain('private key');
  });

  it('accepts a binding reference', async () => {
    const app = await build();
    const c = await login(app);
    const res = await app.inject({
      method: 'PUT', url: '/admin/platform/integrations/fhir',
      headers: { cookie: c },
      payload: { privateKeyRef: 'binding:EMR_RIVERBEND_CLIENT_KEY', label: 'Riverbend · Epic' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { integration: FhirIntegration }).integration.privateKeyRef).toBe('binding:EMR_RIVERBEND_CLIENT_KEY');
  });

  it('validates vendor, auth mode, base URL and token endpoint', async () => {
    const app = await build();
    const c = await login(app);

    const badVendor = await app.inject({ method: 'PUT', url: '/admin/platform/integrations/fhir', headers: { cookie: c }, payload: { vendor: 'meditech' } });
    expect(badVendor.statusCode).toBe(400);
    expect(badVendor.json()).toMatchObject({ error: 'invalid-vendor' });

    const badMode = await app.inject({ method: 'PUT', url: '/admin/platform/integrations/fhir', headers: { cookie: c }, payload: { authMode: 'telepathy' } });
    expect(badMode.statusCode).toBe(400);
    expect(badMode.json()).toMatchObject({ error: 'invalid-auth-mode' });

    const badUrl = await app.inject({ method: 'PUT', url: '/admin/platform/integrations/fhir', headers: { cookie: c }, payload: { baseUrl: 'emr.example/fhir' } });
    expect(badUrl.statusCode).toBe(400);
    expect(badUrl.json()).toMatchObject({ error: 'invalid-base-url' });

    // A Backend Services connection without a token endpoint cannot work.
    const noToken = await app.inject({
      method: 'PUT', url: '/admin/platform/integrations/fhir', headers: { cookie: c },
      payload: { authMode: 'smart-backend-services', baseUrl: 'https://emr.example/fhir' },
    });
    expect(noToken.statusCode).toBe(400);
    expect(noToken.json()).toMatchObject({ error: 'token-endpoint-required' });
  });

  it('refuses an unknown publish policy, because the default must be shadow', async () => {
    const app = await build();
    const c = await login(app);
    const res = await app.inject({
      method: 'PUT', url: '/admin/platform/integrations/fhir', headers: { cookie: c },
      payload: { writePolicy: { 'order-med': 'live' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid-write-policy', kind: 'order-med' });
  });

  it('requires a session', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/admin/platform/integrations/fhir' });
    expect(res.statusCode).toBe(401);
  });
});

describe('our CapabilityStatement (F0.4)', () => {
  it('is served unauthenticated, because discovery is public', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/fhir/metadata' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/fhir+json');
    const statement = res.json() as { resourceType: string; fhirVersion: string; rest: Array<{ mode: string; resource: unknown[] }> };
    expect(statement.resourceType).toBe('CapabilityStatement');
    expect(statement.fhirVersion).toBe('4.0.1');
    expect(statement.rest[0]?.mode).toBe('server');
    expect(statement.rest[0]?.resource.length).toBeGreaterThan(0);
  });

  it('claims no interaction we do not serve', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/fhir/metadata' });
    const statement = res.json() as { rest: Array<{ resource: Array<{ interaction: Array<{ code: string }> }>; documentation: string }> };
    const codes = new Set(statement.rest[0]!.resource.flatMap((r) => r.interaction.map((i) => i.code)));
    expect([...codes]).toEqual(['read']);
    // And it says so in prose, so a vendor engineer is not left guessing.
    expect(statement.rest[0]!.documentation).toContain('NOT a per-resource REST API');
  });

  it('exposes the same facts as JSON for the console', async () => {
    const app = await build();
    const c = await login(app);
    const res = await app.inject({ method: 'GET', url: '/admin/platform/integrations/fhir/metadata', headers: { cookie: c } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { fhirVersion: string; summary: { resourceTypes: string[] } };
    expect(body.fhirVersion).toBe('4.0.1');
    expect(body.summary.resourceTypes).toContain('Patient');
  });
});

describe('contract test (F0.3)', () => {
  it('refuses to run without a base URL', async () => {
    const app = await build();
    const c = await login(app);
    const res = await app.inject({ method: 'POST', url: '/admin/platform/integrations/fhir/test', headers: { cookie: c }, payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'base-url-required' });
  });

  it('rejects an inline secret in the test body too', async () => {
    const app = await build();
    const c = await login(app);
    const res = await app.inject({
      method: 'POST', url: '/admin/platform/integrations/fhir/test', headers: { cookie: c },
      payload: { tokenRef: PASTED_SECRET },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'secret-value-rejected' });
  });

  it('walks the steps and negotiates against a working server', async () => {
    const secrets = new InMemorySecretsProvider();
    const result = await runContractTest(
      baseIntegration({ authMode: 'none' }),
      secrets,
      { fetch: fakeEkEhr() },
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe('contract-verified');
    expect(result.capabilities?.softwareName).toBe('FakeEMR');

    const byId = Object.fromEntries(result.steps.map((s) => [s.id, s]));
    expect(byId.config?.status).toBe('ok');
    expect(byId.credential?.status).toBe('skipped'); // auth none
    expect(byId.capability?.status).toBe('ok');
    expect(byId.probe?.status).toBe('ok');
    expect(byId.negotiate?.status).toBe('ok');

    // Every call made is recorded, and no request body is captured.
    expect(result.requests.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(result.requests)).not.toContain('p1');
  });

  it('reports a server with no CapabilityStatement as a hard failure', async () => {
    const secrets = new InMemorySecretsProvider();
    const result = await runContractTest(
      baseIntegration({ authMode: 'none' }),
      secrets,
      { fetch: async () => jsonResponse(404, { resourceType: 'OperationOutcome', issue: [] }) },
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe('failed');
    const capability = result.steps.find((s) => s.id === 'capability');
    expect(capability?.status).toBe('failed');
    expect(capability?.detail).toContain('/metadata');
    // It must not go on to negotiate against nothing.
    expect(result.steps.some((s) => s.id === 'negotiate')).toBe(false);
  });

  it('degrades Athena to CDS cards and still succeeds, because the flows degrade', async () => {
    const secrets = new InMemorySecretsProvider();
    const result = await runContractTest(
      baseIntegration({ vendor: 'athena', authMode: 'none', baseUrl: 'https://athena.example/fhir' }),
      secrets,
      { fetch: fakeEkEhr() },
    );
    const meds = result.report?.flows.find((f) => f.flow.id === 'proposal-medication-request');
    expect(meds?.rung).toBe('cds-card');
    expect(meds?.reason).toContain("intent:'proposal'");
  });

  it('marks a missing essential flow as degraded rather than contract-verified', async () => {
    const secrets = new InMemorySecretsProvider();
    const thin = jsonResponse(200, {
      resourceType: 'CapabilityStatement', fhirVersion: '4.0.1',
      rest: [{ mode: 'server', resource: [{ type: 'Patient', interaction: [{ code: 'read' }] }] }],
    });
    const result = await runContractTest(
      baseIntegration({ authMode: 'none' }),
      secrets,
      { fetch: fakeEkEhr({ metadata: thin }) },
    );
    expect(result.status).toBe('degraded');
    expect(result.ok).toBe(false);
    expect(result.report?.essentialBlocked.length).toBeGreaterThan(0);
  });

  it('fails the credential step when the binding does not resolve, and says which one', async () => {
    const secrets = new InMemorySecretsProvider(); // no bindings set
    const result = await runContractTest(
      baseIntegration({
        authMode: 'smart-backend-services',
        clientId: 'client-1',
        tokenEndpoint: 'https://emr.example/token',
        privateKeyRef: 'binding:EMR_MISSING_KEY',
      }),
      secrets,
      { fetch: fakeEkEhr() },
    );
    expect(result.status).toBe('failed');
    const credential = result.steps.find((s) => s.id === 'credential');
    expect(credential?.status).toBe('failed');
    expect(credential?.detail).toContain('EMR_MISSING_KEY');
    // Nothing should have been sent — we never got past the credential.
    expect(result.requests).toHaveLength(0);
  });

  it('fails fast on incomplete configuration instead of attempting a call', async () => {
    const secrets = new InMemorySecretsProvider();
    const result = await runContractTest(
      // No tokenEndpoint and no clientId — exactOptionalPropertyTypes means the
      // key is simply absent rather than explicitly undefined.
      baseIntegration({ authMode: 'smart-backend-services', clientId: '' }),
      secrets,
      { fetch: fakeEkEhr() },
    );
    expect(result.status).toBe('not-configured');
    expect(result.steps.find((s) => s.id === 'config')?.detail).toContain('tokenEndpoint');
    expect(result.requests).toHaveLength(0);
  });
});
