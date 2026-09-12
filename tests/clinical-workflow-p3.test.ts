/******************************************************************************
 * Clinician workflow, Phase 3 — the adoption layer.
 *
 * Phases 1 and 2 made the loop work and made it honest. Phase 3 is about whether
 * a clinician would actually live in it, which comes down to three things:
 *
 *   3.4  A refusal that is really a DATA GAP becomes an order, not a shrug. When
 *        the anemia guardrail blocks a dose because iron status is stale, the
 *        action offered must be the iron panel — a blocked dose with nothing
 *        attached is a dead end.
 *   3.5  "Not now" and "not mine" are first-class answers. A deferral must come
 *        back AT the stated time and not before; a handoff must reach the
 *        recipient's queue and name them as owner. Neither may silently vanish,
 *        and neither may be recorded as a dismissal — that would teach the
 *        ranking that a correct suggestion was wrong.
 *
 * The named properties are asserted here against the same code the routes call.
 ******************************************************************************/

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp, } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import { getSwarmWorkspace, resetSwarmRuntime } from '../src/server/swarm-routes.js';
import { RealmRegistry, populateFacility } from '../src/realm/index.js';
import { OutcomeEpisodeCoordinator } from '../src/swarm/outcome-episode.js';
import { dispatchApprovedEpisode } from '../src/swarm/command-dispatch.js';
import { anemiaFindings, clinicalNbaState, CLINICAL_ACTION_MAPS, esaTrajectory } from '../src/swarm/clinical-nba.js';
import { ANEMIA_CONSUMED_BY, ESA_CELLS, esaRecommend, type EsaPatientWindow } from '../src/swarm/anemia.js';
import { esaWhatIf } from '../src/swarm/anemia-forecast.js';
import { asRankedDecision, validateRankedDecision } from '../src/swarm/nba-decision.js';
import { decidesLater, deferralActive, type NbaDecision } from '../src/swarm/workspace.js';
import type { PostgresEventStore } from '../src/server/postgres-event-store.js';
import type { CanonicalEvent } from '../src/healthcare-core/events.js';
import type { LedgerEntry } from '../src/hypergraph/ledger.js';
import type { ActorContext } from '../src/server/scoped-persistence.js';

const NOW = '2026-09-01T00:00:00.000Z';
const PATIENT = 'p-esa-1';
/** The patient the populated sim facility actually contains — the dispatch test
 *  places an order against a real record, not a dangling id. */
const REAL_PATIENT = 'f1-pt-0001';

