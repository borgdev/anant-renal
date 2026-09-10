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

// P5 step D — nutrition / electrolyte twin over the REAL ledger.
//
// Reconstructs the serial nutrition series (albumin, CRP, creatinine, non-HDL,
// potassium, bicarbonate), the handgrip assessments and the interdialytic
// intervals from the session ring, then scores the two P5 forecasts against what
// actually happened: the potassium forecast (MAE + event detection for K > 6.0)
// and the PEW assessment (observed vs predicted markers). Verdicts are
// "insufficient" rather than invented when the series is too short.

import {
  NUTRITION_REFERENCE, assessPew, forecastPotassium, type NutritionGuardInput,
} from './nutrition.js';
import { attributePatientIdFromOrder } from './renal-cohort.js';
// the session ring, the URR series and the clearance priors are shared with P1 so
// the potassium forecast's dose term is never a second, divergent estimate
import { sessionsFromState as adequacySessionsFromState, predictSessionUrr, URR_LAB_CODE } from './adequacy-twin.js';
import { spKtVFromUrr } from '../protocols/priors.js';

export const NUTRITION_TWIN_TARGET_K_MAE = 0.5;
export const NUTRITION_TWIN_TARGET_AUROC = 0.8;

export interface NutritionTwinEventInput {
  realmId?: string;
  eventId?: string;
  kind: string;
  emittedAt: string;
  realmAt?: string;
  patientId?: string;
  payload: Record<string, unknown>;
}

export interface NutritionTwinPatientInput { patientId: string; realmId?: string; state: Record<string, unknown> }

export interface NutritionObservation {
  at: string;
  albumin?: number | undefined;
  crp?: number | undefined;
  creatinineMgDl?: number | undefined;
  nonHdlMgDl?: number | undefined;
  potassium?: number | undefined;
  bicarbonate?: number | undefined;
  handgripKg?: number | undefined;
  /** session gap before this observation, when known */
  interdialyticHours?: number | undefined;
}

export interface NutritionTwin {
  patientId: string;
  asOf: string;
  observations: NutritionObservation[];
  sessions: Array<{ sessionId: string; endedAt: string; deliveredMinutes: number; ufVolumeL?: number | undefined; postWeightKg?: number | undefined; predictedSpKtV?: number | undefined }>;
  /** the observed URR series (the dose evidence), paired with its session */
  observedUrr: Array<{ at: string; urrPct: number; spKtV?: number | undefined }>;
  summary: {
    observations: number;
    latestAlbumin?: number | undefined;
    albuminTrend30d?: number | undefined;
    latestCrp?: number | undefined;
    latestHandgripKg?: number | undefined;
    latestNonHdlMgDl?: number | undefined;
    latestPotassium?: number | undefined;
    latestBicarbonate?: number | undefined;
    ktV?: number | undefined;
    interdialyticHours?: number | undefined;
    pewMarkers: number;
    pew: boolean;
    dominantPathway: string;
    ecgFlags: number;
  };
  /** device ECG patterns recorded on the ledger (adjuncts, never triggers) */
  ecgFlags: Array<{ at: string; pattern: string }>;
  provenance: { source: 'realm-ledger'; labEvents: number; assessmentEvents: number; urrResults: number; ktVSource: 'observed-urr' | 'modelled-from-delivery' | 'none'; attributedBy: 'payload-patientId' | 'order-id-prefix' | 'none';
    synthetic: true };
}

/**
 * Sessions with the delivered dose attached: the clearance prior's prediction from
 * the delivered parameters, which the observed URR (when present) supersedes.
 */
