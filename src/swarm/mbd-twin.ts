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

// P4 step D — CKD-MBD twin over the REAL ledger.
//
// Reconstructs the serial [P, Ca, PTH] triplet history from `lab.result-arrived`
// events (attributed by order-id prefix, the same rule the cohort uses) plus the
// therapy exposure history from `medication.ordered` events, then checks the
// coupled responder against what actually happened: the observed change in each
// analyte after each therapy step is compared with the projected change. The
// score is per-analyte MAE (the §2.5 acceptance is multi-output MAE, not AUROC),
// and the verdict is "insufficient" when there are too few observed steps.

import { correctedCalcium, projectMbdTherapy, type MbdCoupledInput, type MbdTherapyState } from './mbd.js';
import { attributePatientIdFromOrder } from './renal-cohort.js';

export const MBD_TWIN_TARGET_MAE_MG_DL = 0.9;
/** a therapy step is only scorable once this many days have elapsed */
export const MBD_STEP_WINDOW_DAYS = 30;

export interface MbdTwinEventInput {
  realmId?: string;
  eventId?: string;
  kind: string;
  emittedAt: string;
  realmAt?: string;
  patientId?: string;
  payload: Record<string, unknown>;
}

export interface MbdTwinPatientInput { patientId: string; realmId?: string; state: Record<string, unknown> }

export interface MbdTriplet {
  at: string;
  phosphate?: number | undefined;
  calcium?: number | undefined;
  albumin?: number | undefined;
  correctedCalcium?: number | undefined;
  pth?: number | undefined;
  vitaminD?: number | undefined;
  /** complete triplet = P + Ca + PTH present */
  complete: boolean;
}

export interface MbdTherapyStep {
  at: string;
  code: string;
  /** the prescribed amount PER DOSE, in the unit prescribed */
  doseValue: number;
  unit: 'mg' | 'mcg';
  /** the order's frequency text, e.g. 'three times daily' / 'weekly' */
  frequency?: string | undefined;
  class: MbdTherapyState['binderClass'];
  kind: 'binder' | 'calcimimetic' | 'vitamin-d' | 'other';
}

export interface MbdTwin {
  patientId: string;
  asOf: string;
  triplets: MbdTriplet[];
  therapy: MbdTherapyStep[];
  currentTherapy: MbdTherapyState;
  summary: {
    triplets: number;
    completeTriplets: number;
    latestPhosphate?: number | undefined;
    latestCorrectedCalcium?: number | undefined;
    latestPth?: number | undefined;
    phosphateDelta30d?: number | undefined;
    calciumDelta30d?: number | undefined;
    pthDelta30d?: number | undefined;
    inTarget: boolean;
    therapySteps: number;
  };
  provenance: { source: 'realm-ledger'; labEvents: number; medEvents: number; attributedBy: 'payload-patientId' | 'order-id-prefix' | 'none'; synthetic: true };
}

const num = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number.parseFloat(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
};
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const atOf = (e: MbdTwinEventInput): string => e.realmAt ?? e.emittedAt;

const MBD_LAB_MAP: Record<string, keyof MbdTriplet> = {
  PHOS: 'phosphate',
  phosphate: 'phosphate',
  CALCIUM: 'calcium',
  calcium: 'calcium',
  ALBUMIN: 'albumin',
  albumin: 'albumin',
  PTH: 'pth',
  pth: 'pth',
  VITD: 'vitaminD',
  vitaminD: 'vitaminD',
};

function therapyClassOf(code: string): MbdTherapyStep['kind'] {
  if (['sevelamer', 'calcium-acetate', 'lanthanum', 'ferric-citrate'].includes(code)) return 'binder';
  if (code === 'cinacalcet' || code === 'etelcalcetide') return 'calcimimetic';
  if (code === 'calcitriol' || code === 'paricalcitol' || code === 'doxercalciferol') return 'vitamin-d';
  return 'other';
}

function binderClassOf(code: string): MbdTherapyState['binderClass'] {
  if (code === 'calcium-acetate') return 'calcium-acetate';
  if (code === 'lanthanum') return 'lanthanum';
  if (code === 'sevelamer') return 'sevelamer';
  return 'none';
}

const doseOf = (dose: string | undefined): { doseValue: number; unit: 'mg' | 'mcg' } => {
  const raw = (dose ?? '').trim();
  const value = Number.parseFloat(raw);
  return {
    doseValue: Number.isFinite(value) ? value : 0,
    unit: raw.toLowerCase().includes('mcg') ? 'mcg' : 'mg',
  };
};