function inMemoryStore() {
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

/** The ESA window the anemia pack reasons over — iron panel age is the variable under test. */
const win = (over: Partial<EsaPatientWindow> = {}): EsaPatientWindow => ({
  patientId: PATIENT,
  currentHgb: 9.4,
  onESA: true,
  currentDose: 8000,
  hgbTrendLast90d: [9.2, 9.4],
  esaEscalationsLast90d: 0,
  ferritin: 420,
  transferrinSat: 28,
  lastIronPanelAt: '2026-08-01T00:00:00.000Z',
  asOf: NOW,
  ...over,
});

describe('3.1 — the approval carries the trajectory, not the number alone', () => {
  const anemiaState = (window: EsaPatientWindow) => {
    const whatIf = esaWhatIf(window);
    return clinicalNbaState({
      protocol: 'anemia',
      insightKind: 'anemia.esa.proposal',
      cells: ESA_CELLS,
      consumedBy: ANEMIA_CONSUMED_BY,
      actionMap: CLINICAL_ACTION_MAPS.anemia,
      findings: anemiaFindings([{ rec: esaRecommend(window), whatIf }]),
    });
  };

  it('the curve is present on the ranked action AND on the proposal being approved', () => {
    const s = anemiaState(win());
    const nba = s.nbas.find((n) => n.actionKind === 'titrate-med')!;
    expect(nba.trajectory, 'the ranked action must carry its own curve').toBeDefined();

    // The same series is on the proposal, which is what an episode is opened from.
    const proposal = s.proposals.find((p) => (p.payload as { order?: unknown }).order !== undefined)!;
    const trajectory = (proposal.payload as { trajectory?: { points: unknown[]; chosenIndex: number | null } }).trajectory;
    expect(trajectory).toBeDefined();
    expect(trajectory!.points.length).toBeGreaterThan(1);

    // The controller's choice is a real index into the series, so a console can
    // mark the recommended candidate without re-deriving it.
    expect(trajectory!.chosenIndex).toBeGreaterThanOrEqual(0);
    expect(trajectory!.chosenIndex).toBeLessThan(trajectory!.points.length);
  });

  it('the dose being approved is one of the rows in the curve', () => {
    const window = win();
    const s = anemiaState(window);
    const nba = s.nbas.find((n) => n.actionKind === 'titrate-med')!;
    const order = (s.proposals.find((p) => (p.payload as { order?: unknown }).order !== undefined)!.payload as {
      order: { payload: { dose?: string } };
    }).order;
    // The display is only truthful if the reader can locate the dose they are
    // approving on the curve — otherwise the chart is about a different decision.
    const doses = nba.trajectory!.points.map((p) => String(p.dose));
    expect(doses).toContain(order.payload.dose);
  });

  it('the curve needs no client-side recomputation: every field is already formatted', () => {
    const t = esaTrajectory(esaWhatIf(win()));
    expect(t.horizonWeeks).toBeGreaterThan(0);
    expect(t.targetBand).toEqual({ min: 10, max: 12 });
    for (const p of t.points) {
      expect(Number.isFinite(p.endHgb)).toBe(true);
      expect(Number.isFinite(p.pctInBand)).toBe(true);
      expect(p.weeksInBand).toBeGreaterThanOrEqual(0);
      expect(p.weeksInBand).toBeLessThanOrEqual(t.horizonWeeks);
      expect(typeof p.label).toBe('string');
      expect(p.label.length).toBeGreaterThan(0);
    }
    expect(t.note.length).toBeGreaterThan(0);
    expect(t.unavailableReason).toBeUndefined();
  });

  it('a blocked analysis carries the reason and NO fabricated points', () => {
    const s = anemiaState(win({ lastIronPanelAt: '2025-01-01T00:00:00.000Z' }));
    const nba = s.nbas[0]!;
    expect(nba.actionKind).toBe('order-lab');
    const t = nba.trajectory!;
    // The iron order is the action, but there is no dose curve to show — inventing a
    // flat line would put a fabricated Hb projection in front of a prescriber.
    expect(t.points).toEqual([]);
    expect(t.chosenIndex).toBeNull();
    expect(t.unavailableReason).toMatch(/iron/i);
  });
});

describe('3.4 — a refusal that is a data gap becomes an order', () => {
  it('a stale iron panel turns the ESA block into an iron-studies order', () => {
    const rec = esaRecommend(win({ lastIronPanelAt: '2025-01-01T00:00:00.000Z' }));
    expect(rec.direction).toBe('blocked');
    expect(rec.guardrails.flags).toContain('iron-not-checked-quarterly');

    const [finding] = anemiaFindings([{ rec, realmId: 'realm:x' }]);
    expect(finding!.action).toBe('order-iron-panel');
    // The ESA dose is still NOT drafted — a blocked titration places nothing. What
    // the pack places instead is the test that unblocks it.
    expect(finding!.order).toBeUndefined();
    // The recommendation carries the guardrail's own words, so the clinician reads
    // WHY the dose stopped rather than a bare refusal.
    expect(finding!.recommendation).toMatch(/iron/i);
  });

  it('the iron order is a real, allowlisted proposal that carries the patient', () => {
    const rec = esaRecommend(win({ lastIronPanelAt: '2025-01-01T00:00:00.000Z' }));
    const s = clinicalNbaState({
      protocol: 'anemia',
      insightKind: 'anemia.esa.proposal',
      cells: ESA_CELLS,
      consumedBy: ANEMIA_CONSUMED_BY,
      actionMap: CLINICAL_ACTION_MAPS.anemia,
      findings: anemiaFindings([{ rec, realmId: 'realm:x' }]),
    });

    // The owning cell permits the effect, so the ranker does not reject it.
    expect(s.diagnostics.rejected).toEqual([]);
    expect(s.unmapped).toEqual([]);
    expect(s.nbas).toHaveLength(1);
    const nba = s.nbas[0]!;
    expect(nba.actionKind).toBe('order-lab');
    expect(nba.cells).toEqual(['iron-management']);

    // The order rides on the proposal, with the patient injected by the bridge —
    // a lab order can never point at a patient other than the one it was raised for.
    const proposal = s.proposals[0]!;
    const order = (proposal.payload as { order?: { effect: string; payload: Record<string, unknown> } }).order;
    expect(order).toEqual({
      effect: 'order-lab',
      payload: { patientId: PATIENT, code: 'FERRITIN', priority: 'routine' },
    });
  });

  it('approving it really places the lab order in the patient record', async () => {
    const realmId = 'realm:p3-iron';
    RealmRegistry.create({ id: realmId, mode: 'sim' });
    const realm = RealmRegistry.get(realmId)!;
    populateFacility(realm, { facilityId: 'f1', kind: 'dialysis', name: 'P3 Dialysis', units: ['U1'], patientCount: 1 });
    realm.start();

    const rec = esaRecommend(win({ patientId: REAL_PATIENT, lastIronPanelAt: '2025-01-01T00:00:00.000Z' }));
    const s = clinicalNbaState({
      protocol: 'anemia',
      insightKind: 'anemia.esa.proposal',
      cells: ESA_CELLS,
      consumedBy: ANEMIA_CONSUMED_BY,
      actionMap: CLINICAL_ACTION_MAPS.anemia,
      findings: anemiaFindings([{ rec, realmId }]),
    });
    const proposal = s.proposals[0]!;

    // Walk the episode to exactly the state a clinician's approval leaves it in,
    // taking the order from the PROPOSAL (the pack states it once).
    const coordinator = new OutcomeEpisodeCoordinator();
    const episode = coordinator.getOrOpen({ kind: 'anemia.iron-response', subject: `patient:${REAL_PATIENT}`, scopeType: 'patient' });
    coordinator.addEvidence(episode.episodeId, [{ sourceId: `lab:ferritin:${REAL_PATIENT}`, contentType: 'fact' }], true);
    coordinator.propose(episode.episodeId, {
      proposalId: `prop-${episode.episodeId}`,
      cellId: 'iron-management',
      kind: 'anemia.iron-response',
      subject: `patient:${REAL_PATIENT}`,
      scopeType: 'patient',
      option: 'Order iron studies (ferritin + TSAT)',
      recommendation: proposal.recommendation,
      allowed: true,
      evidence: [{ sourceId: `lab:ferritin:${REAL_PATIENT}`, contentType: 'fact' }],
      producedAt: NOW,
      payload: proposal.payload,
    }, true);
    coordinator.requestApproval(episode.episodeId, 'B');
    coordinator.decide(episode.episodeId, 'approved', 'Dr. Alvarez (nephrology)', 'B');
    coordinator.dispatchCommand(episode.episodeId, 'order-lab', { realmId });

    const result = dispatchApprovedEpisode({ coordinator, episodeId: episode.episodeId, realmOf: (id) => RealmRegistry.get(id) });
    expect(result.effectKind).toBe('order-lab');
    expect(result.replayed).toBe(false);

    const orders = realm.graph.listKind('order');
    expect(orders).toHaveLength(1);
    expect(orders[0]!.state.code).toBe('FERRITIN');
    expect(orders[0]!.state.patientId).toBe(REAL_PATIENT);
    expect(orders[0]!.state.status).toBe('ordered');

    RealmRegistry.remove(realmId);
  });

  it('a microcytic block with a FRESH iron panel places nothing — the block was the point', () => {
    const rec = esaRecommend(win({ mcv: 74 }));
    expect(rec.direction).toBe('blocked');
    expect(rec.guardrails.flags).not.toContain('iron-not-checked-quarterly');
    const [finding] = anemiaFindings([{ rec }]);
    expect(finding!.action).toBe('blocked');
    expect(finding!.order).toBeUndefined();
    // `blocked` maps to null: the protocol deliberately has no action, which is
    // silence, not a coverage gap.
    const s = clinicalNbaState({
      protocol: 'anemia',
      insightKind: 'anemia.esa.proposal',
      cells: ESA_CELLS,
      consumedBy: ANEMIA_CONSUMED_BY,
      actionMap: CLINICAL_ACTION_MAPS.anemia,
      findings: [finding!],
    });
    expect(s.nbas).toEqual([]);
    expect(s.unmapped).toEqual([]);
  });
});

describe('3.5 — defer and hand off: the rules live in one place', () => {
  /** The minimum a stored decision carries — enough for the two queue predicates. */
  const dec = (over: Partial<NbaDecision>): NbaDecision => ({
    id: 'nba-dec-test', createdAt: NOW, updatedAt: NOW,
    nbaId: 'nba:x', title: 't', subject: 'patient:x', scopeType: 'patient',
    decision: 'approved', approver: 'md', evidenceCount: 1, expectedOutcome: 1,
    ...over,
  });
  it('refuses a deferral with no time, and a time that has passed', () => {
    expect(validateRankedDecision({ decision: 'deferred', approver: 'md' })).toMatchObject({ error: 'defer-until-required' });
    expect(validateRankedDecision({ decision: 'deferred', approver: 'md', deferUntil: 'not-a-date' })).toMatchObject({ error: 'defer-until-required' });
    expect(
      validateRankedDecision({ decision: 'deferred', approver: 'md', deferUntil: '2026-08-01T00:00:00.000Z', nowMs: Date.parse(NOW) }),
    ).toMatchObject({ error: 'defer-until-in-the-past' });
    expect(
      validateRankedDecision({ decision: 'deferred', approver: 'md', deferUntil: '2026-09-08T08:00:00.000Z', nowMs: Date.parse(NOW) }),
    ).toBeNull();
  });

  it('refuses a handoff to nobody, and an unexplained dismissal', () => {
    expect(validateRankedDecision({ decision: 'handed-off', approver: 'md' })).toMatchObject({ error: 'handed-to-required' });
    expect(validateRankedDecision({ decision: 'handed-off', approver: 'md', handedTo: '  ' })).toMatchObject({ error: 'handed-to-required' });
    expect(validateRankedDecision({ decision: 'dismissed', approver: 'md' })).toMatchObject({ error: 'reason-required' });
    // An approval needs nothing: it is not feedback, it is an act.
    expect(validateRankedDecision({ decision: 'approved', approver: 'md' })).toBeNull();
  });

  it('an unknown body value is never a silent deferral', () => {
    expect(asRankedDecision(undefined)).toBe('approved');
    expect(asRankedDecision('deferred')).toBe('deferred');
    // A typo must not become a dismissal either — only explicit names count.
    expect(asRankedDecision('snooze')).toBe('approved');
  });

  it('a deferral is live until its stated time and no longer', () => {
    const now = Date.parse(NOW);
    const decision = dec({ decision: 'deferred', deferUntil: '2026-09-02T00:00:00.000Z' });
    expect(decidesLater(decision.decision)).toBe(true);
    expect(deferralActive(decision, now)).toBe(true);
    // One millisecond before the stated time it is still hidden…
    expect(deferralActive(decision, Date.parse('2026-09-02T00:00:00.000Z') - 1)).toBe(true);
    // …and at the stated time it comes back.
    expect(deferralActive(decision, Date.parse('2026-09-02T00:00:00.000Z'))).toBe(false);
    // A handoff is never hidden: it is someone else's live work, not a snooze.
    const handoff = dec({ decision: 'handed-off', handedTo: 'Dr. Chen' });
    expect(deferralActive(handoff, now)).toBe(false);
    expect(decidesLater(handoff.decision)).toBe(true);
  });

  it('an unparseable deferral time never hides work', () => {
    // Fail open on a corrupt clock value: hiding an action forever is worse than
    // showing it once too early.
    expect(deferralActive(dec({ decision: 'deferred', deferUntil: 'soon' }), Date.parse(NOW))).toBe(false);
    expect(deferralActive(dec({ decision: 'deferred' }), Date.parse(NOW))).toBe(false);
  });
});

type App = Awaited<ReturnType<typeof build>>;
async function build() {
  return buildApp({
    store: inMemoryStore(),
    telemetry: new Telemetry('test', new InMemorySink()),
    packs: [healthcareCorePack],
    authenticate: async () => ({ actorRef: 'user:test', scopeIds: ['scope:*'], clearance: 'restricted-phi', purposeOfUse: 'operations' } as ActorContext),
    checkHealth: async () => ({ db: true, redis: true }),
    adminApiAuth: true,
  });
}

async function login(app: App, username: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { username, password } });
  const raw = Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'].join(';') : String(res.headers['set-cookie'] ?? '');
  const token = /hh_session=([^;]+)/.exec(raw)?.[1];
  if (!token) throw new Error(`no session cookie: ${res.statusCode} ${res.body}`);
  return token;
}
const cookie = (token: string) => `hh_session=${token}`;

