// Living cohorts — membership as a durable, explainable, versioned edge.
//
// A cohort is NOT a saved filter. It is a declared clinical proposition: a set of
// entry criteria over state AND trajectory, an exit that must exist, the action it
// suggests when a patient qualifies, and the boundary it may never cross.
//
// Three rules make this a system rather than 25 alert streams:
//
//   1. Cohorts are DATA. A definition is plain serialisable JSON so an operator can
//      add, edit or retire one through the admin API — no code, no deploy.
//   2. A criterion may only reference a METRIC. The metric vocabulary below is
//      closed, and every metric resolves from an existing pack output or a
//      ledger-derived fact. A user-authored cohort therefore cannot invent clinical
//      logic, and cannot silently disagree with the protocol it belongs to.
//   3. Membership is ALWAYS a suggestion. `evaluatePatient` says whether a patient
//      currently satisfies the proposition; it never acts. Acting goes through the
//      existing proposal → approval → episode path.
//
// An unresolved metric is never read as "not a member". It is reported as
// `unresolved` and surfaced as a coverage number, exactly as the protocol packs
// treat their coverage gates — otherwise a missing lab would silently look like a
// healthy patient.

import type { ProtocolId } from '../protocols/shared-state.js';
import { RENAL_PROTOCOLS, evaluateProtocolForPatient } from '../protocols/registry.js';
import { idhProbability } from './fluid.js';
import type { RenalPatientFacts } from './renal-cohort.js';

export type CohortKind = 'suggested' | 'monitoring';

export type CohortComparator = 'gte' | 'gt' | 'lte' | 'lt' | 'eq' | 'neq' | 'present' | 'absent' | 'outside';

export interface CohortCriterion {
  /** a metric id from COHORT_METRICS — the closed vocabulary */
  metric: string;
  comparator: CohortComparator;
  /** scalar for gte/gt/lte/lt/eq/neq */
  value?: number | string | boolean;
  /** band bounds for `outside` */
  min?: number;
  max?: number;
  /** shown to the reviewer alongside the measured value */
  note?: string;
}

export interface CohortDefinition {
  id: string;
  label: string;
  /** `suggested` proposes an action; `monitoring` only observes membership */
  kind: CohortKind;
  /** the protocol whose outputs this cohort composes, or `cross` for several */
  protocol: ProtocolId | 'cross';
  /** free text: what this cohort is for, in the clinician's words */
  rationale: string;
  entry: CohortCriterion[];
  /** MANDATORY. A cohort that can only grow is an inbox. */
  exit: CohortCriterion[];
  /** ALL entry criteria must hold (default) or ANY of them */
  entryMode?: 'all' | 'any';
  /** what a qualifying patient is suggested for (never executed automatically) */
  suggestedAction: string;
  /** proposal class from the owning pack's boundary */
  approvalClass: 'A' | 'B' | 'C' | 'D';
  /** the boundary this cohort may never cross */
  mayNever: string[];
  /** references to the guards that apply before acting */
  guard: string[];
  /** below this many members the cohort reports `insufficient`, not a prevalence */
  minN: number;
  /** bump when a criterion changes: membership is attributed to the version */
  criterionVersion: string;
  owner: string;
  enabled: boolean;
}

/* ======================================================================
 * The metric vocabulary — closed, and each metric names its real source
 * ====================================================================== */

export interface CohortMetricSpec {
  id: string;
  label: string;
  unit: string;
  valueType: 'number' | 'enum' | 'boolean';
  /** the module that actually computes it — nothing is recomputed here */
  source: string;
}

const PROTOCOL_METRICS: CohortMetricSpec[] = RENAL_PROTOCOLS.flatMap((p) => [
  {
    id: `protocol.severity.${p.id}`, label: `${p.label} severity`, unit: '0..1',
    valueType: 'number' as const, source: 'src/protocols/registry.ts evaluateProtocolForPatient',
  },
  {
    id: `protocol.status.${p.id}`, label: `${p.label} status`, unit: 'green|amber|red|unknown',
    valueType: 'enum' as const, source: 'src/protocols/registry.ts evaluateProtocolForPatient',
  },
]);

export const COHORT_METRICS: readonly CohortMetricSpec[] = [
  ...PROTOCOL_METRICS,
  {
    id: 'protocols.atRisk', label: 'Protocols at risk (severity ≥ 0.5)', unit: 'count',
    valueType: 'number', source: 'src/protocols/registry.ts — count over all seven protocols',
  },
  {
    id: 'idh.nextSessionProbability', label: 'IDH probability, next session', unit: '0..1',
    valueType: 'number',
    source: 'src/swarm/fluid.ts idhProbability — nadir SBP, IDWG and age; the UF-rate term falls back to its 8 mL/kg/h default because the facts carry no body weight, so the ceiling is ~0.55',
  },
  {
    id: 'hgb.current', label: 'Haemoglobin', unit: 'g/dL', valueType: 'number',
    source: 'src/swarm/renal-cohort.ts labs.HGB',
  },
  {
    id: 'hgb.slopePerWeek', label: 'Haemoglobin slope', unit: 'g/dL/wk', valueType: 'number',
    source: 'src/server/cohort-routes.ts ledgerLabSeries(HGB)',
  },
  {
    id: 'hgb.forecast4w', label: 'Haemoglobin projected at 4 weeks', unit: 'g/dL', valueType: 'number',
    source: 'src/server/cohort-routes.ts ledgerLabSeries(HGB) + slopePerWeek',
  },
  {
    id: 'potassium.current', label: 'Potassium', unit: 'mmol/L', valueType: 'number',
    source: 'src/swarm/renal-cohort.ts labs.POTASSIUM',
  },
  {
    id: 'potassium.slopePerWeek', label: 'Potassium slope', unit: 'mmol/L/wk', valueType: 'number',
    source: 'src/server/cohort-routes.ts ledgerLabSeries(POTASSIUM)',
  },
  {
    id: 'potassium.forecastNextSession', label: 'Potassium projected at the next session', unit: 'mmol/L',
    valueType: 'number', source: 'src/server/cohort-routes.ts ledgerLabSeries(POTASSIUM) + interval projection',
  },
  {
    id: 'phosphate.current', label: 'Phosphate', unit: 'mg/dL', valueType: 'number',
    source: 'src/swarm/renal-cohort.ts labs.PHOS',
  },
  {
    id: 'phosphate.slopePerWeek', label: 'Phosphate slope', unit: 'mg/dL/wk', valueType: 'number',
    source: 'src/server/cohort-routes.ts ledgerLabSeries(PHOS)',
  },
  { id: 'pth.current', label: 'PTH', unit: 'pg/mL', valueType: 'number', source: 'src/swarm/renal-cohort.ts labs.PTH' },
  { id: 'calcium.current', label: 'Corrected calcium', unit: 'mg/dL', valueType: 'number', source: 'src/swarm/renal-cohort.ts labs.CALCIUM' },
  { id: 'ktv.current', label: 'Delivered Kt/V', unit: '', valueType: 'number', source: 'src/swarm/renal-cohort.ts labs.KTV' },
  { id: 'urr.current', label: 'URR', unit: '%', valueType: 'number', source: 'src/swarm/renal-cohort.ts labs.URR' },
  { id: 'idwg.avgKg', label: 'Mean interdialytic weight gain', unit: 'kg', valueType: 'number', source: 'src/swarm/renal-cohort.ts sessions.avgIdwgKg' },
  { id: 'albumin.current', label: 'Albumin', unit: 'g/dL', valueType: 'number', source: 'src/swarm/renal-cohort.ts labs.ALBUMIN' },
  { id: 'crp.current', label: 'hs-CRP', unit: 'mg/L', valueType: 'number', source: 'src/swarm/renal-cohort.ts labs.CRP' },
  { id: 'handgrip.current', label: 'Handgrip strength', unit: 'kg', valueType: 'number', source: 'src/swarm/renal-cohort.ts labs.HANDSGRIP' },
  { id: 'temperature.current', label: 'Temperature', unit: '°C', valueType: 'number', source: 'src/swarm/renal-cohort.ts vitals.tempC' },
  { id: 'catheter.days', label: 'Catheter days in situ', unit: 'd', valueType: 'number', source: 'src/swarm/renal-cohort.ts access.ageDays (0 when not a catheter)' },
  { id: 'access.observations', label: 'Access measurements on record', unit: 'count', valueType: 'number', source: 'src/swarm/renal-cohort.ts access.observations' },
  { id: 'access.dysfunction', label: 'Access dysfunction flagged', unit: '', valueType: 'boolean', source: 'src/swarm/renal-cohort.ts access.dysfunction' },
  { id: 'sessions.count', label: 'Sessions on record', unit: 'count', valueType: 'number', source: 'src/swarm/renal-cohort.ts sessions.count' },
  { id: 'sessions.missedPct', label: 'Mean session adherence', unit: '%', valueType: 'number', source: 'src/swarm/renal-cohort.ts sessions.avgAdherencePct' },
  { id: 'vintage.years', label: 'Dialysis vintage', unit: 'y', valueType: 'number', source: 'src/realm/sim-populator.ts patient state dialysisVintageYears' },
  { id: 'age.years', label: 'Age', unit: 'y', valueType: 'number', source: 'src/swarm/renal-cohort.ts age' },
];

