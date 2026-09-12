/******************************************************************************
 * Fluid / dry weight / intradialytic hypotension (IDH) domain — P2 protocol pack
 * (step A: engine + guardrails + observer cell).
 *
 * Evidence anchor (implementation strategy §0/§2.1): published SOTA for IDH is a
 * temporal fusion transformer (AUROC 0.953) — that is the benchmark, not the
 * plan. Our differentiator is the COUNTERFACTUAL UF SIMULATOR (what happens if
 * we slow the ultrafiltration rate), so the baseline is gradient-boosted trees
 * over a mechanistic volume/haemodynamic prior, with per-horizon (15/30/60 min)
 * forecasts. Nothing here ever schedules or changes a machine setting.
 *
 * Same six-step pack as anemia/adequacy:
 *   • FLUID_FEATURES / guardFluidPrescription / fluidLatent / fluidRecommend
 *   • FLUID_CELLS, FLUID_CONSUMED_BY, durable episodes
 *
 * SAFETY BOUNDARY: class-B/C advisory. UF-rate reductions and dry-weight
 * reassessments require clinical review; the platform has no machine authority.
 ******************************************************************************/

import { cellAllowlist, type CellManifest } from './cells.js';
import { aggregateSwarmInsights, makeProposal, type CellProposal, type SwarmInsight } from './insight.js';
import { attachInsightBelief, rankNextBestActions, type NbaCandidate, type NextBestAction } from './nba.js';
import type { OutcomeEpisode } from './outcome-episode.js';
import type { PersistentOutcomeCoordinator } from './durable-coordinator.js';
import type { EvidenceRef, ScopeType } from './types.js';
import type { SwarmWorkspaceStore } from './workspace.js';
import { fluidPrior, IDWG_FLAG_KG, NADIR_SBP_FLOOR, UF_ACHIEVEMENT_FLOOR_PCT } from '../protocols/priors.js';

/* ======================================================================
 * 1. Feature catalog
 * ====================================================================== */

export interface FluidFeature {
  id: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  relevance: number;
}

export const FLUID_FEATURES: readonly FluidFeature[] = [
  { id: 'ufRateMlH', label: 'Ultrafiltration rate', unit: 'mL/h', min: 0, max: 1500, relevance: 0.24 },
  { id: 'ufRatePerKg', label: 'UF rate per kg body weight', unit: 'mL/kg/h', min: 0, max: 20, relevance: 0.18 },
  { id: 'preSbp', label: 'Pre-dialysis systolic BP', unit: 'mmHg', min: 70, max: 200, relevance: 0.14 },
  { id: 'nadirSbpPrev', label: 'Nadir SBP in the previous session', unit: 'mmHg', min: 60, max: 170, relevance: 0.12 },
  { id: 'idwgKg', label: 'Interdialytic weight gain', unit: 'kg', min: 0, max: 8, relevance: 0.1 },
  { id: 'ufVolumeL', label: 'Ultrafiltration volume', unit: 'L', min: 0, max: 6, relevance: 0.07 },
  { id: 'plannedMinutes', label: 'Planned session length', unit: 'min', min: 60, max: 300, relevance: 0.05 },
  { id: 'age', label: 'Age', unit: 'years', min: 18, max: 95, relevance: 0.04 },
  { id: 'cardiacHistory', label: 'Cardiac history (0/1)', unit: 'flag', min: 0, max: 1, relevance: 0.03 },
  { id: 'postWeightKg', label: 'Post-dialysis (target) weight', unit: 'kg', min: 35, max: 160, relevance: 0.03 },
];

/** UF-rate ceilings used by the guardrails (mL/kg/h). */
export const UF_RATE_PER_KG_SAFE = 10;
export const UF_RATE_PER_KG_HIGH = 13;
/** Per-horizon IDH forecast points inside a session (the fluid protocol's clocks). */
export const FLUID_HORIZONS_MIN = [15, 30, 60] as const;
/** Smallest titratable UF-rate step (mL/h). */
export const UF_RATE_STEP = 50;

