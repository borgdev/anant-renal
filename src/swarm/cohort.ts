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
    valueType: 'number', source: 'src/swarm/fluid.ts idhProbability (mechanistic prior)',
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
      const sbp = num(facts.sessions.minNadirSbp) ?? num(facts.vitals.systolic);
      if (sbp === undefined) return undefined;
      return Math.round(idhProbability({ currentSbp: sbp, minute: 60 }) * 10_000) / 10_000;
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
  };
}

/* ======================================================================
 * The seed catalog — DATA, not code. Operators add and edit these.
 * ====================================================================== */

export const SEED_COHORT_DEFINITIONS: readonly CohortDefinition[] = [
  {
    id: 'idh-next-session',
    label: 'Elevated intradialytic hypotension risk, next session',
    kind: 'suggested',
    protocol: 'fluid',
    rationale: 'Patients the fluid advisor projects are likely to drop below the nadir pressure threshold during their next treatment, so the UF plan can be reviewed before they arrive.',
    entry: [
      { metric: 'idh.nextSessionProbability', comparator: 'gte', value: 0.6, note: 'fluid advisor mechanistic prior at 60 minutes' },
      { metric: 'sessions.count', comparator: 'gte', value: 1, note: 'at least one session on record' },
    ],
    exit: [
      { metric: 'idh.nextSessionProbability', comparator: 'lt', value: 0.4, note: 'risk resolved below the exit threshold' },
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
    criterionVersion: '1.0.0',
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
      { metric: 'hgb.slopePerWeek', comparator: 'lte', value: -0.15, note: 'falling trajectory' },
      { metric: 'hgb.forecast4w', comparator: 'lt', value: 10, note: 'projects below the lower target' },
    ],
    exit: [
      { metric: 'hgb.forecast4w', comparator: 'gte', value: 10, note: 'trajectory no longer projects below target' },
      { metric: 'hgb.slopePerWeek', comparator: 'gte', value: -0.05, note: 'decline has flattened' },
    ],
    suggestedAction: 'Review iron studies, ESA response and any bleeding source before the next cycle',
    approvalClass: 'C',
    mayNever: ['change an ESA dose', 'order a transfusion'],
    guard: ['anemia coverage gate', 'iron-first guardrail', 'microcytic guardrail'],
    minN: 5,
    criterionVersion: '1.0.0',
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
    rationale: 'Phosphate is above target and still rising, or PTH is trending unfavourably — the coupled picture rather than a single analyte.',
    entry: [
      { metric: 'phosphate.current', comparator: 'gt', value: 5.5, note: 'above target' },
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
    rationale: 'Delivered clearance is below target or the access and treatment pattern predicts it will be, so the prescription can be reviewed before the next monthly draw.',
    entry: [
      { metric: 'protocol.severity.adequacy', comparator: 'gte', value: 0.5, note: 'adequacy advisor confidence' },
      { metric: 'sessions.count', comparator: 'gte', value: 1 },
    ],
    exit: [
      { metric: 'urr.current', comparator: 'gte', value: 65, note: 'URR back above the floor' },
      { metric: 'ktv.current', comparator: 'gte', value: 1.2, note: 'Kt/V back above target' },
    ],
    suggestedAction: 'Review treatment time, blood flow, access performance and the clearance measurement',
    approvalClass: 'B',
    mayNever: ['set a machine parameter', 'change prescribed treatment time'],
    guard: ['adequacy coverage gate', 'recirculation interpretability rule'],
    minN: 5,
    criterionVersion: '1.0.0',
    owner: 'nephrology',
    enabled: true,
  },
  {
    id: 'access-deterioration',
    label: 'Progressive vascular access deterioration',
    kind: 'suggested',
    protocol: 'access',
    rationale: 'Access measurements have diverged from the patient\'s own baseline, or dysfunction is already flagged — surveillance before a thrombosis rather than after.',
    entry: [
      { metric: 'access.observations', comparator: 'gte', value: 3, note: 'a trend needs serial measurements' },
      { metric: 'protocol.severity.access', comparator: 'gte', value: 0.5, note: 'access advisor confidence' },
    ],
    exit: [
      { metric: 'access.dysfunction', comparator: 'absent', note: 'no dysfunction pattern flagged' },
      { metric: 'protocol.severity.access', comparator: 'lt', value: 0.3, note: 'severity resolved' },
    ],
    suggestedAction: 'Access-team review of the pressure and flow trend; consider imaging where clinically indicated',
    approvalClass: 'B',
    mayNever: ['order a procedure', 'book an intervention'],
    guard: ['kdoqi min-observations gate', 'post-intervention quiet window'],
    minN: 5,
    criterionVersion: '1.0.0',
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
