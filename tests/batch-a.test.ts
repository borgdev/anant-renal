// Batch A — live subscription pull (emulator), counterfactual apply-with-evidence,
// agent-spec-triggered runs, and local-corpus → agent search/citation.

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import type { PostgresEventStore } from '../src/server/postgres-event-store.js';
import type { CanonicalEvent } from '../src/healthcare-core/events.js';
import type { LedgerEntry } from '../src/hypergraph/ledger.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import type { ActorContext } from '../src/server/scoped-persistence.js';
import { RealmRegistry, populateFacility } from '../src/realm/index.js';
import { buildHealthcareHypergraphSchema } from '../packs/healthcare-core/hypergraph.js';
import { RealmHypergraph } from '../src/realm/hypergraph-bridge.js';
import { FhirEmulator, emulatorSearchBundle, seedFhirDataset } from '../src/fhir/emulator.js';
import { FhirClient } from '../src/fhir/client.js';
import { FhirSubscriptionPump } from '../src/fhir/subscription.js';
import { buildKnowledgeToolBus } from '../src/knowledge/agents/tool-bus.js';
import { CounterfactualStore } from '../src/realm/counterfactual-store.js';
import type { FhirCtx } from '../src/fhir/types.js';

function inMemoryStore(): PostgresEventStore {
  const events: CanonicalEvent[] = [];
  const ledger: LedgerEntry[] = [];
  const audit: unknown[] = [];
  return {
    async applyMigrations() { /* noop */ },
    async appendEvent(_scope: { scopeId: string; actorRef: string }, ev: CanonicalEvent) { events.push(ev); },
    async queryEvents() { return events; },
    async appendLedger(_scopeId: string, entry: LedgerEntry) { ledger.push(entry); },
    async queryLedger() { return ledger; },
    async appendAudit(row: unknown) { audit.push(row); },
    async withTransaction<T>(fn: (client: unknown) => Promise<T>) { return fn({}); },
  } as unknown as PostgresEventStore;
}

const actor: ActorContext = { actorRef: 'user:ops', scopeIds: ['realm:r1', 'scope:*'], purposeOfUse: 'operations', clearance: 'restricted-phi' };

async function makeApp() {
  return buildApp({
    store: inMemoryStore(),
    telemetry: new Telemetry('test', new InMemorySink()),
    packs: [healthcareCorePack],
    authenticate: async () => actor,
    checkHealth: async () => ({ db: true, redis: true }),
  });
}

function makeRealm(id = 'realm:ba'): string {
  if (RealmRegistry.get(id)) return id;
  const hg = new RealmHypergraph(buildHealthcareHypergraphSchema(), id);
  const realm = RealmRegistry.create({ id, mode: 'sim', hypergraph: hg });
  populateFacility(realm, { facilityId: 'f1', kind: 'dialysis', name: 'BA Dialysis', units: ['U1'], patientCount: 2 });
  realm.start();
  return id;
}

function ctx(): FhirCtx { return { realmId: 'realm:ba', facilityId: 'f1', scopeId: 'realm:ba', sourceId: 'test', ingestedAt: '2026-08-16T00:00:00Z' }; }

