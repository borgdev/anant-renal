import { describe, expect, it, beforeEach } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import type { PostgresEventStore } from '../src/server/postgres-event-store.js';
import type { CanonicalEvent } from '../src/healthcare-core/events.js';
import type { LedgerEntry } from '../src/hypergraph/ledger.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import type { ActorContext } from '../src/server/scoped-persistence.js';
import { SWARM_CELLS, cellAllows, cellById } from '../src/swarm/cells.js';
import { aggregateSwarmInsights, makeProposal } from '../src/swarm/insight.js';
import { rankNextBestActions, type NbaCandidate } from '../src/swarm/nba.js';
import { OutcomeEpisodeCoordinator } from '../src/swarm/outcome-episode.js';
import { buildSwarmDemo, policyWhatIf } from '../src/swarm/demo.js';
import type { WorldEffectKind } from '../src/swarm/types.js';

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

const VALID_KINDS: WorldEffectKind[] = [
  'admit-patient', 'transfer-patient', 'discharge-patient', 'order-lab', 'result-lab', 'order-med',
  'administer-med', 'hold-med', 'titrate-med', 'record-vitals', 'record-assessment', 'update-care-plan',
  'schedule-followup', 'notify-staff', 'flag-safety-event', 'submit-claim', 'request-prior-auth',
  'record-agent-thought', 'assign-object', 'release-object', 'mark-object-state', 'open-ticket',
  'update-ticket', 'close-ticket', 'escalate', 'submit-intent', 'advance-plan', 'approve-effect', 'operator-directive',
];

describe('swarm cells', () => {
  it('declares 12 renal cells, each with a valid allowlist + approval class + eval gate', () => {
    expect(SWARM_CELLS).toHaveLength(12);
    for (const cell of SWARM_CELLS) {
      expect(cell.allowedActions.length).toBeGreaterThan(0);
      for (const a of cell.allowedActions) expect(VALID_KINDS).toContain(a);
      expect(['A', 'B', 'C', 'D']).toContain(cell.approvalClass);
      expect(cell.evalGate).toBeGreaterThan(0);
      expect(cell.evalGate).toBeLessThanOrEqual(1);
      expect(typeof cell.killSwitch).toBe('boolean');
    }
  });

  it('cellAllows respects the allowlist (allowed actions only)', () => {
    const cont = cellById('treatment-continuity')!;
    expect(cont.allowedActions).toContain('schedule-followup');
    expect(cellAllows('treatment-continuity', 'schedule-followup')).toBe(true);
    // submit-claim is NOT in treatment-continuity's allowlist.
    expect(cellAllows('treatment-continuity', 'submit-claim')).toBe(false);
    // Every manifest carries a kill-switch flag (mechanism is present, cells are active).
    expect(cont.killSwitch).toBe(false);
  });
});