export function cohortMetric(id: string): CohortMetricSpec | undefined {
  return COHORT_METRICS.find((m) => m.id === id);
}

/* ======================================================================
 * Resolution — every value comes from an existing computation
 * ====================================================================== */

export interface LabPoint { at: string; value: number }

export interface CohortMetricContext {
  /** ledger-derived lab series, when the caller can supply one */
  series?: ((patientId: string, code: string) => readonly LabPoint[]) | undefined;
  /** treatment interval, for projecting to the next session */
  intervalDays?: number | undefined;
  /** evaluation instant */
  at: string;
  /** patient state values the facts layer does not carry (vintage, …) */
  state?: Record<string, unknown> | undefined;
}

export type MetricValue = number | string | boolean;

/**
 * One lab vocabulary at the boundary.
 *
 * The realm ledger emits shorthand codes (`K`, `HGB`, `PHOS`) while clinicians and
 * cohort authors write clinical names. Asking the ledger for `POTASSIUM` returns
 * nothing at all — silently, which is how a trend cohort ends up permanently
 * unresolved. These aliases are the single translation table, and the ledger
 * series is indexed by the SAME canonical name a metric uses.
 */
export const LAB_CODE_ALIASES: Record<string, readonly string[]> = {
  POTASSIUM: ['POTASSIUM', 'K'],
  HGB: ['HGB', 'HB', 'HAEMOGLOBIN'],
  PHOS: ['PHOS', 'PHOSPHATE'],
  URR: ['URR'],
  KTV: ['KTV', 'KTVV'],
  PTH: ['PTH'],
  CALCIUM: ['CALCIUM', 'CA'],
  ALBUMIN: ['ALBUMIN', 'ALB'],
  CRP: ['CRP'],
  FERRITIN: ['FERRITIN'],
  TSAT: ['TSAT', 'SAT'],
  HANDSGRIP: ['HANDSGRIP'],
};

/** Ledger code → canonical metric code, so both directions agree. */
export const LAB_CODE_CANONICAL: Record<string, string> = Object.entries(LAB_CODE_ALIASES)
  .flatMap(([canonical, aliases]) => aliases.map((alias) => [alias.toUpperCase(), canonical] as const))
  .reduce<Record<string, string>>((acc, [alias, canonical]) => ({ ...acc, [alias]: canonical }), {});

/** Canonical name for a ledger code (identity when it is not a known lab). */
export function canonicalLabCode(code: string): string {
  return LAB_CODE_CANONICAL[code.toUpperCase()] ?? code;
}

/** Ordinary least squares slope per week over a short series. Undefined if thin. */
export function slopePerWeek(points: readonly LabPoint[], minPoints = 3): number | undefined {
  if (points.length < minPoints) return undefined;
  const sorted = [...points].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const t0 = Date.parse(sorted[0]!.at);
  const xs = sorted.map((p) => (Date.parse(p.at) - t0) / 86_400_000);
  const ys = sorted.map((p) => p.value);
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) ** 2;
  }
  if (den === 0) return undefined;
  return Math.round((num / den) * 7 * 10_000) / 10_000;
}

/**
 * Resolve one metric for one patient. Returns undefined when the underlying data
 * is absent — the caller must treat that as `unresolved`, never as false.
 */
