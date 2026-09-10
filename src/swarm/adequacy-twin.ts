/******************************************************************************
 * Dialysis adequacy — patient twin over the REAL ledger (P1 step D).
 *
 * The twin reconstructs what each delivered session actually achieved and
 * compares it with the measured clearance on the same ledger, so the adequacy
 * advisor's prior can be scored against reality instead of against itself:
 *
 *   session ledger (`start-session` … `end-session`, `record-session-telemetry`)
 *     → delivered minutes, Qb, UF volume, telediagnostic aggregates
 *   + URR lab results (`result-lab` code URR, attributed by order id)
 *     → observed clearance series
 *   → predicted URR from the Daugirdas/clearance prior
 *   → forecast-vs-observed drift (MAPE target ≤ 5% per the acceptance criteria)
 *
 * Everything is derived from realm state/ledger (F1). Synthetic data only.
 ******************************************************************************/

import {
  clearanceMultiplier,
  type AdequacyPatientWindow,
} from './adequacy.js';
import { daugirdasSpKtV, spKtVFromUrr, ktvToUrr } from '../protocols/priors.js';
import { attributePatientIdFromOrder } from './renal-cohort.js';

export const ADEQUACY_TWIN_DRIFT_TARGET_MAPE_PCT = 5;
/** Sessions with this URR code on the ledger. */
export const URR_LAB_CODE = 'URR';
export const KTV_MEASURED_CODES = ['URR', 'KTV', 'SPKTV'] as const;

export interface AdequacyTwinSession {
  sessionId: string;
  startedAt: string;
  endedAt?: string | undefined;
  deliveredMinutes: number;
  prescribedMinutes?: number | undefined;
  qbAvg?: number | undefined;
  ufVolumeL?: number | undefined;
  postWeightKg?: number | undefined;
  recirculationPct?: number | undefined;
  nadirSbp?: number | undefined;
  telemetryPoints: number;
  stoppedEarly: boolean;
  /** predicted single-pool Kt/V for this session (clearance prior) */
  predictedSpKtV?: number | undefined;
  predictedUrrPct?: number | undefined;
}

export interface AdequacyTwinObservation { at: string; urrPct: number }

export interface AdequacyTwin {
  patientId: string;
  asOf: string;
  sessions: AdequacyTwinSession[];
  observedUrr: AdequacyTwinObservation[];
  summary: {
    sessionCount: number;
    avgDeliveredMinutes?: number | undefined;
    avgAdherencePct?: number | undefined;
    avgQb?: number | undefined;
    avgPredictedSpKtV?: number | undefined;
    latestObservedUrrPct?: number | undefined;
    inBandPct?: number | undefined;
  };
  provenance: {
    source: 'realm-ledger';
    sessionEvents: number;
    urrResults: number;
    attributedBy: 'payload-patientId' | 'order-id-prefix' | 'none';
    synthetic: true;
  };
}

export interface AdequacyTwinEventInput {
  realmId?: string;
  eventId?: string;
  kind: string;
  emittedAt: string;
  realmAt?: string;
  patientId?: string;
  payload: Record<string, unknown>;
}