/* ======================================================================
 * 2. Guardrails
 * ====================================================================== */

export type FluidGuardFlag =
  | 'no-intra-session-telemetry'      // no BP/UF telemetry → block
  | 'idh-in-previous-session'         // hypotension history → never escalate UF
  | 'dry-weight-not-reassessed'       // target weight stale → reassess first
  | 'uf-rate-above-refill-ceiling'    // UF rate above the plasma-refill ceiling
  | 'shortened-sessions-adherence-first'
  | 'idwg-within-tolerance'           // no volume to remove → no UF escalation
  | 'cardiac-fragility'               // no UF escalation, prefer profiling
  | 'systolic-floor-breached';        // nadir SBP under the floor → de-escalate

export interface FluidGuardInput {
  sessionCount?: number | undefined;
  telemetryPoints?: number | undefined;
  ufRateMlH?: number | undefined;
  postWeightKg?: number | undefined;
  preSbp?: number | undefined;
  nadirSbp?: number | undefined;
  nadirSbpPrev?: number | undefined;
  idwgKg?: number | undefined;
  plannedMinutes?: number | undefined;
  adherencePct?: number | undefined;
  age?: number | undefined;
  cardiacHistory?: boolean | undefined;
  dryWeightAssessedAt?: string | undefined;
  asOf?: string | undefined;
}

export interface FluidGuardResult {
  flags: FluidGuardFlag[];
  blocked: boolean;
  blockReason: string | null;
  ufEscalationAllowed: boolean;
  ufReductionAdvised: boolean;
  ufRatePerKg?: number | undefined;
}

export function guardFluidPrescription(input: FluidGuardInput): FluidGuardResult {
  const flags: FluidGuardFlag[] = [];
  const weight = input.postWeightKg ?? 70;
  const ufRatePerKg = input.ufRateMlH !== undefined ? Math.round((input.ufRateMlH / weight) * 100) / 100 : undefined;
  const adherence = input.adherencePct
    ?? (input.telemetryPoints !== undefined && input.telemetryPoints > 0 ? 100 : undefined);
  const prior = fluidPrior({
    ...(input.idwgKg !== undefined ? { avgIdwgKg: input.idwgKg } : {}),
    ...(input.nadirSbp !== undefined ? { minNadirSbp: input.nadirSbp } : {}),
    ...(input.postWeightKg !== undefined ? { dryWeightKg: input.postWeightKg } : {}),
  });

  if (!input.sessionCount || !input.telemetryPoints) flags.push('no-intra-session-telemetry');
  if ((input.nadirSbpPrev ?? 999) < NADIR_SBP_FLOOR) flags.push('idh-in-previous-session');
  if (input.idwgKg !== undefined && input.idwgKg <= 1.5) flags.push('idwg-within-tolerance');
  if (adherence !== undefined && adherence < 90) flags.push('shortened-sessions-adherence-first');
  if (input.cardiacHistory === true || (input.age ?? 0) >= 80) flags.push('cardiac-fragility');
  if ((input.nadirSbp ?? 999) < NADIR_SBP_FLOOR) flags.push('systolic-floor-breached');
  if (ufRatePerKg !== undefined && ufRatePerKg > UF_RATE_PER_KG_HIGH) flags.push('uf-rate-above-refill-ceiling');

  // Dry weight: stale (or unknown) target weight blocks any volume change.
  const asOf = input.asOf ? Date.parse(input.asOf) : Number.NaN;
  const assessed = input.dryWeightAssessedAt ? Date.parse(input.dryWeightAssessedAt) : Number.NaN;
  const fresh = Number.isFinite(asOf) && Number.isFinite(assessed) && (asOf - assessed) / 86_400_000 <= 30;
  if (!fresh) flags.push('dry-weight-not-reassessed');

  const blocked = flags.includes('no-intra-session-telemetry') || flags.includes('shortened-sessions-adherence-first') || flags.includes('dry-weight-not-reassessed');
  const blockReason = !blocked
    ? null
    : flags.includes('no-intra-session-telemetry')
      ? 'No intra-session telemetry — the fluid model cannot score a session it cannot see.'
      : flags.includes('shortened-sessions-adherence-first')
        ? 'Delivered time below 90% of prescribed — adherence intervention precedes any UF change.'
        : 'Target (dry) weight not reassessed within 30 days — no volume change without a weight review.';

  return {
    flags,
    blocked,
    blockReason,
    ufEscalationAllowed: !blocked
      && !flags.includes('idh-in-previous-session')
      && !flags.includes('cardiac-fragility')
      && !flags.includes('uf-rate-above-refill-ceiling')
      && !flags.includes('systolic-floor-breached')
      && !flags.includes('idwg-within-tolerance'),
    ufReductionAdvised: flags.includes('idh-in-previous-session') || flags.includes('systolic-floor-breached') || (ufRatePerKg !== undefined && ufRatePerKg > UF_RATE_PER_KG_HIGH),
    ufRatePerKg,
    ...(prior.drivers.length ? {} : {}),
  };
}