export function resolveMetric(
  metricId: string,
  facts: RenalPatientFacts,
  ctx: CohortMetricContext,
  statuses: Map<string, { status: string; severity: number }>,
): MetricValue | undefined {
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  // try every alias a lab is known by, so `POTASSIUM` finds a ledger `K`
  const lab = (code: string): number | undefined => {
    const aliases = LAB_CODE_ALIASES[code] ?? [code];
    for (const alias of aliases) {
      const value = num(facts.labs[alias]);
      if (value !== undefined) return value;
    }
    return num(facts.labs[code]);
  };
  const series = (code: string): readonly LabPoint[] => ctx.series?.(facts.patientId, canonicalLabCode(code)) ?? [];

  if (metricId.startsWith('protocol.severity.')) {
    const id = metricId.slice('protocol.severity.'.length);
    const s = statuses.get(id);
    return s ? s.severity : undefined;
  }
  if (metricId.startsWith('protocol.status.')) {
    const id = metricId.slice('protocol.status.'.length);
    const s = statuses.get(id);
    return s ? s.status : undefined;
  }

  switch (metricId) {
    case 'protocols.atRisk':
      return [...statuses.entries()].filter(([, s]) => s.severity >= 0.5).length;
    case 'idh.nextSessionProbability': {
      // The advisor's prior is driven by the UF RATE above all else, then nadir BP,
      // IDWG, age and cardiac history (src/swarm/fluid.ts idhProbability). This
      // previously supplied a systolic reading and nothing else, which collapses
      // the function to `0.055 * (110 - sbp)` — a near-constant 0.029–0.04 across
      // an entire 58-patient fleet. An operator could author a threshold on it
      // (the seeded cohort asked for >= 0.6) and that cohort could never fire,
      // silently, forever. Pass every input the facts layer actually carries.
      //
      // RESIDUAL LIMITATION: the facts carry UF volume and delivered minutes but
      // no body weight, so ufRatePerKg cannot be computed and the prior falls back
      // to its default 8 mL/kg/h — it therefore under-weights the dominant term and
      // tops out near 0.55 rather than the ~0.74 a fully-specified patient reaches.
      // That ceiling is stated in the metric's `source` so an author is not misled.
      const nadir = num(facts.sessions.minNadirSbp);
      const sbp = nadir ?? num(facts.vitals.systolic);
      if (sbp === undefined) return undefined;
      const idwgKg = num(facts.sessions.avgIdwgKg);
      const age = num(facts.age);
      return Math.round(idhProbability({
        currentSbp: sbp,
        ...(nadir !== undefined ? { nadirSbpPrev: nadir } : {}),
        ...(idwgKg !== undefined ? { idwgKg } : {}),
        ...(age !== undefined ? { age } : {}),
        minute: 60,
      }) * 10_000) / 10_000;
    }
    case 'hgb.current': return lab('HGB');
    case 'hgb.slopePerWeek': return slopePerWeek(series('HGB'));
    case 'hgb.forecast4w': {
      const current = lab('HGB');
      const slope = slopePerWeek(series('HGB'));
      if (current === undefined || slope === undefined) return undefined;
      return Math.round((current + slope * 4) * 100) / 100;
    }
    case 'potassium.current': return lab('POTASSIUM');
    case 'potassium.slopePerWeek': return slopePerWeek(series('POTASSIUM'));
    case 'potassium.forecastNextSession': {
      const current = lab('POTASSIUM');
      const slope = slopePerWeek(series('POTASSIUM'));
      if (current === undefined) return undefined;
      const days = ctx.intervalDays ?? 2;
      const projected = slope === undefined ? current : current + slope * (days / 7);
      return Math.round(projected * 100) / 100;
    }
    case 'phosphate.current': return lab('PHOS');
    case 'phosphate.slopePerWeek': return slopePerWeek(series('PHOS'));
    case 'pth.current': return lab('PTH');
    case 'calcium.current': return lab('CALCIUM');
    case 'ktv.current': return lab('KTV');
    case 'urr.current': return lab('URR');
    case 'idwg.avgKg': return num(facts.sessions.avgIdwgKg);
    case 'albumin.current': return lab('ALBUMIN');
    case 'crp.current': return lab('CRP');
    case 'handgrip.current': return lab('HANDSGRIP');
    case 'temperature.current': return num(facts.vitals.tempC);
    case 'catheter.days': {
      // A non-catheter patient has ZERO catheter days — that is a true statement,
      // not missing data. Returning undefined here would leave every non-catheter
      // patient permanently `unresolved` and unable to exit the cohort.
      const type = (facts.access.type ?? '').toLowerCase();
      if (!type.includes('cath')) return 0;
      return num(facts.access.ageDays) ?? 0;
    }
    case 'access.observations': return facts.access.observations;
    case 'access.dysfunction': return facts.access.dysfunction;
    case 'sessions.count': return facts.sessions.count;
    case 'sessions.missedPct': return num(facts.sessions.avgAdherencePct);
    case 'vintage.years': return num(ctx.state?.dialysisVintageYears);
    case 'age.years': return num(facts.age);
    default: return undefined;
  }
}

/* ======================================================================
 * Criterion + cohort evaluation
 * ====================================================================== */

export type CriterionOutcome = 'met' | 'not-met' | 'unresolved';

export interface CriterionResult {
  metric: string;
  comparator: CohortComparator;
  expected: string;
  observed?: MetricValue | undefined;
  outcome: CriterionOutcome;
  note?: string | undefined;
}

function compare(observed: MetricValue | undefined, criterion: CohortCriterion): CriterionOutcome {
  if (criterion.comparator === 'present') return observed === undefined ? 'unresolved' : 'met';
  if (criterion.comparator === 'absent') return observed === undefined ? 'met' : 'not-met';
  if (observed === undefined) return 'unresolved';
  if (criterion.comparator === 'outside') {
    if (typeof observed !== 'number') return 'unresolved';
    const min = criterion.min ?? -Infinity;
    const max = criterion.max ?? Infinity;
    return observed < min || observed > max ? 'met' : 'not-met';
  }
  const expected = criterion.value;
  switch (criterion.comparator) {
    case 'gte': return typeof observed === 'number' && typeof expected === 'number' ? (observed >= expected ? 'met' : 'not-met') : 'unresolved';
    case 'gt': return typeof observed === 'number' && typeof expected === 'number' ? (observed > expected ? 'met' : 'not-met') : 'unresolved';
    case 'lte': return typeof observed === 'number' && typeof expected === 'number' ? (observed <= expected ? 'met' : 'not-met') : 'unresolved';
    case 'lt': return typeof observed === 'number' && typeof expected === 'number' ? (observed < expected ? 'met' : 'not-met') : 'unresolved';
    case 'neq': return observed !== expected ? 'met' : 'not-met';
    default: return observed === expected ? 'met' : 'not-met';
  }
}

export function describeCriterion(c: CohortCriterion): string {
  if (c.comparator === 'present') return `${c.metric} present`;
  if (c.comparator === 'absent') return `${c.metric} absent`;
  if (c.comparator === 'outside') return `${c.metric} outside [${c.min ?? '—'}, ${c.max ?? '—'}]`;
  return `${c.metric} ${c.comparator} ${String(c.value)}`;
}

export interface CohortEvaluation {
  cohortId: string;
  patientId: string;
  state: 'member' | 'not-member' | 'unresolved';
  entry: CriterionResult[];
  exit: CriterionResult[];
  /** 0..1 — share of the deciding criteria that resolved and held */
  confidence: number;
  /** one line a clinician can read: why this patient is here */
  reason: string;
  /** metrics that could not be resolved — coverage, not health */
  unresolved: string[];
}

/**
 * Evaluate one patient against one cohort. Pure: no storage, no action.
 *
 * `unresolved` means the data needed to decide is missing. It is deliberately a
 * third state — in `all` mode a partially-resolved entry cannot conclude
 * membership, and saying "not a member" there would turn a missing lab into a
 * clean bill of health.
 */
export function evaluatePatient(
  def: CohortDefinition,
  facts: RenalPatientFacts,
  ctx: CohortMetricContext,
  providedStatuses?: Map<string, { status: string; severity: number }>,
): CohortEvaluation {
  const statuses = providedStatuses ?? new Map(
    RENAL_PROTOCOLS.map((p) => {
      const s = evaluateProtocolForPatient(p.id, facts);
      return [p.id as string, { status: s.status as string, severity: s.severity }] as const;
    }),
  );

  const run = (criteria: CohortCriterion[]): CriterionResult[] =>
    criteria.map((c) => {
      const observed = resolveMetric(c.metric, facts, ctx, statuses);
      return {
        metric: c.metric,
        comparator: c.comparator,
        expected: describeCriterion(c),
        observed,
        outcome: compare(observed, c),
        ...(c.note ? { note: c.note } : {}),
      };
    });

  const entry = run(def.entry);
  const exit = run(def.exit);
  const mode = def.entryMode ?? 'all';
  const met = entry.filter((r) => r.outcome === 'met').length;
  const unresolved = entry.filter((r) => r.outcome === 'unresolved');
  const decided = entry.filter((r) => r.outcome !== 'unresolved').length;

  const qualifies = entry.length > 0 && (mode === 'all' ? met === entry.length : met > 0);
  const undecidable = !qualifies && unresolved.length > 0 && (
    mode === 'all' ? entry.every((r) => r.outcome !== 'not-met') : decided === 0
  );

  const state: CohortEvaluation['state'] = qualifies ? 'member' : undecidable ? 'unresolved' : 'not-member';
  const confidence = entry.length === 0 ? 0 : Math.round(((qualifies ? met : 0) / entry.length) * 10_000) / 10_000;

  const held = entry.filter((r) => r.outcome === 'met').map((r) => `${r.expected}${r.observed !== undefined ? ` (measured ${r.observed})` : ''}`);
  const reason = state === 'member'
    ? held.join('; ')
    : state === 'unresolved'
      ? `cannot decide: ${unresolved.map((r) => r.metric).join(', ')} not resolvable`
      : `does not currently qualify (${entry.filter((r) => r.outcome === 'not-met').map((r) => r.metric).join(', ') || 'no entry criteria met'})`;

  return {
    cohortId: def.id,
    patientId: facts.patientId,
    state,
    entry,
    exit,
    confidence,
    reason,
    unresolved: unresolved.map((r) => r.metric),
  };
}

