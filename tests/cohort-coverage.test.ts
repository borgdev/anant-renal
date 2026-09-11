/******************************************************************************
 * Living cohorts — coverage, honest empty cohorts, and the cost of evaluating.
 *
 * Three defects are encoded here as tests, because all three were invisible in
 * the product:
 *
 *   1. `members: 0` was indistinguishable from "no data", so four of eight
 *      shipped cohorts sat at zero and read as "nobody is at risk" when in fact
 *      their inputs never arrived, or their criteria could not be met TOGETHER.
 *   2. One evaluation performed 465 full realm-ledger scans because the patient
 *      snapshot was re-taken as the argument to every lab-series lookup. It
 *      answered in 42s what it computed in 13ms.
 *   3. Every poll rewrote every membership row, so a refresh of the nurse's work
 *      queue cost one database round trip per (cohort × patient) whether or not
 *      anything had changed.
 *
 * The evaluation-cost test asserts on the COUNT OF SCANS, not on elapsed time —
 * a timing assertion would pass on a fast machine while the defect remained.
 ******************************************************************************/

import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import {
  analyseCohortDeclines, cohortCoverageOf, cohortStateOf, evaluatePatient, resolveMetric,
  COHORT_METRICS, SEED_COHORT_DEFINITIONS, SUPERSEDED_SEED_COHORTS, seedUpgradeFor,
  type CohortDefinition, type CohortEvaluation, type LabPoint,
} from '../src/swarm/cohort.js';
import { renalPatientFacts, type RenalPatientInput } from '../src/swarm/renal-cohort.js';
import { SwarmWorkspaceStore, type CohortMembershipInput } from '../src/swarm/workspace.js';

/* ---------- fixtures ---------- */

function patient(id: string, labs: Record<string, number> = {}, state: Record<string, unknown> = {}): RenalPatientInput {
  return {
    id,
    realmId: 'sim:coverage',
    medCodes: [],
    state: {
      facilityId: 'fac-a',
      age: 66,
      sex: 'F',
      trajectory: 'stable',
      dialysisVintageYears: 3.4,
      access: { type: 'avf', ageDays: 400 },
      sessions: [],
      labs: { HGB: 10.6, KTV: 1.35, URR: 70, PHOS: 4.4, POTASSIUM: 4.6, ...labs },
      ...state,
    },
  };
}

function cohort(over: Partial<CohortDefinition> = {}): CohortDefinition {
  return {
    id: 'coverage-cohort', label: 'Coverage cohort', kind: 'suggested', protocol: 'anemia',
    rationale: 'test',
    entry: [{ metric: 'hgb.current', comparator: 'lt', value: 11 }],
    exit: [{ metric: 'hgb.current', comparator: 'gte', value: 11 }],
    suggestedAction: 'review', approvalClass: 'C', mayNever: ['act'], guard: ['g'],
    minN: 2, criterionVersion: '1.0.0', owner: 'test', enabled: true,
    ...over,
  };
}

const ctx = { at: '2026-09-10T07:00:00Z' };

function evaluationsOf(def: CohortDefinition, patients: RenalPatientInput[]): CohortEvaluation[] {
  return patients.map((p) => evaluatePatient(def, renalPatientFacts(p), ctx));
}

/* ---------- 1. coverage: "0 members" is four different facts ---------- */

