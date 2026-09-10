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

// P3 step D — access twin over the REAL ledger.
//
// The twin folds the reducer's access observation ring (plus any ledger
// `record-access` event that never reached the ring, e.g. after a realm
// restore) into a Δ-from-baseline series, scores every observation with the
// mechanistic prior, and then checks the prior against what actually happened:
// an intervention or a thrombosis is the observed outcome of a progressing
// stenosis. Acoustic captures are reported for provenance only and never enter
// the score unless the ingestion flag is on.

import {
  ACCESS_REFERENCE, accessBaseline, stenosisProbability, thrombosisRisk, type AccessGuardInput,
} from './access.js';
import { accessAcousticEnabled } from './access-governance.js';
import { attributePatientIdFromOrder } from './renal-cohort.js';

export const ACCESS_TWIN_TARGET_AUROC = 0.8;
/** an intervention/thrombosis within this window counts as the observed outcome of a stenosis */
export const ACCESS_OUTCOME_WINDOW_DAYS = 30;

export interface AccessTwinEventInput {
  realmId?: string;
  eventId?: string;
  kind: string;
  emittedAt: string;
  realmAt?: string;
  patientId?: string;
  payload: Record<string, unknown>;
}

export interface AccessTwinPatientInput { patientId: string; realmId?: string; state: Record<string, unknown> }

export interface AccessTwinObservation {
  at: string;
  event: string;
  /** measured values as recorded */
  venousPressureMmHg?: number | undefined;
  arterialPressureMmHg?: number | undefined;
  measuredAtQb?: number | undefined;
  bloodFlowMlMin?: number | undefined;
  accessFlowMlMin?: number | undefined;
  recirculationPct?: number | undefined;
  deliveredClearancePct?: number | undefined;
  cannulationDifficulty?: string | undefined;
  /** Δ from the patient's own baseline */
  venousPressureDeltaPct?: number | undefined;
  accessFlowDeltaPct?: number | undefined;
  deliveredClearanceDeltaPct?: number | undefined;
  /** prior outputs */
  stenosisProbability?: number | undefined;
  thrombosisRisk30d?: number | undefined;
  thrombosisRisk90d?: number | undefined;
  /** observed outcome — an intervention or thrombosis within the window */
  outcome?: boolean | undefined;
  outcomeEvent?: string | undefined;
  /** synthetic acoustic delta vs the patient's baseline capture (gated) */
  acousticDeltaScore?: number | undefined;
  acousticProvenance?: string | undefined;
}