/** True when the cohort's own exit criteria now hold for this patient. */
export function shouldExit(evaluation: CohortEvaluation): boolean {
  return evaluation.exit.some((r) => r.outcome === 'met');
}

/* ======================================================================
 * Cohort-level state (§6 / §11) — churn, coverage and severity, kept apart
 * ====================================================================== */

export interface CohortState {
  cohortId: string;
  label: string;
  kind: CohortKind;
  protocol: ProtocolId | 'cross';
  suggestedAction: string;
  criterionVersion: string;
  /** patients currently satisfying the proposition */
  members: number;
  /** patients who could not be evaluated — a coverage number, not a risk number */
  unresolved: number;
  /** patients evaluated at all */
  evaluated: number;
  /** members per 100 evaluated, and `insufficient` below minN */
  prevalence: number | 'insufficient';
  meanConfidence: number;
  minN: number;
  /** members whose suggested action is actionable by a human right now */
  actionable: number;
  /**
   * Why this cohort has the members it has — per-criterion resolution and, when
   * it is empty, the specific reason. A bare `members: 0` cannot distinguish a
   * healthy empty cohort from one whose data never arrives.
   */
  coverage: CohortCoverage;
}

export function cohortStateOf(
  def: CohortDefinition,
  evaluations: readonly CohortEvaluation[],
  actionableIds: ReadonlySet<string>,
): CohortState {
  const members = evaluations.filter((e) => e.state === 'member');
  const evaluated = evaluations.length;
  const prevalence = members.length < def.minN
    ? 'insufficient' as const
    : Math.round((members.length / Math.max(1, evaluated)) * 1000) / 10;
  return {
    cohortId: def.id,
    label: def.label,
    kind: def.kind,
    protocol: def.protocol,
    suggestedAction: def.suggestedAction,
    criterionVersion: def.criterionVersion,
    members: members.length,
    unresolved: evaluations.filter((e) => e.state === 'unresolved').length,
    evaluated,
    prevalence,
    meanConfidence: members.length === 0
      ? 0
      : Math.round((members.reduce((a, e) => a + e.confidence, 0) / members.length) * 10_000) / 10_000,
    minN: def.minN,
    actionable: members.filter((e) => actionableIds.has(e.patientId)).length,
    coverage: cohortCoverageOf(def, evaluations),
  };
}

/* ======================================================================
 * Coverage — WHY a cohort has the members it has
 *
 * "0 members" is not an answer. It is three different facts wearing one number:
 *
 *   • the cohort is fine and nobody qualifies today (criteria-too-strict);
 *   • NOBODY HAS THE MEASUREMENT (data-gap) — the cohort is silently decorative;
 *   • the measurement exists but never resolves (insufficient-coverage).
 *
 * Before this, an operator saw `members: 0` and could not tell a healthy empty
 * cohort from a dead one. `mdb-worsening` sat at zero for exactly this reason:
 * the fleet carries no serial PTH, so the criterion could never resolve, and
 * nothing anywhere said so. Coverage says so, per criterion, with the module
 * that would have to supply the data.
 * ====================================================================== */

export interface CriterionCoverage {
  metric: string;
  expected: string;
  /** patients for whom this criterion resolved and held */
  met: number;
  /** patients for whom it resolved and did not hold */
  notMet: number;
  /** patients for whom the underlying measurement is absent */
  unresolved: number;
  /** met / evaluated — the share of the population this criterion selected */
  metPct: number;
  /** (met + notMet) / evaluated — the share the data could actually decide */
  resolvedPct: number;
  /** observed numeric range across resolved patients, for calibrating a threshold */
  observedMin?: number | undefined;
  observedMax?: number | undefined;
  unit: string;
  /** the module that computes it — what someone would have to fix */
  source: string;
}

export type CohortDiagnosis =
  /** some patients qualify */
  | 'members'
  /** nobody has the measurement — the cohort cannot be assessed at all */
  | 'data-gap'
  /** the measurement exists and nobody reaches the threshold */
  | 'criteria-too-strict'
  /** every criterion is individually satisfiable, but no patient satisfies them together */
  | 'no-joint-overlap'
  /** nothing was evaluated, so there is nothing to conclude */
  | 'insufficient-coverage';

export interface CohortCoverage {
  evaluated: number;
  members: number;
  entryMode: 'all' | 'any';
  /** one row per entry criterion, in declaration order */
  criteria: CriterionCoverage[];
  /** criteria no patient satisfied AND no patient could resolve — a data gap */
  dataBlocked: string[];
  /** criteria that resolved but which nobody satisfied — a threshold problem */
  neverMet: string[];
  /**
   * The criteria named by `verdict` as the reason there are no members: the
   * unmeasurable ones, the unsurpassed ones, or — when every criterion is
   * individually satisfiable — the criterion that admits the fewest patients.
   */
  blockers: string[];
  diagnosis: CohortDiagnosis;
  /** one sentence an operator can act on, naming the metric and its source */
  verdict: string;
}

const pct = (n: number, d: number): number => (d === 0 ? 0 : Math.round((n / d) * 1000) / 10);

