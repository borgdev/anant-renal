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

// F4.6 — the terminology service surface. A partner EMR must be able to resolve
// the codes we send, including the locally-declared ones it cannot look up
// anywhere else.

import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import type { ActorContext } from '../src/server/scoped-persistence.js';
import { terminologyReport } from '../src/fhir/code-registry.js';

const actor: ActorContext = {
  actorRef: 'user:test',
  scopeIds: ['scope:*'],
  clearance: 'restricted-phi',
  purposeOfUse: 'operations',
} as ActorContext;

async function build() {
  return buildApp({
    store: {
      async recordFhirResource() { /* noop */ },
      async listFhirResources() { return []; },
    } as never,
    telemetry: new Telemetry('test', new InMemorySink()),
    packs: [healthcareCorePack],
    authenticate: async () => actor,
    checkHealth: async () => ({ db: true, redis: true }),
    adminApiAuth: true,
  });
}

type App = Awaited<ReturnType<typeof build>>;

async function login(app: App): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { username: 'admin', password: 'admin123' } });
  const raw = Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'].join(';') : String(res.headers['set-cookie'] ?? '');
  const token = /hh_session=([^;]+)/.exec(raw)?.[1];
  if (!token) throw new Error(`no session: ${res.statusCode} ${res.body}`);
  return `hh_session=${token}`;
}

const param = (body: string, name: string): unknown => {
  const parsed = JSON.parse(body) as { parameter?: Array<{ name: string; valueString?: string; valueBoolean?: boolean }> };
  return parsed.parameter?.find((p) => p.name === name)?.valueString ?? parsed.parameter?.find((p) => p.name === name)?.valueBoolean;
};

describe('F4 · terminology service surface', () => {
  it('$lookup resolves a verified LOINC code to its real display', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/fhir/CodeSystem/$lookup?system=http://loinc.org&code=2823-3' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/fhir+json');
    expect(JSON.parse(res.body).resourceType).toBe('Parameters');
    expect(param(res.body, 'display')).toBe('Potassium [Moles/volume] in Serum or Plasma');
    expect(param(res.body, 'name')).toBe('LOINC');
    expect(param(res.body, 'fidelity')).toBe('verified');
  });

  it('$lookup resolves a LOCAL code and says it is local', async () => {
    // The receiver has no other way to learn what this urn means.
    const app = await build();
    const res = await app.inject({
      method: 'GET',
      url: '/fhir/CodeSystem/$lookup?system=urn:ananthealth:codesystem:safety-flag&code=access-risk',
    });
    expect(res.statusCode).toBe(200);
    expect(param(res.body, 'fidelity')).toBe('local');
    expect(param(res.body, 'display')).toBe('Vascular access at risk');
  });

  it('$lookup on KTV-DEL returns the real Kt/V code, not the placeholder', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/fhir/CodeSystem/$lookup?system=http://loinc.org&code=70961-8' });
    expect(res.statusCode).toBe(200);
    expect(param(res.body, 'display')).toBe('Kt/V.Hemodialysis');
  });

  it('$lookup without required parameters is a 400 OperationOutcome', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/fhir/CodeSystem/$lookup?system=http://loinc.org' });
    expect(res.statusCode).toBe(400);
    const outcome = JSON.parse(res.body) as { resourceType: string; issue: Array<{ code: string; severity: string }> };
    expect(outcome.resourceType).toBe('OperationOutcome');
    expect(outcome.issue[0]?.code).toBe('required');
    expect(outcome.issue[0]?.severity).toBe('error');
  });

  it('$lookup on an unknown code is a 404 OperationOutcome, not an empty 200', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/fhir/CodeSystem/$lookup?system=http://loinc.org&code=00000-0' });
    expect(res.statusCode).toBe(404);
    const outcome = JSON.parse(res.body) as { resourceType: string; issue: Array<{ code: string }> };
    expect(outcome.resourceType).toBe('OperationOutcome');
    expect(outcome.issue[0]?.code).toBe('not-found');
  });

  it('$validate-code answers true for a code we can emit and false for one we cannot', async () => {
    const app = await build();
    const good = await app.inject({ method: 'GET', url: '/fhir/ValueSet/$validate-code?system=http://www.nlm.nih.gov/research/umls/rxnorm&code=214824' });
    expect(good.statusCode).toBe(200);
    expect(param(good.body, 'result')).toBe(true);
    expect(param(good.body, 'display')).toBe('sevelamer');

    // An unknown code is a valid ANSWER (result:false), not an error.
    const bad = await app.inject({ method: 'GET', url: '/fhir/ValueSet/$validate-code?system=http://loinc.org&code=00000-0' });
    expect(bad.statusCode).toBe(200);
    expect(param(bad.body, 'result')).toBe(false);
    expect(String(param(bad.body, 'message'))).toMatch(/cannot emit/);
  });

  it('serves the code systems it uses, marking its own as complete', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/fhir/CodeSystem' });
    expect(res.statusCode).toBe(200);
    const bundle = JSON.parse(res.body) as { resourceType: string; total: number; entry: Array<{ resource: { url: string; content: string; count: number } }> };
    expect(bundle.resourceType).toBe('Bundle');
    expect(bundle.total).toBeGreaterThan(3);
    const loinc = bundle.entry.find((e) => e.resource.url === 'http://loinc.org');
    expect(loinc?.resource.content).toBe('not-present'); // a licensed system we do not rehost
    const local = bundle.entry.filter((e) => e.resource.url.startsWith('urn:ananthealth:codesystem:'));
    expect(local.length).toBeGreaterThan(0);
    for (const l of local) expect(l.resource.content).toBe('complete');
  });

  it('publishes the harness value sets, including one per local code system', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/fhir/ValueSet' });
    expect(res.statusCode).toBe(200);
    const bundle = JSON.parse(res.body) as { entry: Array<{ resource: { url: string } }> };
    const urls = bundle.entry.map((e) => e.resource.url);
    expect(urls).toContain('urn:ananthealth:valueset:vs:dialysis.labs.core');
    expect(urls.some((u) => u.startsWith('urn:ananthealth:valueset:local.'))).toBe(true);
  });

  it('reports terminology coverage and what still needs sign-off', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/fhir/terminology/report' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { parameter: Array<{ name: string; valueString: string }>; needsSignOff: unknown[] };
    const report = terminologyReport();
    expect(Number(param(res.body, 'total'))).toBe(report.total);
    expect(Number(param(res.body, 'verified'))).toBe(report.verified);
    expect(body.needsSignOff.length).toBe(report.local);
  });

  it('the admin coverage report carries a code-fidelity section', async () => {
    const app = await build();
    const c = await login(app);
    const res = await app.inject({ method: 'GET', url: '/admin/fhir/coverage', headers: { cookie: c } });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      codeFidelity: { total: number; verified: number; local: number; needsSignOff: Array<{ domain: string; slug: string; why: string }>; note: string };
    };
    const report = terminologyReport();
    expect(body.codeFidelity.total).toBe(report.total);
    expect(body.codeFidelity.verified).toBe(report.verified);
    expect(body.codeFidelity.needsSignOff.length).toBe(report.local);
    // A reviewer must be told WHY each entry is unverified.
    for (const row of body.codeFidelity.needsSignOff) expect(row.why).toBeTruthy();
    expect(body.codeFidelity.note).toMatch(/sign-off/);
  });
});
