/******************************************************************************
 *
 * Copyright (c) 2026 AnantHQ Inc.
 * All Rights Reserved.
 *
 * This software is licensed, not sold.
 *
 * The contents of this file constitute confidential and proprietary
 * information belonging exclusively to Unison Software Technologies Pvt. Ltd.
 *
 * This source code incorporates proprietary algorithms, software architecture,
 * business logic, computational methods, optimization techniques,
 * workflows, data structures, APIs, and implementation details that are
 * protected by copyright law, patent law, trade secret law, and
 * international intellectual property treaties.
 *
 * Except as expressly permitted by a written license agreement,
 * no person or organization may:
 *
 *   • Copy or reproduce this software.
 *   • Modify or create derivative works.
 *   • Reverse engineer, decompile, or disassemble.
 *   • Benchmark or publicly disclose performance.
 *   • Redistribute, sublicense, lease, rent, or sell.
 *   • Use this software for competitive analysis.
 *   • Disclose any implementation details.
 *
 * Any unauthorized use is strictly prohibited and may result in
 * civil damages, injunctive relief, criminal prosecution,
 * and all other remedies available under applicable law.
 *
 ******************************************************************************/

// P5 step C — nutrition / electrolyte counterfactual.
//
// Candidate interventions are projected on the SAME markers the pathways use, so
// the plan is judged on the pathway it claims to fix: a dietitian referral must
// move the poor-intake markers, a dialysis-dose change must move the
// inadequate-dialysis markers, and an alkali must move bicarbonate (and, through
// the acidosis coupling, potassium). Every candidate's projected potassium is
// re-checked against the lab-confirmation contract.

import {
  NUTRITION_REFERENCE, assessPew, forecastPotassium, nutritionRecommend, guardNutritionPlan,
  type NutritionGuardInput,
} from './nutrition.js';

export const NUTRITION_SIMULATOR_MODEL = { id: 'nutrition.plan-sim', version: '0.1.0', kind: 'pathway-mechanistic-counterfactual' as const };

export const NUTRITION_TRADEOFF_WEIGHTS = {
  /** residual PEW burden after the plan */
  pewBurden: 1.2,
  /** projected potassium risk */
  hyperkalemia: 1.5,
  /** acidosis left uncorrected */
  acidosis: 0.7,
  /** intervention cost/burden (supplements, extra visits, drugs) */
  burden: 0.25,
} as const;

export interface NutritionCandidate {
  label: string;
  action: string;
  pathway: string;
  /** projected markers at the horizon */
  projected: {
    albumin: number;
    crp: number;
    handgripKg: number;
    nonHdlMgDl: number;
    potassium: number;
    bicarbonate: number;
    ktV: number;
  };
  /** PEW markers expected to resolve */
  markersResolved: number;
  projectedPotassiumRisk: number;
  riskTone: 'low' | 'moderate' | 'high';
  allowed: boolean;
  blockedReason?: string | undefined;
  requiresLabConfirmation: boolean;
  burden: number;
  score: number;
}