let app: App;
let admin: string;
let nurse: string;

beforeAll(async () => {
  app = await build();
  admin = await login(app, 'admin', 'admin123');
  nurse = await login(app, 'nurse', 'nurse123');
  // Warm the workspace once: the queue is derived from real state, so the swarm
  // runtime has to exist before a decision can be recorded against it.
  await app.inject({ method: 'GET', url: '/admin/swarm/anemia/state', headers: { cookie: cookie(admin) } });
});

afterAll(async () => {
  await app?.close();
  resetSwarmRuntime();
});

interface QueueItem { id: string; kind: string; state: string; owner: string; console: string; title: string; summary: string }
async function queue(token: string): Promise<QueueItem[]> {
  const res = await app.inject({ method: 'GET', url: '/api/work', headers: { cookie: cookie(token) } });
  expect(res.statusCode).toBe(200);
  return (res.json() as { items: QueueItem[] }).items;
}

/** Write a decision the way the routes do, so the queue reads real state. */
async function record(input: Record<string, unknown>): Promise<void> {
  const ws = getSwarmWorkspace();
  if (!ws) throw new Error('no swarm workspace');
  await ws.recordNbaDecision({
    nbaId: 'nba:p3:test',
    title: 'Increase ESA dose · p-esa-1',
    subject: 'patient:p-esa-1',
    scopeType: 'patient',
    evidenceCount: 3,
    expectedOutcome: 2,
    approver: 'Dr. Alvarez (nephrology)',
    ...input,
  } as never);
}