/* ======================================================================
 * 3. Deterministic 2-D latent — volume load × haemodynamic fragility
 * ====================================================================== */

const norm = (v: number, f: FluidFeature): number =>
  Math.max(-1, Math.min(1, ((v - f.min) / (f.max - f.min)) * 2 - 1));

export function fluidLatent(input: FluidGuardInput): { l1: number; l2: number; polarRadius: number; polarAngleRad: number } {
  const f = (id: string): FluidFeature => FLUID_FEATURES.find((x) => x.id === id)!;
  // Rate per kg is derived when only the absolute rate and the weight are known.
  const ratePerKg = input.ufRateMlH !== undefined && input.postWeightKg
    ? Math.round((input.ufRateMlH / input.postWeightKg) * 100) / 100
    : undefined;
  // Axis 1 — volume load to remove (higher = more fluid to remove).
  const volume = (input.idwgKg !== undefined ? norm(input.idwgKg, f('idwgKg')) * 0.6 : 0)
    + (ratePerKg !== undefined ? norm(ratePerKg, f('ufRatePerKg')) * 0.4 : 0);
  // Axis 2 — haemodynamic fragility (higher = more fragile).
  const fragility = (input.nadirSbp !== undefined ? 1 - Math.max(0, Math.min(1, (input.nadirSbp - 80) / 50)) : 0) * 0.5
    + ((input.age ?? 60) >= 80 ? 0.25 : (input.age ?? 60) >= 70 ? 0.15 : 0)
    + (input.cardiacHistory ? 0.25 : 0);
  const l1 = Math.max(-1, Math.min(1, volume));
  const l2 = Math.max(-1, Math.min(1, fragility * 2 - 1));
  return { l1, l2, polarRadius: Math.hypot(l1, l2), polarAngleRad: Math.atan2(l2, l1) };
}

/* ======================================================================
 * 4. Reference surrogate
 * ====================================================================== */

export interface FluidPatientWindow extends FluidGuardInput {
  patientId: string;
  facilityId?: string | undefined;
  /** per-session telemetry, most recent last (minute, bp, hr, ufRate, ufVolume) */
  telemetry?: ReadonlyArray<{ minute: number; bp?: string | undefined; hr?: number | undefined; ufRateMlH?: number | undefined; ufVolumeL?: number | undefined; temperatureC?: number | undefined; symptoms?: readonly string[] | undefined }> | undefined;
  deliveredMinutes?: number | undefined;
  ufVolumeL?: number | undefined;
  dryWeightAssessedAt?: string | undefined;
}