/** Per-criterion coverage for one cohort over the evaluated population. */
export function cohortCoverageOf(def: CohortDefinition, evaluations: readonly CohortEvaluation[]): CohortCoverage {
  const evaluated = evaluations.length;
  const members = evaluations.filter((e) => e.state === 'member').length;
  const entryMode = def.entryMode ?? 'all';

  const buckets = new Map<string, CriterionCoverage>();
  for (const c of def.entry) {
    if (buckets.has(c.metric)) continue;
    const spec = cohortMetric(c.metric);
    buckets.set(c.metric, {
      metric: c.metric,
      expected: describeCriterion(c),
      met: 0,
      notMet: 0,
      unresolved: 0,
      metPct: 0,
      resolvedPct: 0,
      unit: spec?.unit ?? '',
      source: spec?.source ?? 'unknown — not in the metric vocabulary',
    });
  }

  for (const ev of evaluations) {
    for (const r of ev.entry) {
      const b = buckets.get(r.metric);
      if (!b) continue;
      if (r.outcome === 'met') b.met += 1;
      else if (r.outcome === 'not-met') b.notMet += 1;
      else b.unresolved += 1;
      if (typeof r.observed === 'number') {
        b.observedMin = b.observedMin === undefined ? r.observed : Math.min(b.observedMin, r.observed);
        b.observedMax = b.observedMax === undefined ? r.observed : Math.max(b.observedMax, r.observed);
      }
    }
  }

  const criteria = [...buckets.values()].map((b) => ({
    ...b,
    metPct: pct(b.met, evaluated),
    resolvedPct: pct(b.met + b.notMet, evaluated),
  }));

  // In BOTH modes, "no members" means no criterion held — in `all` mode every
  // criterion must hold, in `any` mode at least one must. So a criterion that no
  // patient satisfied is decisive on its own, and when every criterion IS
  // individually satisfied the emptiness must come from their intersection.
  const unmeasurable = criteria.filter((c) => c.met === 0 && c.notMet === 0);
  const unsurpassed = criteria.filter((c) => c.met === 0 && c.notMet > 0);
  const binding = criteria.length === 0
    ? undefined
    : [...criteria].sort((a, b) => a.met - b.met || a.metric.localeCompare(b.metric))[0];

  const dataBlocked = unmeasurable.map((c) => c.metric);
  const neverMet = unsurpassed.map((c) => c.metric);

  let diagnosis: CohortDiagnosis = 'members';
  let blockers: string[] = [];
  let verdict = `${members} of ${evaluated} evaluated patients satisfy this cohort.`;

  // An unmeasurable criterion BLOCKS in `all` mode and does not block in `any`
  // mode. Reporting it as the headline in `any` mode is therefore wrong whenever
  // another branch resolved and simply failed: it would send an operator after a
  // missing measurement when the real answer is "the measure exists and nobody
  // crosses the threshold".
  const unmeasurableBlocks = entryMode === 'all' && unmeasurable.length > 0;

  if (members === 0 && evaluated === 0) {
    diagnosis = 'insufficient-coverage';
    verdict = 'no patients were evaluated at all — the patient source returned nothing, so this cohort has not been assessed.';
  } else if (members === 0 && unmeasurableBlocks) {
    const gap = unmeasurable[0]!;
    diagnosis = 'data-gap';
    blockers = dataBlocked;
    const alsoUnsurpassed = unsurpassed[0];
    verdict = `no members: '${gap.metric}' could not be resolved for any of ${evaluated} evaluated patients — nothing in the data supplies it (source: ${gap.source}). This cohort cannot be assessed on the current data, so its zero is not evidence that nobody is at risk.`
      + (alsoUnsurpassed ? ` '${alsoUnsurpassed.metric}' is also never satisfied${range(alsoUnsurpassed)}.` : '');
  } else if (members === 0 && unsurpassed.length > 0) {
    const strict = unsurpassed.sort((a, b) => (a.notMet - b.notMet) || a.metric.localeCompare(b.metric))[0]!;
    diagnosis = 'criteria-too-strict';
    blockers = neverMet;
    verdict = `no members: the data resolved '${strict.metric}' for ${strict.notMet} patients and none met ${strict.expected}${range(strict)}. The criterion is decidable and the threshold sits outside the observed population.`
      + (entryMode === 'any' && unmeasurable.length > 0
        ? ` ${unmeasurable.length} further criterion(a) could not be resolved at all (${dataBlocked.join(', ')}), but in 'any' mode a missing measurement cannot admit anyone — it is a coverage gap, not the reason for this zero.`
        : '');
  } else if (members === 0 && unmeasurable.length > 0 && binding) {
    // `any` mode where NO branch resolved at all: nothing could be decided.
    diagnosis = 'data-gap';
    blockers = dataBlocked;
    verdict = `no members: none of the ${criteria.length} entry criteria could be resolved for any of ${evaluated} evaluated patients (${dataBlocked.map((m) => `'${m}'`).join(', ')}). This cohort cannot be assessed on the current data, so its zero is not evidence that nobody is at risk.`;
  } else if (members === 0 && binding) {
    // Every criterion is individually satisfiable, so the emptiness is the
    // INTERSECTION — e.g. an adequacy flag that only fires for the patients who
    // have no sessions, paired with a criterion requiring a session. Nothing is
    // missing and nothing is mis-thresholded; the cohort is unsatisfiable as
    // written, and saying "insufficient coverage" here would send an operator
    // looking for data that is not the problem.
    diagnosis = 'no-joint-overlap';
    blockers = [binding.metric];
    const others = criteria.filter((c) => c.metric !== binding.metric)
      .map((c) => `'${c.metric}' holds for ${c.met}`)
      .join(', ');
    verdict = `no members: every entry criterion is individually satisfiable, but no patient evaluated satisfies them together. The binding criterion is '${binding.metric}' (${binding.expected}), satisfied by only ${binding.met} of ${evaluated} patients${range(binding)}${others ? `; ${others}` : ''}.`
      // The counts cannot tell "mutually exclusive as written" from "this
      // population happens to contain no such patient" — and saying the first
      // when it is the second would send an operator to rewrite good criteria.
      + ` Two separate populations are being described rather than one: either the criteria are mutually exclusive as written, or no such patient exists in this population. The counts do not distinguish the two, so check both branches before changing a threshold.`;
  } else if (members === 0) {
    diagnosis = 'insufficient-coverage';
    verdict = `no members: this cohort declares no entry criteria, so nothing can admit a patient.`;
  }

  return {
    evaluated,
    members,
    entryMode,
    criteria,
    dataBlocked,
    neverMet,
    blockers,
    diagnosis,
    verdict,
  };
}

function range(c: CriterionCoverage): string {
  if (c.observedMin === undefined || c.observedMax === undefined) return '';
  // Only append the unit when it is a unit. Vocabulary entries carry ranges
  // ('0..1') and enum sets ('green|amber|red|unknown') in the same field, and
  // "observed range 0.03–0.04 0..1" is unreadable.
  const isUnit = Boolean(c.unit) && c.unit.length <= 8 && !c.unit.includes('|') && !c.unit.includes('..');
  const unit = isUnit ? ` ${c.unit}` : '';
  const lo = Math.round(c.observedMin * 100) / 100;
  const hi = Math.round(c.observedMax * 100) / 100;
  return lo === hi ? ` (observed ${lo}${unit})` : ` (observed range ${lo}–${hi}${unit})`;
}

/* ======================================================================
 * Decline analysis — what a rejected suggestion is evidence OF
 *
 * A decline is the only signal in the system that a clinician disagreed with a
 * criterion. It is recorded durably and attributed to the criterion version it
 * was made against, so a cohort that was wrong once cannot be condemned forever
 * by the verdict a previous criterion earned.
 *
 * Nothing here edits a cohort. It produces evidence an operator can act on —
 * the tuning step stays a human edit through the same API a human uses.
 * ====================================================================== */

export interface CohortDeclineAnalysis {
  cohortId: string;
  label: string;
  owner: string;
  enabled: boolean;
  /** the definition version in force right now */
  criterionVersion: string;
  /** declines recorded against the CURRENT version only */
  declines: number;
  /** suggestions accepted at review against the current version */
  acceptances: number;
  /** declines / decisions, or null when no human has decided anything yet */
  declineRate: number | null;
  /** reasons given, grouped, most common first */
  reasons: Array<{ reason: string; count: number }>;
  /** versions the cohort has been judged under, newest first */
  byVersion: Array<{ criterionVersion: string; declines: number; acceptances: number; stale: boolean }>;
  /** true when declines under this version are dominated by one reason */
  clustered: boolean;
  /** the criterion to look at first, and why — evidence, never an edit */
  recommendation: string;
  /** every suggestion declined and none accepted, over the sample floor */
  retireCandidate: boolean;
}

/** A tuning recommendation is only made once this many decisions exist. */
export const DECLINE_SAMPLE_FLOOR = 3;

export interface CohortDecisionLike {
  cohortId: string;
  action: 'review' | 'decline';
  reason: string;
  criterionVersion: string;
}