describe('3.5 — a snoozed action reappears at the stated time, and not before', () => {
  it('a deferral is absent while it is in force and present once due', async () => {
    // Due tomorrow: hidden. The queue must not show work nobody asked to see yet.
    await record({ decision: 'deferred', deferUntil: new Date(Date.now() + 86_400_000).toISOString(), reason: 'after the iron panel returns' });
    let items = await queue(admin);
    expect(items.some((i) => i.id === 'action:nba:p3:test')).toBe(false);

    // …and shown, with its reason and time, once the moment arrives. The stored
    // time is what the queue obeys — not a timer held in a process.
    await record({ decision: 'deferred', deferUntil: new Date(Date.now() - 60_000).toISOString(), reason: 'after the iron panel returns' });
    items = await queue(admin);
    const item = items.find((i) => i.id === 'action:nba:p3:test');
    expect(item).toBeDefined();
    expect(item!.kind).toBe('action');
    expect(item!.state).toBe('deferred');
    expect(item!.console).toBe('exec');
    // The clinician is told WHY it came back, not just that it did.
    expect(item!.summary).toMatch(/iron panel returns/);
    expect(item!.owner).toBe('Dr. Alvarez (nephrology)');
  });

  it('a deferral that is due is decidable from My Work, through the same rules', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/work/action:nba:p3:test/actions',
      headers: { cookie: cookie(admin) },
      payload: { action: 'dismiss' },
    });
    // No reason: refused here exactly as the swarm route refuses it.
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('reason-required');
  });
});

