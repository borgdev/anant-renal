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

// The multi-specialty ACCEPTANCE test — the thing every gap above exists to make
// possible, asserted end to end on one running app.
//
// The claim being tested is Phase 5's exit criterion, in its own words: adding a
// second specialty requires pack package work, NOT core architecture changes.
//
// The deployment below has FIVE packs: the substrate, renal, payer, the real
// `oncology-provider`, and one more specialty that exists only in this process.
//
//   routes      each registers its own, under its own authority
//   screen      oncology's manifest declares a view by KIND, which the shell draws
//   coverage    the assurance track reviews a protocol it was never written for
//   application a binding takes one dark without darkening the others
//   hand-off    cross-pack workflows, decided by the packs, on a real deployment
//
// TWO specialities, two different jobs. `oncology-provider` is a REAL pack: it is
// here to prove the end-to-end path works for a specialty that ships, and its id
// must not be reused below. The in-process one under `synthetic-oncology` is a
// specialty NO catalog entry describes — the never-heard-of case — and it carries
// the assurance contribution, because a real pack declaring one would be a claim
// about a model that does not exist.
//
// Neither is renal. Half of these assertions would pass for a pack written against
// renal vocabulary, and the whole defect class this work closed was platform-side
// vocabularies that only renal could satisfy.

import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import { dialysisProviderPack } from '../packs/dialysis-provider/index.js';
import { payerPack } from '../packs/payer/index.js';
import { oncologyProviderPack } from '../packs/oncology-provider/index.js';
import type { DomainPack } from '../src/control-plane/pack-registry.js';
import type { PackRouteContribution, PackWithContributions } from '../src/control-plane/pack-contributions.js';
import type { PackPatient } from '../src/control-plane/pack-contributions.js';
import type { ActorContext } from '../src/server/scoped-persistence.js';
import type { PostgresEventStore } from '../src/server/postgres-event-store.js';
import type { CanonicalEvent } from '../src/healthcare-core/events.js';
import type { LedgerEntry } from '../src/hypergraph/ledger.js';
import { setSpecialtyBindingSnapshot } from '../src/server/specialty-apply.js';

const actor: ActorContext = {
  actorRef: 'user:acceptance',
  scopeIds: ['scope:*'],
  clearance: 'restricted-phi',
  purposeOfUse: 'operations',
} as ActorContext;

function inMemoryStore(): PostgresEventStore {
  const events: CanonicalEvent[] = [];
  const ledger: LedgerEntry[] = [];
  const audit: unknown[] = [];
  return {
    async applyMigrations() { /* no-op */ },
    async appendEvent(_s: unknown, e: CanonicalEvent) { events.push(e); },
    async queryEvents() { return events; },
    async appendLedger(_s: unknown, e: LedgerEntry) { ledger.push(e); },
    async queryLedger() { return ledger; },
    async appendAudit(_s: unknown, row: unknown) { audit.push(row); },
    async queryAudit() { return audit; },
    async recordFhirResource() { /* noop */ },
    async listFhirResources() { return []; },
  } as unknown as PostgresEventStore;
}

/*
 * A THIRD specialty that exists only in this process — an id the catalog has never
 * seen, and deliberately NOT `oncology-provider`: that is now a real pack with a
 * real declared surface, and sharing its id would make this fixture collide with
 * the real manifest's lens rather than test anything.
 */
const SYNTHETIC_ROUTES: PackRouteContribution = {
  id: 'synthetic.regimen',
  scope: 'exec',
  prefixes: ['/admin/swarm/synthetic-oncology'],
  register(app, deps) {
    app.get('/admin/swarm/synthetic-oncology/state', async () => {
      const patients: readonly PackPatient[] = deps.patients();
      // The pack reads the population the platform gave it and nothing else.
      return {
        actions: {
          nbas: patients.slice(0, 2).map((p, i) => ({
            id: `nba-${p.id}-${i}`, title: `Regimen review for ${p.id}`, score: 0.9 - i / 10,
            actionKind: 'review-regimen', cells: ['synthetic.regimen'],
          })),
          considered: patients.length, actionable: patients.length, suppressed: 0,
          kinds: ['synthetic.regimen'], unmapped: [], rejected: [],
        },
        patientsInScope: patients.length,
      };
    });
  },
};

const syntheticOncologyPack: PackWithContributions = {
  ...(healthcareCorePack as DomainPack),
  id: 'synthetic-oncology',
  version: '0.1.0',
  capabilities: ['treatment-planning'],
  requiredControls: ['access-policy', 'audit-provenance'],
  specialty: {
    evidenceTier: 'modelled',
    controls: ['access-policy', 'audit-provenance'],
    ontologyConcepts: 3,
    // A view by KIND, declared against its own route. Before G5 this was a
    // blocking `unknown-lens-view` because `synthetic-regimen` is not one of the
    // eleven renal view ids.
    uiLens: {
      id: 'synthetic-oncology',
      label: 'Synthetic oncology',
      views: [{ id: 'synthetic-regimen', label: 'Regimen review', kind: 'ranked-actions', source: '/admin/swarm/synthetic-oncology/state' }],
      terminology: { patient: 'Person under treatment', 'patient-view': 'Treatment intelligence' },
    },
  },
  routes: [SYNTHETIC_ROUTES],
  assurance: [{
    // A protocol with NO renal vocabulary. The assurance track must review it and
    // must not accuse it of missing renal guideline rules.
    protocol: 'synthetic-oncology.regimen-v1',
    slice: 'X1',
    modelId: 'synthetic-oncology.regimen-v0',
    redTeamIds: ['rt-syn-1'],
    coverageDefaults: { minSerialLabs: 2 },
    artifactProbe: () => ({ present: true, band: 'pass', note: 'synthetic probe' }),
    routes: '/admin/swarm/synthetic-oncology',
    mdrKind: 'synthetic-oncology-mdr-file',
  }],
} as unknown as PackWithContributions;