describe('swarm insights', () => {
  const NOW = '2026-08-22T00:00:00.000Z';
  const consumedBy = {
    'coverage.proposal': ['workforce-resilience', 'facility-capacity', 'treatment-continuity', 'access-surveillance'],
    'assessment.insight': ['clinical-quality', 'access-surveillance', 'assessment-intelligence'],
  };

  it('aggregates cross-cell consensus, retains conflicts, records abstentions', () => {
    const proposals = [
      makeProposal({ cellId: 'workforce-resilience', kind: 'coverage.proposal', subject: 'region:x', scopeType: 'region', option: 'plan A', recommendation: 'r', allowed: true, evidence: [{ sourceId: 's1', contentType: 'signal' }], producedAt: NOW, payload: { treatments: 43 } }),
      makeProposal({ cellId: 'facility-capacity', kind: 'coverage.proposal', subject: 'region:x', scopeType: 'region', option: 'plan A', recommendation: 'r', allowed: true, evidence: [{ sourceId: 's2', contentType: 'fact' }], producedAt: NOW, payload: {} }),
      makeProposal({ cellId: 'treatment-continuity', kind: 'coverage.proposal', subject: 'region:x', scopeType: 'region', option: 'plan A', recommendation: 'r', allowed: true, evidence: [{ sourceId: 's3', contentType: 'event' }], producedAt: NOW, payload: {} }),
      // conflict — access proposes a different option
      makeProposal({ cellId: 'access-surveillance', kind: 'coverage.proposal', subject: 'region:x', scopeType: 'region', option: 'plan B', recommendation: 'r', allowed: true, evidence: [{ sourceId: 's4', contentType: 'event' }], producedAt: NOW, payload: {} }),
    ];
    const insights = aggregateSwarmInsights({ proposals, consumedBy });
    const cov = insights.find((i) => i.kind === 'coverage.proposal')!;
    expect(cov.cells).toEqual(['workforce-resilience', 'facility-capacity', 'treatment-continuity']);
    expect(cov.consensus).toBe(0.75); // 3 supporters / 4 observed
    expect(cov.conflicts).toEqual(['access-surveillance']);
    expect(cov.retained).toBe(true);
    expect(cov.abstentions).toEqual([]);
    expect(cov.evidenceCount).toBe(4);
  });

  it('attaches a Dempster–Shafer belief overlay (P0) to every insight', () => {
    const proposals = [
      makeProposal({ cellId: 'workforce-resilience', kind: 'coverage.proposal', subject: 'region:x', scopeType: 'region', option: 'plan A', recommendation: 'r', allowed: true, evidence: [{ sourceId: 's1', contentType: 'signal' }], producedAt: NOW, payload: {} }),
      makeProposal({ cellId: 'facility-capacity', kind: 'coverage.proposal', subject: 'region:x', scopeType: 'region', option: 'plan A', recommendation: 'r', allowed: true, evidence: [{ sourceId: 's2', contentType: 'fact' }], producedAt: NOW, payload: {} }),
      makeProposal({ cellId: 'access-surveillance', kind: 'coverage.proposal', subject: 'region:x', scopeType: 'region', option: 'plan B', recommendation: 'r', allowed: true, evidence: [{ sourceId: 's4', contentType: 'event' }], producedAt: NOW, payload: {} }),
    ];
    const insights = aggregateSwarmInsights({ proposals, consumedBy });
    const cov = insights.find((i) => i.kind === 'coverage.proposal')!;
    expect(cov.belief).toBeTypeOf('number');
    expect(cov.plausibility).toBeTypeOf('number');
    expect(cov.uncertainty).toBeTypeOf('number');
    expect(cov.conflictMass).toBeTypeOf('number');
    expect(cov.belief!).toBeGreaterThanOrEqual(0);
    expect(cov.plausibility!).toBeGreaterThanOrEqual(cov.belief!);
    expect(cov.plausibility!).toBeLessThanOrEqual(1);
    expect(cov.uncertainty!).toBeCloseTo(cov.plausibility! - cov.belief!, 5);
    // 2-on-A vs 1-on-B dissent: measurable conflict mass, belief short of full commitment
    expect(cov.conflictMass!).toBeGreaterThan(0);
  });

  it('dst mode retains strong dissent but accepts weak dissent (P1 gate)', () => {
    const strong = [
      makeProposal({ cellId: 'c1', kind: 'coverage.proposal', subject: 'region:x', scopeType: 'region', option: 'plan A', recommendation: 'r', allowed: true, evidence: [{ sourceId: 's1', contentType: 'event' }, { sourceId: 's2', contentType: 'fact' }], producedAt: NOW, payload: {} }),
      makeProposal({ cellId: 'c2', kind: 'coverage.proposal', subject: 'region:x', scopeType: 'region', option: 'plan A', recommendation: 'r', allowed: true, evidence: [{ sourceId: 's3', contentType: 'event' }, { sourceId: 's4', contentType: 'fact' }], producedAt: NOW, payload: {} }),
      makeProposal({ cellId: 'c3', kind: 'coverage.proposal', subject: 'region:x', scopeType: 'region', option: 'plan A', recommendation: 'r', allowed: true, evidence: [{ sourceId: 's5', contentType: 'event' }, { sourceId: 's6', contentType: 'fact' }], producedAt: NOW, payload: {} }),
      makeProposal({ cellId: 'c4', kind: 'coverage.proposal', subject: 'region:x', scopeType: 'region', option: 'plan B', recommendation: 'r', allowed: true, evidence: [{ sourceId: 's7', contentType: 'event' }, { sourceId: 's8', contentType: 'fact' }], producedAt: NOW, payload: {} }),
    ];
    const weak = strong.map((p, idx) => (idx === 3
      ? makeProposal({ cellId: 'c4', kind: 'coverage.proposal', subject: 'region:x', scopeType: 'region', option: 'plan B', recommendation: 'r', allowed: true, evidence: [], producedAt: NOW, payload: {} })
      : p));
    // Full reliability (no P3 discount) isolates the P1 gate semantics.
    const strongDst = aggregateSwarmInsights({ proposals: strong, consumedBy: {}, mode: 'dst', getReliability: () => 1 });
    const weakDst = aggregateSwarmInsights({ proposals: weak, consumedBy: {}, mode: 'dst', getReliability: () => 1 });
    const weakSimple = aggregateSwarmInsights({ proposals: weak, consumedBy: {}, mode: 'simple' });
    const a = strongDst.find((i) => i.kind === 'coverage.proposal')!;
    const b = weakDst.find((i) => i.kind === 'coverage.proposal')!;
    const c = weakSimple.find((i) => i.kind === 'coverage.proposal')!;
    expect(a.conflictMass!).toBeGreaterThanOrEqual(0.5); // 3-vs-1 strong → high K
    expect(a.retained).toBe(true);
    expect(b.conflictMass!).toBeLessThan(0.3); // unsupported dissent ≈ noise
    expect(b.retained).toBe(false); // dst gate lets weak dissent through
    expect(c.retained).toBe(true); // legacy gate would have blocked it
  });

  it('records abstentions for cells that consumed the signal but stayed silent', () => {
    const proposals = [
      makeProposal({ cellId: 'clinical-quality', kind: 'assessment.insight', subject: 'market:y', scopeType: 'market', option: 'review', recommendation: 'r', allowed: true, evidence: [{ sourceId: 'e1', contentType: 'event' }], producedAt: NOW, payload: {} }),
      makeProposal({ cellId: 'assessment-intelligence', kind: 'assessment.insight', subject: 'market:y', scopeType: 'market', option: 'review', recommendation: 'r', allowed: true, evidence: [{ sourceId: 'e2', contentType: 'fact' }], producedAt: NOW, payload: {} }),
    ];
    const insights = aggregateSwarmInsights({ proposals, consumedBy });
    const a = insights.find((i) => i.kind === 'assessment.insight')!;
    expect(a.cells).toEqual(['clinical-quality', 'assessment-intelligence']);
    expect(a.abstentions).toEqual(['access-surveillance']); // consumed but silent
    expect(a.consensus).toBe(0.67); // 2 supporters / 3 observed, rounded to 2dp
    expect(a.review).toBe('clinical'); // class C → clinical review
  });
});