describe('cohort coverage explains an empty cohort', () => {
  it('reports members when the cohort admits someone', () => {
    const def = cohort();
    const coverage = cohortCoverageOf(def, evaluationsOf(def, [patient('p-1', { HGB: 9 }), patient('p-2', { HGB: 13 })]));
    expect(coverage.members).toBe(1);
    expect(coverage.diagnosis).toBe('members');
    expect(coverage.criteria[0]!.met).toBe(1);
    expect(coverage.criteria[0]!.notMet).toBe(1);
  });

  it('names a DATA GAP when nobody has the measurement, rather than reporting a clean cohort', () => {
    // PTH is absent from every patient, so an MBD criterion cannot resolve.
    const def = cohort({ entry: [{ metric: 'pth.current', comparator: 'gt', value: 300 }] });
    const coverage = cohortCoverageOf(def, evaluationsOf(def, [patient('p-1'), patient('p-2')]));
    expect(coverage.members).toBe(0);
    expect(coverage.diagnosis).toBe('data-gap');
    expect(coverage.dataBlocked).toEqual(['pth.current']);
    // The verdict must name the module that would have to supply the data — an
    // operator cannot act on "no members".
    expect(coverage.verdict).toContain('pth.current');
    expect(coverage.verdict).toContain('renal-cohort');
    expect(coverage.verdict).toContain('not evidence');
    // the diagnosis must never be expressed as a risk number
    expect(coverage.criteria[0]!.unresolved).toBe(2);
    expect(coverage.criteria[0]!.resolvedPct).toBe(0);
  });

  it('names a THRESHOLD problem when the measure resolves but nobody reaches it', () => {
    const def = cohort({ entry: [{ metric: 'hgb.current', comparator: 'lt', value: 5 }] });
    const coverage = cohortCoverageOf(def, evaluationsOf(def, [patient('p-1', { HGB: 10.6 }), patient('p-2', { HGB: 11.2 })]));
    expect(coverage.diagnosis).toBe('criteria-too-strict');
    expect(coverage.neverMet).toEqual(['hgb.current']);
    // the observed population is the evidence for calibrating the threshold
    expect(coverage.criteria[0]!.observedMin).toBe(10.6);
    expect(coverage.criteria[0]!.observedMax).toBe(11.2);
    expect(coverage.verdict).toContain('observed range 10.6–11.2');
  });

  it('names NO JOINT OVERLAP when each criterion is satisfiable but never together', () => {
    // This is the real shape of `inadequate-clearance`: an adequacy flag that
    // only fires for the patients who have no sessions, paired with a criterion
    // requiring a session. Nothing is missing and nothing is mis-thresholded —
    // the cohort is unsatisfiable as written, and calling it a coverage problem
    // would send an operator hunting for data that is not the issue.
    const def = cohort({
      entry: [
        { metric: 'sessions.count', comparator: 'gte', value: 1 },
        { metric: 'hgb.current', comparator: 'lt', value: 5 },
      ],
    });
    const withSessions = patient('p-1', { HGB: 10.6 }, { sessions: [{ id: 's-1', adherencePct: 100 }] });
    const lowHgb = patient('p-2', { HGB: 4.9 });
    const coverage = cohortCoverageOf(def, evaluationsOf(def, [withSessions, lowHgb]));
    expect(coverage.members).toBe(0);
    expect(coverage.diagnosis).toBe('no-joint-overlap');
    expect(coverage.dataBlocked).toEqual([]);
    expect(coverage.neverMet).toEqual([]);
    // the binding criterion is the one that admits the fewest patients
    expect(coverage.blockers).toEqual(['hgb.current']);
    expect(coverage.verdict).toContain('individually satisfiable');
    // and it must NOT claim the definition is broken: the counts cannot tell
    // "mutually exclusive" from "no such patient in this population"
    expect(coverage.verdict).toContain('no patient evaluated satisfies them together');
    expect(coverage.verdict).toContain('check both branches');
    expect(coverage.verdict).not.toContain('cannot admit anyone');
  });

  it('says so when nothing was evaluated at all', () => {
    const def = cohort();
    const coverage = cohortCoverageOf(def, []);
    expect(coverage.diagnosis).toBe('insufficient-coverage');
    expect(coverage.verdict).toContain('no patients were evaluated');
  });

  it('carries the coverage on the cohort state, so every route that reports state reports it too', () => {
    const def = cohort({ entry: [{ metric: 'pth.current', comparator: 'gt', value: 300 }] });
    const state = cohortStateOf(def, evaluationsOf(def, [patient('p-1'), patient('p-2')]), new Set());
    expect(state.coverage.diagnosis).toBe('data-gap');
    expect(state.coverage.evaluated).toBe(2);
  });

  it('every shipped cohort reports a diagnosis other than a bare zero', () => {
    const patients = [patient('p-1', { HGB: 9 }), patient('p-2', { HGB: 13 })];
    for (const seed of SEED_COHORT_DEFINITIONS) {
      const coverage = cohortCoverageOf(seed as CohortDefinition, evaluationsOf(seed as CohortDefinition, patients));
      expect(coverage.criteria.length, `${seed.id} has no entry criteria`).toBeGreaterThan(0);
      expect(coverage.verdict.length, `${seed.id} has no verdict`).toBeGreaterThan(20);
      if (coverage.members === 0) {
        expect(coverage.diagnosis).not.toBe('members');
        expect(coverage.blockers.length, `${seed.id} is empty but names no blocker`).toBeGreaterThan(0);
      }
    }
  });
});

/* ---------- 2. decline analysis: what a rejected suggestion is evidence of ---------- */

