// B batch hardening — P2-feature tests (drafts service, agent turn, dashboard),
// measure id resolution + coverage, and realm restore-on-boot.

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import type { PostgresEventStore } from '../src/server/postgres-event-store.js';
import type { CanonicalEvent } from '../src/healthcare-core/events.js';
import type { LedgerEntry } from '../src/hypergraph/ledger.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import type { ActorContext } from '../src/server/scoped-persistence.js';
import { RealmRegistry, captureSnapshot, restoreSnapshot, populateFacility } from '../src/realm/index.js';
import { buildHealthcareHypergraphSchema } from '../packs/healthcare-core/hypergraph.js';
import { RealmHypergraph } from '../src/realm/hypergraph-bridge.js';
import { AgentAuthoringService } from '../src/server/agent-authoring.js';
import { restoreRealmsFromSpecs } from '../src/server/realm-restore.js';
import { MeasureEvaluator } from '../src/measures/evaluator.js';
import { ValueSetRegistry } from '../src/measures/value-set-registry.js';
import { evaluateCatalogMeasure } from '../src/measures/catalog-evaluator.js';
import { ALL_CMS_MEASURES } from '../src/healthcare-core/cms-measure-catalog.js';
import type { StoredMeasure } from '../src/measures/types.js';
import { runReact } from '../src/knowledge/agents/runner.js';
import type { ToolDefinition } from '../src/knowledge/agents/tool-bus.js';

// Deterministic measure coverage regardless of .harness/measures/ contents
// (a live `npm run measures:sync` or measures:seed populates it and shifts
// catalog measures from `embedded` to `synced`). Force a non-existent root so
// this file's coverage/evaluate assertions are stable.
process.env.HH_MEASURES_ROOT = '/nonexistent/hh-measures';

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

const VALID_AGENT_YAML = `id: test-agent
version: 1.0.0
packId: test-pack
displayName: Test Agent
description: A test agent
scope: facility
trigger:
  kind: manual
inputs: {}
outputs: {}
plan:
  type: step
  step:
    id: s1
    skill: llm.call
governance:
  phiHandling: read
  purposeOfUse: [treatment]
  clearanceRequired: internal
billing:
  baseFeeUsd: 0
labels: {}
`;