/**
 * Doses per day implied by the order's frequency text. Pharmacy orders carry a
 * PER-DOSE amount ("sevelamer 800 mg three times daily"), so a daily-equivalent
 * needs the multiplier — dividing every order by 7 understates a tid binder by
 * a factor of 21 and makes the projection wrong.
 */
export function dosesPerDay(frequency: string | undefined): number {
  const f = (frequency ?? '').toLowerCase();
  if (!f) return 1; // an unlabelled order is treated as once daily
  if (f.includes('four times') || f.includes('qid') || f.includes('q6h')) return 4;
  if (f.includes('three times') || f.includes('tid') || f.includes('q8h')) return 3;
  if (f.includes('twice') || f.includes('bid') || f.includes('q12h')) return 2;
  if (f.includes('every other')) return 0.5;
  if (f.includes('monthly')) return 1 / 30;
  if (f.includes('weekly')) return 1 / 7;
  return 1;
}

/** Daily-equivalent therapy state from the most recent steps. */
export function currentTherapyFromSteps(steps: readonly MbdTherapyStep[]): MbdTherapyState {
  const state: MbdTherapyState = { binderMgPerDay: 0, binderClass: 'none', calcimimeticMgPerDay: 0, activeVitaminDMcgPerDay: 0 };
  for (const step of steps.slice(-8)) {
    const perDay = dosesPerDay(step.frequency);
    if (step.kind === 'binder') {
      const mg = step.unit === 'mcg' ? step.doseValue / 1000 : step.doseValue;
      state.binderMgPerDay = Math.round(mg * perDay);
      // the most recent recognised binder class wins (a switch must be visible)
      if (step.class !== 'none') state.binderClass = step.class;
    }
    if (step.kind === 'calcimimetic') {
      const mg = step.unit === 'mcg' ? step.doseValue / 1000 : step.doseValue;
      state.calcimimeticMgPerDay = Math.round(mg * perDay * 100) / 100;
    }
    if (step.kind === 'vitamin-d') {
      const mcg = step.unit === 'mg' ? step.doseValue * 1000 : step.doseValue;
      state.activeVitaminDMcgPerDay = Math.round(mcg * perDay * 100) / 100;
    }
  }
  return state;
}