describe('decline analysis', () => {
  const def = cohort({ criterionVersion: '2.0.0', entry: [{ metric: 'hgb.current', comparator: 'lt', value: 11 }] });
  const decline = (reason: string, criterionVersion = '2.0.0') =>
    ({ cohortId: def.id, action: 'decline' as const, reason, criterionVersion });

  it('refuses to judge a cohort below the sample floor', () => {
    const a = analyseCohortDeclines(def, [decline('too broad')]);
    expect(a.declines).toBe(1);
    // one rejection is one person's opinion, not a cluster
    expect(a.clustered).toBe(false);
    expect(a.recommendation).toContain('Not enough human decisions');
  });

  it('reports a below-floor signal as an OBSERVATION with its sample size, without acting on it', () => {
    // Regression: requiring 3 declines before looking at the reasons at all made
    // 2-of-2 sharing one reason answer "spread across 1 reason(s)" — the
    // opposite of what the data said.
    const a = analyseCohortDeclines(def, [decline('criterion too broad for this unit'), decline('criterion too broad for this unit')]);
    expect(a.declines).toBe(2);
    expect(a.reasons).toEqual([{ reason: 'criterion too broad for this unit', count: 2 }]);
    expect(a.clustered).toBe(true);
    expect(a.recommendation).toContain('Not enough human decisions');
    // the signal is named, with its sample size, but NOT as a recommendation
    expect(a.recommendation).toContain('criterion too broad for this unit');
    expect(a.recommendation).toContain('2 of 2');
  });

  it('names the criterion once the sample is adequate', () => {
    const a = analyseCohortDeclines(def, [decline('criterion too broad for this unit'), decline('criterion too broad for this unit'), decline('criterion too broad for this unit')]);
    expect(a.clustered).toBe(true);
    expect(a.recommendation).toContain('3 of 3 declines');
    expect(a.recommendation).toContain('criterion too broad for this unit');
    expect(a.recommendation).toContain('hgb.current lt 11');
    // it must stay an instruction to a human, never an automatic edit
    expect(a.recommendation).toContain('bumping criterionVersion');
  });

  it('does not carry a verdict earned by an OLD criterion version forward', () => {
    const a = analyseCohortDeclines(def, [
      decline('stale reason a', '1.0.0'),
      decline('stale reason b', '1.0.0'),
      decline('stale reason c', '1.0.0'),
    ]);
    // three declines — but none of them against the version now in force
    expect(a.declines).toBe(0);
    expect(a.declineRate).toBeNull();
    // it must say there is nothing recorded FOR THIS VERSION, rather than
    // reusing the old verdict or pretending the history does not exist
    expect(a.recommendation).toContain('No decisions have been recorded against version 2.0.0');
    // and the history is still reported, marked stale
    expect(a.byVersion).toEqual([{ criterionVersion: '1.0.0', declines: 3, acceptances: 0, stale: true }]);
    expect(a.retireCandidate).toBe(false);
  });

  it('flags a retire candidate only when every decision was a decline', () => {
    const allDeclined = analyseCohortDeclines(def, [decline('a'), decline('b'), decline('c')]);
    expect(allDeclined.retireCandidate).toBe(true);
    expect(allDeclined.acceptances).toBe(0);
    const someAccepted = analyseCohortDeclines(def, [
      decline('a'), decline('b'), decline('c'),
      { cohortId: def.id, action: 'review', reason: 'accepted', criterionVersion: '2.0.0' },
    ]);
    expect(someAccepted.retireCandidate).toBe(false);
    expect(someAccepted.acceptances).toBe(1);
    expect(someAccepted.declineRate).toBe(75);
  });

  it('never proposes an edit it cannot justify, and never reports a rate with no decisions', () => {
    const none = analyseCohortDeclines(def, []);
    expect(none.declineRate).toBeNull();
    expect(none.reasons).toEqual([]);
    expect(none.clustered).toBe(false);
    expect(none.retireCandidate).toBe(false);
    // "nothing recorded" and "not enough recorded" are different facts, and an
    // operator acts differently on each
    expect(none.recommendation).toContain('No decisions have been recorded');
  });
});

/* ---------- 3. the cost of evaluating: one scan, and only changed rows written ---------- */

function membership(over: Partial<CohortMembershipInput> = {}): CohortMembershipInput {
  return {
    cohortId: 'c-1', patientId: 'p-1', realmId: 'sim:x', member: true,
    reason: 'hgb.current lt 11', confidence: 1, criterionVersion: '1.0.0',
    risk: 0.5, suggestedAction: 'review', protocol: 'anemia', unresolved: [],
    ...over,
  };
}