export function nutritionSessionsFromState(state: Record<string, unknown>): Array<{ sessionId: string; endedAt: string; deliveredMinutes: number; ufVolumeL?: number | undefined; postWeightKg?: number | undefined; predictedSpKtV?: number | undefined }> {
  return adequacySessionsFromState(state)
    .map((s) => {
      const predicted = predictSessionUrr(s).spKtV;
      return {
        sessionId: s.sessionId,
        endedAt: s.endedAt ?? s.startedAt ?? '',
        deliveredMinutes: s.deliveredMinutes,
        ...(s.ufVolumeL !== undefined ? { ufVolumeL: s.ufVolumeL } : {}),
        ...(s.postWeightKg !== undefined ? { postWeightKg: s.postWeightKg } : {}),
        ...(predicted !== undefined ? { predictedSpKtV: predicted } : {}),
      };
    })
    .filter((s) => s.endedAt.length > 0)
    .sort((a, b) => a.endedAt.localeCompare(b.endedAt));
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
const atOf = (e: NutritionTwinEventInput): string => e.realmAt ?? e.emittedAt;

const NUTRITION_LAB_MAP: Record<string, keyof NutritionObservation> = {
  ALBUMIN: 'albumin',
  albumin: 'albumin',
  CRP: 'crp',
  crp: 'crp',
  CREATININE: 'creatinineMgDl',
  creatinine: 'creatinineMgDl',
  NONHDL: 'nonHdlMgDl',
  nonHdlMgDl: 'nonHdlMgDl',
  K: 'potassium',
  potassium: 'potassium',
  BICARB: 'bicarbonate',
  bicarbonate: 'bicarbonate',
};

export function buildNutritionTwin(input: {
  patientId: string;
  events: readonly NutritionTwinEventInput[];
  patients?: readonly NutritionTwinPatientInput[];
  asOf?: string;
}): NutritionTwin {
  const knownPatientIds = [input.patientId, ...(input.patients ?? []).map((p) => p.patientId)];
  const state = (input.patients ?? []).find((p) => p.patientId === input.patientId)?.state ?? {};
  const observedUrrRaw: Array<{ at: string; urrPct: number }> = [];
  let urrResults = 0;

  const observations: NutritionObservation[] = [];
  const ecgFlags: Array<{ at: string; pattern: string }> = [];
  let attributedBy: NutritionTwin['provenance']['attributedBy'] = 'none';
  let labEvents = 0;
  let assessmentEvents = 0;

  // seed from the state cache (latest panel values) so a fresh realm still scores
  const labs = (state.labs ?? {}) as Record<string, unknown>;
  if (labs.albumin !== undefined || labs.K !== undefined) {
    observations.push({
      at: str((state.lastVitals as Record<string, unknown> | undefined)?.at) ?? new Date().toISOString(),
      albumin: num(labs.albumin),
      crp: num(labs.crp),
      creatinineMgDl: num(labs.creatinine),
      nonHdlMgDl: num(labs.nonHdlMgDl),
      potassium: num(labs.K),
      bicarbonate: num(labs.bicarb),
    });
  }

  for (const event of input.events) {
    const payloadPatient = str(event.payload.patientId);
    const owner = payloadPatient ?? attributePatientIdFromOrder(str(event.payload.orderId) ?? '', knownPatientIds);
    if (owner !== input.patientId) continue;
    const at = atOf(event);

    if (event.kind === 'result-lab' && str(event.payload.code) === URR_LAB_CODE) {
      const value = num(event.payload.value);
      if (value !== undefined) {
        urrResults += 1;
        observedUrrRaw.push({ at, urrPct: value });
        attributedBy = payloadPatient ? 'payload-patientId' : 'order-id-prefix';
      }
    }

    if (event.kind === 'result-lab') {
      const key = NUTRITION_LAB_MAP[str(event.payload.code) ?? ''];
      if (!key) continue;
      const value = num(event.payload.value);
      if (value === undefined) continue;
      labEvents += 1;
      attributedBy = payloadPatient ? 'payload-patientId' : 'order-id-prefix';
      let observation = observations.find((o) => Math.abs(Date.parse(o.at) - Date.parse(at)) < 6 * 3_600_000);
      if (!observation) {
        observation = { at };
        observations.push(observation);
      }
      (observation as unknown as Record<string, number>)[key] = value;
    }

    if (event.kind === 'record-assessment' && str(event.payload.assessmentId) === 'handgrip') {
      const value = num(event.payload.score);
      if (value === undefined) continue;
      assessmentEvents += 1;
      attributedBy = payloadPatient ? 'payload-patientId' : 'order-id-prefix';
      let observation = observations.find((o) => Math.abs(Date.parse(o.at) - Date.parse(at)) < 6 * 3_600_000);
      if (!observation) {
        observation = { at };
        observations.push(observation);
      }
      observation.handgripKg = value;
    }

    if (event.kind === 'flag-safety-event') {
      const kind = str(event.payload.safetyKind) ?? '';
      if (kind.startsWith('ecg-')) {
        ecgFlags.push({ at, pattern: kind.replace('ecg-', '') });
        attributedBy = payloadPatient ? 'payload-patientId' : 'order-id-prefix';
      }
    }
  }

  observations.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  // the dose: the OBSERVED URR when the session carries the UF volume and post
  // weight the single-pool prior needs, else the clearance prior from delivery,
  // else nothing (never an invented number)
  const sessions = nutritionSessionsFromState(state);
  const observedUrr = [...observedUrrRaw]
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .map((o) => {
      const session = [...sessions].reverse().find((s) => s.endedAt <= o.at);
      const spKtV = session && session.deliveredMinutes > 0 && session.ufVolumeL !== undefined && session.postWeightKg !== undefined
        ? spKtVFromUrr({ urrPct: o.urrPct, durationHours: session.deliveredMinutes / 60, ufVolumeL: session.ufVolumeL, postWeightKg: session.postWeightKg })
        : undefined;
      return { at: o.at, urrPct: o.urrPct, ...(spKtV !== undefined ? { spKtV } : {}) };
    });
  const ktVFromUrr = observedUrr.filter((o) => o.spKtV !== undefined).at(-1)?.spKtV;
  const ktVSource: NutritionTwin['provenance']['ktVSource'] = ktVFromUrr !== undefined
    ? 'observed-urr'
    : (sessions.at(-1)?.predictedSpKtV !== undefined ? 'modelled-from-delivery' : 'none');
  // interdialytic interval: the gap between the two most recent sessions
  const lastTwo = sessions.slice(-2);
  const interdialyticHours = lastTwo.length === 2 && lastTwo[0]!.endedAt && lastTwo[1]!.endedAt
    ? Math.round((Date.parse(lastTwo[1]!.endedAt) - Date.parse(lastTwo[0]!.endedAt)) / 3_600_000)
    : undefined;

  const albuminSeries = observations.map((o) => o.albumin).filter((v): v is number => v !== undefined);
  const crpSeries = observations.map((o) => o.crp).filter((v): v is number => v !== undefined);
  const potassiumSeries = observations.map((o) => o.potassium).filter((v): v is number => v !== undefined);
  const lastSessionKtV = ktVFromUrr ?? sessions.at(-1)?.predictedSpKtV;

  // "latest" means the last KNOWN value for that marker, not the value of the
  // last observation: a potassium drawn yesterday must not hide the albumin
  // measured a month ago, and the staleness rule needs the timestamp of the
  // POTASSIUM measurement, not of whatever was measured most recently.
  const lastWith = (key: keyof NutritionObservation): NutritionObservation | undefined => [...observations].reverse().find((o) => o[key] !== undefined);
  const albuminObs = lastWith('albumin');
  const crpObs = lastWith('crp');
  const potassiumObs = lastWith('potassium');
  const albuminThen = albuminObs
    ? [...observations].filter((o) => o.albumin !== undefined && Date.parse(o.at) <= Date.parse(albuminObs.at) - 20 * 86_400_000).at(-1)
    : undefined;

  const assessable: NutritionGuardInput = {
    patientId: input.patientId,
    ...(albuminObs?.albumin !== undefined ? { albumin: albuminObs.albumin } : {}),
    albuminSeries,
    ...(albuminObs?.albumin !== undefined && albuminThen?.albumin !== undefined
      ? { albuminTrend30d: Math.round((albuminObs.albumin - albuminThen.albumin) * 100) / 100 }
      : {}),
    ...(crpObs?.crp !== undefined ? { crp: crpObs.crp } : {}),
    crpSeries,
    ...(lastWith('handgripKg')?.handgripKg !== undefined ? { handgripKg: lastWith('handgripKg')!.handgripKg } : {}),
    ...(lastWith('nonHdlMgDl')?.nonHdlMgDl !== undefined ? { nonHdlMgDl: lastWith('nonHdlMgDl')!.nonHdlMgDl } : {}),
    ...(lastWith('creatinineMgDl')?.creatinineMgDl !== undefined ? { creatinineMgDl: lastWith('creatinineMgDl')!.creatinineMgDl } : {}),
    ...(potassiumObs?.potassium !== undefined ? { potassium: potassiumObs.potassium } : {}),
    potassiumSeries,
    ...(potassiumObs?.at !== undefined ? { potassiumMeasuredAt: potassiumObs.at } : {}),
    ...(lastWith('bicarbonate')?.bicarbonate !== undefined ? { bicarbonate: lastWith('bicarbonate')!.bicarbonate } : {}),
    ...(interdialyticHours !== undefined ? { interdialyticHours } : {}),
    ...(lastSessionKtV !== undefined ? { ktV: lastSessionKtV } : {}),
  };
  const pew = assessPew(assessable);

  return {
    patientId: input.patientId,
    asOf: input.asOf ?? observations.at(-1)?.at ?? new Date().toISOString(),
    observations,
    sessions,
    observedUrr,
    summary: {
      observations: observations.length,
      ...(albuminObs?.albumin !== undefined ? { latestAlbumin: albuminObs.albumin } : {}),
      ...(assessable.albuminTrend30d !== undefined ? { albuminTrend30d: assessable.albuminTrend30d } : {}),
      ...(crpObs?.crp !== undefined ? { latestCrp: crpObs.crp } : {}),
      ...(assessable.handgripKg !== undefined ? { latestHandgripKg: assessable.handgripKg } : {}),
      ...(assessable.nonHdlMgDl !== undefined ? { latestNonHdlMgDl: assessable.nonHdlMgDl } : {}),
      ...(potassiumObs?.potassium !== undefined ? { latestPotassium: potassiumObs.potassium } : {}),
      ...(assessable.bicarbonate !== undefined ? { latestBicarbonate: assessable.bicarbonate } : {}),
      ...(lastSessionKtV !== undefined ? { ktV: lastSessionKtV } : {}),
      ...(interdialyticHours !== undefined ? { interdialyticHours } : {}),
      pewMarkers: pew.markersPresent,
      pew: pew.pew,
      dominantPathway: pew.dominant,
      ecgFlags: ecgFlags.length,
    },
    ecgFlags,
    provenance: {
      source: 'realm-ledger',
      labEvents,
      assessmentEvents,
      urrResults,
      ktVSource,
      attributedBy,
      synthetic: true,
    },
  };
}

export interface NutritionTwinDriftScore {
  n: number;
  potassiumPairs: number;
  /** potassium forecast error (MAE, mmol/L) */
  potassiumMae?: number | undefined;
  potassiumBias?: number | undefined;
  /** event detection for K > 6.0 across consecutive observations */
  auroc?: number | undefined;
  events: number;
  observedEvents: number;
  pewAgreement: { predicted: boolean; observedMarkers: number } | undefined;
  verdict: 'pass' | 'watch' | 'insufficient';
  targetMae: number;
  targetAuroc: number;
  rows: Array<{ at: string; observed: number | undefined; projected?: number | undefined; event: boolean }>;
  note: string;
}

function aurocLocal(rows: Array<{ score: number; label: 0 | 1 }>): number | undefined {
  const pos = rows.filter((r) => r.label === 1).length;
  const neg = rows.length - pos;
  if (!pos || !neg) return undefined;
  const sorted = [...rows].sort((a, b) => a.score - b.score);
  const ranks = new Array<number>(sorted.length).fill(0);
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1]!.score === sorted[i]!.score) j += 1;
    const avg = (i + j + 2) / 2;
    for (let k = i; k <= j; k += 1) ranks[k] = avg;
    i = j + 1;
  }
  let rankSum = 0;
  for (let k = 0; k < sorted.length; k += 1) if (sorted[k]!.label === 1) rankSum += ranks[k]!;
  return Math.round(((rankSum - (pos * (pos + 1)) / 2) / (pos * neg)) * 10000) / 10000;
}

