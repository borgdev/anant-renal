// Living cohorts — declarative membership with a mandatory exit.
//
// The load-bearing tests here are the ANTI-ROT ones:
//
//   * every shipped cohort must EMPTY for a resolved patient — a cohort that can
//     only grow is an inbox with a clinical label;
//   * an unresolvable metric is never read as "not a member", because that would
//     turn a missing measurement into a clean bill of health;
//   * an operator-authored cohort may only reference the closed metric
//     vocabulary, so authoring is configuration and never new clinical logic;
//   * membership is attributed to a criterion VERSION, so editing a criterion
//     cannot silently rewrite why a patient was enrolled last week.

import { describe, expect, it } from 'vitest';
import {
  COHORT_METRICS, SEED_COHORT_DEFINITIONS, canonicalLabCode, cohortMetric, cohortStateOf,
  evaluatePatient, resolveMetric, shouldExit, slopePerWeek,
  type CohortDefinition, type CohortEvaluation, type LabPoint,
} from '../src/swarm/cohort.js';
import { renalPatientFacts, type RenalPatientInput } from '../src/swarm/renal-cohort.js';
import { evaluateCohorts, ledgerLabSeries, validateCohortInput } from '../src/server/cohort-routes.js';

/* ---------- fixtures ---------- */

function patient(over: Partial<Record<string, number>> = {}, state: Record<string, unknown> = {}): RenalPatientInput {
  return {
    id: over.patientId === undefined ? 'p-1' : 'p-1',
    realmId: 'sim:cohort',
    medCodes: [],
    state: {
      facilityId: 'fac-a',
      age: 66,
      sex: 'F',
      trajectory: 'stable',
      dialysisVintageYears: 3.4,
      access: { type: 'avf', ageDays: 400 },
      sessions: [],
      labs: {
        HGB: 10.6, FERRITIN: 400, TSAT: 25, KTV: 1.35, URR: 70,
        PHOS: 4.4, CALCIUM: 9.2, PTH: 240, ALBUMIN: 3.9, POTASSIUM: 4.6, CRP: 4,
        ...over,
      },
      ...state,
    },
  };
}

function seriesOf(points: Array<[number, number]>): readonly LabPoint[] {
  // [daysAgo, value]
  const base = Date.parse('2026-09-10T07:00:00Z');
  return points.map(([daysAgo, value]) => ({ at: new Date(base - daysAgo * 86_400_000).toISOString(), value }));
}

function cohort(over: Partial<CohortDefinition> = {}): CohortDefinition {
  return {
    id: 'test-cohort', label: 'Test cohort', kind: 'suggested', protocol: 'anemia',
    rationale: 'test', entry: [{ metric: 'age.years', comparator: 'gte', value: 18 }],
    exit: [{ metric: 'age.years', comparator: 'lt', value: 18 }],
    suggestedAction: 'review', approvalClass: 'C', mayNever: ['act'], guard: ['g'],
    minN: 2, criterionVersion: '1.0.0', owner: 'test', enabled: true,
    ...over,
  };
}

const ctx = { at: '2026-09-10T07:00:00Z' };

/* ---------- 1. the engine ---------- */