export function buildMbdTwin(input: {
  patientId: string;
  events: readonly MbdTwinEventInput[];
  patients?: readonly MbdTwinPatientInput[];
  asOf?: string;
}): MbdTwin {
  const knownPatientIds = [input.patientId, ...(input.patients ?? []).map((p) => p.patientId)];
  const state = (input.patients ?? []).find((p) => p.patientId === input.patientId)?.state ?? {};
  const labs = (state.labs ?? {}) as Record<string, unknown>;

  // seed from the state cache (latest values), then overlay the ledger series
  const triplets: MbdTriplet[] = [];
  const seedAt = str((state.lastVitals as Record<string, unknown> | undefined)?.at) ?? str(state.admittedAt) ?? new Date().toISOString();
  const seeded: MbdTriplet = {
    at: seedAt,
    phosphate: num(labs.PHOS) ?? num(labs.phosphate),
    calcium: num(labs.calcium) ?? num(labs.CALCIUM),
    albumin: num(labs.albumin),
    pth: num(labs.pth),
    vitaminD: num(labs.vitaminD) ?? num(labs.VITD),
    complete: false,
  };
  seeded.correctedCalcium = seeded.calcium !== undefined ? correctedCalcium(seeded.calcium, seeded.albumin) : undefined;
  seeded.complete = seeded.phosphate !== undefined && seeded.calcium !== undefined && seeded.pth !== undefined;
  if (seeded.phosphate !== undefined || seeded.calcium !== undefined || seeded.pth !== undefined) triplets.push(seeded);

  const therapy: MbdTherapyStep[] = [];
  let attributedBy: MbdTwin['provenance']['attributedBy'] = 'none';
  let labEvents = 0;
  let medEvents = 0;

  for (const event of input.events) {
    const payloadPatient = str(event.payload.patientId);
    const owner = payloadPatient ?? attributePatientIdFromOrder(str(event.payload.orderId) ?? '', knownPatientIds);
    if (owner !== input.patientId) continue;

    if (event.kind === 'result-lab') {
      const code = str(event.payload.code) ?? '';
      const key = MBD_LAB_MAP[code];
      if (!key) continue;
      const value = num(event.payload.value);
      if (value === undefined) continue;
      labEvents += 1;
      attributedBy = payloadPatient ? 'payload-patientId' : 'order-id-prefix';
      const at = atOf(event);
      let triplet = triplets.find((t) => Math.abs(Date.parse(t.at) - Date.parse(at)) < 6 * 3_600_000);
      if (!triplet) {
        triplet = { at, complete: false };
        triplets.push(triplet);
      }
      (triplet as unknown as Record<string, number>)[key] = value;
      if (key === 'calcium') triplet.correctedCalcium = correctedCalcium(value, triplet.albumin);
      triplet.complete = triplet.phosphate !== undefined && triplet.calcium !== undefined && triplet.pth !== undefined;
    }

    if (event.kind === 'order-med') {
      const code = str(event.payload.code) ?? '';
      const kind = therapyClassOf(code);
      if (kind === 'other') continue;
      medEvents += 1;
      attributedBy = payloadPatient ? 'payload-patientId' : 'order-id-prefix';
      therapy.push({
        at: atOf(event),
        code,
        ...doseOf(str(event.payload.dose)),
        ...(str(event.payload.frequency) !== undefined ? { frequency: str(event.payload.frequency) } : {}),
        class: binderClassOf(code),
        kind,
      });
    }
  }

  triplets.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  therapy.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  // A panel batch can deliver calcium before albumin, so the correction is
  // recomputed once the batch is closed — otherwise the corrected calcium would
  // depend on the order the results happened to arrive in.
  for (const triplet of triplets) {
    if (triplet.calcium !== undefined) triplet.correctedCalcium = correctedCalcium(triplet.calcium, triplet.albumin);
    triplet.complete = triplet.phosphate !== undefined && triplet.calcium !== undefined && triplet.pth !== undefined;
  }

  const completeTriplets = triplets.filter((t) => t.complete);
  const latest = completeTriplets.at(-1) ?? triplets.at(-1);
  const thirtyDaysAgo = completeTriplets.filter((t) => Date.parse(t.at) <= Date.parse(latest?.at ?? new Date().toISOString()) - 20 * 86_400_000).at(-1);
  const delta = (a?: number, b?: number): number | undefined => (a !== undefined && b !== undefined ? Math.round((a - b) * 100) / 100 : undefined);

  const phosphate = latest?.phosphate;
  const corrected = latest?.correctedCalcium;
  const pth = latest?.pth;
  const inTarget = phosphate !== undefined && corrected !== undefined && pth !== undefined
    && phosphate >= 2.5 && phosphate <= 5.5 && corrected >= 8.4 && corrected <= 10.2 && pth >= 130 && pth <= 585;

  return {
    patientId: input.patientId,
    asOf: input.asOf ?? latest?.at ?? new Date().toISOString(),
    triplets,
    therapy,
    currentTherapy: currentTherapyFromSteps(therapy),
    summary: {
      triplets: triplets.length,
      completeTriplets: completeTriplets.length,
      latestPhosphate: phosphate,
      latestCorrectedCalcium: corrected,
      latestPth: pth,
      phosphateDelta30d: delta(phosphate, thirtyDaysAgo?.phosphate),
      calciumDelta30d: delta(corrected, thirtyDaysAgo?.correctedCalcium),
      pthDelta30d: delta(pth, thirtyDaysAgo?.pth),
      inTarget,
      therapySteps: therapy.length,
    },
    provenance: {
      source: 'realm-ledger',
      labEvents,
      medEvents,
      attributedBy,
      synthetic: true,
    },
  };
}

export interface MbdTwinDriftScore {
  n: number;
  steps: number;
  /** per-analyte MAE between the projected and observed change after each step */
  mae: { phosphate?: number | undefined; correctedCalcium?: number | undefined; pth?: number | undefined };
  overallMae?: number | undefined;
  bias: { phosphate?: number | undefined; correctedCalcium?: number | undefined; pth?: number | undefined };
  verdict: 'pass' | 'watch' | 'insufficient';
  targetMaeMgDl: number;
  rows: Array<{
    at: string;
    step: string;
    observedDelta: { phosphate?: number | undefined; correctedCalcium?: number | undefined; pth?: number | undefined };
    projectedDelta: { phosphate?: number | undefined; correctedCalcium?: number | undefined; pth?: number | undefined };
    error: { phosphate?: number | undefined; correctedCalcium?: number | undefined; pth?: number | undefined };
  }>;
  note: string;
}

