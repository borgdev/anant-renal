/******************************************************************************
 * Anemia / ESA responsiveness phenotype — Paper B (Brier & Gaweda 2011).
 *
 * The review's clinical thesis is that ESA "resistance" is stratified: some
 * patients respond well, some have FUNCTIONAL iron deficiency (stores present,
 * not available), some are INFLAMMATORY poor responders, and some are frankly
 * refractory. Their biomarker panel (oncostatin-M receptor β, fibrinogen α/β,
 * complement C3, Factor XIII → poor; cysteine/histidine-rich 1 → good) is not
 * available from routine labs, so this module classifies the SAME clinical
 * buckets from routine surrogates the platform already governs:
 *
 *   • iron substrate      — ferritin / TSAT / MCV        (axis-1 of the latent)
 *   • inflammatory tone   — CRP (+ PTH/Calcium)          (axis-2 of the latent)
 *   • response to therapy — dose escalation without an Hb rise
 *   • dose intensity      — current weekly ESA dose
 *
 * Pure + deterministic. It CLASSIFIES and recommends a workup — it never orders
 * and it never overrides the iron-first guardrails.
 ******************************************************************************/

import { esaLatent, guardDose, type EsaPatientWindow } from './anemia.js';

export type EsaPhenotype =
  | 'responsive'
  | 'functional-iron-deficiency'
  | 'inflammatory-resistance'
  | 'refractory'
  | 'insufficient-data';

/* Classification thresholds (routine-lab surrogates for Paper B's panel). */
export const ESA_FUNCTIONAL_IRON_TSAT_MAX = 20;
export const ESA_FUNCTIONAL_IRON_FERRITIN_MIN = 100;
export const ESA_FUNCTIONAL_IRON_FERRITIN_MAX = 500;
export const ESA_INFLAMMATION_CRP_MIN = 10;
export const ESA_MICROCYTIC_MCV_MAX = 80;
export const ESA_REFRACTORY_DOSE_MIN = 12000;
export const ESA_MIN_TREND_POINTS = 3;

export interface EsaPhenotypeMarker {
  functionalIronDeficiency: boolean;
  ironPoor: boolean;
  lowMcv: boolean;
  inflammatory: boolean;
  escalationWithoutResponse: boolean;
  highDose: boolean;
  /** Latent axis-1 (iron/nutrition substrate), [-1, 1]. */
  ironAxis: number;
  /** Latent axis-2 (ESA resistance / inflammation), [-1, 1]. */
  resistanceAxis: number;
  doseIntensity: 'none' | 'low' | 'moderate' | 'high';
}

export interface EsaPhenotypeReadout {
  phenotype: EsaPhenotype;
  label: string;
  confidence: 'low' | 'moderate' | 'high';
  markers: EsaPhenotypeMarker;
  reasons: string[];
  workup: string[];
  note: string;
}

export const ESA_PHENOTYPE_CATALOG: readonly { id: EsaPhenotype; label: string; criterion: string; workup: string[] }[] = [
  {
    id: 'functional-iron-deficiency',
    label: 'Functional iron deficiency',
    criterion: `TSAT < ${ESA_FUNCTIONAL_IRON_TSAT_MAX}% with ferritin ${ESA_FUNCTIONAL_IRON_FERRITIN_MIN}–${ESA_FUNCTIONAL_IRON_FERRITIN_MAX} ng/mL (or MCV < ${ESA_MICROCYTIC_MCV_MAX} fL)`,
    workup: ['Replete IV iron before escalating ESA', 'Check B12 / folate', 'Reassess TSAT + ferritin in 4 weeks'],
  },
  {
    id: 'inflammatory-resistance',
    label: 'Inflammatory ESA resistance',
    criterion: `CRP ≥ ${ESA_INFLAMMATION_CRP_MIN} mg/L (or a high latent resistance axis) with a poor Hb response`,
    workup: ['Assess infection / inflammation source', 'Review albumin + access history', 'Avoid reflexive dose escalation'],
  },
  {
    id: 'refractory',
    label: 'Refractory (hyporesponse)',
    criterion: `Escalating dose ≥ ${ESA_REFRACTORY_DOSE_MIN} u/wk without an Hb rise, with inflammation and/or iron depletion`,
    workup: ['Structured ESA hyporesponse workup (iron, inflammation, occult blood loss, adherence)', 'Rule out malignancy / hyperparathyroidism', 'Nephrology review before further titration'],
  },
  {
    id: 'responsive',
    label: 'Responsive',
    criterion: 'Stable or improving Hb without escalation, adequate iron substrate and low inflammatory tone',
    workup: ['Maintain dose', 'Reassess monthly'],
  },
  {
    id: 'insufficient-data',
    label: 'Insufficient data',
    criterion: `Fewer than ${ESA_MIN_TREND_POINTS} weekly Hb samples (or no ESA picture) in the window`,
    workup: ['Obtain weekly Hb trend + iron panel before classifying'],
  },
];

const LABEL: Record<EsaPhenotype, string> = {
  responsive: 'Responsive',
  'functional-iron-deficiency': 'Functional iron deficiency',
  'inflammatory-resistance': 'Inflammatory ESA resistance',
  refractory: 'Refractory (hyporesponse)',
  'insufficient-data': 'Insufficient data',
};

const workupFor = (id: EsaPhenotype): string[] => [...(ESA_PHENOTYPE_CATALOG.find((p) => p.id === id)?.workup ?? [])];

