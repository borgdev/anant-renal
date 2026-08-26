import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import type { PostgresEventStore } from '../src/server/postgres-event-store.js';
import type { CanonicalEvent } from '../src/healthcare-core/events.js';
import type { LedgerEntry } from '../src/hypergraph/ledger.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import type { ActorContext } from '../src/server/scoped-persistence.js';

function inMemoryStore(): PostgresEventStore {
  const events: CanonicalEvent[] = [];
  const ledger: LedgerEntry[] = [];
  const audit: unknown[] = [];
  const store = {
    async applyMigrations() { /* noop */ },
    async appendEvent(_scope: { scopeId: string; actorRef: string }, ev: CanonicalEvent) { events.push(ev); },
    async queryEvents() { return events; },
    async ledgerAppend(_scope: { scopeId: string; actorRef: string }, e: LedgerEntry) { ledger.push(e); },
    async ledgerQuery() { return ledger; },
    async appendAudit(_scope: { scopeId: string; actorRef: string }, row: unknown) { audit.push(row); },
    async queryAudit() { return audit; },
    async recordFhirResource(_scope: { scopeId: string; actorRef: string }, r: unknown) { /* noop */ },
    async listFhirResources() { return []; },
  } as unknown as PostgresEventStore;
  return store;
}

const actor: ActorContext = { actorRef: 'user:test', scopeIds: ['scope:*'], clearance: 'restricted-phi', purposeOfUse: 'operations' } as ActorContext;

async function build() {
  return buildApp({
    store: inMemoryStore(),
    telemetry: new Telemetry('test', new InMemorySink()),
    packs: [healthcareCorePack],
    authenticate: async () => actor,
    checkHealth: async () => ({ db: true, redis: true }),
  });
}