describe('membership recording writes only what changed', () => {
  it('writes every row once, then nothing on an identical re-evaluation', async () => {
    const store = new SwarmWorkspaceStore();
    const batch = [membership(), membership({ patientId: 'p-2', member: false }), membership({ patientId: 'p-3' })];
    const first = await store.recordCohortMemberships(batch);
    expect(first.written).toBe(3);
    expect(first.unchanged).toBe(0);

    // A polling work queue re-evaluates constantly. An unchanged row needs no
    // write: its recorded content is byte-identical, so rewriting it adds
    // latency and no information.
    const second = await store.recordCohortMemberships(batch);
    expect(second.written).toBe(0);
    expect(second.unchanged).toBe(3);
  });

  it('writes exactly the rows whose clinical content changed', async () => {
    const store = new SwarmWorkspaceStore();
    await store.recordCohortMemberships([membership(), membership({ patientId: 'p-2' })]);
    const second = await store.recordCohortMemberships([
      membership(),
      membership({ patientId: 'p-2', reason: 'potassium.current gte 5.5' }),
    ]);
    expect(second.written).toBe(1);
    expect(second.unchanged).toBe(1);
    const rows = await store.listCohortMemberships();
    expect(rows.find((r) => r.patientId === 'p-2')?.reason).toBe('potassium.current gte 5.5');
  });

  it('records entry and exit history once, not once per poll', async () => {
    const store = new SwarmWorkspaceStore();
    await store.recordCohortMemberships([membership({ member: true })]);
    await store.recordCohortMemberships([membership({ member: true })]);
    await store.recordCohortMemberships([membership({ member: false })]);
    await store.recordCohortMemberships([membership({ member: false })]);
    await store.recordCohortMemberships([membership({ member: true })]);

    const [row] = await store.listCohortMemberships();
    expect(row?.member).toBe(true);
    // entered → exited → entered, ONCE each. Repeated polling of an unchanged
    // row must not manufacture churn: the history is the explainability record.
    expect(row?.history.map((h) => h.event)).toEqual(['entered', 'exited', 'entered']);
    expect(row?.enteredAt).toBeTruthy();
  });

  it('keeps lastEvaluatedAt meaning "last evaluation that CHANGED this record"', async () => {
    let clock = 0;
    const store = new SwarmWorkspaceStore(undefined, () => new Date(Date.UTC(2026, 0, 1, 0, 0, clock += 1)).toISOString());
    await store.recordCohortMemberships([membership({ member: true })]);
    const firstSeen = (await store.listCohortMemberships())[0]!.lastEvaluatedAt;
    await store.recordCohortMemberships([membership({ member: true })]);
    const afterNoop = (await store.listCohortMemberships())[0]!.lastEvaluatedAt;
    expect(afterNoop).toBe(firstSeen);
    await store.recordCohortMemberships([membership({ member: false })]);
    const afterChange = (await store.listCohortMemberships())[0]!.lastEvaluatedAt;
    expect(afterChange).not.toBe(firstSeen);
  });

  it('still records a single membership through the singleton path', async () => {
    const store = new SwarmWorkspaceStore();
    const doc = await store.recordCohortMembership(membership());
    expect(doc.member).toBe(true);
    expect((await store.listCohortMemberships()).length).toBe(1);
  });
});