export type FluidAction = 'reduce-uf-rate' | 'extend-time-for-uf' | 'review-dry-weight' | 'profile-temperature-sodium' | 'adherence-first' | 'hold' | 'blocked';

export interface FluidRecommendation {
  patientId: string;
  guardrails: FluidGuardResult;
  latent: ReturnType<typeof fluidLatent>;
  current: {
    ufRateMlH?: number | undefined;
    ufRatePerKg?: number | undefined;
    ufVolumeL?: number | undefined;
    deliveredMinutes?: number | undefined;
    nadirSbp?: number | undefined;
    idwgKg?: number | undefined;
    /**
     * IDH probability at 15/30/60 minutes — the protocol's intra-session clocks.
     * Computed by the mechanistic prior here; the learned head (step E) refines it.
     */
    idhRiskByMinute?: Record<number, number> | undefined;
  };
  action: FluidAction;
  recommended: {
    ufRateMlH?: number | undefined;
    extraMinutes?: number | undefined;
    ufVolumeCapL?: number | undefined;
    expectedIdhRiskByMinute?: Record<number, number> | undefined;
    fluidRemovedL?: number | undefined;
  };
  drivers: Array<{ id: string; label: string; relevance: number }>;
  model: { id: string; version: string; kind: 'reference-surrogate' | 'trained' };
  synthetic: boolean;
  note: string;
}

export const FLUID_ADVISOR_MODEL = { id: 'fluid.idh-v0', version: '0.1.0', kind: 'reference-surrogate' as const };

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/**
 * Mechanistic IDH probability. Logistic in the UF-rate-per-kg and the current
 * systolic pressure, with fixed offsets for the prior-session nadir, IDWG and
 * cardiac history — every coefficient is documented and monotone, so the
 * simulator cannot return a non-physiological answer.
 */
export function idhProbability(input: {
  ufRatePerKg?: number | undefined;
  currentSbp: number;
  nadirSbpPrev?: number | undefined;
  idwgKg?: number | undefined;
  age?: number | undefined;
  cardiacHistory?: boolean | undefined;
  minute: number;
}): number {
  const rate = input.ufRatePerKg ?? 8;
  // risk grows through the session as plasma refilling lags
  const elapsed = 1 - Math.exp(-Math.max(0, input.minute) / 45);
  const z =
    -3.1
    + 0.28 * Math.max(0, rate - 6)
    + 0.055 * (110 - input.currentSbp)
    + (input.nadirSbpPrev !== undefined && input.nadirSbpPrev < NADIR_SBP_FLOOR ? 0.7 : 0)
    + Math.max(0, (input.idwgKg ?? 2) - 2.5) * 0.22
    + ((input.age ?? 60) >= 80 ? 0.4 : 0)
    + (input.cardiacHistory ? 0.45 : 0);
  const p = 1 / (1 + Math.exp(-z));
  return round3(Math.min(0.99, Math.max(0.005, p * (0.35 + 0.65 * elapsed))));
}