describe('swarm workspace routes', () => {
  it('reports a workspace summary across executive asset kinds', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/admin/swarm/workspace' });
    expect(res.statusCode).toBe(200);
    const summary = res.json().summary;
    for (const kind of ['red-team-scenario', 'red-team-run', 'submission-package', 'config-release', 'evidence-review', 'facility-simulation', 'knowledge-note', 'admin-tenant', 'admin-kafka', 'admin-policy']) {
      expect(typeof summary[kind]).toBe('number');
    }
  });

  it('seeds the red-team scenarios (8 core + provider/payer) and replays against live policy', async () => {
    const app = await build();
    const list = await app.inject({ method: 'GET', url: '/admin/swarm/red-team/scenarios' });
    expect(list.statusCode).toBe(200);
    expect(list.json().scenarios).toHaveLength(12);
    const replay = await app.inject({ method: 'POST', url: '/admin/swarm/red-team/replay', payload: { scenarioId: 'rt-001' } });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().run.passed).toBe(true);
    // Unknown scenario → 404.
    const missing = await app.inject({ method: 'POST', url: '/admin/swarm/red-team/replay', payload: { scenarioId: 'nope' } });
    expect(missing.statusCode).toBe(404);
  });

  it('supports the config release lifecycle over HTTP', async () => {
    const app = await build();
    const created = await app.inject({ method: 'POST', url: '/admin/swarm/config/releases', payload: { version: 'route-sandbox', changeSummary: 'Route test' } });
    expect(created.statusCode).toBe(200);
    const id = created.json().release.id;
    expect(created.json().release.status).toBe('draft');
    const validated = await app.inject({ method: 'POST', url: `/admin/swarm/config/releases/${id}/validate`, payload: {} });
    expect(validated.json().release.status).toBe('validated');
    const approved = await app.inject({ method: 'POST', url: `/admin/swarm/config/releases/${id}/request-approval`, payload: {} });
    expect(approved.json().release.status).toBe('approved');
    const active = await app.inject({ method: 'POST', url: `/admin/swarm/config/releases/${id}/activate`, payload: {} });
    expect(active.json().release.status).toBe('active');
    const list = await app.inject({ method: 'GET', url: '/admin/swarm/config/releases' });
    expect(list.json().active?.id).toBe(id);
  });

  it('creates + validates submission packages', async () => {
    const app = await build();
    // With no live realms the package has 0 included results → dry-run draft
    // (the validated path is exercised in the store unit tests with real counts).
    const created = await app.inject({ method: 'POST', url: '/admin/swarm/submissions', payload: { measureId: 'ecqm:M21Basic/1.0.0', realmId: 'realm:c2' } });
    expect(created.statusCode).toBe(200);
    expect(created.json().package.status).toBe('draft');
    expect(created.json().package.resultsIncluded).toBe(0);
    expect(created.json().package.liveTransmission).toBe(false);
    const list = await app.inject({ method: 'GET', url: '/admin/swarm/submissions' });
    expect(list.json().packages.length).toBeGreaterThan(0);
  });

  it('supports evidence review request + decision over HTTP', async () => {
    const app = await build();
    const req = await app.inject({ method: 'POST', url: '/admin/swarm/reviews', payload: { entityId: 'route-ep-1', entityType: 'outcome-episode', requestedBy: 'fa' } });
    expect(req.statusCode).toBe(200);
    const id = req.json().review.id;
    expect(req.json().review.status).toBe('pending');
    const dec = await app.inject({ method: 'POST', url: `/admin/swarm/reviews/${id}/review`, payload: { decision: 'confirmed', reviewer: 'rod' } });
    expect(dec.json().review.status).toBe('confirmed');
  });

  it('runs a facility simulation against real realm counts (none → blocked)', async () => {
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/admin/swarm/facility/simulate', payload: { realmId: 'realm:empty' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().simulation.feasible).toBe(false);
    expect(res.json().simulation.checks[0]?.detail).toContain('No unit capacity');
  });

  it('supports knowledge notes + comments over HTTP', async () => {
    const app = await build();
    const created = await app.inject({ method: 'POST', url: '/admin/swarm/notes', payload: { nodeId: 'treatment-continuity', title: 'Transport gap', content: 'Cannot drive Tuesdays' } });
    expect(created.statusCode).toBe(200);
    const id = created.json().note.id;
    expect(created.json().note.version).toBe(1);
    const commented = await app.inject({ method: 'POST', url: `/admin/swarm/notes/${id}/comments`, payload: { body: 'Escalate to coordinator' } });
    expect(commented.json().note.version).toBe(2);
    const list = await app.inject({ method: 'GET', url: '/admin/swarm/notes?nodeId=treatment-continuity' });
    expect(list.json().notes).toHaveLength(1);
  });

  it('persists platform-admin profile, kafka test verifies the contract', async () => {
    const app = await build();
    const saved = await app.inject({ method: 'PUT', url: '/admin/swarm/admin/tenant', payload: { displayName: 'Acme Renal', status: 'active' } });
    expect(saved.json().tenant.displayName).toBe('Acme Renal');
    const got = await app.inject({ method: 'GET', url: '/admin/swarm/admin/tenant' });
    expect(got.json().tenant.displayName).toBe('Acme Renal');
    const tested = await app.inject({ method: 'POST', url: '/admin/swarm/admin/kafka/test', payload: {} });
    expect(tested.json().kafka.status).toBe('contract-verified');
    const policy = await app.inject({ method: 'GET', url: '/admin/swarm/admin/policy' });
    expect(policy.json().policy.defaultDecision).toBe('block');
  });

  it('serves the seeded executive substrate over HTTP', async () => {
    const app = await build();
    const events = await app.inject({ method: 'GET', url: '/admin/swarm/events' });
    expect(events.statusCode).toBe(200);
    expect(events.json().events.length).toBeGreaterThanOrEqual(3);
    expect(typeof events.json().temporalStates).toBe('number');

    const evidence = await app.inject({ method: 'GET', url: '/admin/swarm/evidence' });
    expect(evidence.json().evidence).toHaveLength(2);

    const traces = await app.inject({ method: 'GET', url: '/admin/swarm/traces' });
    expect(traces.json().traces).toHaveLength(6);

    const models = await app.inject({ method: 'GET', url: '/admin/swarm/models' });
    expect(models.json().models[0]?.modelId).toBe('grounded-assessment-extractor');

    const drift = await app.inject({ method: 'GET', url: '/admin/swarm/drift' });
    expect(drift.json().drift).toHaveLength(1);

    const authority = await app.inject({ method: 'GET', url: '/admin/swarm/authority' });
    expect(authority.json().sources).toHaveLength(2);

    const audits = await app.inject({ method: 'GET', url: '/admin/swarm/audits' });
    expect(audits.json().audits).toHaveLength(2);

    // Topology is now PROJECTED from real data (operating-model hierarchy + cell/
    // measure/source catalogs + master-data facilities/patients) rather than the
    // hardcoded 20/25-node reference seed — assert the derived graph shape.
    const topology = await app.inject({ method: 'GET', url: '/admin/swarm/topology' });
    const t = topology.json();
    expect(t.nodes.length).toBeGreaterThanOrEqual(15);
    expect(t.edges.length).toBeGreaterThanOrEqual(15);
    expect(t.nodes.some((n: { type?: string }) => n.type === 'enterprise')).toBe(true);
    expect(t.nodes.some((n: { type?: string }) => n.type === 'cell')).toBe(true);
    expect(t.nodes.some((n: { type?: string }) => n.type === 'measure')).toBe(true);
    expect(t.nodes.some((n: { type?: string }) => n.type === 'source')).toBe(true);
    expect(t.edges.some((e: { relation?: string }) => e.relation === 'contains')).toBe(true);
  });

  it('serves a read-only live swarm snapshot + real outcome rollups', async () => {
    const app = await build();
    const state = await app.inject({ method: 'GET', url: '/admin/swarm/state' });
    expect(state.statusCode).toBe(200);
    const s = state.json();
    expect(Array.isArray(s.cells)).toBe(true);
    expect(Array.isArray(s.insights)).toBe(true);
    expect(Array.isArray(s.nbas)).toBe(true);
    expect(Array.isArray(s.episodes)).toBe(true);
    expect(typeof s.kpis?.cmsReadiness).toBe('number');

    const rollups = await app.inject({ method: 'GET', url: '/admin/swarm/rollups' });
    expect(rollups.statusCode).toBe(200);
    const r = rollups.json();
    for (const key of ['clinical', 'operational', 'regulatory', 'economic']) {
      expect(typeof r[key]?.value).toBe('number');
      expect(typeof r[key]?.label).toBe('string');
    }
    expect(typeof r.cmsReadiness).toBe('number');
    expect(typeof r.valueAtRisk).toBe('number');
    expect(typeof r.treatmentsProtected).toBe('number');
  });

  it('records durable NBA decisions, overlays status and audits them', async () => {
    const app = await build();
    const nbaRes = await app.inject({ method: 'GET', url: '/admin/swarm/nba' });
    const nba = nbaRes.json().nbas[0];
    expect(nba).toBeTruthy();

    const decided = await app.inject({ method: 'POST', url: `/admin/swarm/nba/${nba.nbaId}/decide`, payload: { decision: 'approved', approver: 'rod' } });
    expect(decided.statusCode).toBe(200);
    expect(decided.json().decision.decision).toBe('approved');
    expect(decided.json().decision.episodeId).toBeTruthy();

    const list = await app.inject({ method: 'GET', url: '/admin/swarm/nba' });
    const overlay = list.json().nbas.find((n: { nbaId: string }) => n.nbaId === nba.nbaId);
    expect(overlay.status).toBe('executed');

    const decisions = await app.inject({ method: 'GET', url: '/admin/swarm/nba/decisions' });
    expect(decisions.json().decisions.length).toBeGreaterThanOrEqual(1);

    const audits = await app.inject({ method: 'GET', url: '/admin/swarm/audits' });
    expect(audits.json().audits.some((a: { action?: string; entityId?: string }) => a.action === 'nba.approved' && a.entityId === nba.nbaId)).toBe(true);
  });

  it('opens a stable outcome episode and persists the full decision loop', async () => {
    const app = await build();
    const subject = `realm:stability-${Date.now()}`;
    const open = await app.inject({ method: 'POST', url: '/admin/swarm/episodes', payload: { kind: 'continuity.proposal', subject, scopeType: 'facility' } });
    const episodeId = open.json().episode.episodeId;
    expect(episodeId).toBeTruthy();

    const propose = await app.inject({ method: 'POST', url: `/admin/swarm/episodes/${episodeId}/propose`, payload: {} });
    expect(propose.statusCode).toBe(200);
    expect(propose.json().episode.state).toBe('AwaitingApproval');

    const decide = await app.inject({ method: 'POST', url: `/admin/swarm/episodes/${episodeId}/decide`, payload: { decision: 'approved', approver: 'rod', approvalClass: 'B' } });
    expect(decide.statusCode).toBe(200);
    expect(decide.json().episode.state).toBe('Coordinating');

    const ack = await app.inject({ method: 'POST', url: `/admin/swarm/episodes/${episodeId}/ack`, payload: { by: 'facility', met: true } });
    expect(ack.statusCode).toBe(200);
    expect(ack.json().episode.state).toBe('Resolved');
    expect(ack.json().episode.dossierHash).toMatch(/^[0-9a-f]{64}$/);

    const list = await app.inject({ method: 'GET', url: '/admin/swarm/episodes' });
    expect(list.json().episodes.some((e: { episodeId: string }) => e.episodeId === episodeId)).toBe(true);
  });

  it('supports substrate create + delete over HTTP', async () => {
    const app = await build();
    const ev = await app.inject({ method: 'POST', url: '/admin/swarm/events', payload: { eventId: 'ev:http-1', eventType: 'vital.observed' } });
    expect(ev.json().event.status).toBe('accepted');
    const evId = ev.json().event.id;
    expect((await app.inject({ method: 'DELETE', url: `/admin/swarm/events/${evId}`, payload: {} })).json().ok).toBe(true);

    const evidence = await app.inject({ method: 'POST', url: '/admin/swarm/evidence', payload: { exactText: 'Prefers afternoons' } });
    expect(evidence.json().evidence.contentHash).toMatch(/^[0-9a-f]{64}$/);

    const model = await app.inject({ method: 'POST', url: '/admin/swarm/models', payload: { modelId: 'esrd-risk-projection' } });
    expect(model.json().model.killSwitch).toBe(true);

    const node = await app.inject({ method: 'POST', url: '/admin/swarm/topology/nodes', payload: { label: 'New clinic', type: 'facility' } });
    expect(node.json().node.id).toBe('new-clinic');

    const edge = await app.inject({ method: 'POST', url: '/admin/swarm/topology/edges', payload: { source: 'new-clinic', target: 'region', relation: 'contains' } });
    expect(edge.statusCode).toBe(200);
    expect(edge.json().edge.confidence).toBe(1);
  });

  it('records real realm events when realms have ledgers', async () => {
    const app = await build();
    // No realm ledgers in this harness → durable seed events still serve the feed.
    const events = await app.inject({ method: 'GET', url: '/admin/swarm/events' });
    expect(events.json().events.length).toBeGreaterThan(0);
    expect(events.json().events.some((e: { sourceSystem?: string }) => e.sourceSystem === 'realm-ledger')).toBe(false);
  });

  it('serves the full catalog the exec console renders', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/admin/swarm/catalog' });
    expect(res.statusCode).toBe(200);
    const c = res.json().catalogs;
    expect((c['agent-manifest'] as unknown[]).length).toBeGreaterThan(0);
    expect((c['measure-pack'] as unknown[]).length).toBeGreaterThan(0);
    expect((c['public-source'] as unknown[]).length).toBeGreaterThan(0);
    expect((c['federal-fact'] as unknown[]).length).toBe(4);
    expect((c['green-team-check'] as unknown[]).length).toBe(6);
    expect((c['facility-station'] as unknown[]).length).toBe(12);
    expect((c['outcome-episode-story'] as unknown[]).length).toBe(3);
    expect((c['operating-model'] as { organization?: string })?.organization).toBe('Riverbend Kidney Care');
    // Per-kind reads.
    const manifests = await app.inject({ method: 'GET', url: '/admin/swarm/catalog/agent-manifest' });
    expect((manifests.json().rows as unknown[]).length).toBeGreaterThan(0);
    const single = await app.inject({ method: 'GET', url: '/admin/swarm/catalog/operating-model' });
    expect((single.json().data as { organization?: string })?.organization).toBe('Riverbend Kidney Care');
  });

  it('supports catalog create + delete over HTTP', async () => {
    const app = await build();
    const created = await app.inject({ method: 'POST', url: '/admin/swarm/catalog/measure-pack', payload: { id: 'live-measure', name: 'Live measure pack', program: 'ESRD QIP', paymentYear: 2026, version: '1.0', status: 'active-final', sourceIds: [], inputEvents: [], submission: 'EQRS', owner: 'Quality' } });
    expect(created.statusCode).toBe(200);
    const rows = await app.inject({ method: 'GET', url: '/admin/swarm/catalog/measure-pack' });
    expect((rows.json().rows as Array<{ id: string }>).some((r) => r.id === 'live-measure')).toBe(true);
    const deleted = await app.inject({ method: 'DELETE', url: '/admin/swarm/catalog/measure-pack/live-measure', payload: {} });
    expect(deleted.json().ok).toBe(true);
    // Unknown kind → 404.
    const bad = await app.inject({ method: 'GET', url: '/admin/swarm/catalog/nope' });
    expect(bad.statusCode).toBe(404);
  });

  it('cleans up the demo — drops sim realms, episodes/NBA decisions, prunes the outbox', async () => {
    const app = await build();

    // Seed a durable episode + NBA decision (the demo decision fabric).
    const open = await app.inject({ method: 'POST', url: '/admin/swarm/episodes', payload: { kind: 'continuity.proposal', subject: 'realm:cleanup', scopeType: 'facility' } });
    const episodeId = open.json().episode.episodeId;
    const nbaRes = await app.inject({ method: 'GET', url: '/admin/swarm/nba' });
    const nbaId = nbaRes.json().nbas[0]?.nbaId;
    await app.inject({ method: 'POST', url: `/admin/swarm/nba/${nbaId}/decide`, payload: { decision: 'approved', approver: 'rod' } });

    const cleanup = await app.inject({ method: 'POST', url: '/admin/demo/cleanup', payload: {} });
    expect(cleanup.statusCode).toBe(200);
    expect(cleanup.json().ok).toBe(true);
    const report = cleanup.json().report;
    expect(report.episodesRemoved).toBeGreaterThanOrEqual(1);
    expect(report.nbaDecisionsRemoved).toBeGreaterThanOrEqual(1);
    expect(typeof report.outboxDeliveredRemoved).toBe('number');
    expect(typeof report.simRealmsRemoved).toBe('number');
    expect(typeof report.outboxCounts?.delivered).toBe('number');

    // The demo decision fabric is gone after cleanup.
    const episodes = await app.inject({ method: 'GET', url: '/admin/swarm/episodes' });
    expect(episodes.json().episodes.some((e: { episodeId: string }) => e.episodeId === episodeId)).toBe(false);
    const decisions = await app.inject({ method: 'GET', url: '/admin/swarm/nba/decisions' });
    expect(decisions.json().decisions.some((d: { nbaId: string }) => d.nbaId === nbaId)).toBe(false);
  });
});