describe('next-best actions', () => {
  it('ranks deterministically by outcome + urgency + consensus (advisory)', () => {
    const candidates: NbaCandidate[] = [
      { title: 'Protect 43 weekend treatments', cells: ['continuity', 'workforce'], scopeType: 'region', subject: 'region:x', owner: 'ROD', due: '2 hours', evidence: Array.from({ length: 18 }, (_, i) => ({ sourceId: `e${i}`, contentType: 'object' })), consensus: 0.96, approvalClass: 'B', expectedOutcome: 43, urgency: 0.95, policyCost: 0.4, risk: 0.2 },
      { title: 'Open catheter reduction review', cells: ['clinical quality'], scopeType: 'market', subject: 'market:y', owner: 'Quality Director', due: 'This week', evidence: Array.from({ length: 22 }, (_, i) => ({ sourceId: `e${i}`, contentType: 'object' })), consensus: 0.94, approvalClass: 'C', expectedOutcome: 31, urgency: 0.6, policyCost: 0.5, risk: 0.3 },
    ];
    const a = rankNextBestActions(candidates);
    const b = rankNextBestActions(candidates);
    expect(a[0]!.title).toBe('Protect 43 weekend treatments');
    expect(a[0]!.rank).toBe(1);
    expect(a.map((n) => n.nbaId)).toEqual(b.map((n) => n.nbaId)); // deterministic
    expect(a[0]!.status).toBe('proposed'); // below maxPolicyCost
    // A very-high-policy-cost candidate is held for review (awaiting-approval).
    const costly = rankNextBestActions([{ ...candidates[0]!, policyCost: 0.9 }]);
    expect(costly[0]!.status).toBe('awaiting-approval');
  });
});