describe('3.5 — a handed-off action reaches the recipient and leaves the giver', () => {
  it('names the recipient as owner and is visible in the decision console', async () => {
    await record({ decision: 'handed-off', handedTo: 'Dr. Chen (renal)', handedToConsole: 'exec' });
    const items = await queue(admin);
    const item = items.find((i) => i.id === 'action:nba:p3:test');
    expect(item).toBeDefined();
    expect(item!.state).toBe('handed-off');
    expect(item!.owner).toBe('Dr. Chen (renal)');
    expect(item!.console).toBe('exec');
    expect(item!.summary).toMatch(/Dr\. Chen/);
  });

  it('leaves the decision console for a role that cannot open it', async () => {
    // The giver's console is `exec` (clinical); a nurse works in `ops`. The item
    // must not appear in a queue whose role cannot act on it.
    const nurseItems = await queue(nurse);
    expect(nurseItems.some((i) => i.id === 'action:nba:p3:test')).toBe(false);
  });

  it('a handoff to a console that cannot approve stays visible rather than vanishing', async () => {
    // `ops` holds no `work.approve`, so work handed there would be unreachable —
    // it stays in the decision console with the recipient named. Losing an action
    // is a worse failure than showing it where it can still be acted on.
    await record({ decision: 'handed-off', handedTo: 'Duty pharmacist', handedToConsole: 'ops' });
    const items = await queue(admin);
    const item = items.find((i) => i.id === 'action:nba:p3:test');
    expect(item).toBeDefined();
    expect(item!.console).toBe('exec');
    expect(item!.owner).toBe('Duty pharmacist');
  });

  it('neither a deferral nor a handoff is ever recorded as a dismissal', async () => {
    const ws = getSwarmWorkspace()!;
    // Every row is kept; the CURRENT answer is the newest one, never a superseded
    // row. Reading the oldest would report a stale answer as current.
    const rows = await ws.list<NbaDecision>('nba-decision');
    const mine = rows.filter((d) => d.nbaId === 'nba:p3:test');
    expect(mine.length).toBeGreaterThan(0);
    for (const row of mine) expect(['deferred', 'handed-off']).toContain(row.decision);
    const current = (await ws.listNbaDecisions()).find((d) => d.nbaId === 'nba:p3:test')!;
    expect(current.decision).toBe('handed-off');
    expect(current.handedTo).toBe('Duty pharmacist');
  });

  it('the swarm route reports a deferral as a deferral, not a dismissal', async () => {
    const state = await app.inject({ method: 'GET', url: '/admin/swarm/nba', headers: { cookie: cookie(admin) } });
    expect(state.statusCode).toBe(200);
    const nbas = (state.json() as { nbas: Array<{ nbaId: string; status: string }> }).nbas;
    for (const nba of nbas.filter((n) => n.nbaId === 'nba:p3:test')) {
      expect(['deferred', 'handed-off']).toContain(nba.status);
      expect(nba.status).not.toBe('dismissed');
    }
  });
});