describe('B1 — agent authoring service (injectable base dir)', () => {
  it('draft create → list → get → delete with audit, fully disk-based', () => {
    const base = mkdtempSync(join(tmpdir(), 'hh-auth-'));
    mkdirSync(join(base, 'test-pack'), { recursive: true });
    const svc = new AgentAuthoringService(base);

    const draft = svc.saveDraft({ packId: 'test-pack', id: 'test-agent', yaml: VALID_AGENT_YAML, actorRef: 'user:t' });
    expect(draft.id).toBe('test-agent');
    expect(svc.listDrafts().length).toBe(1);

    const got = svc.getDraft('test-pack', 'test-agent')!;
    expect(got.yaml).toContain('test-agent');
    expect(got.validation.ok).toBe(true);
    expect(svc.auditLog().map((a) => a.action)).toContain('create-draft');

    expect(svc.removeDraft('test-pack', 'test-agent')).toBe(true);
    expect(svc.getDraft('test-pack', 'test-agent')).toBeNull();
    expect(svc.listDrafts().length).toBe(0);
    expect(svc.auditLog().map((a) => a.action)).toContain('delete');

    rmSync(base, { recursive: true, force: true });
  });

  it('publish writes the agents file + audit; removeDraft is a no-op once published', () => {
    const base = mkdtempSync(join(tmpdir(), 'hh-auth-'));
    mkdirSync(join(base, 'test-pack'), { recursive: true });
    const svc = new AgentAuthoringService(base);
    svc.saveDraft({ packId: 'test-pack', id: 'test-agent', yaml: VALID_AGENT_YAML, actorRef: 'user:t' });

    const pub = svc.publish({ packId: 'test-pack', id: 'test-agent', actorRef: 'user:t' });
    expect(pub.published).toBe(true);
    expect(pub.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(svc.auditLog().map((a) => a.action)).toContain('publish');
    // published agent is live; the draft is gone → removeDraft correctly no-ops
    expect(svc.getDraft('test-pack', 'test-agent')).toBeNull();
    expect(svc.removeDraft('test-pack', 'test-agent')).toBe(false);

    rmSync(base, { recursive: true, force: true });
  });
});

describe('B1 — P2 route surfaces', () => {
  it('agent turn route returns a real episode', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: '/admin/knowledge/agent/turn',
      payload: { question: 'Cite the CMS165 numerator criteria and show me the value set expansion.' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { episodeId: string; strategy: string; answer: string };
    expect(body.episodeId).toBeTruthy();
    expect(body.strategy).toBeTruthy();
    expect(typeof body.answer).toBe('string');
  });

  it('draft validate returns errors for bad YAML, no disk writes', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/admin/drafts/validate', payload: { yaml: 'id: [unclosed' } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; errors: string[] };
    expect(body.ok).toBe(false);
    expect(body.errors.length).toBeGreaterThan(0);
  });

  it('dashboard endpoints respond 200 with shape', async () => {
    const app = await makeApp();
    const summary = await app.inject({ method: 'GET', url: '/admin/summary' });
    expect(summary.statusCode).toBe(200);
    const audit = await app.inject({ method: 'GET', url: '/admin/audit?limit=8' });
    expect(audit.statusCode).toBe(200);
    expect((audit.json() as { audit: unknown[] }).audit).toBeDefined();
    const broker = await app.inject({ method: 'GET', url: '/admin/broker' });
    expect(broker.statusCode).toBe(200);
  });
});

describe('B2 — measure id resolution + coverage', () => {
  function evaluator(): MeasureEvaluator {
    const measure: StoredMeasure = {
      id: 'ecqm:CMS165FHIRControllingHighBloodPressure/v1.6.000',
      cmsId: 'CMS165FHIRControllingHighBloodPressure',
      name: 'CMS165FHIRControllingHighBloodPressure', title: 'Controlling High Blood Pressure',
      version: '1.6.000', status: 'active', libraryRefs: [], raw: {},
      upstream: { repo: 'r', path: 'm.json', blobSha: 'x', commitSha: 'y', rawUrl: 'https://x', fetchedAt: '2026', contentHash: 'h' },
    };
    return new MeasureEvaluator({ measures: [measure], libraries: [], valueSetRegistry: new ValueSetRegistry(mkdtempSync(join(tmpdir(), 'hh-vsr-'))) });
  }

  it('getMeasure resolves canonical, plain-CMS, cms:-prefixed and punctuation-insensitive ids', () => {
    const ev = evaluator();
    expect(ev.getMeasure('ecqm:CMS165FHIRControllingHighBloodPressure/v1.6.000')?.id).toContain('ecqm:');
    expect(ev.getMeasure('CMS165FHIRControllingHighBloodPressure')?.cmsId).toBe('CMS165FHIRControllingHighBloodPressure');
    expect(ev.getMeasure('cms:CMS165FHIRControllingHighBloodPressure')?.cmsId).toBe('CMS165FHIRControllingHighBloodPressure');
    expect(ev.getMeasure('cms165fhircontrollinghighbloodpressure')?.cmsId).toBe('CMS165FHIRControllingHighBloodPressure');
    // punctuation-insensitive: dashes/case don't matter
    expect(ev.getMeasure('cms165-fhir-controlling-high-blood-pressure')?.cmsId).toBe('CMS165FHIRControllingHighBloodPressure');
    expect(ev.getMeasure('cms:does-not-exist')).toBeUndefined();
  });

  it('coverage endpoint reports catalog vs synced', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/admin/measures/coverage' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { catalogTotal: number; syncedTotal: number; synced: unknown[]; catalog: Array<{ id: string; evaluable: boolean }> };
    expect(body.catalogTotal).toBeGreaterThan(0);
    expect(Array.isArray(body.catalog)).toBe(true);
    expect(body.catalog[0]!.id).toMatch(/^cms:/);
  });
});