export function fluidRecommend(input: FluidPatientWindow): FluidRecommendation {
  const guardrails = guardFluidPrescription(input);
  const latent = fluidLatent(input);
  const weight = input.postWeightKg ?? 70;
  const ufVolumeL = input.ufVolumeL;
  const deliveredMinutes = input.deliveredMinutes ?? input.plannedMinutes;
  const ufRateMlH = input.ufRateMlH
    ?? (ufVolumeL !== undefined && deliveredMinutes ? Math.round((ufVolumeL * 1000 * 60) / deliveredMinutes) : undefined);
  const ufRatePerKg = ufRateMlH !== undefined ? Math.round((ufRateMlH / weight) * 100) / 100 : undefined;
  const currentSbp = input.nadirSbp ?? input.preSbp ?? 110;

  const riskAt = (rate: number | undefined, minute: number): number => idhProbability({
    ...(rate !== undefined ? { ufRatePerKg: Math.round((rate / weight) * 100) / 100 } : {}),
    currentSbp,
    ...(input.nadirSbpPrev !== undefined ? { nadirSbpPrev: input.nadirSbpPrev } : {}),
    ...(input.idwgKg !== undefined ? { idwgKg: input.idwgKg } : {}),
    ...(input.age !== undefined ? { age: input.age } : {}),
    ...(input.cardiacHistory !== undefined ? { cardiacHistory: input.cardiacHistory } : {}),
    minute,
  });
  const idhRiskByMinute: Record<number, number> = {};
  for (const m of FLUID_HORIZONS_MIN) idhRiskByMinute[m] = riskAt(ufRateMlH, m);

  let action: FluidAction = 'hold';
  let recommendedRate: number | undefined;
  let extraMinutes: number | undefined;
  let note = '';

  if (guardrails.blocked) {
    action = guardrails.flags.includes('shortened-sessions-adherence-first') ? 'adherence-first' : 'blocked';
    note = guardrails.blockReason ?? 'Blocked by guardrails.';
  } else if ((input.idwgKg ?? 0) <= 1.5) {
    action = 'hold';
    note = `IDWG ${input.idwgKg ?? '—'} kg is within tolerance — no UF escalation; keep the current goal and reassess.`;
  } else if (guardrails.ufReductionAdvised) {
    // Hypotension-prone: reduce the RATE, extend time to preserve fluid removal.
    recommendedRate = ufRateMlH !== undefined ? Math.max(UF_RATE_STEP, Math.round((ufRateMlH * 0.75) / UF_RATE_STEP) * UF_RATE_STEP) : undefined;
    const needed = ufVolumeL !== undefined && recommendedRate ? Math.round((ufVolumeL * 1000 * 60) / recommendedRate) : undefined;
    extraMinutes = needed !== undefined && deliveredMinutes !== undefined && needed > deliveredMinutes ? needed - deliveredMinutes : undefined;
    action = extraMinutes !== undefined ? 'extend-time-for-uf' : 'reduce-uf-rate';
    note = `Hypotension-prone profile — reduce the UF rate${recommendedRate ? ` to ${recommendedRate} mL/h (${Math.round((recommendedRate / weight) * 100) / 100} mL/kg/h)` : ''}${extraMinutes ? ` and extend the session by ~${extraMinutes} min to keep the same fluid removal` : ''}. Class B/C review.`;
  } else if (ufRatePerKg !== undefined && ufRatePerKg <= UF_RATE_PER_KG_SAFE) {
    action = 'profile-temperature-sodium';
    note = `UF rate ${ufRatePerKg} mL/kg/h is already at or below the safe ceiling (${UF_RATE_PER_KG_SAFE}) — cooling the dialysate and sodium profiling are the remaining levers.`;
  } else {
    recommendedRate = ufRateMlH !== undefined ? Math.max(UF_RATE_STEP, Math.round((ufRateMlH * 0.85) / UF_RATE_STEP) * UF_RATE_STEP) : undefined;
    action = 'reduce-uf-rate';
    note = `UF rate ${ufRatePerKg ?? '—'} mL/kg/h is above the safe ceiling (${UF_RATE_PER_KG_SAFE}) — step it down; the fluid goal is unchanged.`;
  }

  const expectedRate = recommendedRate ?? ufRateMlH;
  const expectedIdhRiskByMinute: Record<number, number> = {};
  for (const m of FLUID_HORIZONS_MIN) expectedIdhRiskByMinute[m] = riskAt(expectedRate, m);

  return {
    patientId: input.patientId,
    guardrails,
    latent,
    current: {
      ufRateMlH,
      ufRatePerKg,
      ufVolumeL,
      deliveredMinutes,
      nadirSbp: input.nadirSbp,
      idwgKg: input.idwgKg,
      idhRiskByMinute,
    },
    action,
    recommended: {
      ...(recommendedRate !== undefined ? { ufRateMlH: recommendedRate } : {}),
      ...(extraMinutes !== undefined ? { extraMinutes } : {}),
      ...(ufVolumeL !== undefined ? { ufVolumeCapL: ufVolumeL } : {}),
      expectedIdhRiskByMinute,
      ...(ufVolumeL !== undefined ? { fluidRemovedL: ufVolumeL } : {}),
    },
    drivers: FLUID_FEATURES.map((f) => ({ id: f.id, label: f.label, relevance: f.relevance })).sort((a, b) => b.relevance - a.relevance),
    model: FLUID_ADVISOR_MODEL,
    synthetic: true,
    note,
  };
}