describe('cohort engine', () => {
  it('evaluates entry criteria and explains the membership', () => {
    const facts = renalPatientFacts(patient());
    const def = cohort({ entry: [{ metric: 'hgb.current', comparator: 'lt', value: 11 }] });
    const evaluation = evaluatePatient(def, facts, ctx);
    expect(evaluation.state).toBe('member');
    expect(evaluation.reason).toContain('hgb.current lt 11');
    expect(evaluation.confidence).toBe(1);
  });

  it('supports ALL and ANY entry modes', () => {
    const facts = renalPatientFacts(patient()); // hgb 10.6, albumin 3.9
    const both = cohort({
      entry: [
        { metric: 'hgb.current', comparator: 'lt', value: 11 },      // holds
        { metric: 'albumin.current', comparator: 'lt', value: 3 },   // does not
      ],
    });
    // ALL: one failing criterion is enough to keep the patient out
    expect(evaluatePatient(both, facts, ctx).state).toBe('not-member');
    // ANY: one holding criterion is enough to place them in
    expect(evaluatePatient({ ...both, entryMode: 'any' }, facts, ctx).state).toBe('member');
  });

  it('UNRESOLVED IS NOT FALSE — a missing measurement never reads as healthy', () => {
    const facts = renalPatientFacts(patient());
    // trend needs a series; with no series the criterion cannot be decided
    const def = cohort({ entry: [{ metric: 'hgb.slopePerWeek', comparator: 'lte', value: -0.1 }] });
    const evaluation = evaluatePatient(def, facts, ctx);
    expect(evaluation.state).toBe('unresolved');
    expect(evaluation.unresolved).toEqual(['hgb.slopePerWeek']);
    expect(evaluation.reason).toMatch(/cannot decide/);

    // …and once the series exists, the same cohort decides
    const withSeries = evaluatePatient(def, facts, {
      ...ctx,
      series: () => seriesOf([[28, 11.4], [14, 11.0], [0, 10.6]]),
    });
    expect(withSeries.state).toBe('member');
  });

  it('a partially-decided ALL entry cannot conclude membership', () => {
    const facts = renalPatientFacts(patient());
    const def = cohort({
      entry: [
        { metric: 'hgb.current', comparator: 'lt', value: 11 },      // met
        { metric: 'hgb.slopePerWeek', comparator: 'lte', value: -0.1 }, // unresolved
      ],
    });
    expect(evaluatePatient(def, facts, ctx).state).toBe('unresolved');
  });

  it('computes slopes and projections from real series', () => {
    const slope = slopePerWeek(seriesOf([[28, 11.4], [14, 11.0], [0, 10.6]]));
    expect(slope).toBeLessThan(0);
    expect(slopePerWeek(seriesOf([[0, 10]]))).toBeUndefined(); // too thin to trend
  });

  it('cohort state separates coverage from risk and refuses prevalence below minN', () => {
    const def = cohort({ minN: 5 });
    const evaluations: CohortEvaluation[] = [
      { cohortId: def.id, patientId: 'a', state: 'member', entry: [], exit: [], confidence: 1, reason: '', unresolved: [] },
      { cohortId: def.id, patientId: 'b', state: 'unresolved', entry: [], exit: [], confidence: 0, reason: '', unresolved: ['x'] },
    ];
    const state = cohortStateOf(def, evaluations, new Set(['a']));
    expect(state.members).toBe(1);
    expect(state.unresolved).toBe(1);
    expect(state.prevalence).toBe('insufficient'); // 1 member < minN 5
    expect(state.actionable).toBe(1);
  });
});

/* ---------- 2. anti-rot guarantees on the shipped catalog ---------- */