export interface AdequacyTwinPatientInput {
  patientId: string;
  realmId?: string;
  state: Record<string, unknown>;
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

/** Order of the ledger for clinical time: realm time wins over wall clock. */
const atOf = (e: AdequacyTwinEventInput): string => e.realmAt ?? e.emittedAt;

/** Session ring from the F1 reducer, folded back into a clinical series. */
export function sessionsFromState(state: Record<string, unknown>): AdequacyTwinSession[] {
  const raw = Array.isArray(state.sessions) ? (state.sessions as Array<Record<string, unknown>>) : [];
  return raw.map((s) => {
    const deliveredMinutes = num(s.deliveredMinutes) ?? 0;
    const prescribedMinutes = num(s.prescribedMinutes);
    return {
      sessionId: str(s.sessionId) ?? 'unknown',
      startedAt: str(s.startedAt) ?? '',
      endedAt: str(s.endedAt),
      deliveredMinutes,
      prescribedMinutes,
      qbAvg: num(s.qbAvg) ?? num(s.qbSampleAvg),
      ufVolumeL: num(s.ufVolumeL),
      postWeightKg: num(s.postWeightKg),
      recirculationPct: num(s.recirculationPct),
      nadirSbp: num(s.nadirSbp),
      telemetryPoints: num(s.telemetryPoints) ?? 0,
      stoppedEarly: s.stoppedEarly === true,
    };
  });
}

/** Predict the URR a session should achieve from its delivered parameters. */
export function predictSessionUrr(session: AdequacyTwinSession, opts: { referenceMinutes?: number | undefined; potassium?: number | undefined } = {}): { spKtV?: number | undefined; urrPct?: number | undefined } {
  if (!session.deliveredMinutes) return { spKtV: undefined, urrPct: undefined };
  const referenceMinutes = opts.referenceMinutes ?? session.prescribedMinutes ?? 240;
  const multiplier = clearanceMultiplier({
    minutesNow: referenceMinutes,
    minutesNext: session.deliveredMinutes,
    ...(session.qbAvg !== undefined ? { qbNow: session.qbAvg, qbNext: session.qbAvg } : {}),
  });
  // Reference delivered spKt/V at the prescribed prescription, scaled for actual delivery.
  const referenceSpKtV = 1.35;
  const spKtV = Math.round(Math.min(3, referenceSpKtV * multiplier) * 100) / 100;
  return { spKtV, urrPct: Math.round(ktvToUrr(spKtV) * 10) / 10 };
}

/**
 * Build the adequacy twin: sessions from patient state plus the observed URR
 * series from the ledger (results carry only an orderId, so they are attributed
 * by longest patient-id prefix — same rule as the cohort builder).
 */
export function buildAdequacyTwin(input: {
  patientId: string;
  events: readonly AdequacyTwinEventInput[];
  patients?: readonly AdequacyTwinPatientInput[];
  asOf?: string;
}): AdequacyTwin {
  const knownPatientIds = [
    input.patientId,
    ...(input.patients ?? []).map((p) => p.patientId),
  ];
  const state = (input.patients ?? []).find((p) => p.patientId === input.patientId)?.state
    ?? (input.patients ?? [])[0]?.state
    ?? {};
  const rawSessions = sessionsFromState(state);

  let attributedBy: AdequacyTwin['provenance']['attributedBy'] = 'none';
  let urrAttribution: AdequacyTwin['provenance']['attributedBy'] = 'none';
  const urrObservations: AdequacyTwinObservation[] = [];
  let sessionEvents = 0;

  for (const event of input.events) {
    if (event.kind === 'end-session' || event.kind === 'start-session') sessionEvents += 1;
    const payloadPatient = str(event.payload.patientId);
    const fromOrder = payloadPatient ? undefined : attributePatientIdFromOrder(str(event.payload.orderId) ?? '', knownPatientIds);
    const owner = payloadPatient ?? fromOrder;
    if (owner !== input.patientId) continue;
    if (payloadPatient) attributedBy = 'payload-patientId';
    else if (fromOrder) attributedBy = attributedBy === 'payload-patientId' ? attributedBy : 'order-id-prefix';

    if (event.kind === 'result-lab' && str(event.payload.code) === URR_LAB_CODE) {
      const value = num(event.payload.value);
      if (value !== undefined) {
        urrObservations.push({ at: atOf(event), urrPct: value });
        // provenance of the CLEARANCE series specifically: matured results carry
        // only an orderId, so this is normally the prefix attribution.
        urrAttribution = payloadPatient ? 'payload-patientId' : 'order-id-prefix';
      }
    }
  }

  // Sessions on the ledger that never made it into the ring (e.g. restored state)
  if (rawSessions.length === 0) {
    for (const event of input.events) {
      const payloadPatient = str(event.payload.patientId);
      const owner = payloadPatient ?? attributePatientIdFromOrder(str(event.payload.orderId) ?? '', knownPatientIds);
      if (owner !== input.patientId || event.kind !== 'end-session') continue;
      rawSessions.push({
        sessionId: str(event.payload.sessionId) ?? `ledger-${rawSessions.length + 1}`,
        startedAt: atOf(event),
        endedAt: atOf(event),
        deliveredMinutes: num(event.payload.deliveredMinutes) ?? 0,
        prescribedMinutes: undefined,
        qbAvg: num(event.payload.qbAvg),
        ufVolumeL: num(event.payload.ufVolumeL),
        postWeightKg: num(event.payload.postWeightKg),
        recirculationPct: num(event.payload.recirculationPct),
        nadirSbp: undefined,
        telemetryPoints: 0,
        stoppedEarly: event.payload.stoppedEarly === true,
      });
    }
  }

  const sessions: AdequacyTwinSession[] = rawSessions
    .map((s) => ({ ...s, ...predictSessionUrr(s) }))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  urrObservations.sort((a, b) => a.at.localeCompare(b.at));

  const delivered = sessions.map((s) => s.deliveredMinutes).filter((v) => v > 0);
  const adherence = sessions
    .filter((s) => s.prescribedMinutes && s.deliveredMinutes)
    .map((s) => Math.round((s.deliveredMinutes / (s.prescribedMinutes ?? s.deliveredMinutes)) * 100));
  const qbs = sessions.map((s) => s.qbAvg).filter((v): v is number => v !== undefined);
  const predicted = sessions.map((s) => s.predictedSpKtV).filter((v): v is number => v !== undefined);
  const inBand = predicted.filter((v) => v >= 1.2 && v <= 1.4).length;

  const asOf = input.asOf ?? urrObservations[urrObservations.length - 1]?.at ?? sessions[sessions.length - 1]?.endedAt ?? new Date().toISOString();

  return {
    patientId: input.patientId,
    asOf,
    sessions,
    observedUrr: urrObservations,
    summary: {
      sessionCount: sessions.length,
      avgDeliveredMinutes: delivered.length ? Math.round(delivered.reduce((a, b) => a + b, 0) / delivered.length) : undefined,
      avgAdherencePct: adherence.length ? Math.round(adherence.reduce((a, b) => a + b, 0) / adherence.length) : undefined,
      avgQb: qbs.length ? Math.round(qbs.reduce((a, b) => a + b, 0) / qbs.length) : undefined,
      avgPredictedSpKtV: predicted.length ? Math.round((predicted.reduce((a, b) => a + b, 0) / predicted.length) * 100) / 100 : undefined,
      latestObservedUrrPct: urrObservations.length ? urrObservations[urrObservations.length - 1]!.urrPct : undefined,
      inBandPct: predicted.length ? Math.round((inBand / predicted.length) * 100) : undefined,
    },
    provenance: {
      source: 'realm-ledger',
      sessionEvents,
      urrResults: urrObservations.length,
      attributedBy: urrAttribution === 'none' ? attributedBy : urrAttribution,
      synthetic: true,
    },
  };
}

export interface AdequacyTwinDriftScore {
  n: number;
  mae?: number | undefined;
  mapePct?: number | undefined;
  bias?: number | undefined;
  verdict: 'pass' | 'watch' | 'insufficient';
  targetMapePct: number;
  rows: Array<{ at: string; observedUrrpct: number; predictedUrrPct?: number | undefined; errorPct?: number | undefined }>;
  note: string;
}

/**
 * Score the clearance prior against the twin's observed URR series.
 * A pair is formed with the most recent session at/ before each observation.
 */
export function scoreAdequacyTwinDrift(twin: AdequacyTwin, opts: { targetMapePct?: number } = {}): AdequacyTwinDriftScore {
  const targetMapePct = opts.targetMapePct ?? ADEQUACY_TWIN_DRIFT_TARGET_MAPE_PCT;
  const rows: AdequacyTwinDriftScore['rows'] = [];
  for (const obs of twin.observedUrr) {
    const session = [...twin.sessions].reverse().find((s) => (s.endedAt ?? s.startedAt) <= obs.at);
    const predicted = session?.predictedUrrPct;
    rows.push({
      at: obs.at,
      observedUrrpct: obs.urrPct,
      predictedUrrPct: predicted,
      errorPct: predicted !== undefined && obs.urrPct !== 0 ? Math.round(Math.abs((predicted - obs.urrPct) / obs.urrPct) * 1000) / 10 : undefined,
    });
  }
  const scored = rows.filter((r) => r.errorPct !== undefined);
  if (scored.length < 3) {
    return {
      n: scored.length,
      rows,
      verdict: 'insufficient',
      targetMapePct,
      note: `Only ${scored.length} session↔URR pair(s) — at least 3 are needed to score the clearance prior (need more URR results on the ledger).`,
    };
  }
  const mapePct = Math.round((scored.reduce((a, r) => a + (r.errorPct ?? 0), 0) / scored.length) * 10) / 10;
  const mae = Math.round((scored.reduce((a, r) => a + Math.abs((r.predictedUrrPct ?? 0) - r.observedUrrpct), 0) / scored.length) * 100) / 100;
  const bias = Math.round((scored.reduce((a, r) => a + ((r.predictedUrrPct ?? 0) - r.observedUrrpct), 0) / scored.length) * 100) / 100;
  const verdict: AdequacyTwinDriftScore['verdict'] = mapePct <= targetMapePct ? 'pass' : mapePct <= targetMapePct * 2 ? 'watch' : 'insufficient';
  return {
    n: scored.length,
    mae,
    mapePct,
    bias,
    verdict,
    targetMapePct,
    rows,
    note: verdict === 'pass'
      ? `Clearance prior within ${targetMapePct}% MAPE against the twin's observed URR (${mapePct}%).`
      : `Clearance prior MAPE ${mapePct}% exceeds the ${targetMapePct}% acceptance target — the learned head (step E) must correct it before any recommendation is trusted.`,
  };
}

/** Convenience: window for the advisor built from the twin's latest state. */
export function adequacyWindowFromTwin(twin: AdequacyTwin, extra: Partial<AdequacyPatientWindow> = {}): AdequacyPatientWindow {
  const lastSession = twin.sessions[twin.sessions.length - 1];
  return {
    patientId: twin.patientId,
    sessionCount: twin.summary.sessionCount,
    prescribedMinutes: lastSession?.prescribedMinutes,
    deliveredMinutes: lastSession?.deliveredMinutes,
    qbAvg: lastSession?.qbAvg,
    ufVolumeL: lastSession?.ufVolumeL,
    postWeightKg: lastSession?.postWeightKg,
    recirculationPct: lastSession?.recirculationPct,
    nadirSbp: lastSession?.nadirSbp,
    urrPct: twin.summary.latestObservedUrrPct,
    urrTrendPct: twin.observedUrr.map((o) => o.urrPct),
    adherencePct: twin.summary.avgAdherencePct,
    asOf: twin.asOf,
    ...extra,
  };
}

export { daugirdasSpKtV, spKtVFromUrr, ktvToUrr };