describe('C1 — embedded (CQL-free) catalog measure evaluation', () => {
  const caBundle = (value: number) => ({
    resourceType: 'Bundle',
    entry: [
      { resource: { resourceType: 'Patient', id: 'p1' } },
      { resource: { resourceType: 'Observation', subject: { reference: 'Patient/p1' }, code: { coding: [{ code: '17861-6' }] }, valueQuantity: { value, unit: 'mg/dL' } } },
    ],
  });

  it('evaluates the hypercalcemia catalog measure from a LOINC bundle', () => {
    const spec = ALL_CMS_MEASURES.find((m) => m.id === 'cms:esrd-qip:hypercalcemia')!;
    expect(spec.thresholds).toBeTruthy();
    const met = evaluateCatalogMeasure(spec, caBundle(11.0));
    expect(met.engine).toBe('embedded');
    expect(met.patients[0]!.met).toBe(true);
    const notMet = evaluateCatalogMeasure(spec, caBundle(9.5));
    expect(notMet.patients[0]!.met).toBe(false);
  });

  it('evaluate route serves embedded catalog measures (no synced store needed)', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: '/admin/measures/cms%3Aesrd-qip%3Ahypercalcemia/evaluate',
      payload: { bundle: caBundle(11.0) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { engine: string; patients: Array<{ met: boolean }> };
    expect(body.engine).toBe('embedded');
    expect(body.patients[0]!.met).toBe(true);
  });

  it('coverage reports embedded measures separately', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/admin/measures/coverage' });
    const body = res.json() as { embeddedTotal: number; catalog: Array<{ id: string; source: string | null; evaluable: boolean }> };
    expect(body.embeddedTotal).toBeGreaterThanOrEqual(3);
    const ktv = body.catalog.find((c) => c.id === 'cms:esrd-qip:kt-v')!;
    expect(ktv.source).toBe('embedded');
    expect(ktv.evaluable).toBe(true);
  });
});

describe('B3 — realm restore-on-boot', () => {
  it('rebuilds a persisted realm from its creation spec', async () => {
    const fakeStore = {
      listRealmSpecs: async () => [{
        realmId: 'realm:restore', mode: 'sim', trajectoryEngine: null,
        specJson: JSON.stringify({ seed: { facilityId: 'f1', kind: 'dialysis', name: 'Restored Dialysis', units: ['U1'], patientCount: 2 } }),
        createdAt: '2026-08-16T00:00:00Z', updatedAt: '2026-08-16T00:00:00Z',
      }],
      getRealmSnapshot: async () => undefined,
    };
    const restored = await restoreRealmsFromSpecs(fakeStore);
    expect(restored).toContain('realm:restore');
    const realm = RealmRegistry.get('realm:restore');
    expect(realm).toBeTruthy();
    expect(realm!.graph.listKind('patient').length).toBe(2);
    expect(realm!.graph.listKind('facility').length).toBe(1);
    RealmRegistry.remove('realm:restore');
  });

  it('captureSnapshot → restoreSnapshot restores entities + presences + ledger + clock (C2)', async () => {
    const hg = new RealmHypergraph(buildHealthcareHypergraphSchema(), 'realm:snap-src');
    const src = RealmRegistry.create({ id: 'realm:snap-src', mode: 'sim', hypergraph: hg });
    populateFacility(src, { facilityId: 'f1', kind: 'dialysis', name: 'Src Dialysis', units: ['U1'], patientCount: 1 });
    src.start();
    const md = src.spawnPresence({ agentSpecId: 'md', runId: 'r', role: 'md', clearance: 'phi', purposeOfUse: ['treatment'], location: { facilityId: 'f1', unitId: 'U1' } });
    // populateFacility seeds patient `f1-pt-0001` — target that id so no duplicate patient is created.
    src.emit(md.presenceId, { kind: 'admit-patient', patientId: 'f1-pt-0001', facilityId: 'f1', unitId: 'U1' });
    src.emit(md.presenceId, { kind: 'record-vitals', patientId: 'f1-pt-0001', hr: 92, spo2: 96 });
    const patient = src.graph.listKind('patient')[0]!;
    src.graph.patch(patient.urn, { labs: { K: 4.2, HGB: 11.5, URR: 68, PHOS: 5.1 }, trajectory: 'decompensating' }, 'test-seed');

    const snapshot = captureSnapshot(src);
    src.stop();

    const hg2 = new RealmHypergraph(buildHealthcareHypergraphSchema(), 'realm:snap-dst');
    const dst = restoreSnapshot(snapshot, () => RealmRegistry.create({ id: 'realm:snap-dst', mode: 'sim', hypergraph: hg2 }));
    dst.start();

    expect(dst.graph.listKind('patient').length).toBe(1);
    const st = dst.graph.listKind('patient')[0]!.state as Record<string, unknown>;
    expect((st.labs as { K: number }).K).toBe(4.2);
    expect(st.trajectory).toBe('decompensating');
    expect((st.lastVitals as { hr: number }).hr).toBe(92);
    expect(dst.presences.list().length).toBe(1);
    expect(dst.ledger.listAll().length).toBeGreaterThanOrEqual(2);
    expect(dst.clock.realmAt.toISOString()).toBe(snapshot.realm.realmAt);
    expect(dst.clock.seq).toBe(snapshot.realm.seq);

    RealmRegistry.remove('realm:snap-src');
    RealmRegistry.remove('realm:snap-dst');
  });
});