describe('a patient identifier is only unique within a realm', () => {
  // The reference fleet carries `f1-pt-0001` in BOTH `realm:b3` and `realm:c2`.
  // Keying membership on `cohortId::patientId` merged two different patients into
  // one explainability record: one facility's reason and history overwrote the
  // other's, and because the two rows then differed on every pass the record was
  // rewritten on every poll forever (8 rows of 464, indefinitely).
  const inRealm = (realmId: string, over: Partial<CohortMembershipInput> = {}) =>
    membership({ patientId: 'f1-pt-0001', realmId, reason: `reason from ${realmId}`, ...over });

  it('keeps two facilities\u2019 records for the same identifier apart', async () => {
    const store = new SwarmWorkspaceStore();
    await store.recordCohortMemberships([inRealm('realm:b3'), inRealm('realm:c2')]);
    const rows = await store.listCohortMemberships();
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.realmId).sort()).toEqual(['realm:b3', 'realm:c2']);
    expect(rows.map((r) => r.reason).sort()).toEqual(['reason from realm:b3', 'reason from realm:c2']);
    // the key must carry the realm, or the two records collide again
    expect(rows.every((r) => r.id === `c-1::${r.realmId}::f1-pt-0001`)).toBe(true);
  });

  it('settles: re-evaluating two realms stops rewriting anything', async () => {
    const store = new SwarmWorkspaceStore();
    const batch = [inRealm('realm:b3'), inRealm('realm:c2')];
    expect((await store.recordCohortMemberships(batch)).written).toBe(2);
    // Before the fix this reported 2 changed rows on EVERY pass, forever.
    expect((await store.recordCohortMemberships(batch)).written).toBe(0);
    expect((await store.recordCohortMemberships(batch)).written).toBe(0);
  });

  it('keeps a decline in one facility from suppressing another facility\u2019s suggestion', async () => {
    const store = new SwarmWorkspaceStore();
    await store.recordCohortDecision({
      cohortId: 'c-1', patientId: 'f1-pt-0001', realmId: 'realm:b3', action: 'decline',
      reason: 'criterion too broad for this unit', actor: 'nurse:a', criterionVersion: '1.0.0',
      suggestionReason: 'hgb.current lt 11', confidence: 1, risk: 0.5,
    });
    const { declinedSuppression } = await import('../src/server/cohort-routes.js');
    const suppressed = await declinedSuppression(store);
    expect(suppressed('c-1', 'realm:b3', 'f1-pt-0001', '1.0.0')).toBe('criterion too broad for this unit');
    expect(suppressed('c-1', 'realm:c2', 'f1-pt-0001', '1.0.0')).toBeNull();
    // and a version bump re-opens the question in the realm it was declined in
    expect(suppressed('c-1', 'realm:b3', 'f1-pt-0001', '1.1.0')).toBeNull();
  });

  it('retires rows written under the pre-realm-scoped key', async () => {
    const store = new SwarmWorkspaceStore();
    // a row as it existed before the fix: id without the realm segment
    await store.create('cohort-membership', 'c-1::f1-pt-0001', {
      cohortId: 'c-1', patientId: 'f1-pt-0001', realmId: 'realm:b3', member: true,
      reason: 'legacy', confidence: 1, criterionVersion: '1.0.0', risk: 0.5,
      suggestedAction: 'review', protocol: 'anemia', unresolved: [], history: [],
      lastEvaluatedAt: '2026-01-01T00:00:00Z',
    });
    await store.recordCohortMemberships([inRealm('realm:b3')]);
    const rows = await store.listCohortMemberships();
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe('c-1::realm:b3::f1-pt-0001');
  });
});

/* ---------- 4. the ledger scan happens once per evaluation ---------- */