const mean = (values: readonly number[]): number | undefined =>
  values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 1000) / 1000 : undefined;

/**
 * Score the coupled responder against observed therapy steps. For each step we
 * take the triplet before it and the first triplet after the response window,
 * and compare the observed per-analyte change with the projection of the same
 * step through the responder.
 */
export function scoreMbdTwinDrift(twin: MbdTwin, opts: { targetMaeMgDl?: number } = {}): MbdTwinDriftScore {
  const targetMaeMgDl = opts.targetMaeMgDl ?? MBD_TWIN_TARGET_MAE_MG_DL;
  const complete = twin.triplets.filter((t) => t.complete);
  const rows: MbdTwinDriftScore['rows'] = [];

  for (const step of twin.therapy) {
    const before = [...complete].filter((t) => Date.parse(t.at) <= Date.parse(step.at)).at(-1);
    const after = [...complete].filter((t) => Date.parse(t.at) >= Date.parse(step.at) + MBD_STEP_WINDOW_DAYS * 86_400_000).at(0);
    if (!before || !after) continue;
    const observedDelta = {
      phosphate: before.phosphate !== undefined && after.phosphate !== undefined ? Math.round((after.phosphate - before.phosphate) * 100) / 100 : undefined,
      correctedCalcium: before.correctedCalcium !== undefined && after.correctedCalcium !== undefined ? Math.round((after.correctedCalcium - before.correctedCalcium) * 100) / 100 : undefined,
      pth: before.pth !== undefined && after.pth !== undefined ? Math.round(after.pth - before.pth) : undefined,
    };
    // project the step from the "before" set point
    const projected = projectStepDelta(before, step);
    const error = {
      phosphate: observedDelta.phosphate !== undefined && projected.phosphate !== undefined ? Math.round((projected.phosphate - observedDelta.phosphate) * 100) / 100 : undefined,
      correctedCalcium: observedDelta.correctedCalcium !== undefined && projected.correctedCalcium !== undefined ? Math.round((projected.correctedCalcium - observedDelta.correctedCalcium) * 100) / 100 : undefined,
      pth: observedDelta.pth !== undefined && projected.pth !== undefined ? Math.round(projected.pth - observedDelta.pth) : undefined,
    };
    rows.push({ at: step.at, step: `${step.code} (${step.kind})`, observedDelta, projectedDelta: projected, error });
  }

  const err = (key: 'phosphate' | 'correctedCalcium' | 'pth'): number[] =>
    rows.map((r) => r.error[key]).filter((v): v is number => v !== undefined).map((v) => Math.abs(v));

  const mae = {
    phosphate: mean(err('phosphate')),
    correctedCalcium: mean(err('correctedCalcium')),
    pth: mean(err('pth')),
  };
  const bias = {
    phosphate: mean(rows.map((r) => r.projectedDelta.phosphate! - (r.observedDelta.phosphate ?? 0)).filter((v) => Number.isFinite(v))),
    correctedCalcium: mean(rows.map((r) => r.projectedDelta.correctedCalcium! - (r.observedDelta.correctedCalcium ?? 0)).filter((v) => Number.isFinite(v))),
    pth: mean(rows.map((r) => r.projectedDelta.pth! - (r.observedDelta.pth ?? 0)).filter((v) => Number.isFinite(v))),
  };
  const pooled = [...err('phosphate'), ...err('correctedCalcium'), ...err('pth').map((v) => v / 100)];
  const overallMae = mean(pooled);

  if (rows.length < 3) {
    return {
      n: complete.length,
      steps: rows.length,
      mae,
      bias,
      verdict: 'insufficient',
      targetMaeMgDl,
      rows,
      note: `${rows.length} scorable therapy step(s) with a complete triplet on both sides — at least 3 are needed before the coupled responder can be judged.`,
    };
  }

  const verdict: MbdTwinDriftScore['verdict'] = (mae.phosphate ?? 9) <= targetMaeMgDl && (mae.correctedCalcium ?? 9) <= targetMaeMgDl ? 'pass' : 'watch';
  return {
    n: complete.length,
    steps: rows.length,
    mae,
    bias,
    overallMae,
    verdict,
    targetMaeMgDl,
    rows,
    note: verdict === 'pass'
      ? `Coupled responder inside tolerance over ${rows.length} observed therapy step(s): phosphate MAE ${mae.phosphate} mg/dL, corrected calcium MAE ${mae.correctedCalcium} mg/dL (target ≤ ${targetMaeMgDl}).`
      : `Coupled responder outside tolerance over ${rows.length} observed step(s): phosphate MAE ${mae.phosphate ?? '—'} mg/dL, corrected calcium MAE ${mae.correctedCalcium ?? '—'} mg/dL (target ≤ ${targetMaeMgDl}) — the learned artifact (step E) must improve this before a therapy change is trusted.`,
  };
}