export function analyseCohortDeclines(
  def: CohortDefinition,
  decisions: readonly CohortDecisionLike[],
): CohortDeclineAnalysis {
  const mine = decisions.filter((d) => d.cohortId === def.id);
  const current = mine.filter((d) => d.criterionVersion === def.criterionVersion);
  const declines = current.filter((d) => d.action === 'decline');
  const acceptances = current.filter((d) => d.action === 'review');

  const counts = new Map<string, number>();
  for (const d of declines) {
    const reason = d.reason.trim() || '(no reason given)';
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  const reasons = [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));

  const versions = [...new Set(mine.map((d) => d.criterionVersion))].sort((a, b) => b.localeCompare(a));
  const byVersion = versions.map((v) => ({
    criterionVersion: v,
    declines: mine.filter((d) => d.criterionVersion === v && d.action === 'decline').length,
    acceptances: mine.filter((d) => d.criterionVersion === v && d.action === 'review').length,
    // a judgement made against an older criterion says nothing about this one
    stale: v !== def.criterionVersion,
  }));

  const decided = declines.length + acceptances.length;
  const declineRate = decided === 0 ? null : Math.round((declines.length / decided) * 1000) / 10;

  const top = reasons[0];
  // Concentration is a property of the declines themselves, independent of the
  // acceptances: "the declines we have all say the same thing". It needs TWO
  // declines before it is a pattern at all — one rejection is one person's
  // opinion, and flagging it as a cluster would turn a single click into a
  // tuning recommendation.
  const clustered = top !== undefined && declines.length >= 2 && top.count / declines.length >= 0.6;

  let recommendation: string;
  if (decided === 0) {
    recommendation = `No decisions have been recorded against version ${def.criterionVersion} yet, so there is nothing to learn from.`;
  } else if (decided < DECLINE_SAMPLE_FLOOR) {
    // Below the floor we report the signal as an OBSERVATION with its sample
    // size, rather than withholding it or dressing it up as a recommendation.
    const lead = top
      ? ` The emerging signal is "${top.reason}" (${top.count} of ${declines.length} decline(s)); ${DECLINE_SAMPLE_FLOOR} decisions are the floor before that is worth acting on.`
      : '';
    recommendation = `Not enough human decisions to judge this cohort yet (${declines.length} declined, ${acceptances.length} accepted on version ${def.criterionVersion}).${lead}`;
  } else if (clustered && top) {
    const criterion = def.entry[0] ? describeCriterion(def.entry[0]) : 'its entry criterion';
    recommendation = `${top.count} of ${declines.length} declines on version ${def.criterionVersion} share one reason: "${top.reason}". Review the criterion '${criterion}' against that reason — editing the definition (and bumping criterionVersion) is what clears the suppression, so declining again today would change nothing.`;
  } else if (declineRate !== null && declineRate >= 80) {
    recommendation = `${declines.length} of ${decided} suggestions were declined on version ${def.criterionVersion} (${declineRate}%). Compare the entry thresholds against the observed population before trusting this cohort's output.`;
  } else {
    const share = top ? `; the most common covers ${top.count} of ${declines.length}` : '';
    recommendation = `Declines are spread across ${reasons.length} distinct reason(s) on version ${def.criterionVersion}${share} — no single criterion is implicated by the sample yet.`;
  }

  return {
    cohortId: def.id,
    label: def.label,
    owner: def.owner,
    enabled: def.enabled,
    criterionVersion: def.criterionVersion,
    declines: declines.length,
    acceptances: acceptances.length,
    declineRate,
    reasons,
    byVersion,
    clustered,
    recommendation,
    retireCandidate: def.enabled && declines.length >= DECLINE_SAMPLE_FLOOR && acceptances.length === 0,
  };
}

/* ======================================================================
 * Superseded seeds — replacing a shipped definition that could not work
 *
 * Seeding is idempotent per cohort id and NEVER overwrites an operator's edit,
 * which is right. But it also means a corrected shipped definition never reaches
 * a deployment that already has the old one: the catalog would keep the broken
 * criteria forever, and the correction would only ever appear on a fresh store.
 *
 * These four definitions shipped in a form that could not admit anybody (a
 * threshold above the metric's own ceiling, two mutually exclusive criteria, a
 * precondition that excluded every patient the cohort existed to find). They are
 * kept here so the upgrade can be applied ONLY when the stored definition is still
 * byte-for-byte the clinical logic we shipped — i.e. the operator never touched
 * it. Anything else is left alone and reported instead.
 * ====================================================================== */

export interface SupersededSeed {
  /** the definition exactly as previously shipped, clinical logic included */
  definition: CohortDefinition;
  /** why it was replaced, in the operator's terms */
  reason: string;
}

/** Identity of a criterion's DECISION, ignoring the reviewer-facing note. */
function criterionDecision(c: CohortCriterion): string {
  return [c.metric, c.comparator, c.value === undefined ? '' : String(c.value),
    c.min === undefined ? '' : String(c.min), c.max === undefined ? '' : String(c.max)].join('\u0001');
}

/**
 * Is this stored definition still the logic we shipped, untouched?
 *
 * Notes are ignored on purpose: a note does not change who is admitted, and a JSON
 * round-trip through Postgres JSONB does not preserve key order, so comparing the
 * raw objects would be both brittle and wrong.
 */
export function isSupersededShippedDefinition(def: CohortDefinition, superseded: CohortDefinition): boolean {
  if (def.id !== superseded.id) return false;
  if (def.criterionVersion !== superseded.criterionVersion) return false;
  if ((def.entryMode ?? 'all') !== (superseded.entryMode ?? 'all')) return false;
  if (def.minN !== superseded.minN) return false;
  if (def.entry.length !== superseded.entry.length) return false;
  if (def.exit.length !== superseded.exit.length) return false;
  return def.entry.every((c, i) => criterionDecision(c) === criterionDecision(superseded.entry[i]!))
    && def.exit.every((c, i) => criterionDecision(c) === criterionDecision(superseded.exit[i]!));
}

/**
 * The upgrade to apply to a stored definition, or undefined to leave it alone.
 *
 * Returns the CURRENT shipped definition when the stored one is an unmodified
 * superseded seed, so the correction lands without touching an authored cohort.
 */
export function seedUpgradeFor(
  stored: CohortDefinition,
  options: { seeds?: readonly CohortDefinition[]; superseded?: readonly SupersededSeed[] } = {},
): { definition: CohortDefinition; reason: string } | undefined {
  const seeds = options.seeds ?? SEED_COHORT_DEFINITIONS;
  const superseded = options.superseded ?? SUPERSEDED_SEED_COHORTS;
  for (const old of superseded) {
    if (!isSupersededShippedDefinition(stored, old.definition)) continue;
    const current = seeds.find((s) => s.id === stored.id);
    if (!current) continue;
    if (current.criterionVersion === stored.criterionVersion) continue;
    return { definition: current, reason: old.reason };
  }
  return undefined;
}