describe('A1 — in-process FHIR emulator + live subscription pull', () => {
  it('seed dataset covers the watched resource types', () => {
    const types = new Set(seedFhirDataset().map((r) => r.resourceType));
    for (const t of ['Patient', 'Observation', 'Encounter', 'Condition', 'Procedure'] as const) expect(types.has(t)).toBe(true);
  });

  it('emulator searchset honors _lastUpdated / _count / _sort', () => {
    const em = new FhirEmulator();
    em.seed(seedFhirDataset());
    // everything after epoch
    const all = emulatorSearchBundle(em, 'Patient', { _count: '100' });
    expect(all.entry?.length).toBe(2);
    // nothing before epoch → empty
    const none = emulatorSearchBundle(em, 'Patient', { _lastUpdated: 'gt2100-01-01T00:00:00Z' });
    expect(none.entry?.length).toBe(0);
    // count limit
    const one = emulatorSearchBundle(em, 'Patient', { _count: '1' });
    expect(one.entry?.length).toBe(1);
    // sort desc by lastUpdated
    const sorted = emulatorSearchBundle(em, 'Observation', { _count: '100', _sort: '-_lastUpdated' });
    const dates = (sorted.entry ?? []).map((e) => e.resource!.meta!.lastUpdated!);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it('subscription pump hydrates emulator changes into canonical events', async () => {
    const em = new FhirEmulator();
    em.seed(seedFhirDataset());
    const client = new FhirClient({
      baseUrl: 'http://127.0.0.1:3000/fhir-mock',
      fetch: async (url) => {
        const m = /\/fhir-mock\/([A-Za-z]+)\?/.exec(url);
        const resourceType = m?.[1] ?? 'Patient';
        const qs = new URLSearchParams(url.split('?')[1] ?? '');
        const params = {
          ...(qs.get('_lastUpdated') ? { _lastUpdated: qs.get('_lastUpdated')! } : {}),
          ...(qs.get('_count') ? { _count: qs.get('_count')! } : {}),
        };
        const bundle = emulatorSearchBundle(em, resourceType, params);
        return { ok: true, status: 200, json: async () => bundle };
      },
    });
    const pump = new FhirSubscriptionPump({ client, ctx: ctx(), resourceTypes: ['Patient', 'Observation', 'Encounter', 'Condition', 'Procedure'] });
    const result = await pump.poll();
    expect(result.fetched).toBe(seedFhirDataset().length);
    expect(result.events.length).toBeGreaterThanOrEqual(7);
    // cursor advanced to the newest lastUpdated
    expect(result.nextSince > '2026-08-16T00:00:00Z').toBe(true);
  });
});

describe('A2 — counterfactual apply-with-evidence', () => {
  it('404 for an unknown counterfactual id', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/admin/counterfactual/nope/apply' });
    expect(res.statusCode).toBe(404);
  });

  it('run + apply-with-evidence (deterministic — force the record promotable)', async () => {
    const app = await makeApp();
    makeRealm();
    const run = await app.inject({
      method: 'POST', url: '/admin/counterfactual/run',
      payload: {
        realmId: 'realm:ba',
        facility: { facilityId: 'cf-fac', kind: 'dialysis', name: 'cf', units: ['U1'], patientCount: 2 },
        interventions: [{ kind: 'event-effect', effect: { diet_phosphate_violation: -0.2 } }],
        advanceTicks: 0,
        label: 'test apply',
      },
    });
    expect(run.statusCode).toBe(200);
    const rec = run.json() as { id: string };
    expect(rec.id).toBeTruthy();

    // Force the stored record promotable so the applied path is exercised exactly.
    const stored = CounterfactualStore.get(rec.id)!;
    stored.report.promotable = true;
    stored.report.gateReasons = [];

    const apply = await app.inject({ method: 'POST', url: `/admin/counterfactual/${rec.id}/apply` });
    expect(apply.statusCode).toBe(200);
    const body = apply.json() as { applied: boolean; evidenceId: string; directiveEffectId: string; delta: Record<string, number> };
    expect(body.applied).toBe(true);
    expect(body.evidenceId).toBe(rec.id);
    expect(body.directiveEffectId).toBeTruthy();
    expect(typeof body.delta).toBe('object');

    // The operator-directive with the evidence link is on the realm ledger.
    const realm = RealmRegistry.get('realm:ba')!;
    const directive = realm.ledger.listAll().find((e) => e.effect.kind === 'operator-directive');
    expect(directive).toBeTruthy();
    expect((directive!.effect as { evidenceId?: string }).evidenceId).toBe(rec.id);
  });
});

describe('A3 — agent-spec-triggered runs', () => {
  it('runs a published agent spec as a real knowledge turn', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: '/admin/knowledge/agent/run-spec',
      payload: { packId: 'flagship-agents', agentId: 'lab-critical-value-pager', source: 'published', question: 'Which patients have a critical lab value, per our protocol?' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { episodeId: string; spec: { id: string; displayName: string }; strategy: string; answer: string };
    expect(body.episodeId).toBeTruthy();
    expect(body.spec.id).toBe('lab-critical-value-pager');
    expect(body.strategy).toBeTruthy();
    expect(typeof body.answer).toBe('string');
  });

  it('404 for a missing agent spec', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: '/admin/knowledge/agent/run-spec',
      payload: { packId: 'flagship-agents', agentId: 'does-not-exist', source: 'published' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('A4 — local-corpus → agent search/citation', () => {
  it('search_local_corpus returns matching snippets + citations', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-lc-'));
    const realmDir = join(dir, '__realm__', 'realm:ba', 'local-corpus');
    mkdirSync(realmDir, { recursive: true });
    writeFileSync(join(realmDir, 'abc123__dialysis-protocol.txt'), 'Phosphate binders must be administered with meals. Target serum phosphate < 5.5 mg/dL.');

    const tools = buildKnowledgeToolBus({ layer: {} as never, storeDir: dir, actorId: 'test', episodeId: 'e1', realmId: 'realm:ba' });
    const search = tools.find((t) => t.name === 'search_local_corpus');
    expect(search).toBeTruthy();
    const r = await search!.invoke({ query: 'phosphate binder protocol' });
    expect(r.ok).toBe(true);
    const data = r.data as { count: number; matches: Array<{ title: string; snippet: string }> };
    expect(data.count).toBe(1);
    expect(data.matches[0]!.title).toContain('dialysis-protocol');
    expect(data.matches[0]!.snippet).toContain('Phosphate binders');
    expect(r.citations?.[0]?.sourceId).toBe('realm:realm:ba:local-corpus');
    expect(r.citations?.[0]?.artifactId).toBe('abc123');
  });
});