export interface NutritionWhatIfResult {
  patientId: string;
  current: { albumin?: number | undefined; potassium?: number | undefined; bicarbonate?: number | undefined };
  pew: ReturnType<typeof assessPew>;
  blocked: boolean;
  blockReason: string | null;
  horizonsDays: readonly number[];
  candidates: NutritionCandidate[];
  recommended?: NutritionCandidate | undefined;
  model: typeof NUTRITION_SIMULATOR_MODEL;
  synthetic: boolean;
  note: string;
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * Project one candidate intervention. The response fractions are documented:
 * dietitian-led support raises albumin ~0.25 g/dL and grip ~2 kg over 90 days;
 * an oral supplement adds ~0.35 g/dL; treating the inflammation source is the
 * only lever that moves albumin when CRP is high; a dose increase of +0.2 spKt/V
 * lowers potassium ~0.35 mmol/L and creatinine; alkali raises bicarbonate ~2.5
 * mmol/L and lowers potassium ~0.4 through the transcellular shift; a K-binder
 * lowers potassium ~0.6 mmol/L at 90 days.
 */
function projectCandidate(input: NutritionGuardInput, action: string): { projected: NutritionCandidate['projected']; markersResolved: number } {
  const albumin = input.albumin ?? 3.6;
  const crp = input.crp ?? 5;
  const grip = input.handgripKg ?? 28;
  const nonHdl = input.nonHdlMgDl ?? 115;
  const ktV = input.ktV ?? 1.3;
  const bicarb = input.bicarbonate ?? 22;
  const inflam = crp > NUTRITION_REFERENCE.crpInflammationMgL;
  const interval = input.interdialyticHours ?? 48;

  let dAlbumin = 0;
  let dCrp = 0;
  let dGrip = 0;
  let dNonHdl = 0;
  let dPotassium = 0;
  let dBicarb = 0;
  let dKtV = 0;
  let markersResolved = 0;

  switch (action) {
    case 'dietitian-referral':
      dAlbumin += 0.25; dGrip += 2; dNonHdl += 12; markersResolved = 2;
      break;
    case 'oral-nutrition-supplement':
      dAlbumin += 0.35; dGrip += 2.5; dNonHdl += 15; markersResolved = 2;
      break;
    case 'inflammation-review':
      // only meaningful when CRP is actually raised: treating the source is the
      // only lever that moves albumin when CRP is high (≈a 65% fall by 90 d)
      dCrp -= inflam ? Math.max(5, crp * 0.65) : 1;
      dAlbumin += inflam ? 0.45 : 0.05;
      dGrip += inflam ? 1.5 : 0.5;
      markersResolved = inflam ? 2 : 1;
      break;
    case 'target-weight-reassessment':
      dAlbumin += (input.dryWeightDeltaKg ?? 0) > 0.8 ? 0.3 : 0.05;
      dGrip += 0.5;
      markersResolved = 1;
      break;
    case 'dialysis-dose-review':
      dKtV += 0.2;
      dPotassium -= 0.35;
      dAlbumin += 0.05;
      markersResolved = ktV < 1.2 ? 1 : 0;
      break;
    case 'alkali-review':
      dBicarb += 2.5;
      dPotassium -= 0.4;
      markersResolved = bicarb < NUTRITION_REFERENCE.bicarbonateLowMmolL ? 1 : 0;
      break;
    case 'k-binder-plan':
      dPotassium -= 0.6;
      dBicarb += 0.5;
      markersResolved = 1;
      break;
    case 'diet-potassium-education':
      dPotassium -= 0.3;
      markersResolved = 1;
      break;
    case 'raasi-review':
      dPotassium -= 0.25;
      markersResolved = 1;
      break;
    default:
      markersResolved = 0;
  }

  // potassium accumulates with the interval again; the dose term is already in dPotassium
  const projectedKtV = Math.round((ktV + dKtV) * 100) / 100;
  const potassiumProjected = round2((input.potassium ?? 4.6) + dPotassium + (interval - 48) / 24 * 0.15);

  return {
    projected: {
      albumin: round2(albumin + dAlbumin),
      crp: round2(Math.max(0.2, crp + dCrp)),
      handgripKg: round2(grip + dGrip),
      nonHdlMgDl: round2(nonHdl + dNonHdl),
      potassium: potassiumProjected,
      bicarbonate: round2(bicarb + dBicarb),
      ktV: projectedKtV,
    },
    markersResolved,
  };
}

export function scoreNutritionCandidate(candidate: Omit<NutritionCandidate, 'score' | 'allowed' | 'blockedReason' | 'riskTone'>): number {
  const residualPew = Math.max(0, 5 - candidate.markersResolved) / 5;
  const potassiumOut = Math.max(0, candidate.projected.potassium - NUTRITION_REFERENCE.potassiumHighMmolL);
  const acidosis = Math.max(0, NUTRITION_REFERENCE.bicarbonateLowMmolL - candidate.projected.bicarbonate) / NUTRITION_REFERENCE.bicarbonateLowMmolL;
  return Math.round((
    NUTRITION_TRADEOFF_WEIGHTS.pewBurden * residualPew
    + NUTRITION_TRADEOFF_WEIGHTS.hyperkalemia * (candidate.projectedPotassiumRisk + potassiumOut)
    + NUTRITION_TRADEOFF_WEIGHTS.acidosis * acidosis
    + NUTRITION_TRADEOFF_WEIGHTS.burden * candidate.burden
  ) * 1000) / 1000;
}

const CANDIDATE_ACTIONS: Array<{ label: string; action: string; pathway: string; burden: number }> = [
  { label: 'Continue current care', action: 'continue', pathway: 'none', burden: 0 },
  { label: 'Dietitian referral (intake pathway)', action: 'dietitian-referral', pathway: 'poor-intake', burden: 0.3 },
  { label: 'Oral nutrition supplement', action: 'oral-nutrition-supplement', pathway: 'catabolism', burden: 0.5 },
  { label: 'Inflammation review (source search)', action: 'inflammation-review', pathway: 'inflammation', burden: 0.35 },
  { label: 'Target-weight reassessment', action: 'target-weight-reassessment', pathway: 'dilution', burden: 0.25 },
  { label: 'Dialysis dose review (+0.2 spKt/V)', action: 'dialysis-dose-review', pathway: 'inadequate-dialysis', burden: 0.45 },
  { label: 'Alkali review (correct acidosis)', action: 'alkali-review', pathway: 'acidosis', burden: 0.4 },
  { label: 'Potassium binder plan', action: 'k-binder-plan', pathway: 'hyperkalaemia', burden: 0.55 },
  { label: 'Diet potassium education', action: 'diet-potassium-education', pathway: 'hyperkalaemia', burden: 0.15 },
  { label: 'RAASi dose review', action: 'raasi-review', pathway: 'hyperkalaemia', burden: 0.2 },
];

export function nutritionWhatIf(input: NutritionGuardInput): NutritionWhatIfResult {
  const base = nutritionRecommend(input);
  const guardrails = guardNutritionPlan(input);
  const pew = assessPew(input);
  const forecast = forecastPotassium(input);

  const candidates: NutritionCandidate[] = CANDIDATE_ACTIONS.map((definition) => {
    const { projected, markersResolved } = projectCandidate(input, definition.action);
    const nextForecast = forecastPotassium({ ...input, potassium: projected.potassium, bicarbonate: projected.bicarbonate, ktV: projected.ktV });
    const projectedPotassiumRisk = nextForecast.probabilityAbove6 ?? 0;
    const allowed = !guardrails.blocked;
    const blockedReason = guardrails.blocked ? guardrails.blockReason ?? 'Blocked by guardrails.' : undefined;
    const partial = {
      label: definition.label,
      action: definition.action,
      pathway: definition.pathway,
      projected,
      markersResolved,
      projectedPotassiumRisk,
      allowed,
      ...(blockedReason ? { blockedReason } : {}),
      // ANY candidate that projects the potassium into the hyperkalaemic range,
      // or at an escalating probability, inherits the lab-confirmation contract
      requiresLabConfirmation: projected.potassium > NUTRITION_REFERENCE.potassiumHighMmolL - 0.2 || projectedPotassiumRisk >= NUTRITION_REFERENCE.hyperkalemiaActionThreshold,
      burden: definition.burden,
    };
    return {
      ...partial,
      riskTone: (projectedPotassiumRisk >= 0.6 ? 'high' : projectedPotassiumRisk >= NUTRITION_REFERENCE.hyperkalemiaActionThreshold ? 'moderate' : 'low') as NutritionCandidate['riskTone'],
      score: scoreNutritionCandidate(partial),
    };
  });

  const viable = candidates.filter((c) => c.allowed);
  const recommended = viable.length ? [...viable].sort((a, b) => a.score - b.score)[0] : undefined;

  return {
    patientId: input.patientId,
    current: { albumin: input.albumin, potassium: input.potassium, bicarbonate: input.bicarbonate },
    pew,
    blocked: guardrails.blocked,
    blockReason: guardrails.blockReason,
    horizonsDays: NUTRITION_REFERENCE.horizonsDays,
    candidates,
    recommended,
    model: NUTRITION_SIMULATOR_MODEL,
    synthetic: true,
    note: recommended
      ? `Lowest-burden plan: ${recommended.label} → projected albumin ${recommended.projected.albumin} g/dL, potassium ${recommended.projected.potassium} mmol/L, bicarbonate ${recommended.projected.bicarbonate} mmol/L at 90 d, resolving ${recommended.markersResolved} PEW marker(s)${recommended.requiresLabConfirmation ? ' — the potassium projection requires a confirmatory lab before any potassium-lowering action' : ''}. Advisory only.`
      : `No viable plan under the current guardrails${guardrails.blocked ? ` (${guardrails.blockReason})` : ''}.`,
  };
}

/**
 * Pathway attribution after a candidate: how much of the PEW burden each
 * pathway still carries. This is what makes the plan's *target* explicit.
 */
export function pathwayProjection(input: NutritionGuardInput, action: string): Array<{ pathway: string; before: number; after: number }> {
  const before = assessPew(input).pathways;
  const { projected } = projectCandidate(input, action);
  const after = assessPew({
    ...input,
    albumin: projected.albumin,
    crp: projected.crp,
    // the re-assessment sees the projected panel, so a projected fall in CRP can
    // actually resolve the inflammation pathway rather than being masked by the
    // historical series
    crpSeries: input.crpSeries ? [...input.crpSeries, projected.crp] : undefined,
    handgripKg: projected.handgripKg,
    nonHdlMgDl: projected.nonHdlMgDl,
    creatinineMgDl: input.creatinineMgDl !== undefined ? input.creatinineMgDl * (1 + ((input.ktV ?? 1.3) - projected.ktV) * 0.25) : undefined,
    ktV: projected.ktV,
    dryWeightDeltaKg: action === 'target-weight-reassessment' ? 0.2 : input.dryWeightDeltaKg,
    appetiteScore: action === 'dietitian-referral' || action === 'oral-nutrition-supplement' ? Math.min(10, (input.appetiteScore ?? 5) + 2) : input.appetiteScore,
  }).pathways;
  return before.map((b) => ({
    pathway: b.pathway,
    before: b.score,
    after: after.find((a) => a.pathway === b.pathway)?.score ?? b.score,
  }));
}

export { forecastPotassium };