/* ======================================================================
 * 5. Bounded cells + durable episodes
 * ====================================================================== */

export const FLUID_CELLS: CellManifest[] = [
  {
    id: 'fluid-uf-optimizer',
    version: '0.1.0',
    displayName: 'Fluid / UF optimisation',
    domain: 'quality',
    owner: 'Nephrology · Renal dialysis',
    consumes: ['session.started.v1', 'session.telemetry.v1', 'session.ended.v1'],
    produces: ['fluid.uf.proposal'],
    allowedActions: ['order-lab', 'update-care-plan', 'schedule-followup', 'notify-staff'],
    approvalClass: 'C',
    evalGate: 0.9,
    killSwitch: false,
    rollback: true,
    observerRef: 'docs/renal-protocols-implementation-strategy.md §2.1 · per-horizon IDH model + UF counterfactual',
  },
  {
    id: 'intradialytic-monitoring',
    version: '0.1.0',
    displayName: 'Intradialytic monitoring',
    domain: 'patient-care',
    owner: 'Nursing · dialysis unit',
    consumes: ['session.telemetry.v1'],
    produces: ['fluid.idh.watch'],
    allowedActions: ['notify-staff', 'flag-safety-event', 'record-vitals', 'update-care-plan'],
    approvalClass: 'B',
    evalGate: 0.85,
    killSwitch: false,
    rollback: true,
    observerRef: 'Implementation strategy §2.1 · intra-session telemetry watch (nursing escalation)',
  },
];

export const FLUID_CONSUMED_BY: Record<string, string[]> = {
  'fluid.uf.proposal': ['fluid-uf-optimizer', 'intradialytic-monitoring'],
  'fluid.idh.watch': ['intradialytic-monitoring'],
};

export const FLUID_EPISODE_KINDS = ['fluid.idh-response'] as const;

/* ======================================================================
 * 6. Reference boundary
 * ====================================================================== */

export interface FluidDemoState {
  source: 'fluid';
  features: readonly FluidFeature[];
  cells: CellManifest[];
  proposals: CellProposal[];
  insights: SwarmInsight[];
  nbas: NextBestAction[];
  conflictCount: number;
  kpis: { idhRatePct: number; sessionsWithTelemetryPct: number; ufGoalAchievedPct: number; valueAtRiskUsd: number };
}

const NOW = () => new Date().toISOString();
const ev = (sourceId: string, contentType: string): EvidenceRef => ({ sourceId, contentType });