/**
 * Score the two P5 forecasts against the observed series:
 *  - the potassium forecast is walked forward one observation at a time (the
 *    same forecast the advisor runs) and compared with what the next potassium
 *    actually was, giving MAE and an event detection AUROC for K > 6.0;
 *  - the PEW assessment is reported against the observed marker count.
 */
export function scoreNutritionTwinDrift(twin: NutritionTwin, opts: { targetMae?: number; targetAuroc?: number } = {}): NutritionTwinDriftScore {
  const targetMae = opts.targetMae ?? NUTRITION_TWIN_TARGET_K_MAE;
  const targetAuroc = opts.targetAuroc ?? NUTRITION_TWIN_TARGET_AUROC;
  const series = twin.observations.filter((o) => o.potassium !== undefined);
  const rows: NutritionTwinDriftScore['rows'] = [];
  const pairs: Array<{ score: number; label: 0 | 1 }> = [];

  for (let i = 0; i < series.length - 1; i += 1) {
    const current = series[i]!;
    const next = series[i + 1]!;
    const forecast = forecastPotassium({
      patientId: twin.patientId,
      potassium: current.potassium,
      bicarbonate: current.bicarbonate,
      ktV: twin.summary.ktV,
      interdialyticHours: twin.summary.interdialyticHours,
    });
    if (forecast.nextSession === undefined || next.potassium === undefined) continue;
    const event = next.potassium > NUTRITION_REFERENCE.potassiumHighMmolL;
    rows.push({ at: next.at, observed: next.potassium, projected: forecast.nextSession, event });
    pairs.push({ score: forecast.probabilityAbove6 ?? 0, label: event ? 1 : 0 });
  }

  const errors = rows.map((r) => (r.projected ?? 0) - (r.observed ?? 0));
  const potassiumMae = errors.length ? Math.round((errors.reduce((a, b) => a + Math.abs(b), 0) / errors.length) * 1000) / 1000 : undefined;
  const potassiumBias = errors.length ? Math.round((errors.reduce((a, b) => a + b, 0) / errors.length) * 1000) / 1000 : undefined;
  const events = pairs.filter((p) => p.label === 1).length;
  const auroc = aurocLocal(pairs);

  if (rows.length < 4 || events === 0) {
    return {
      n: series.length,
      potassiumPairs: rows.length,
      potassiumMae,
      potassiumBias,
      events,
      observedEvents: events,
      pewAgreement: { predicted: twin.summary.pew, observedMarkers: twin.summary.pewMarkers },
      verdict: 'insufficient',
      targetMae,
      targetAuroc,
      rows,
      note: rows.length < 4
        ? `Only ${rows.length} consecutive potassium pair(s) with a forecast — at least 4 (with at least one K > ${NUTRITION_REFERENCE.potassiumHighMmolL} event) are needed before the potassium forecast can be judged.`
        : `No potassium above ${NUTRITION_REFERENCE.potassiumHighMmolL} in the observed window — the event-detection AUROC cannot be measured yet.`,
    };
  }

  const verdict: NutritionTwinDriftScore['verdict'] = (potassiumMae ?? 9) <= targetMae && (auroc ?? 0) >= targetAuroc ? 'pass' : 'watch';
  return {
    n: series.length,
    potassiumPairs: rows.length,
    potassiumMae,
    potassiumBias,
    auroc,
    events,
    observedEvents: events,
    pewAgreement: { predicted: twin.summary.pew, observedMarkers: twin.summary.pewMarkers },
    verdict,
    targetMae,
    targetAuroc,
    rows,
    note: verdict === 'pass'
      ? `Potassium forecast inside tolerance over ${rows.length} forward pairs: MAE ${potassiumMae} mmol/L (≤ ${targetMae}) and event AUROC ${auroc} (≥ ${targetAuroc}) for K > ${NUTRITION_REFERENCE.potassiumHighMmolL} across ${events} event(s).`
      : `Potassium forecast MAE ${potassiumMae ?? '—'} mmol/L / event AUROC ${auroc ?? '—'} over ${rows.length} pairs does not yet meet the ${targetMae} mmol/L and ${targetAuroc} targets — the learned head (step E) must improve it before the forecast is trusted.`,
  };
}