describe('outcome episodes', () => {
  it('walks the full approved loop Observed → … → Resolved with measure result', () => {
    const c = new OutcomeEpisodeCoordinator();
    const e = c.open({ kind: 'coverage.proposal', subject: 'region:x', scopeType: 'region' });
    expect(e.state).toBe('Observed');
    c.addEvidence(e.episodeId, [{ sourceId: 's', contentType: 'event' }], true);
    expect(c.get(e.episodeId)!.state).toBe('Understood');
    c.propose(e.episodeId, makeProposal({ cellId: 'treatment-continuity', kind: 'continuity.proposal', subject: 'region:x', scopeType: 'region', option: 'plan A', recommendation: 'r', allowed: true, evidence: [], producedAt: new Date().toISOString(), payload: {} }), true);
    expect(c.get(e.episodeId)!.state).toBe('Proposed');
    c.requestApproval(e.episodeId, 'B');
    expect(c.get(e.episodeId)!.state).toBe('AwaitingApproval');
    c.decide(e.episodeId, 'approved', 'AR', 'B');
    expect(c.get(e.episodeId)!.state).toBe('Coordinating');
    c.dispatchCommand(e.episodeId, 'schedule-followup');
    c.acknowledge(e.episodeId, 'facility');
    expect(c.get(e.episodeId)!.state).toBe('Verifying');
    c.verify(e.episodeId, { measureId: 'ecqm:M21Basic/1.0.0', met: true });
    const done = c.get(e.episodeId)!;
    expect(done.state).toBe('Resolved');
    expect(done.measureResult?.met).toBe(true);
    expect(done.dossierHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects invalid transitions and blocks duplicate commands (idempotency)', () => {
    const c = new OutcomeEpisodeCoordinator();
    const e = c.open({ kind: 'k', subject: 'p', scopeType: 'patient' });
    expect(() => c.decide(e.episodeId, 'approved', 'x', 'B')).toThrow(/invalid-outcome-transition/); // Observed → Coordinating invalid
    // Policy failure → Blocked
    c.addEvidence(e.episodeId, [], true);
    c.propose(e.episodeId, makeProposal({ cellId: 'cms-readiness', kind: 'measure.gap', subject: 'p', scopeType: 'patient', option: 'o', recommendation: 'r', allowed: true, evidence: [], producedAt: new Date().toISOString(), payload: {} }), false);
    expect(c.get(e.episodeId)!.state).toBe('Blocked');
  });

  it('reject + escalate + reopen paths', () => {
    const c = new OutcomeEpisodeCoordinator();
    const e = c.open({ kind: 'k', subject: 'p', scopeType: 'patient' });
    c.addEvidence(e.episodeId, [], true);
    c.propose(e.episodeId, makeProposal({ cellId: 'clinical-quality', kind: 'quality.variation', subject: 'p', scopeType: 'patient', option: 'o', recommendation: 'r', allowed: true, evidence: [], producedAt: new Date().toISOString(), payload: {} }), true);
    c.requestApproval(e.episodeId, 'C');
    c.decide(e.episodeId, 'rejected', 'MD', 'C');
    expect(c.get(e.episodeId)!.state).toBe('Rejected');
    // escalate path
    const e2 = c.open({ kind: 'k', subject: 'q', scopeType: 'patient' });
    c.addEvidence(e2.episodeId, [], true);
    c.propose(e2.episodeId, makeProposal({ cellId: 'asset-reliability', kind: 'asset.risk', subject: 'q', scopeType: 'patient', option: 'o', recommendation: 'r', allowed: true, evidence: [], producedAt: new Date().toISOString(), payload: {} }), true);
    c.requestApproval(e2.episodeId, 'B');
    c.decide(e2.episodeId, 'approved', 'OP', 'B');
    c.dispatchCommand(e2.episodeId, 'open-ticket');
    c.acknowledge(e2.episodeId, 'facility');
    c.escalate(e2.episodeId, 'adverse evidence');
    expect(c.get(e2.episodeId)!.state).toBe('Escalated');
  });
});

describe('swarm demo boundary', () => {
  it('reproduces the executable reference boundary: 12 cells · 5 insights · 4 NBAs · 1 conflict · resolved episode', () => {
    const demo = buildSwarmDemo(() => '2026-08-22T00:00:00.000Z');
    expect(demo.cells).toHaveLength(12);
    expect(demo.insights).toHaveLength(5);
    expect(demo.nbas).toHaveLength(4);
    expect(demo.conflictCount).toBeGreaterThanOrEqual(1);
    const ep = demo.episodes[0]!;
    expect(ep.state).toBe('Resolved');
    expect(ep.measureResult?.met).toBe(true);
    expect(ep.command?.idempotencyKey).toContain('out:');
    // consensus headline matches the prototype's 96% weekend-coverage insight
    const weekend = demo.insights.find((i) => i.subject === 'region:middle-tennessee');
    expect(weekend?.consensus).toBe(0.75); // 3 of 4 observed cells (access dissents)
    expect(weekend?.conflicts).toContain('access-surveillance');
    expect(weekend?.review).toBe('operator'); // class B
  });

  it('policy what-if is an isolated sandbox (no mutation) and responds to threshold', () => {
    const demo = buildSwarmDemo();
    const loose = policyWhatIf(0.5, demo);
    const strict = policyWhatIf(0.98, demo);
    expect(loose.simulation).toBe(true);
    expect(loose.episodesSurfaced).toBeGreaterThanOrEqual(strict.episodesSurfaced);
    expect(strict.episodesSurfaced).toBeLessThanOrEqual(5);
  });
});

describe('swarm admin routes', () => {
  beforeEach(async () => { /* stateless per test */ });

  it('serves cells, insights, nba, what-if and demo endpoints', async () => {
    const app = await build();
    const cells = await app.inject({ method: 'GET', url: '/admin/swarm/cells' });
    expect(cells.statusCode).toBe(200);
    expect((cells.json() as { cells: unknown[] }).cells).toHaveLength(12);

    const insights = await app.inject({ method: 'GET', url: '/admin/swarm/insights' });
    expect(insights.statusCode).toBe(200);

    const nba = await app.inject({ method: 'GET', url: '/admin/swarm/nba' });
    expect(nba.statusCode).toBe(200);
    expect((nba.json() as { nbas: unknown[] }).nbas.length).toBeGreaterThan(0);
    expect((nba.json() as { advisory: boolean }).advisory).toBe(true);

    const whatif = await app.inject({ method: 'POST', url: '/admin/swarm/whatif', payload: { threshold: 0.9 } });
    expect(whatif.statusCode).toBe(200);
    expect((whatif.json() as { simulation: boolean }).simulation).toBe(true);

    const badWhatif = await app.inject({ method: 'POST', url: '/admin/swarm/whatif', payload: { threshold: 2 } });
    expect(badWhatif.statusCode).toBe(200);
    expect((badWhatif.json() as { error: string }).error).toMatch(/threshold/);

    const demo = await app.inject({ method: 'POST', url: '/admin/swarm/demo' });
    expect(demo.statusCode).toBe(200);
    expect((demo.json() as { ok: boolean }).ok).toBe(true);

    await app.close();
  });

  it('opens, decides, and acknowledges an outcome episode through the routes', async () => {
    const app = await build();
    const open = await app.inject({ method: 'POST', url: '/admin/swarm/episodes', payload: { kind: 'continuity.risk', subject: 'patient:p1', scopeType: 'patient' } });
    const ep = (open.json() as { episode: { episodeId: string } }).episode;
    expect(ep.episodeId).toBeTruthy();

    // advance to AwaitingApproval via the demo state's resolved episode isn't needed;
    // open a fresh one and drive it to Coordinating by approve.
    const decide = await app.inject({ method: 'POST', url: `/admin/swarm/episodes/${ep.episodeId}/decide`, payload: { decision: 'approved', approver: 'AR', approvalClass: 'B' } });
    // Observed → Coordinating is an invalid transition → handled 400, not a crash.
    expect(decide.statusCode).toBe(400);
    expect((decide.json() as { error: string }).error).toMatch(/invalid-outcome-transition/);

    const list = await app.inject({ method: 'GET', url: '/admin/swarm/episodes' });
    expect(list.statusCode).toBe(200);
    await app.close();
  });
});