export function buildFluidDemo(now: () => string = NOW): Omit<FluidDemoState, 'episodes'> {
  const proposals: CellProposal[] = [
    makeProposal({
      cellId: 'fluid-uf-optimizer', kind: 'fluid.uf.proposal', subject: 'patient:p-idh-1', scopeType: 'patient',
      option: 'reduce UF rate and extend the session', approvalClass: 'C',
      recommendation: 'Patient p-idh-1: UF 1250 mL/h (16.2 mL/kg/h) with a prior-session nadir SBP of 84 — step the rate down to ~900 mL/h and keep the same fluid removal; IDH risk at 60 min is projected to fall from the current level. Class C review.',
      allowed: true, evidence: [ev('session.telemetry.v1:p-idh-1', 'event'), ev('vital.observed:p-idh-1', 'fact')],
      producedAt: now(), payload: { ufRateMlH: 900, horizonMinutes: 60 },
    }),
    makeProposal({
      cellId: 'intradialytic-monitoring', kind: 'fluid.idh.watch', subject: 'patient:p-idh-2', scopeType: 'patient',
      option: 'nursing escalation for a falling systolic trend', approvalClass: 'B',
      recommendation: 'Patient p-idh-2: systolic fell 22 mmHg within the first 30 minutes at an unchanged UF rate — nursing review (positioning, rate pause) and a documented IDH event.',
      allowed: true, evidence: [ev('session.telemetry.v1:p-idh-2', 'event')],
      producedAt: now(), payload: { dropMmHg: 22, minute: 30 },
    }),
  ];
  const insights = aggregateSwarmInsights({ proposals, consumedBy: FLUID_CONSUMED_BY, mode: 'dst' });
  const conflictCount = insights.filter((i) => i.retained).length;
  const candidates: NbaCandidate[] = [
    {
      title: 'Reduce UF rate for p-idh-1 (hypotension-prone, prior nadir 84 mmHg)', cells: ['fluid-uf-optimizer'],
      scopeType: 'patient', subject: 'patient:p-idh-1', owner: 'Nephrology · Renal dialysis', due: 'Next session',
      evidence: [ev('session.telemetry.v1:p-idh-1', 'event')],
      action: { kind: 'update-care-plan', target: 'patient:p-idh-1' },
      valueUnit: 'dollars',
      consensus: 0.93, approvalClass: 'C', expectedOutcome: 31000, urgency: 0.7, policyCost: 0.35, risk: 0.3,
      insightKind: 'fluid.uf.proposal',
    },
    {
      title: 'Nursing escalation for p-idh-2 (systolic fall at unchanged UF)', cells: ['intradialytic-monitoring'],
      scopeType: 'patient', subject: 'patient:p-idh-2', owner: 'Nursing · dialysis unit', due: 'Now',
      evidence: [ev('session.telemetry.v1:p-idh-2', 'event')],
      action: { kind: 'notify-staff', target: 'patient:p-idh-2' },
      valueUnit: 'dollars',
      consensus: 0.8, approvalClass: 'B', expectedOutcome: 12000, urgency: 0.85, policyCost: 0.2, risk: 0.25,
      insightKind: 'fluid.idh.watch',
    },
  ];
  const nbas = rankNextBestActions(attachInsightBelief(candidates, insights), { limit: 4, beliefAware: true, allowlist: cellAllowlist(FLUID_CELLS) });
  return {
    source: 'fluid',
    features: FLUID_FEATURES,
    cells: FLUID_CELLS,
    proposals,
    insights,
    nbas,
    conflictCount,
    kpis: { idhRatePct: 11, sessionsWithTelemetryPct: 96, ufGoalAchievedPct: 88, valueAtRiskUsd: 240000 },
  };
}

export function fluidEpisodes(coordinator: PersistentOutcomeCoordinator): OutcomeEpisode[] {
  return coordinator.list().filter((e) => (FLUID_EPISODE_KINDS as readonly string[]).includes(e.kind));
}

/**
 * Seed durable fluid episodes: one AwaitingApproval (Class C UF change) and one
 * full closed loop (Class B nursing escalation → verified IDH-rate outcome).
 */