/**
 * Classify ESA responsiveness from routine labs + the dose history. Precedence:
 * refractory → functional iron deficiency → inflammatory resistance → responsive.
 */
export function esaResponsiveness(window: EsaPatientWindow): EsaPhenotypeReadout {
  const trend = window.hgbTrendLast90d ?? [];
  const guard = guardDose(window);
  const { l1, l2 } = esaLatent({
    ...(window.mcv !== undefined ? { mcv: window.mcv } : {}),
    ...(window.ferritin !== undefined ? { ferritin: window.ferritin } : {}),
    ...(window.transferrinSat !== undefined ? { transferrinSat: window.transferrinSat } : {}),
    ...(window.crp !== undefined ? { crp: window.crp } : {}),
    ...(window.pth !== undefined ? { pth: window.pth } : {}),
    ...(window.calcium !== undefined ? { calcium: window.calcium } : {}),
  });

  const first = trend[0];
  const last = trend[trend.length - 1];
  const rise = first !== undefined && last !== undefined ? last - first : 0;
  const dose = Math.max(0, window.currentDose);
  const doseIntensity: EsaPhenotypeMarker['doseIntensity'] = dose === 0 ? 'none' : dose < 6000 ? 'low' : dose < ESA_REFRACTORY_DOSE_MIN ? 'moderate' : 'high';

  const markers: EsaPhenotypeMarker = {
    functionalIronDeficiency:
      window.transferrinSat !== undefined && window.transferrinSat < ESA_FUNCTIONAL_IRON_TSAT_MAX
      && window.ferritin !== undefined
      && window.ferritin >= ESA_FUNCTIONAL_IRON_FERRITIN_MIN
      && window.ferritin <= ESA_FUNCTIONAL_IRON_FERRITIN_MAX,
    ironPoor:
      (window.ferritin !== undefined && window.ferritin < ESA_FUNCTIONAL_IRON_FERRITIN_MIN)
      || (window.transferrinSat !== undefined && window.transferrinSat < ESA_FUNCTIONAL_IRON_TSAT_MAX),
    lowMcv: window.mcv !== undefined && window.mcv < ESA_MICROCYTIC_MCV_MAX,
    inflammatory:
      (window.crp !== undefined && window.crp >= ESA_INFLAMMATION_CRP_MIN) || l2 > 0.3,
    escalationWithoutResponse:
      guard.flags.includes('esa-dose-escalated-without-response-90d')
      || (window.esaEscalationsLast90d >= 2 && Math.abs(rise) < 0.5),
    highDose: dose >= ESA_REFRACTORY_DOSE_MIN,
    ironAxis: l1,
    resistanceAxis: l2,
    doseIntensity,
  };

  const reasons: string[] = [];
  if (markers.functionalIronDeficiency) {
    reasons.push(`TSAT ${window.transferrinSat}% with ferritin ${window.ferritin} ng/mL — stores present but not available (functional iron deficiency).`);
  }
  if (markers.lowMcv) reasons.push(`MCV ${window.mcv} fL is microcytic — iron/B12 substrate is the limit before ESA.`);
  if (markers.inflammatory) {
    reasons.push(
      window.crp !== undefined && window.crp >= ESA_INFLAMMATION_CRP_MIN
        ? `CRP ${window.crp} mg/L indicates inflammatory tone (a routine surrogate for Paper B's poor-response markers).`
        : `Latent resistance axis ${l2.toFixed(2)} indicates inflammatory ESA resistance.`,
    );
  }
  if (markers.escalationWithoutResponse) reasons.push(`Dose escalated over 90 days with an Hb change of ${rise.toFixed(1)} g/dL — no meaningful response.`);
  if (markers.highDose) reasons.push(`Current dose ${dose.toLocaleString()} u/wk is at the high-intensity band.`);
  if (!reasons.length) reasons.push('Stable Hb, adequate iron substrate and low inflammatory tone — no resistance marker present.');

  const plenty = trend.length >= ESA_MIN_TREND_POINTS;
  const evidenceCount = [markers.functionalIronDeficiency || markers.lowMcv || markers.ironPoor, markers.inflammatory, markers.escalationWithoutResponse].filter(Boolean).length;
  const confidence: EsaPhenotypeReadout['confidence'] = !plenty ? 'low' : evidenceCount >= 2 ? 'high' : 'moderate';

  let phenotype: EsaPhenotype;
  if (!plenty && (window.currentHgb === undefined || dose === 0)) {
    phenotype = 'insufficient-data';
  } else if (markers.escalationWithoutResponse && window.currentHgb < 11 && (markers.inflammatory || markers.highDose)) {
    phenotype = 'refractory';
  } else if (markers.functionalIronDeficiency || markers.lowMcv) {
    phenotype = 'functional-iron-deficiency';
  } else if (markers.inflammatory && (window.currentHgb < 11 || markers.escalationWithoutResponse)) {
    phenotype = 'inflammatory-resistance';
  } else if (!plenty) {
    phenotype = 'insufficient-data';
  } else {
    phenotype = 'responsive';
  }

  const note = phenotype === 'insufficient-data'
    ? `Not enough weekly Hb history (${trend.length}/${ESA_MIN_TREND_POINTS}) to classify ESA responsiveness — keep the engine in reference mode.`
    : `${LABEL[phenotype]} — ${reasons[0]}`;

  return {
    phenotype,
    label: LABEL[phenotype],
    confidence,
    markers,
    reasons,
    workup: workupFor(phenotype),
    note,
  };
}