describe('D3 — agent-authoring → runtime → measure feedback loop', () => {
  it('run-spec records a run; runs list + detail return it with citations', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: '/admin/knowledge/agent/run-spec',
      payload: { packId: 'flagship-agents', agentId: 'lab-critical-value-pager', source: 'published', question: 'Which patients have a critical lab value, per our protocol?' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { episodeId: string; recorded: boolean; spec: { id: string } };
    expect(body.recorded).toBe(true);
    expect(body.episodeId).toBeTruthy();

    const list = await app.inject({ method: 'GET', url: '/admin/knowledge/agent/runs?agentId=lab-critical-value-pager&limit=5' });
    expect(list.statusCode).toBe(200);
    const lj = list.json() as { runs: Array<{ episodeId: string; agent: { agentId: string; source: string; displayName: string }; question: string; citations: unknown[] }> };
    const found = lj.runs.find((r) => r.episodeId === body.episodeId);
    expect(found).toBeTruthy();
    expect(found!.agent.agentId).toBe('lab-critical-value-pager');
    expect(found!.agent.source).toBe('published');
    expect(found!.agent.displayName).toBeTruthy();
    expect(Array.isArray(found!.citations)).toBe(true);

    const detail = await app.inject({ method: 'GET', url: `/admin/knowledge/agent/runs/${body.episodeId}` });
    expect(detail.statusCode).toBe(200);
    const dj = detail.json() as { episodeId: string; answer: string; measureScores: unknown[] };
    expect(dj.episodeId).toBe(body.episodeId);
    expect(typeof dj.answer).toBe('string');
    expect(Array.isArray(dj.measureScores)).toBe(true);
  });

  it('ad-hoc turn records a run without an agent reference', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/admin/knowledge/agent/turn', payload: { question: 'Cite the CMS165 numerator criteria.' } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { episodeId: string; recorded: boolean };
    expect(body.recorded).toBe(true);
    const list = await app.inject({ method: 'GET', url: '/admin/knowledge/agent/runs?limit=20' });
    const lj = list.json() as { runs: Array<{ episodeId: string; agent?: unknown }> };
    expect(lj.runs.some((r) => r.episodeId === body.episodeId && !r.agent)).toBe(true);
  });

  it('react runner invokes evaluate_measure for a measure question and folds the score into the answer', async () => {
    const fakeMeasure = {
      name: 'evaluate_measure', description: '', parameters: { type: 'object', properties: {} },
      invoke: async () => ({
        ok: true,
        data: { patients: [{ patientId: 'demo-patient', met: true }] },
        citations: [{ sourceId: 'cqframework', upstream: { rawUrl: 'https://x', contentHash: 'abc' } }],
      }),
    } as unknown as ToolDefinition;
    const out = await runReact({ question: 'Evaluate ecqm:M21Basic/1.0.0 against the demo lab patient', tools: [fakeMeasure] });
    const measureStep = out.steps.find((s) => s.kind === 'tool' && s.tool?.name === 'evaluate_measure');
    expect(measureStep).toBeTruthy();
    expect(out.citations.some((c) => c.sourceId === 'cqframework')).toBe(true);
    expect(out.answer).toContain('ecqm:M21Basic/1.0.0');
    expect(out.answer).toContain('numerator met');
  });
});