export async function seedFluidEpisodes(
  coordinator: PersistentOutcomeCoordinator,
  _ws?: SwarmWorkspaceStore,
  now: () => string = NOW,
): Promise<{ opened: string[]; existing: string[]; closed: string[] }> {
  const opened: string[] = [];
  const existing: string[] = [];
  const closed: string[] = [];
  const find = (subject: string): OutcomeEpisode | undefined =>
    coordinator.list().find((e) => e.kind === 'fluid.idh-response' && e.subject === subject && e.scopeType === 'patient');

  const p1 = find('patient:p-idh-1');
  if (!p1) {
    const rec = fluidRecommend({
      patientId: 'p-idh-1', sessionCount: 6, telemetryPoints: 12, plannedMinutes: 210, deliveredMinutes: 205,
      ufVolumeL: 4.2, ufRateMlH: 1250, postWeightKg: 77, preSbp: 128, nadirSbp: 96, nadirSbpPrev: 84,
      idwgKg: 4.4, age: 78, cardiacHistory: true, adherencePct: 98,
      dryWeightAssessedAt: '2026-08-20T00:00:00Z', asOf: now(),
    });
    const e = coordinator.open({ kind: 'fluid.idh-response', subject: 'patient:p-idh-1', scopeType: 'patient' });
    coordinator.addEvidence(e.episodeId, [ev('session.telemetry.v1:p-idh-1', 'event')], true);
    coordinator.propose(e.episodeId, makeProposal({
      cellId: 'fluid-uf-optimizer', kind: 'fluid.uf.proposal', subject: e.subject, scopeType: 'patient',
      option: 'reduce UF rate and extend the session', approvalClass: 'C',
      recommendation: rec.note, allowed: true, evidence: [ev('session.telemetry.v1:p-idh-1', 'event')],
      producedAt: now(), payload: { advisor: rec },
    }), true);
    coordinator.requestApproval(e.episodeId, 'C');
    opened.push(e.episodeId);
  } else {
    existing.push(p1.episodeId);
  }

  const p2 = find('patient:p-idh-2');
  if (!p2) {
    const e = coordinator.open({ kind: 'fluid.idh-response', subject: 'patient:p-idh-2', scopeType: 'patient' });
    coordinator.addEvidence(e.episodeId, [ev('session.telemetry.v1:p-idh-2', 'event')], true);
    coordinator.propose(e.episodeId, makeProposal({
      cellId: 'intradialytic-monitoring', kind: 'fluid.idh.watch', subject: e.subject, scopeType: 'patient',
      option: 'nursing escalation for a falling systolic trend', approvalClass: 'B',
      recommendation: 'Systolic fell 22 mmHg in the first 30 minutes with an unchanged UF rate — nursing escalation, rate pause and a documented IDH event.',
      allowed: true, evidence: [ev('session.telemetry.v1:p-idh-2', 'event')], producedAt: now(), payload: { dropMmHg: 22 },
    }), true);
    coordinator.requestApproval(e.episodeId, 'B');
    coordinator.decide(e.episodeId, 'approved', 'Nurse lead (dialysis unit)', 'B');
    coordinator.dispatchCommand(e.episodeId, 'update-care-plan');
    coordinator.acknowledge(e.episodeId, 'patient:p-idh-2');
    coordinator.verify(e.episodeId, { measureId: 'fluid.idh-event-rate', met: true });
    closed.push(e.episodeId);
  } else {
    existing.push(p2.episodeId);
  }

  return { opened, existing, closed };
}

/** Targeted reset — removes ONLY fluid episodes. */
export async function dropFluidEpisodes(coordinator: PersistentOutcomeCoordinator): Promise<number> {
  const targets = fluidEpisodes(coordinator);
  for (const e of targets) coordinator.remove(e.episodeId);
  return targets.length;
}

export const FLUID_REFERENCE = {
  ufRatePerKgSafe: UF_RATE_PER_KG_SAFE,
  ufRatePerKgHigh: UF_RATE_PER_KG_HIGH,
  horizonsMin: FLUID_HORIZONS_MIN,
  ufRateStep: UF_RATE_STEP,
  nadirSbpFloor: NADIR_SBP_FLOOR,
  idwgFlagKg: IDWG_FLAG_KG,
  ufAchievementFloorPct: UF_ACHIEVEMENT_FLOOR_PCT,
} as const;