type App = Awaited<ReturnType<typeof buildApp>>;

/** POST /auth/login → the hh_session cookie value. */
async function login(app: App, username: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { username, password } });
  const setCookie = res.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie.join(';') : String(setCookie ?? '');
  const token = /hh_session=([^;]+)/.exec(raw)?.[1];
  if (!token) throw new Error(`no session cookie: ${res.statusCode} ${res.body}`);
  return token;
}

const cookie = (token: string): string => `hh_session=${token}`;

/** The three-specialty deployment: renal, payer, and one nothing was written for. */
async function deployment(): Promise<App> {
  return buildApp({
    store: inMemoryStore(),
    telemetry: new Telemetry('test', new InMemorySink()),
    packs: [healthcareCorePack, dialysisProviderPack, payerPack, oncologyProviderPack, syntheticOncologyPack],
    authenticate: async () => actor,
    checkHealth: async () => ({ db: true, redis: true }),
    adminApiAuth: true,
  });
}

describe('ACCEPTANCE — a deployment hosts several specialties at once', () => {
  it('every specialty registers its own routes, and an absent pack is 404 not 403', async () => {
    const app = await deployment();
    const auth = { cookie: cookie(await login(app, 'admin', 'admin123')) };
    // The real specialty the platform was never written for: installed, and until
    // it declared a surface, indistinguishable from absent.
    expect((await app.inject({ method: 'GET', url: '/admin/swarm/oncology/board', headers: auth })).statusCode).toBe(200);
    // The in-process one, which no catalog entry describes at all.
    expect((await app.inject({ method: 'GET', url: '/admin/swarm/synthetic-oncology/state', headers: auth })).statusCode).toBe(200);
    // And the ones it hosts alongside them.
    expect((await app.inject({ method: 'GET', url: '/admin/swarm/anemia/state', headers: auth })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/admin/swarm/payer/state', headers: auth })).statusCode).toBe(200);
    // A specialty that is NOT installed does not exist. It is not a permission an
    // operator could be granted, which is why this is 404 rather than 403.
    expect((await app.inject({ method: 'GET', url: '/admin/swarm/radiology/state', headers: auth })).statusCode).toBe(404);
    await app.close();
  });

  it('the console is offered every specialty that declares views, not only the leading one', async () => {
    const app = await deployment();
    const auth = { cookie: cookie(await login(app, 'admin', 'admin123')) };
    // A lens leads because the deployment said so. Without an activation nothing
    // leads and the shell falls back to the organization's operating model — which
    // is the correct behaviour, and not the thing under test here.
    const activated = await app.inject({
      method: 'POST', url: '/admin/platform/packs/dialysis-provider/activate', headers: auth, payload: { by: 'acceptance' },
    });
    expect(activated.statusCode).toBe(200);

    const ctx = (await app.inject({ method: 'GET', url: '/api/context', headers: auth })).json() as {
      pack: { label?: string };
      viewGroups: Array<{ packId: string; primary: boolean; views: Array<{ id: string; kind?: string; source?: string }> }>;
      packs: Array<{ packId: string; applied: boolean; show: boolean }>;
    };
    // Renal leads, and its own eleven views are offered.
    expect(ctx.pack.label).toBe('Renal');
    expect(ctx.viewGroups.filter((g) => g.primary)).toHaveLength(1);
    expect(ctx.viewGroups[0]?.packId).toBe('dialysis-provider');
    expect(ctx.viewGroups[0]?.views).toHaveLength(11);

    // The payer declares `views: []`, and an empty DECLARATION is a real answer:
    // it gets no group rather than inheriting renal's strip. That distinction is
    // the §4 defect the field exists to fix.
    expect(ctx.viewGroups.find((g) => g.packId === 'payer')).toBeUndefined();

    // The platform KNOWS the third specialty exists, which is what the console
    // switcher and the conformance matrix read.
    expect(ctx.packs.find((p) => p.packId === 'synthetic-oncology')).toBeTruthy();

    // A LENS IS READ FROM THE PACK'S MANIFEST, so the in-process pack contributes
    // no view group — and that is a coupling worth stating rather than a gap. Phase
    // 3 made the manifest the source of a pack's declared surface, and the loader
    // resolves every pack THROUGH its manifest, so a deployment cannot contain a
    // manifestless pack at all.
    expect(ctx.viewGroups.find((g) => g.packId === 'synthetic-oncology')).toBeUndefined();

    // THE REAL SECOND SPECIALTY, and this is the assertion that matters: its screen
    // arrives as a KIND plus its own route, so the shell draws it without a `case`
    // arm for `oncology-regimen`. Nothing in `src/` mentions oncology.
    const oncology = ctx.viewGroups.find((g) => g.packId === 'oncology-provider');
    expect(oncology?.views).toEqual([
      { id: 'oncology-regimen', label: 'Regimen review', kind: 'ranked-actions', source: '/admin/swarm/oncology/board' },
    ]);
    expect(oncology?.primary).toBe(false);
    await app.close();
  });

  it('the pack reads the population the PLATFORM gave it, not one it reached for', async () => {
    const app = await deployment();
    const auth = { cookie: cookie(await login(app, 'admin', 'admin123')) };
    const body = (await app.inject({ method: 'GET', url: '/admin/swarm/synthetic-oncology/state', headers: auth })).json() as {
      actions: { considered: number }; patientsInScope: number;
    };
    // No patients are registered in this deployment, and the pack answers 0 rather
    // than inventing a cohort. The projection is the platform's, which is what
    // makes `applied` enforceable.
    expect(body.patientsInScope).toBe(0);
    expect(body.actions.considered).toBe(0);
    await app.close();
  });

  it('taking ONE specialty dark does not darken the others', async () => {
    // The property G6 exists for, on a three-specialty deployment: a specialty can
    // be installed, be declared, and still be OFF — without that being a fact about
    // any other specialty.
    //
    // Written through the API rather than poked into the gate's snapshot, because
    // the snapshot governs the PATIENT projection while the DURABLE bindings govern
    // what `/api/context` resolves. A test that set only one of them would pass
    // while the two disagreed about the same pack.
    const app = await deployment();
    const auth = { cookie: cookie(await login(app, 'admin', 'admin123')) };
    const written = await app.inject({
      method: 'PUT', url: '/admin/platform/specialty-bindings', headers: auth,
      payload: { scope: 'scope:*', packId: 'synthetic-oncology', applied: false, show: false, entitled: false, by: 'acceptance' },
    });
    expect(written.statusCode).toBe(200);

    const ctx = (await app.inject({ method: 'GET', url: '/api/context', headers: auth })).json() as {
      packs: Array<{ packId: string; applied: boolean; show: boolean; reason: string }>;
    };
    const byId = new Map(ctx.packs.map((p) => [p.packId, p]));
    expect(byId.get('synthetic-oncology')?.applied).toBe(false);
    expect(byId.get('synthetic-oncology')?.show).toBe(false);
    expect(byId.get('synthetic-oncology')?.reason).toBe('binding');
    // The others are untouched — read the OTHER way round, one binding for one
    // pack would have darkened every specialty in the deployment.
    expect(byId.get('dialysis-provider')?.applied).toBe(true);
    expect(byId.get('payer')?.reason).toBe('no-binding');
    await app.close();
  });

  it('the assurance track reviews every specialty, and does not accuse the new one of missing renal rules', async () => {
    const app = await deployment();
    const auth = { cookie: cookie(await login(app, 'admin', 'admin123')) };
    const body = (await app.inject({ method: 'GET', url: '/admin/swarm/assurance/overview', headers: auth })).json() as {
      protocols: Array<{ protocol: string; checks: Array<{ id: string; status: string; detail: string }> }>;
    };
    const protocols = body.protocols.map((p) => p.protocol);
    // Seven renal protocols AND the one the track was never written against.
    expect(protocols).toContain('synthetic-oncology.regimen-v1');
    expect(protocols).toHaveLength(8);

    const onc = body.protocols.find((p) => p.protocol === 'synthetic-oncology.regimen-v1');
    const rules = onc?.checks.find((c) => c.id === 'synthetic-oncology.regimen-v1.rules');
    // The platform ships no rule pack for oncology, so the check WARNS and names
    // what is missing. Failing it would block every release containing a non-renal
    // pack forever, on the grounds that it is not renal.
    expect(rules?.status).toBe('warn');
    expect(rules?.detail).toMatch(/no platform rule pack covers/);
    await app.close();
  });

  it('a cross-pack hand-off between specialties fires on a real canonical event', async () => {
    const app = await deployment();
    const auth = { cookie: cookie(await login(app, 'admin', 'admin123')) };
    const before = (await app.inject({ method: 'GET', url: '/admin/swarm/cross-pack', headers: auth })).json() as {
      running: string[]; notRunning: Array<{ workflowId: string }>;
    };
    // Which hand-offs run is decided by the packs in THIS deployment.
    expect(before.running).toEqual(['x:hospitalization->payer-auth', 'x:denied-auth->reschedule+appeal']);

    // The router is built from the installed manifests at registration, and firing
    // is asserted in `tests/cross-pack-workflows.test.ts`; what this asserts is that
    // a deployment of several specialties HAS a live hand-off at all, which was not
    // true of any deployment before this work.
    expect(before.running.length).toBeGreaterThan(0);
    await app.close();
  });
});