/** Project a single therapy step from a measured "before" triplet. */
function projectStepDelta(before: MbdTriplet, step: MbdTherapyStep): { phosphate?: number | undefined; correctedCalcium?: number | undefined; pth?: number | undefined } {
  const therapy: MbdTherapyState = { binderMgPerDay: 0, binderClass: 'none', calcimimeticMgPerDay: 0, activeVitaminDMcgPerDay: 0 };
  const next: MbdTherapyState = { ...therapy };
  const perDay = dosesPerDay(step.frequency);
  if (step.kind === 'binder') {
    const mg = step.unit === 'mcg' ? step.doseValue / 1000 : step.doseValue;
    therapy.binderMgPerDay = 0;
    next.binderMgPerDay = Math.round(mg * perDay);
    next.binderClass = step.class;
  } else if (step.kind === 'calcimimetic') {
    const mg = step.unit === 'mcg' ? step.doseValue / 1000 : step.doseValue;
    next.calcimimeticMgPerDay = Math.round(mg * perDay * 100) / 100;
  } else if (step.kind === 'vitamin-d') {
    const mcg = step.unit === 'mg' ? step.doseValue * 1000 : step.doseValue;
    next.activeVitaminDMcgPerDay = Math.round(mcg * perDay * 100) / 100;
  }
  const input: MbdCoupledInput = {
    patientId: 'twin-step',
    ...(before.phosphate !== undefined ? { phosphate: before.phosphate } : {}),
    ...(before.calcium !== undefined ? { calcium: before.calcium } : {}),
    ...(before.albumin !== undefined ? { albumin: before.albumin } : {}),
    ...(before.pth !== undefined ? { pth: before.pth } : {}),
    therapy,
  };
  const projection = projectMbdTherapy(input, next);
  const at90 = projection.points[90];
  const at30 = projection.points[30];
  return {
    phosphate: at30 && before.phosphate !== undefined ? Math.round((at30.phosphate - before.phosphate) * 100) / 100 : undefined,
    correctedCalcium: at30 && before.calcium !== undefined && at30.correctedCalcium !== undefined ? Math.round((at30.correctedCalcium - (before.correctedCalcium ?? before.calcium)) * 100) / 100 : undefined,
    pth: at90 && before.pth !== undefined ? Math.round(at90.pth - before.pth) : undefined,
  };
}

/** Window for the advisor, built from the twin. */
export function mbdWindowFromTwin(twin: MbdTwin, extra: Partial<MbdCoupledInput> = {}): MbdCoupledInput & { phosphateSeries?: number } {
  const complete = twin.triplets.filter((t) => t.complete);
  const latest = complete.at(-1) ?? twin.triplets.at(-1);
  return {
    patientId: twin.patientId,
    ...(latest?.phosphate !== undefined ? { phosphate: latest.phosphate } : {}),
    ...(latest?.calcium !== undefined ? { calcium: latest.calcium } : {}),
    ...(latest?.albumin !== undefined ? { albumin: latest.albumin } : {}),
    ...(latest?.pth !== undefined ? { pth: latest.pth } : {}),
    ...(latest?.vitaminD !== undefined ? { vitaminD: latest.vitaminD } : {}),
    triplets: complete.length,
    phosphateSeries: twin.triplets.filter((t) => t.phosphate !== undefined).length,
    ...(latest?.at !== undefined ? { lastTripletAt: latest.at } : {}),
    ...(twin.summary.phosphateDelta30d !== undefined ? { phosphateTrend30d: twin.summary.phosphateDelta30d } : {}),
    ...(twin.summary.calciumDelta30d !== undefined ? { calciumTrend30d: twin.summary.calciumDelta30d } : {}),
    therapy: twin.currentTherapy,
    ...extra,
    asOf: twin.asOf,
  };
}

export { correctedCalcium };