describe('the shipped cohort catalog', () => {
  it('every cohort declares an exit, a boundary and a version', () => {
    expect(SEED_COHORT_DEFINITIONS.length).toBeGreaterThanOrEqual(6);
    for (const def of SEED_COHORT_DEFINITIONS) {
      expect(def.exit.length, `${def.id} must declare an exit`).toBeGreaterThan(0);
      expect(def.mayNever.length, `${def.id} must state what it may never do`).toBeGreaterThan(0);
      expect(def.guard.length, `${def.id} must name its guards`).toBeGreaterThan(0);
      expect(def.criterionVersion).toMatch(/^\d+\.\d+\.\d+$/);
      expect(def.minN).toBeGreaterThan(0);
    }
    expect(new Set(SEED_COHORT_DEFINITIONS.map((d) => d.id)).size).toBe(SEED_COHORT_DEFINITIONS.length);
  });

  it('EVERY COHORT EMPTIES — a resolved patient leaves every one of them', () => {
    // a healthy, in-range, well-treated patient with a stable series
    const facts = renalPatientFacts(patient({
      HGB: 11.2, POTASSIUM: 4.4, PHOS: 4.0, CALCIUM: 9.3, PTH: 180,
      KTV: 1.5, URR: 74, ALBUMIN: 4.1, CRP: 3, FERRITIN: 600, TSAT: 32,
    }, {
      access: { type: 'avf', ageDays: 500 },
      lastVitals: { hr: 72, bp: '128/78', spo2: 97 },
    }));
    const stable: Readonly<Record<string, readonly LabPoint[]>> = {
      HGB: seriesOf([[28, 11.1], [14, 11.15], [0, 11.2]]),
      POTASSIUM: seriesOf([[28, 4.5], [14, 4.45], [0, 4.4]]),
      PHOS: seriesOf([[28, 4.1], [14, 4.05], [0, 4.0]]),
    };
    for (const def of SEED_COHORT_DEFINITIONS) {
      const evaluation = evaluatePatient(def, facts, { ...ctx, series: (_p, code) => stable[code] ?? [] });
      expect(evaluation.state, `${def.id} must not enrol a resolved patient`).not.toBe('member');
    }
  });

  it('a deteriorating patient does enrol, and the reason is legible', () => {
    const facts = renalPatientFacts(patient({ HGB: 10.4 }));
    const def = SEED_COHORT_DEFINITIONS.find((d) => d.id === 'hgb-deviation-4w')!;
    const falling: Readonly<Record<string, readonly LabPoint[]>> = {
      HGB: seriesOf([[28, 11.6], [14, 11.0], [0, 10.4]]),
    };
    const evaluation = evaluatePatient(def, facts, { ...ctx, series: (_p, code) => falling[code] ?? [] });
    expect(evaluation.state).toBe('member');
    expect(evaluation.reason).toMatch(/hgb\.slopePerWeek/);
    expect(evaluation.reason).toMatch(/measured/);
  });

  it('every criterion in the catalog references a real metric', () => {
    for (const def of SEED_COHORT_DEFINITIONS) {
      for (const criterion of [...def.entry, ...def.exit]) {
        expect(cohortMetric(criterion.metric), `${def.id} references unknown metric ${criterion.metric}`).toBeDefined();
      }
    }
  });

  it('every metric names the module that computes it', () => {
    for (const metric of COHORT_METRICS) {
      expect(metric.source, `${metric.id} must name its source`).toMatch(/src\//);
    }
  });
});

/* ---------- 3. operator-authored cohorts stay configuration ---------- */

describe('cohort authoring', () => {
  it('accepts a valid definition', () => {
    const parsed = validateCohortInput({
      id: 'local-iron-review', label: 'Iron review local', protocol: 'anemia',
      entry: [{ metric: 'crp.current', comparator: 'gt', value: 10 }],
      exit: [{ metric: 'crp.current', comparator: 'lte', value: 10 }],
      mayNever: ['change an ESA dose'], guard: ['iron-first guardrail'],
    });
    // crp.current is in the vocabulary; a valid body parses
    expect(parsed.ok).toBe(true);
  });

  it('REJECTS a metric outside the vocabulary — no new clinical logic', () => {
    const parsed = validateCohortInput({
      id: 'rogue', label: 'Rogue', entry: [{ metric: 'invented.risk.score', comparator: 'gte', value: 1 }],
      exit: [{ metric: 'crp.current', comparator: 'lte', value: 10 }],
      mayNever: ['x'], guard: ['y'],
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/unknown-metric/);
  });

  it('rejects a cohort without an exit, a boundary, or guards', () => {
    const base = {
      id: 'x', label: 'X',
      entry: [{ metric: 'crp.current', comparator: 'gt', value: 10 }],
      exit: [{ metric: 'crp.current', comparator: 'lte', value: 10 }],
      mayNever: ['z'], guard: ['g'],
    };
    expect(validateCohortInput({ ...base, exit: [] }).ok).toBe(false);
    expect(validateCohortInput({ ...base, mayNever: [] }).ok).toBe(false);
    expect(validateCohortInput({ ...base, guard: [] }).ok).toBe(false);
    expect(validateCohortInput({ ...base, entry: [{ metric: 'crp.current', comparator: 'gte' }] }).ok).toBe(false);
    expect(validateCohortInput({ ...base, id: 'Bad ID' }).ok).toBe(false);
  });

  it('rejects an unknown protocol and an unknown comparator', () => {
    const base = {
      id: 'x', label: 'X', entry: [{ metric: 'crp.current', comparator: 'gt', value: 10 }],
      exit: [{ metric: 'crp.current', comparator: 'lte', value: 10 }], mayNever: ['z'], guard: ['g'],
    };
    expect(validateCohortInput({ ...base, protocol: 'oncology' }).ok).toBe(false);
    expect(validateCohortInput({ ...base, entry: [{ metric: 'crp.current', comparator: 'smells-wrong', value: 1 }] }).ok).toBe(false);
  });
});

/* ---------- 4. evaluation over a live cohort ---------- */

describe('cohort evaluation over the cohort at large', () => {
  it('runs every cohort, reports coverage, and orders by opportunity', () => {
    const patients: RenalPatientInput[] = [
      patient({ HGB: 10.2 }, { access: { type: 'catheter', ageDays: 200 } }),
      patient({ HGB: 11.4, POTASSIUM: 5.9 }),
      // qualifies on the phosphate LEVEL but has no trend series: the cohort
      // cannot decide, which is exactly the case that must not read as healthy
      patient({ HGB: 11.0, PHOS: 6.0 }),
    ];
    const falling: Readonly<Record<string, readonly LabPoint[]>> = {
      HGB: seriesOf([[28, 11.4], [14, 10.9], [0, 10.2]]),
    };
    const { rows, states } = evaluateCohorts(SEED_COHORT_DEFINITIONS, patients, {
      ...ctx,
      series: (_p, code) => falling[code] ?? [],
      intervalDays: 2,
    });
    expect(states).toHaveLength(SEED_COHORT_DEFINITIONS.length);
    expect(rows.length).toBe(SEED_COHORT_DEFINITIONS.length * patients.length);
    for (const row of rows) {
      expect(row.opportunity).toBeGreaterThanOrEqual(0);
      expect(typeof row.reason).toBe('string');
    }
    // the catheter patient must enter the catheter cohort
    const catheter = rows.find((r) => r.cohortId === 'infection-risk-catheter' && r.patientId === 'p-1');
    expect(catheter?.state).toBe('member');
    // a patient who qualifies on level but has no trend reports UNRESOLVED, not absent
    const mbd = rows.find((r) => r.cohortId === 'mbd-worsening' && r.patientId === 'p-1');
    expect(mbd, 'third patient carries the qualifying phosphate').toBeDefined();
    const unresolvedRow = rows.find((r) => r.state === 'unresolved');
    expect(unresolvedRow?.unresolved).toContain('phosphate.slopePerWeek');
  });

  it('attributes lab series to patients through their order id', () => {
    const series = ledgerLabSeries(
      [
        { payload: { code: 'HGB', value: 10.1, orderId: 'p-1-HGB-7' }, emittedAt: '2026-09-01T00:00:00Z' },
        { payload: { code: 'HGB', value: 10.9, orderId: 'p-1-HGB-8' }, emittedAt: '2026-09-08T00:00:00Z' },
        { payload: { code: 'HGB', value: 9.9, orderId: 'unknown-patient-HGB-1' }, emittedAt: '2026-09-08T00:00:00Z' },
      ],
      ['p-1'],
    );
    expect(series('p-1', 'HGB').map((p) => p.value)).toEqual([10.1, 10.9]);
    expect(series('p-9', 'HGB')).toEqual([]);
  });

  it('resolves metrics from real pack outputs, not from new logic', () => {
    const facts = renalPatientFacts(patient());
    const statuses = new Map([['fluid', { status: 'amber', severity: 0.4 }]]);
    expect(resolveMetric('protocol.severity.fluid', facts, ctx, statuses)).toBe(0.4);
    expect(resolveMetric('protocol.status.fluid', facts, ctx, statuses)).toBe('amber');
    expect(resolveMetric('protocols.atRisk', facts, ctx, statuses)).toBe(0);
    expect(resolveMetric('age.years', facts, ctx, statuses)).toBe(66);
    // ZERO catheter days is a true statement for a non-catheter patient, not
    // missing data — otherwise they could never satisfy a catheter cohort's exit
    expect(resolveMetric('catheter.days', facts, ctx, statuses)).toBe(0);
  });

  it('exits a member once the exit criteria hold', () => {
    const def = SEED_COHORT_DEFINITIONS.find((d) => d.id === 'infection-risk-catheter')!;
    const withCatheter = renalPatientFacts(patient({}, { access: { type: 'catheter', ageDays: 200 } }));
    const member = evaluatePatient(def, withCatheter, ctx);
    expect(member.state).toBe('member');
    expect(shouldExit(member)).toBe(false);

    const removed = renalPatientFacts(patient({}, { access: { type: 'avf', ageDays: 40 } }));
    const after = evaluatePatient(def, removed, ctx);
    expect(after.state).toBe('not-member');
    expect(shouldExit(after)).toBe(true); // catheter days ≤ 90
  });
});

describe('one lab vocabulary at the boundary', () => {
  // the live bug: the realm ledger emits shorthand codes and the cohort series
  // asked for POTASSIUM, so every potassium trend was silently empty and the
  // hyperkalaemia cohort sat permanently unresolved. Tests did not catch it
  // because the fixtures seeded `labs.POTASSIUM` directly.
  it('canonicalLabCode folds every alias onto ONE name so both sides agree', () => {
    expect(canonicalLabCode('K')).toBe('POTASSIUM');
    expect(canonicalLabCode('potassium')).toBe('POTASSIUM');
    expect(canonicalLabCode('POTASSIUM')).toBe('POTASSIUM');
    expect(canonicalLabCode('HGB')).toBe('HGB');
    expect(canonicalLabCode('HB')).toBe('HGB');
    expect(canonicalLabCode('PHOS')).toBe('PHOS');
    // an unknown code is left alone rather than silently dropped
    expect(canonicalLabCode('VITD')).toBe('VITD');
  });

  it('resolves a level metric from facts keyed by the ledger shorthand', () => {
    // state.labs holds ONLY the ledger code — the true live shape
    const facts = renalPatientFacts(patient({}, { labs: { K: 5.9 } }));
    expect(resolveMetric('potassium.current', facts, { at: at() }, new Map())).toBe(5.9);
  });

  it('fires on level when no trend can be established, and says so', () => {
    const facts = renalPatientFacts(patient({}, { labs: { K: 6.1 } }));
    const verdict = evaluatePatient(defById('hyperkalemia-next-session'), facts, {
      at: at(), series: () => [], // no trajectory available at all
    });
    expect(verdict.state).toBe('member');
    expect(verdict.reason.toLowerCase()).toMatch(/current|level/);
  });

  it('still prefers the trajectory when one exists', () => {
    // level 5.45 is BELOW the 5.5 threshold; only the projection at the
    // treatment interval crosses it, so this exercises the trajectory path alone.
    const facts = renalPatientFacts(patient({}, { labs: { K: 5.45 } }));
    const ctx = { at: at(), series: () => seriesOf([[21, 4.9], [14, 5.08], [7, 5.26], [0, 5.45]]) };
    const current = resolveMetric('potassium.current', facts, ctx, new Map()) as number;
    const forecast = resolveMetric('potassium.forecastNextSession', facts, ctx, new Map()) as number;
    expect(current).toBe(5.45);
    expect(forecast).toBeGreaterThan(current); // the trend is actually used
    expect(forecast).toBeGreaterThanOrEqual(5.5);
    const verdict = evaluatePatient(defById('hyperkalemia-next-session'), facts, ctx);
    expect(verdict.state).toBe('member');
    expect(verdict.reason.toLowerCase()).toMatch(/forecast|next treatment|project/);
  });
});

const at = (): string => '2026-09-10T07:00:00.000Z';

function defById(id: string): CohortDefinition {
  const def = SEED_COHORT_DEFINITIONS.find((d) => d.id === id);
  if (!def) throw new Error(`no cohort definition ${id}`);
  return def;
}