export const SUPERSEDED_SEED_COHORTS: readonly SupersededSeed[] = [
  {
    definition: {
      id: 'idh-next-session', label: 'Elevated intradialytic hypotension risk, next session',
      kind: 'suggested', protocol: 'fluid',
      rationale: 'superseded', entry: [
        { metric: 'idh.nextSessionProbability', comparator: 'gte', value: 0.6 },
        { metric: 'sessions.count', comparator: 'gte', value: 1 },
      ],
      exit: [
        { metric: 'idh.nextSessionProbability', comparator: 'lt', value: 0.4 },
        { metric: 'sessions.count', comparator: 'lt', value: 1 },
      ],
      suggestedAction: '', approvalClass: 'B', mayNever: [], guard: [], minN: 5,
      criterionVersion: '1.0.0', owner: 'renal-nursing', enabled: true,
    },
    reason: 'the entry threshold (IDH probability >= 0.6) was above the metric\'s own ceiling, so the cohort could never admit anyone',
  },
  {
    definition: {
      id: 'hgb-deviation-4w', label: 'Haemoglobin trajectory leaving the target band within four weeks',
      kind: 'suggested', protocol: 'anemia',
      rationale: 'superseded', entry: [
        { metric: 'hgb.slopePerWeek', comparator: 'lte', value: -0.15 },
        { metric: 'hgb.forecast4w', comparator: 'lt', value: 10 },
      ],
      exit: [
        { metric: 'hgb.forecast4w', comparator: 'gte', value: 10 },
        { metric: 'hgb.slopePerWeek', comparator: 'gte', value: -0.05 },
      ],
      suggestedAction: '', approvalClass: 'C', mayNever: [], guard: [], minN: 5,
      criterionVersion: '1.0.0', owner: 'nephrology', enabled: true,
    },
    reason: 'both thresholds sat outside the observed population (slope >= -0.12, forecast >= 10.65), so the cohort could never admit anyone',
  },
  {
    definition: {
      id: 'inadequate-clearance', label: 'Delivered clearance projected below target',
      kind: 'suggested', protocol: 'adequacy',
      rationale: 'superseded', entry: [
        { metric: 'protocol.severity.adequacy', comparator: 'gte', value: 0.5 },
        { metric: 'sessions.count', comparator: 'gte', value: 1 },
      ],
      exit: [
        { metric: 'urr.current', comparator: 'gte', value: 65 },
        { metric: 'ktv.current', comparator: 'gte', value: 1.2 },
      ],
      suggestedAction: '', approvalClass: 'B', mayNever: [], guard: [], minN: 5,
      criterionVersion: '1.0.0', owner: 'nephrology', enabled: true,
    },
    reason: 'the adequacy severity rises to 0.5 only for patients with NO sessions, and the second criterion required a session — mutually exclusive by construction',
  },
  {
    definition: {
      id: 'access-deterioration', label: 'Progressive vascular access deterioration',
      kind: 'suggested', protocol: 'access',
      rationale: 'superseded', entry: [
        { metric: 'access.observations', comparator: 'gte', value: 3 },
        { metric: 'protocol.severity.access', comparator: 'gte', value: 0.5 },
      ],
      exit: [
        { metric: 'access.dysfunction', comparator: 'absent' },
        { metric: 'protocol.severity.access', comparator: 'lt', value: 0.3 },
      ],
      suggestedAction: '', approvalClass: 'B', mayNever: [], guard: [], minN: 5,
      criterionVersion: '1.0.0', owner: 'vascular-access', enabled: true,
    },
    reason: 'requiring 3 access observations excluded every patient the pack flags (they are exactly the under-surveilled ones), so nobody could be admitted',
  },
];

/* ======================================================================
 * The seed catalog — DATA, not code. Operators add and edit these.
 * ====================================================================== */