/** Window for the advisor, built from the twin. */
export function nutritionWindowFromTwin(twin: NutritionTwin, extra: Partial<NutritionGuardInput> = {}): NutritionGuardInput {
  const albuminSeries = twin.observations.map((o) => o.albumin).filter((v): v is number => v !== undefined);
  const crpSeries = twin.observations.map((o) => o.crp).filter((v): v is number => v !== undefined);
  const potassiumSeries = twin.observations.map((o) => o.potassium).filter((v): v is number => v !== undefined);
  const creatinineSeries = twin.observations.map((o) => o.creatinineMgDl).filter((v): v is number => v !== undefined);
  const latest = twin.observations.at(-1);
  return {
    patientId: twin.patientId,
    albumin: twin.summary.latestAlbumin,
    albuminSeries,
    ...(twin.summary.albuminTrend30d !== undefined ? { albuminTrend30d: twin.summary.albuminTrend30d } : {}),
    crp: twin.summary.latestCrp,
    crpSeries,
    handgripKg: twin.summary.latestHandgripKg,
    nonHdlMgDl: twin.summary.latestNonHdlMgDl,
    creatinineMgDl: latest?.creatinineMgDl,
    creatinineSeries,
    potassium: twin.summary.latestPotassium,
    potassiumSeries,
    ...(latest?.at !== undefined ? { potassiumMeasuredAt: latest.at } : {}),
    bicarbonate: twin.summary.latestBicarbonate,
    ...(twin.summary.interdialyticHours !== undefined ? { interdialyticHours: twin.summary.interdialyticHours } : {}),
    ...(twin.summary.ktV !== undefined ? { ktV: twin.summary.ktV } : {}),
    ...(twin.ecgFlags.length ? { ecgFlags: twin.ecgFlags.map((e) => e.pattern) } : {}),
    ...extra,
    asOf: twin.asOf,
  };
}

export { NUTRITION_REFERENCE };