describe('one evaluation takes one patient snapshot', () => {
  it('does not re-scan the ledger once per lab-series lookup', async () => {
    // The defect: `series` was built as
    //   (pid, code) => cachedLedgerSeries(patients())(pid, code)
    // so `patients()` — a scan of every realm ledger — ran as the argument to
    // EVERY lookup. 58 patients × 8 cohorts produced 465 scans for a 13ms
    // answer, and the endpoint took 42s. The count is asserted rather than the
    // elapsed time: a timing assertion passes on a fast machine while the
    // defect is still there.
    let scans = 0;
    const patients = () => {
      scans += 1;
      return [patient('p-1', { HGB: 9 }), patient('p-2', { HGB: 13 })];
    };

    const app = await buildApp({
      store: {
        async applyMigrations() { /* noop */ },
        async appendEvent() { /* noop */ },
        async queryEvents() { return []; },
        async ledgerAppend() { /* noop */ },
        async ledgerQuery() { return []; },
        async appendAudit() { /* noop */ },
        async queryAudit() { return []; },
        async recordFhirResource() { /* noop */ },
        async listFhirResources() { return []; },
      } as never,
      telemetry: new Telemetry('test', new InMemorySink()),
      packs: [healthcareCorePack],
      authenticate: async () => ({
        actorRef: 'user:test', scopeIds: ['scope:*'], clearance: 'restricted-phi',
        purposeOfUse: 'operations',
      }) as never,
      checkHealth: async () => ({ db: true, redis: true }),
      adminApiAuth: true,
      renalPatients: patients,
    });
    const login = await app.inject({
      method: 'POST', url: '/auth/login', payload: { username: 'admin', password: 'admin123' },
    });
    const raw = Array.isArray(login.headers['set-cookie'])
      ? login.headers['set-cookie'].join(';') : String(login.headers['set-cookie'] ?? '');
    const cookie = `hh_session=${/hh_session=([^;]+)/.exec(raw)?.[1]}`;

    scans = 0;
    const res = await app.inject({
      method: 'POST', url: '/admin/cohorts/evaluate',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { persist: false },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { cohorts: Array<{ evaluated: number }> };
    expect(body.cohorts.length).toBeGreaterThan(4);
    for (const c of body.cohorts) expect(c.evaluated).toBe(2);
    // ONE snapshot for the whole evaluation, whatever the criteria count.
    expect(scans).toBe(1);
    await app.close();
  }, 60_000);
});

/* ---------- 5. recalibrated seeds ---------- */

function seriesOf(points: Array<[number, number]>): readonly LabPoint[] {
  // [daysAgo, value]
  const base = Date.parse('2026-09-10T07:00:00Z');
  return points.map(([daysAgo, value]) => ({ at: new Date(base - daysAgo * 86_400_000).toISOString(), value }));
}

describe('shipped cohort criteria are reachable', () => {
  // Four shipped cohorts could not admit anybody: a threshold above the metric's
  // own ceiling, two mutually exclusive criteria, and a precondition that excluded
  // every patient the cohort existed to find. All four sat at zero members and read
  // as "nobody is at risk". These tests assert reachability, not shape.
  const seedOf = (id: string): CohortDefinition => {
    const seed = SEED_COHORT_DEFINITIONS.find((s) => s.id === id);
    expect(seed, `no shipped cohort '${id}'`).toBeDefined();
    return seed as CohortDefinition;
  };
  const evaluate = (id: string, facts: ReturnType<typeof renalPatientFacts>, ctx: { at: string; series?: () => readonly LabPoint[] }) =>
    evaluatePatient(seedOf(id), facts, { ...ctx, ...(ctx.series ? { series: ctx.series } : {}) });

  /** A dialysis session in the shape `renal-cohort` actually reads. */
  const session = (over: Record<string, unknown> = {}) => ({
    sessionId: 's-1', deliveredMinutes: 240, prescribedMinutes: 240, ufVolumeL: 3, ...over,
  });

  it('idh-next-session admits a patient in the fluid advisor\u2019s top tier', () => {
    // the OLD criterion asked for an IDH probability >= 0.6, above the metric's own
    // ceiling, so this cohort could never fire whatever the patient looked like
    const tiered = renalPatientFacts(patient('p-1', {}, { sessions: [session({ nadirSbp: 84 })] }));
    expect(evaluate('idh-next-session', tiered, { at: '2026-09-10T07:00:00Z' }).state).toBe('member');
  });

  it('hgb-deviation-4w admits a falling trajectory and clears it when it flattens', () => {
    // slope ~-0.09/wk with a forecast near 10.4: reachable, where -0.15/<10 was not
    const falling = seriesOf([[21, 11.4], [14, 11.0], [7, 10.6], [0, 10.3]]);
    const admitted = evaluate('hgb-deviation-4w', renalPatientFacts(patient('p-1', { HGB: 10.3 }, { labs: { HGB: 10.3 } })), { at: '2026-09-10T07:00:00Z', series: () => falling });
    expect(admitted.state).toBe('member');
    // and the EXIT must fire for a patient the entry admits, or the cohort can only
    // grow — the anti-rot invariant the whole layer rests on
    const flat = seriesOf([[21, 10.3], [14, 10.3], [7, 10.3], [0, 10.3]]);
    const cleared = evaluate('hgb-deviation-4w', renalPatientFacts(patient('p-1', { HGB: 10.3 }, { labs: { HGB: 10.3 } })), { at: '2026-09-10T07:00:00Z', series: () => flat });
    expect(cleared.exit.some((c) => c.outcome === 'met')).toBe(true);
  });

  it('inadequate-clearance is decided by MEASURED clearance, not by a starved advisor', () => {
    // the OLD entry paired `protocol.severity.adequacy >= 0.5` (which rises only
    // when the advisor has NO data) with `sessions.count >= 1` — mutually exclusive
    const belowFloor = renalPatientFacts(patient('p-1', { URR: 55 }, { sessions: [session()] }));
    expect(evaluate('inadequate-clearance', belowFloor, { at: '2026-09-10T07:00:00Z' }).state).toBe('member');
    // and the observed fleet profile — measured URR above the pack floor — is a
    // decidable "nobody qualifies", NOT an unresolved coverage gap
    const adequate = renalPatientFacts(patient('p-2', { URR: 72 }, { sessions: [session()] }));
    const ev = evaluate('inadequate-clearance', adequate, { at: '2026-09-10T07:00:00Z' });
    expect(ev.state).toBe('not-member');
    const coverage = cohortCoverageOf(seedOf('inadequate-clearance'), [ev]);
    expect(coverage.diagnosis).toBe('criteria-too-strict');
    expect(coverage.neverMet).toContain('urr.current');
  });

  it('reports an unmeasurable branch as coverage, not as the reason, in ANY mode', () => {
    // In `any` mode a missing measurement cannot admit anybody, so it is a coverage
    // fact rather than the explanation for the zero. Reporting it as the headline
    // would send an operator after data when the real answer is "the measure exists
    // and nobody crosses the threshold". In `all` mode the same criterion DOES
    // block, and there the headline is the gap.
    const def: CohortDefinition = {
      id: 'any-mode', label: 'any mode', kind: 'monitoring', protocol: 'cross', rationale: 'test',
      entryMode: 'any',
      entry: [
        { metric: 'urr.current', comparator: 'lt', value: 60 },
        { metric: 'pth.current', comparator: 'gt', value: 300 },
      ],
      exit: [{ metric: 'urr.current', comparator: 'gte', value: 65 }],
      suggestedAction: 'review', approvalClass: 'C', mayNever: ['act'], guard: ['g'],
      minN: 2, criterionVersion: '1.0.0', owner: 'test', enabled: true,
    };
    // PTH is absent from every patient, URR resolves and is adequate everywhere
    const evaluations = evaluationsOf(def, [patient('p-1', { URR: 72 }), patient('p-2', { URR: 74 })]);
    const coverage = cohortCoverageOf(def, evaluations);
    expect(coverage.diagnosis).toBe('criteria-too-strict');
    expect(coverage.dataBlocked).toEqual(['pth.current']);
    expect(coverage.verdict).toContain('urr.current');
    expect(coverage.verdict).toContain('could not be resolved at all');
    expect(coverage.verdict).toContain("cannot admit anyone");

    // the same criteria in ALL mode: the gap is the headline, because there the
    // missing measurement is what blocks membership
    const allMode = cohortCoverageOf({ ...def, entryMode: 'all' }, evaluationsOf({ ...def, entryMode: 'all' }, [patient('p-1', { URR: 72 })]));
    expect(allMode.diagnosis).toBe('data-gap');
    expect(allMode.verdict).toContain('pth.current');
    expect(allMode.verdict).toContain('not evidence that nobody is at risk');
  });

  it('access-deterioration admits the patients the pack flags, including un-surveilled ones', () => {
    // the OLD entry required >= 3 access observations, which excluded exactly the
    // under-surveilled patients the cohort exists to find
    const recirculating = renalPatientFacts(patient('p-1', {}, {
      access: { type: 'avf', ageDays: 400, observations: [] },
      sessions: [{ id: 's-1', adherencePct: 95, recirculationPct: 14 }],
    }));
    const ev = evaluate('access-deterioration', recirculating, { at: '2026-09-10T07:00:00Z' });
    expect(ev.state).toBe('member');
    expect(ev.entry[0]!.observed).toBe(0.6);
  });

  it('every shipped cohort\u2019s exit can clear its own entry direction', () => {
    // A cohort whose exit can never fire for a patient its entry admits is an inbox
    // with a clinical label.
    for (const seed of SEED_COHORT_DEFINITIONS) {
      const numeric = (cs: readonly { metric: string; comparator: string; value?: number | string | boolean }[]) =>
        cs.filter((c) => typeof c.value === 'number');
      for (const entry of numeric(seed.entry)) {
        const exit = numeric(seed.exit).find((c) => c.metric === entry.metric);
        if (!exit) continue;
        const entryValue = entry.value as number;
        const exitValue = exit.value as number;
        const opening = entry.comparator === 'gte' || entry.comparator === 'gt';
        const closing = exit.comparator === 'lte' || exit.comparator === 'lt';
        if (opening) {
          expect(closing, `${seed.id}: '${entry.metric}' opens upward but its exit also opens upward`).toBe(true);
          expect(exitValue, `${seed.id}: exit ${exitValue} must be reachable below entry ${entryValue}`).toBeLessThanOrEqual(entryValue);
        }
      }
    }
  });
});

describe('an authorable threshold must be able to discriminate', () => {
  // The root cause of one dead cohort: `idh.nextSessionProbability` was resolved
  // with a single systolic reading and nothing else, which collapses the advisor's
  // prior to `0.055 * (110 - sbp)` — a near-constant 0.029-0.04 across a whole
  // 58-patient fleet. An operator could author a threshold on it and the cohort
  // would never fire, silently.
  const idh = (age: number, nadirSbp: number, idwgKg: number): number => {
    // IDWG needs a weight pair across two sessions; a single session supplies none
    const sessions = idwgKg > 0
      ? [
        { sessionId: 's-1', deliveredMinutes: 240, prescribedMinutes: 240, ufVolumeL: 3, postWeightKg: 68 },
        { sessionId: 's-2', deliveredMinutes: 240, prescribedMinutes: 240, ufVolumeL: 3, nadirSbp, preWeightKg: 68 + idwgKg },
      ]
      : [{ sessionId: 's-1', deliveredMinutes: 240, prescribedMinutes: 240, ufVolumeL: 3, nadirSbp }];
    const p = patient('p-1', {}, { age, sessions });
    return resolveMetric('idh.nextSessionProbability', renalPatientFacts(p), ctx, new Map()) as number;
  };

  it('the IDH prior responds to the inputs the advisor actually uses', () => {
    const base = idh(55, 118, 0);
    expect(idh(55, 84, 0)).toBeGreaterThan(base);      // a prior low nadir
    expect(idh(55, 118, 5.4)).toBeGreaterThan(base);   // heavy interdialytic gain
    expect(idh(84, 118, 0)).toBeGreaterThan(base);     // age
    // and it must span a real RANGE, not just differ in the fourth decimal: a
    // metric that cannot discriminate is a threshold an operator can author and
    // never see fire
    expect(idh(84, 84, 5.4)).toBeGreaterThan(base * 2);
  });

  it('states in the vocabulary that the UF-rate term is unavailable', () => {
    // the residual limitation must be visible to whoever authors the next threshold
    const spec = COHORT_METRICS.find((m) => m.id === 'idh.nextSessionProbability');
    expect(spec?.source).toContain('no body weight');
    expect(spec?.source).toContain('ceiling');
  });
});

/* ---------- 6. upgrading a superseded shipped definition ---------- */

describe('superseded shipped definitions are upgraded, but never over an edit', () => {
  const current = (id: string): CohortDefinition => SEED_COHORT_DEFINITIONS.find((s) => s.id === id) as CohortDefinition;
  const oldOf = (id: string): CohortDefinition => SUPERSEDED_SEED_COHORTS.find((s) => s.definition.id === id)!.definition;
  const asShipped = (id: string): CohortDefinition => {
    const o = oldOf(id);
    // reproduce what the old seed wrote: `entryMode` was absent entirely, so the
    // spread must not inherit the current seed's 'any'
    const { entryMode: _currentMode, ...rest } = current(id);
    return {
      ...rest,
      entry: o.entry,
      exit: o.exit,
      criterionVersion: o.criterionVersion,
      minN: o.minN,
      ...(o.entryMode ? { entryMode: o.entryMode } : {}),
    };
  };

  it('every superseded cohort is matched to a current seed with a bumped version', () => {
    for (const old of SUPERSEDED_SEED_COHORTS) {
      const seed = SEED_COHORT_DEFINITIONS.find((s) => s.id === old.definition.id);
      expect(seed, `${old.definition.id} has no current seed`).toBeDefined();
      expect(seed!.criterionVersion).not.toBe(old.definition.criterionVersion);
      expect(old.reason.length).toBeGreaterThan(40);
    }
  });

  it('upgrades a stored definition that is still exactly what we shipped', () => {
    for (const old of SUPERSEDED_SEED_COHORTS) {
      const upgrade = seedUpgradeFor(asShipped(old.definition.id));
      expect(upgrade, `${old.definition.id} was not upgraded`).toBeDefined();
      expect(upgrade!.definition.criterionVersion).toBe(current(old.definition.id).criterionVersion);
      expect(upgrade!.reason).toBe(old.reason);
    }
  });

  it('leaves an operator\u2019s edit alone', () => {
    // an operator who changed a threshold keeps their cohort: the upgrade only
    // recognises the clinical logic we shipped, byte for byte
    expect(seedUpgradeFor({ ...asShipped('hgb-deviation-4w'), entry: [{ metric: 'hgb.slopePerWeek', comparator: 'lte', value: -0.11 }] })).toBeUndefined();
    // and one who only reordered the criteria keeps it too
    expect(seedUpgradeFor({ ...asShipped('hgb-deviation-4w'), entry: [...asShipped('hgb-deviation-4w').entry].reverse() })).toBeUndefined();
    // and a disabled cohort is still the shipped logic, so it upgrades
    expect(seedUpgradeFor({ ...asShipped('access-deterioration'), enabled: false })).toBeDefined();
  });

  it('is idempotent — an already-current definition is not upgraded again', () => {
    for (const seed of SEED_COHORT_DEFINITIONS) {
      expect(seedUpgradeFor(seed as CohortDefinition), `${seed.id} re-upgraded`).toBeUndefined();
    }
  });

  it('ignores the reviewer-facing note when recognising what was shipped', () => {
    // a note cannot change who is admitted, and Postgres JSONB does not preserve
    // key order, so notes must not decide whether an upgrade applies
    const withNotes: CohortDefinition = {
      ...asShipped('access-deterioration'),
      entry: asShipped('access-deterioration').entry.map((c) => ({ ...c, note: 'a note added later' })),
    };
    expect(seedUpgradeFor(withNotes)).toBeDefined();
  });
});