export const SEED_COHORT_DEFINITIONS: readonly CohortDefinition[] = [
  {
    id: 'idh-next-session',
    label: 'Elevated intradialytic hypotension risk, next session',
    kind: 'suggested',
    protocol: 'fluid',
    rationale: 'Patients the fluid advisor itself places in its highest risk tier, so the UF plan can be reviewed before they arrive.',
    entry: [
      {
        metric: 'protocol.severity.fluid', comparator: 'gte', value: 0.6,
        note: "the fluid advisor's red tier (severity 0.6 = IDWG above the 2.5 kg flag); the pack already ORs IDWG, UF achievement, nadir SBP and shortened sessions into this number",
      },
      { metric: 'sessions.count', comparator: 'gte', value: 1, note: 'at least one session on record' },
    ],
    exit: [
      { metric: 'protocol.severity.fluid', comparator: 'lt', value: 0.5, note: 'risk resolved below the tier' },
      { metric: 'sessions.count', comparator: 'lt', value: 1, note: 'no treatment history to reason from' },
    ],
    suggestedAction: 'Review the ultrafiltration plan, dry weight and antihypertensive timing before the next session',
    approvalClass: 'B',
    mayNever: [
      'change an ultrafiltration rate or machine parameter',
      'change a prescribed dry weight without clinical sign-off',
    ],
    guard: ['fluid coverage gate', 'fluid guardrails', 'session telemetry availability'],
    minN: 5,
    // 1.1.0 — was `idh.nextSessionProbability >= 0.6`, which could never fire: the
    // prior's own ceiling is ~0.55 even for a patient with every risk factor at an
    // extreme, and on the reference fleet it spans only 0.029-0.088. A threshold
    // that cannot be reached is a cohort that is dead by construction.
    criterionVersion: '1.1.0',
    owner: 'renal-nursing',
    enabled: true,
  },
  {
    id: 'hgb-deviation-4w',
    label: 'Haemoglobin trajectory leaving the target band within four weeks',
    kind: 'suggested',
    protocol: 'anemia',
    rationale: 'Haemoglobin is currently acceptable but its observed slope projects out of the target band, so iron, ESA response and blood loss can be reviewed while there is time to act.',
    entry: [
      { metric: 'hgb.slopePerWeek', comparator: 'lte', value: -0.05, note: 'falling trajectory' },
      { metric: 'hgb.forecast4w', comparator: 'lt', value: 11, note: 'projects to at or below 11 g/dL within the horizon — an early-warning margin under the 10 g/dL band floor, not the floor itself' },
    ],
    exit: [
      { metric: 'hgb.forecast4w', comparator: 'gte', value: 11, note: 'trajectory no longer projects low' },
      { metric: 'hgb.slopePerWeek', comparator: 'gte', value: -0.02, note: 'decline has flattened' },
    ],
    suggestedAction: 'Review iron studies, ESA response and any bleeding source before the next cycle',
    approvalClass: 'C',
    mayNever: ['change an ESA dose', 'order a transfusion'],
    guard: ['anemia coverage gate', 'iron-first guardrail', 'microcytic guardrail'],
    minN: 5,
    // 1.1.0 — was `slope <= -0.15` AND `forecast4w < 10`. Both sat outside the
    // fleet's observed range (slope -0.12..0.31, forecast 10.65..13.16), so the
    // cohort could not admit anyone. The margin at 11 g/dL rather than the floor
    // at 10 is deliberate: iron and ESA act over weeks, so a projection that only
    // reaches the floor at the horizon is already too late to act on.
    criterionVersion: '1.1.0',
    owner: 'nephrology',
    enabled: true,
  },
  {
    id: 'hyperkalemia-next-session',
    label: 'Hyperkalaemia projected before the next treatment',
    kind: 'suggested',
    protocol: 'nutrition-electrolytes',
    rationale: 'Potassium trajectory projects above the action threshold at the next session, and the interval since the last treatment widens the risk.',
    entry: [
      {
        metric: 'potassium.forecastNextSession', comparator: 'gte', value: 5.5,
        note: 'projected at the treatment interval',
      },
      {
        metric: 'potassium.current', comparator: 'gte', value: 5.5,
        note: 'level already above the threshold — used when a trend cannot be established; the reason names which criterion held',
      },
    ],
    entryMode: 'any',
    exit: [
      { metric: 'potassium.current', comparator: 'lt', value: 5, note: 'current value back in range' },
      { metric: 'potassium.forecastNextSession', comparator: 'lt', value: 5.2, note: 'projection resolved' },
    ],
    suggestedAction: 'Confirm a potassium before acting, then review diet, binder adherence and dialysis clearance',
    approvalClass: 'C',
    mayNever: ['act on a device ECG pattern alone', 'order a potassium-binding resin'],
    guard: ['nutrition lab-confirmation contract', 'potassium freshness rule'],
    minN: 5,
    criterionVersion: '1.1.0',
    owner: 'renal-nursing',
    enabled: true,
  },
  {
    id: 'mbd-worsening',
    label: 'Worsening CKD-MBD despite current therapy',
    kind: 'suggested',
    protocol: 'ckd-mbd',
    rationale: 'Phosphate is above the target ceiling and still rising — the patient is not responding to current therapy, which is a different question from a single high value. Deliberately a conjunction: a patient above target whose trend is falling is responding and needs no action. (A cross-analyte cohort would also want PTH; the vocabulary threshold is a flat AND or a flat OR, and PTH is unmeasured for most patients, so the coupled picture is served by protocol.severity.ckd-mbd instead.)',
    entry: [
      { metric: 'phosphate.current', comparator: 'gt', value: 5.5, note: "the pack's own target ceiling (MBD_REFERENCE.phosphateTargetMgDl.upper = 5.5)" },
      { metric: 'phosphate.slopePerWeek', comparator: 'gt', value: 0, note: 'still rising' },
    ],
    exit: [
      { metric: 'phosphate.current', comparator: 'lte', value: 5.5, note: 'back within target' },
      { metric: 'phosphate.slopePerWeek', comparator: 'lte', value: 0, note: 'trend reversed' },
    ],
    suggestedAction: 'Review binder timing and dose, dietary phosphate and PTH assessment',
    approvalClass: 'C',
    mayNever: ['escalate a binder beyond the calcium safety envelope'],
    guard: ['mbd hard envelope', 'mbd serial triplet requirement'],
    minN: 5,
    criterionVersion: '1.0.0',
    owner: 'nephrology',
    enabled: true,
  },
  {
    id: 'inadequate-clearance',
    label: 'Delivered clearance projected below target',
    kind: 'suggested',
    protocol: 'adequacy',
    rationale: 'A MEASURED clearance below the pack floor — URR under 60% or single-pool Kt/V under 1.2 — so the prescription can be reviewed before the next monthly draw.',
    entry: [
      { metric: 'urr.current', comparator: 'lt', value: 60, note: "the pack's own URR floor (URR_FLOOR_PCT = 60)" },
      { metric: 'ktv.current', comparator: 'lt', value: 1.2, note: 'the pack target spKt/V; whichever measure is actually recorded may admit' },
    ],
    entryMode: 'any',
    exit: [
      { metric: 'urr.current', comparator: 'gte', value: 65, note: 'URR back above the floor, with hysteresis so the cohort does not flap' },
      { metric: 'ktv.current', comparator: 'gte', value: 1.2, note: 'Kt/V back above target' },
    ],
    suggestedAction: 'Review treatment time, blood flow, access performance and the clearance measurement',
    approvalClass: 'B',
    mayNever: ['set a machine parameter', 'change prescribed treatment time'],
    guard: ['adequacy coverage gate', 'recirculation interpretability rule'],
    minN: 5,
    // 1.1.0 — was `protocol.severity.adequacy >= 0.5` AND `sessions.count >= 1`,
    // which no patient could satisfy. The adequacy severity rises to 0.5 only when
    // the advisor is STARVED of data (the 3 patients it flagged had zero sessions),
    // and the cohort then required a session — the two criteria were mutually
    // exclusive by construction. Composing the advisor's severity was wrong here:
    // absence of a measurement is coverage, not inadequate clearance.
    criterionVersion: '1.1.0',
    owner: 'nephrology',
    enabled: true,
  },
  {
    id: 'access-deterioration',
    label: 'Progressive vascular access deterioration',
    kind: 'suggested',
    protocol: 'access',
    rationale: 'The access advisor has raised its measured-deterioration tier — dysfunction flagged, or recirculation at or above 10% — so surveillance happens before a thrombosis rather than after.',
    entry: [
      {
        metric: 'protocol.severity.access', comparator: 'gte', value: 0.6,
        note: "the pack's measured tiers: 0.7 dysfunction flagged, 0.6 recirculation >= 10%; the pack already ORs them",
      },
    ],
    exit: [
      { metric: 'protocol.severity.access', comparator: 'lt', value: 0.3, note: 'no dysfunction and no abnormal recirculation' },
    ],
    suggestedAction: 'Access-team review of the pressure and flow trend; consider imaging where clinically indicated',
    approvalClass: 'B',
    mayNever: ['order a procedure', 'book an intervention'],
    guard: ['kdoqi min-observations gate', 'post-intervention quiet window'],
    minN: 5,
    // 1.1.0 — was `access.observations >= 3` AND `severity >= 0.5`, which admitted
    // nobody: the patients the pack flags are precisely the ones with fewer than
    // three measurements, so the "a trend needs serial measurements" precondition
    // excluded every patient the cohort was meant to find. Requiring observations
    // was also backwards — un-surveilled at-risk patients are the target, not a
    // reason to exclude them. The severity already encodes the rationale's OR
    // (diverged from baseline OR dysfunction flagged).
    criterionVersion: '1.1.0',
    owner: 'vascular-access',
    enabled: true,
  },
  {
    id: 'infection-risk-catheter',
    label: 'Catheter-associated infection risk',
    kind: 'suggested',
    protocol: 'infection',
    rationale: 'A catheter in situ past the escalation window, or a febrile and inflammatory picture, with prevention actions that may already be overdue.',
    entry: [
      { metric: 'catheter.days', comparator: 'gt', value: 90, note: 'past the catheter-day escalation window' },
    ],
    exit: [
      { metric: 'catheter.days', comparator: 'lte', value: 90, note: 'catheter removed or replaced' },
    ],
    suggestedAction: 'Review catheter necessity and removal options; confirm cultures before any antimicrobial discussion',
    approvalClass: 'B',
    mayNever: ['name an antimicrobial, a dose or a duration', 'order an isolation'],
    guard: ['culture-before-antibiotic contract', 'catheter escalation rule'],
    minN: 3,
    criterionVersion: '1.0.0',
    owner: 'infection-prevention',
    enabled: true,
  },
  {
    id: 'multi-protocol-deterioration',
    label: 'Deteriorating across several protocols at once',
    kind: 'monitoring',
    protocol: 'cross',
    rationale: 'Three or more protocols concurrently at risk — the patient where independent per-protocol recommendations conflict and therefore need one coordinating decision.',
    entry: [
      { metric: 'protocols.atRisk', comparator: 'gte', value: 3, note: 'protocols with severity ≥ 0.5' },
    ],
    exit: [
      { metric: 'protocols.atRisk', comparator: 'lt', value: 2, note: 'burden resolved' },
    ],
    suggestedAction: 'Coordinate a single multidisciplinary review rather than acting on each protocol independently',
    approvalClass: 'C',
    mayNever: ['issue protocol-by-protocol instructions without an arbitration step'],
    guard: ['cross-protocol arbitration'],
    minN: 3,
    criterionVersion: '1.0.0',
    owner: 'nephrology',
    enabled: true,
  },
];