export interface AccessTwin {
  patientId: string;
  asOf: string;
  accessType?: string | undefined;
  observations: AccessTwinObservation[];
  interventions: Array<{ at: string; event: string }>;
  acoustic: {
    captures: number;
    baselineFeatures?: number[] | undefined;
    provenance: string[];
    synthetic: true;
    /** false unless ACCESS_ACOUSTIC_ENABLED — the score is reported, never used */
    enabled: boolean;
  };
  summary: {
    observations: number;
    measured: number;
    venousPressureDeltaPct?: number | undefined;
    recirculationPct?: number | undefined;
    accessFlowMlMin?: number | undefined;
    accessFlowDeltaPct?: number | undefined;
    latestStenosisProbability?: number | undefined;
    peakStenosisProbability?: number | undefined;
    interventions: number;
    thromboses: number;
    surveillanceGapDays?: number | undefined;
  };
  provenance: { source: 'realm-ledger'; accessEvents: number; acousticEvents: number; attributedBy: 'payload-patientId' | 'order-id-prefix' | 'none'; synthetic: true };
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
const atOf = (e: AccessTwinEventInput): string => e.realmAt ?? e.emittedAt;
const round1 = (v: number): number => Math.round(v * 10) / 10;

interface RawObservation {
  at: string;
  event: string;
  venousPressureMmHg?: number | undefined;
  arterialPressureMmHg?: number | undefined;
  measuredAtQb?: number | undefined;
  bloodFlowMlMin?: number | undefined;
  accessFlowMlMin?: number | undefined;
  recirculationPct?: number | undefined;
  deliveredClearancePct?: number | undefined;
  cannulationDifficulty?: string | undefined;
}

/** Fold the reducer's access observation ring into raw observations. */
export function accessObservationsFromState(state: Record<string, unknown>): RawObservation[] {
  const raw = Array.isArray(state.accessObservations) ? (state.accessObservations as Array<Record<string, unknown>>) : [];
  return raw.map((o) => ({
    at: str(o.at) ?? '',
    event: str(o.event) ?? 'surveillance',
    venousPressureMmHg: num(o.venousPressureMmHg),
    arterialPressureMmHg: num(o.arterialPressureMmHg),
    measuredAtQb: num(o.measuredAtQb),
    bloodFlowMlMin: num(o.bloodFlowMlMin),
    accessFlowMlMin: num(o.accessFlowMlMin),
    recirculationPct: num(o.recirculationPct),
    deliveredClearancePct: num(o.deliveredClearancePct),
    cannulationDifficulty: str(o.cannulationDifficulty),
  })).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

const pctChange = (current: number | undefined, baseline: number | undefined): number | undefined =>
  current !== undefined && baseline !== undefined && baseline !== 0
    ? round1(((current - baseline) / Math.abs(baseline)) * 100)
    : undefined;

const ACOUSTIC_HIGH_BAND = 8;

function acousticDeltaScoreOf(baseline: number[] | undefined, current: number[] | undefined): number | undefined {
  if (!baseline?.length || !current?.length) return undefined;
  const n = Math.min(baseline.length, current.length, ACOUSTIC_HIGH_BAND);
  let acc = 0;
  for (let i = 0; i < n; i += 1) {
    const b = baseline[i] ?? 0;
    const c = current[i] ?? 0;
    acc += b === 0 ? 0 : Math.abs((c - b) / b);
  }
  return Math.round((acc / n) * 1000) / 1000;
}

export function buildAccessTwin(input: {
  patientId: string;
  events: readonly AccessTwinEventInput[];
  patients?: readonly AccessTwinPatientInput[];
  asOf?: string;
}): AccessTwin {
  const knownPatientIds = [input.patientId, ...(input.patients ?? []).map((p) => p.patientId)];
  const state = (input.patients ?? []).find((p) => p.patientId === input.patientId)?.state ?? {};
  const accessRaw = (state.access ?? {}) as Record<string, unknown>;
  const observations = accessObservationsFromState(state);
  // signatures of the observations ALREADY in the ring: ledger events are
  // de-duplicated against these only (two real observations can share a
  // timestamp, e.g. a surveillance value and an event in the same minute).
  const ringSignatures = new Set(observations.map((o) => `${o.at}|${o.event}|${o.venousPressureMmHg ?? ''}|${o.accessFlowMlMin ?? ''}`));
  const interventions: Array<{ at: string; event: string }> = Array.isArray(accessRaw.events)
    ? (accessRaw.events as Array<Record<string, unknown>>)
      .filter((e) => ['angioplasty', 'declot', 'thrombosis', 'catheter-placed', 'avf-created'].includes(str(e.event) ?? ''))
      .map((e) => ({ at: str(e.at) ?? '', event: str(e.event) ?? '' }))
    : [];

  const acousticCaptures: Array<{ at: string; features: number[]; baseline: boolean; provenance: string }> = Array.isArray(state.accessAcoustic)
    ? (state.accessAcoustic as Array<Record<string, unknown>>).map((c) => ({
      at: str(c.at) ?? '',
      features: Array.isArray(c.features) ? (c.features as unknown[]).map((v) => num(v) ?? 0) : [],
      baseline: c.baseline === true,
      provenance: str(c.provenance) ?? '',
    }))
    : [];

  let attributedBy: AccessTwin['provenance']['attributedBy'] = 'none';
  let accessEvents = 0;
  let acousticEvents = 0;

  for (const event of input.events) {
    const payloadPatient = str(event.payload.patientId);
    const owner = payloadPatient ?? attributePatientIdFromOrder(str(event.payload.orderId) ?? '', knownPatientIds);
    if (owner !== input.patientId) continue;

    if (event.kind === 'record-access') {
      accessEvents += 1;
      attributedBy = payloadPatient ? 'payload-patientId' : 'order-id-prefix';
      const at = atOf(event);
      const eventName = str(event.payload.event) ?? 'surveillance';
      const signature = `${at}|${eventName}|${num(event.payload.venousPressureMmHg) ?? ''}|${num(event.payload.accessFlowMlMin) ?? ''}`;
      if (!ringSignatures.has(signature)) {
        ringSignatures.add(signature);
        observations.push({
          at,
          event: eventName,
          venousPressureMmHg: num(event.payload.venousPressureMmHg),
          arterialPressureMmHg: num(event.payload.arterialPressureMmHg),
          measuredAtQb: num(event.payload.measuredAtQb),
          bloodFlowMlMin: num(event.payload.bloodFlowMlMin),
          accessFlowMlMin: num(event.payload.accessFlowMlMin),
          recirculationPct: num(event.payload.recirculationPct),
          deliveredClearancePct: num(event.payload.deliveredClearancePct),
          cannulationDifficulty: str(event.payload.cannulationDifficulty),
        });
      }
      if (['angioplasty', 'declot', 'thrombosis', 'catheter-placed', 'avf-created'].includes(str(event.payload.event) ?? '')) {
        if (!interventions.some((i) => i.at === at && i.event === str(event.payload.event))) {
          interventions.push({ at, event: str(event.payload.event) ?? '' });
        }
      }
    }
    if (event.kind === 'record-access-acoustic') {
      acousticEvents += 1;
      acousticCaptures.push({
        at: atOf(event),
        features: Array.isArray(event.payload.features) ? (event.payload.features as unknown[]).map((v) => num(v) ?? 0) : [],
        baseline: event.payload.baseline === true,
        provenance: str(event.payload.provenance) ?? '',
      });
    }
  }

  const ringInterventions = observations
    .filter((o) => ['angioplasty', 'declot', 'thrombosis', 'catheter-placed', 'avf-created'].includes(o.event))
    .map((o) => ({ at: o.at, event: o.event }));
  for (const intervention of ringInterventions) {
    if (!interventions.some((i) => i.at === intervention.at && i.event === intervention.event)) interventions.push(intervention);
  }
  observations.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  interventions.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  const pressureSeries = observations.map((o) => o.venousPressureMmHg).filter((v): v is number => v !== undefined);
  const flowSeries = observations.map((o) => o.accessFlowMlMin).filter((v): v is number => v !== undefined);
  const clearanceSeries = observations.map((o) => o.deliveredClearancePct).filter((v): v is number => v !== undefined);
  const pressureBaseline = accessBaseline(pressureSeries);
  const flowBaseline = accessBaseline(flowSeries);
  const clearanceBaseline = accessBaseline(clearanceSeries);

  const baselineCapture = acousticCaptures.find((c) => c.baseline) ?? acousticCaptures[0];
  const latestCapture = acousticCaptures[acousticCaptures.length - 1];
  const enabled = accessAcousticEnabled();
  const acousticDelta = enabled && baselineCapture && latestCapture && latestCapture.at !== baselineCapture.at
    ? acousticDeltaScoreOf(baselineCapture.features, latestCapture.features)
    : undefined;

  // Score every observation with the mechanistic prior, then label the outcome.
  const outcomeWindowMs = ACCESS_OUTCOME_WINDOW_DAYS * 86_400_000;
  const scored: AccessTwinObservation[] = observations.map((o, index) => {
    const window: AccessGuardInput & { patientId: string } = {
      patientId: input.patientId,
      ...(str(accessRaw.type) ? { accessType: str(accessRaw.type) as AccessGuardInput['accessType'] } : {}),
      ...(num(accessRaw.ageDays) !== undefined ? { accessAgeDays: num(accessRaw.ageDays) } : {}),
      observations: index + 1,
      ...(o.venousPressureMmHg !== undefined ? { venousPressureMmHg: o.venousPressureMmHg } : {}),
      ...(pressureBaseline !== undefined ? { venousPressureBaselineMmHg: pressureBaseline } : {}),
      ...(o.recirculationPct !== undefined ? { recirculationPct: o.recirculationPct } : {}),
      ...(o.accessFlowMlMin !== undefined ? { accessFlowMlMin: o.accessFlowMlMin } : {}),
      ...(flowBaseline !== undefined ? { accessFlowBaselineMlMin: flowBaseline } : {}),
      ...(o.deliveredClearancePct !== undefined ? { deliveredClearancePct: o.deliveredClearancePct } : {}),
      ...(clearanceBaseline !== undefined ? { deliveredClearanceBaselinePct: clearanceBaseline } : {}),
      ...(o.cannulationDifficulty !== undefined ? { cannulationDifficulty: o.cannulationDifficulty as AccessGuardInput['cannulationDifficulty'] } : {}),
      priorInterventions: interventions.filter((i) => Date.parse(i.at) <= Date.parse(o.at)).length,
    };
    const observed = interventions.find((i) => {
      const dt = Date.parse(i.at) - Date.parse(o.at);
      return dt >= 0 && dt <= outcomeWindowMs;
    });
    return {
      at: o.at,
      event: o.event,
      venousPressureMmHg: o.venousPressureMmHg,
      arterialPressureMmHg: o.arterialPressureMmHg,
      measuredAtQb: o.measuredAtQb,
      bloodFlowMlMin: o.bloodFlowMlMin,
      accessFlowMlMin: o.accessFlowMlMin,
      recirculationPct: o.recirculationPct,
      deliveredClearancePct: o.deliveredClearancePct,
      cannulationDifficulty: o.cannulationDifficulty,
      venousPressureDeltaPct: pctChange(o.venousPressureMmHg, pressureBaseline),
      accessFlowDeltaPct: pctChange(o.accessFlowMlMin, flowBaseline),
      deliveredClearanceDeltaPct: pctChange(o.deliveredClearancePct, clearanceBaseline),
      stenosisProbability: stenosisProbability(window),
      thrombosisRisk30d: thrombosisRisk(window, 30),
      thrombosisRisk90d: thrombosisRisk(window, 90),
      ...(observed ? { outcome: true, outcomeEvent: observed.event } : { outcome: false }),
      ...(acousticDelta !== undefined && index === observations.length - 1 ? { acousticDeltaScore: acousticDelta } : {}),
      ...(latestCapture ? { acousticProvenance: latestCapture.provenance } : {}),
    };
  });

  const latest = scored[scored.length - 1];
  const measured = scored.filter((o) => o.venousPressureMmHg !== undefined || o.accessFlowMlMin !== undefined).length;
  const lastAt = scored[scored.length - 1]?.at;
  const asOf = input.asOf ?? lastAt ?? new Date().toISOString();
  const surveillanceGapDays = lastAt ? Math.round((Date.parse(asOf) - Date.parse(lastAt)) / 86_400_000) : undefined;

  return {
    patientId: input.patientId,
    asOf,
    ...(str(accessRaw.type) ? { accessType: str(accessRaw.type) } : {}),
    observations: scored,
    interventions,
    acoustic: {
      captures: acousticCaptures.length,
      ...(baselineCapture ? { baselineFeatures: baselineCapture.features } : {}),
      provenance: [...new Set(acousticCaptures.map((c) => c.provenance).filter((p) => p.length > 0))],
      synthetic: true,
      enabled,
    },
    summary: {
      observations: scored.length,
      measured,
      ...(latest?.venousPressureDeltaPct !== undefined ? { venousPressureDeltaPct: latest.venousPressureDeltaPct } : {}),
      ...(latest?.recirculationPct !== undefined ? { recirculationPct: latest.recirculationPct } : {}),
      ...(latest?.accessFlowMlMin !== undefined ? { accessFlowMlMin: latest.accessFlowMlMin } : {}),
      ...(latest?.accessFlowDeltaPct !== undefined ? { accessFlowDeltaPct: latest.accessFlowDeltaPct } : {}),
      ...(latest?.stenosisProbability !== undefined ? { latestStenosisProbability: latest.stenosisProbability } : {}),
      ...(scored.length ? { peakStenosisProbability: Math.max(...scored.map((o) => o.stenosisProbability ?? 0)) } : {}),
      interventions: interventions.filter((i) => i.event !== 'thrombosis').length,
      thromboses: interventions.filter((i) => i.event === 'thrombosis').length,
      ...(surveillanceGapDays !== undefined ? { surveillanceGapDays } : {}),
    },
    provenance: {
      source: 'realm-ledger',
      accessEvents,
      acousticEvents,
      attributedBy,
      synthetic: true,
    },
  };
}

export interface AccessTwinDriftScore {
  n: number;
  outcomes: number;
  auroc?: number | undefined;
  brier?: number | undefined;
  ece?: number | undefined;
  meanPredicted: number;
  observedRate: number;
  calibrationGap: number;
  leadTimeDays?: number | undefined;
  verdict: 'pass' | 'watch' | 'insufficient';
  targetAuroc: number;
  rows: Array<{ at: string; observed: boolean; predicted?: number | undefined; event: string; outcomeEvent?: string | undefined }>;
  note: string;
}

/** AUROC (rank/Mann-Whitney, tie-aware) computed locally to keep the twin standalone. */
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
 * Score the stenosis prior against what actually happened: an intervention or a
 * thrombosis within the outcome window is the observed label. Reporting
 * "insufficient" when there are too few scored observations (or only one
 * outcome class) is deliberate — an AUROC must not be invented.
 */
export function scoreAccessTwinDrift(twin: AccessTwin, opts: { targetAuroc?: number } = {}): AccessTwinDriftScore {
  const targetAuroc = opts.targetAuroc ?? ACCESS_TWIN_TARGET_AUROC;
  const rows = twin.observations
    .filter((o) => o.venousPressureMmHg !== undefined || o.accessFlowMlMin !== undefined)
    .map((o) => ({
      at: o.at,
      observed: o.outcome === true,
      predicted: o.stenosisProbability,
      event: o.event,
      outcomeEvent: o.outcomeEvent,
    }));
  const outcomes = rows.filter((r) => r.observed).length;
  const meanPredicted = rows.length ? Math.round((rows.reduce((a, r) => a + (r.predicted ?? 0), 0) / rows.length) * 1000) / 1000 : 0;
  const observedRate = rows.length ? Math.round((outcomes / rows.length) * 1000) / 1000 : 0;
  const calibrationGap = Math.round((observedRate - meanPredicted) * 1000) / 1000;

  if (rows.length < 6 || outcomes === 0 || outcomes === rows.length) {
    return {
      n: rows.length,
      outcomes,
      meanPredicted,
      observedRate,
      calibrationGap,
      verdict: 'insufficient',
      targetAuroc,
      rows,
      note: rows.length < 6
        ? `Only ${rows.length} measured observation(s) — at least 6 (with both outcomes present) are needed before the access model can be judged.`
        : `All ${rows.length} scored observations are '${outcomes === 0 ? 'no outcome' : 'outcome'}' — discrimination cannot be measured yet.`,
    };
  }

  const pairs = rows.map((r) => ({ score: r.predicted ?? 0, label: (r.observed ? 1 : 0) as 0 | 1 }));
  const auroc = aurocLocal(pairs);
  const brier = Math.round((pairs.reduce((a, p) => a + (p.score - p.label) ** 2, 0) / pairs.length) * 10000) / 10000;
  const ece = Math.round(Math.abs(calibrationGap) * 1000) / 1000;
  const leadTimes = twin.observations
    .filter((o) => o.outcome === true && o.outcomeEvent !== undefined)
    .map((o) => {
      const intervention = twin.interventions.find((i) => i.event === o.outcomeEvent && Date.parse(i.at) >= Date.parse(o.at));
      return intervention ? Math.round((Date.parse(intervention.at) - Date.parse(o.at)) / 86_400_000) : undefined;
    })
    .filter((v): v is number => v !== undefined);
  const leadTimeDays = leadTimes.length ? Math.round(leadTimes.reduce((a, b) => a + b, 0) / leadTimes.length) : undefined;
  const verdict: AccessTwinDriftScore['verdict'] = auroc !== undefined && auroc >= targetAuroc && Math.abs(calibrationGap) <= 0.2 ? 'pass' : 'watch';
  return {
    n: rows.length,
    outcomes,
    auroc,
    brier,
    ece,
    meanPredicted,
    observedRate,
    calibrationGap,
    ...(leadTimeDays !== undefined ? { leadTimeDays } : {}),
    verdict,
    targetAuroc,
    rows,
    note: verdict === 'pass'
      ? `Access stenosis prior discriminates at AUROC ${auroc} (≥${targetAuroc}) over ${rows.length} measured observations with a ${calibrationGap} calibration gap and ${leadTimeDays ?? '—'} days of mean lead time.`
      : `Access stenosis prior AUROC ${auroc ?? '—'} / calibration gap ${calibrationGap} does not yet meet the ${targetAuroc} target on ${rows.length} measured observations — the learned Δ-from-baseline head (step E) must improve it before any referral is trusted.`,
  };
}

/** Window for the advisor built from the twin's latest observation. */
export function accessWindowFromTwin(twin: AccessTwin, extra: Partial<AccessGuardInput> = {}): AccessGuardInput & { patientId: string } {
  const latest = twin.observations[twin.observations.length - 1];
  const baselinePressure = twin.observations.find((o) => o.venousPressureMmHg !== undefined)?.venousPressureMmHg;
  const baselineFlow = twin.observations.find((o) => o.accessFlowMlMin !== undefined)?.accessFlowMlMin;
  const lastIntervention = twin.interventions[twin.interventions.length - 1];
  return {
    patientId: twin.patientId,
    ...(twin.accessType ? { accessType: twin.accessType === 'catheter' ? 'catheter' : twin.accessType === 'avg' ? 'avg' : 'avf' } : {}),
    observations: twin.summary.measured,
    ...(latest?.venousPressureMmHg !== undefined ? { venousPressureMmHg: latest.venousPressureMmHg } : {}),
    ...(baselinePressure !== undefined ? { venousPressureBaselineMmHg: baselinePressure } : {}),
    ...(latest?.recirculationPct !== undefined ? { recirculationPct: latest.recirculationPct } : {}),
    ...(latest?.accessFlowMlMin !== undefined ? { accessFlowMlMin: latest.accessFlowMlMin } : {}),
    ...(baselineFlow !== undefined ? { accessFlowBaselineMlMin: baselineFlow } : {}),
    ...(latest?.deliveredClearancePct !== undefined ? { deliveredClearancePct: latest.deliveredClearancePct } : {}),
    ...(latest?.cannulationDifficulty !== undefined ? { cannulationDifficulty: latest.cannulationDifficulty as AccessGuardInput['cannulationDifficulty'] } : {}),
    priorInterventions: twin.summary.interventions,
    ...(lastIntervention ? { daysSinceIntervention: Math.round((Date.parse(twin.asOf) - Date.parse(lastIntervention.at)) / 86_400_000) } : {}),
    ...(twin.acoustic.provenance.length ? { acousticProvenance: twin.acoustic.provenance[0], acousticSynthetic: true, acousticEnabled: twin.acoustic.enabled } : {}),
    ...extra,
    asOf: twin.asOf,
  };
}

export { ACCESS_REFERENCE };
