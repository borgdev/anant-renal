/******************************************************************************
 * Fluid / IDH — patient twin over the REAL ledger (P2 step D).
 *
 * Reconstructs every delivered session's intra-session trajectory from the
 * `record-session-telemetry` effects the reducer folded into patient state, then
 * detects the IDH events that actually happened (nadir SBP < 90 or a ≥ 20 mmHg
 * fall from the first reading) and scores the model's per-horizon prediction
 * against them.
 *
 * This is the fluid analogue of the anemia forecast-vs-observed drift: the
 * verdict is computed on real (synthetic-simulated) sessions, never on the
 * model's own output.
 ******************************************************************************/

import { FLUID_HORIZONS_MIN, idhProbability, type FluidPatientWindow } from './fluid.js';
import { attributePatientIdFromOrder } from './renal-cohort.js';

export const FLUID_TWIN_TARGET_AUROC = 0.85;
export const IDH_NADIR_SBP = 90;
export const IDH_DROP_MMHG = 20;

export interface FluidTelemetryPoint {
  minute: number;
  at?: string | undefined;
  bp?: string | undefined;
  systolic?: number | undefined;
  hr?: number | undefined;
  ufRateMlH?: number | undefined;
  ufVolumeL?: number | undefined;
  temperatureC?: number | undefined;
  symptoms?: string[] | undefined;
}

export interface FluidTwinSession {
  sessionId: string;
  startedAt: string;
  endedAt?: string | undefined;
  deliveredMinutes: number;
  prescribedMinutes?: number | undefined;
  ufVolumeL?: number | undefined;
  qbAvg?: number | undefined;
  postWeightKg?: number | undefined;
  telemetry: FluidTelemetryPoint[];
  telemetryPoints: number;
  /** observed intra-session event */
  idhEvent: boolean;
  nadirSystolic?: number | undefined;
  maxDropMmHg?: number | undefined;
  minutesToNadir?: number | undefined;
  symptoms: string[];
  /** model probability of the event at the closest available horizon */
  predictedRiskAtNadir?: number | undefined;
  predictedRiskByMinute?: Record<number, number> | undefined;
}

export interface FluidTwin {
  patientId: string;
  asOf: string;
  sessions: FluidTwinSession[];
  summary: {
    sessionCount: number;
    sessionsWithTelemetry: number;
    idhEvents: number;
    idhRatePct?: number | undefined;
    meanNadirSystolic?: number | undefined;
    meanUfRateMlH?: number | undefined;
    meanTelemetryPoints?: number | undefined;
  };
  provenance: { source: 'realm-ledger'; telemetryEvents: number; attributedBy: 'payload-patientId' | 'order-id-prefix' | 'none'; synthetic: true };
}

export interface FluidTwinEventInput {
  realmId?: string;
  eventId?: string;
  kind: string;
  emittedAt: string;
  realmAt?: string;
  patientId?: string;
  payload: Record<string, unknown>;
}

export interface FluidTwinPatientInput { patientId: string; realmId?: string; state: Record<string, unknown> }

const num = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number.parseFloat(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
};
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const systolicOf = (bp: string | undefined): number | undefined => {
  if (!bp) return undefined;
  const n = Number.parseInt(bp.split('/')[0] ?? '', 10);
  return Number.isFinite(n) ? n : undefined;
};
const atOf = (e: FluidTwinEventInput): string => e.realmAt ?? e.emittedAt;

/** Fold the reducer's session ring (telemetry included) into typed sessions. */
export function sessionsFromState(state: Record<string, unknown>): FluidTwinSession[] {
  const raw = Array.isArray(state.sessions) ? (state.sessions as Array<Record<string, unknown>>) : [];
  const current = state.currentSession as Record<string, unknown> | null | undefined;
  const rows = current && typeof current === 'object' ? [...raw, { ...current, endedAt: undefined }] : raw;
  return rows.map((s) => {
    const telemetryRaw = Array.isArray(s.telemetry) ? (s.telemetry as Array<Record<string, unknown>>) : [];
    const telemetry: FluidTelemetryPoint[] = telemetryRaw.map((p) => ({
      minute: num(p.minute) ?? 0,
      at: str(p.at),
      bp: str(p.bp),
      systolic: systolicOf(str(p.bp)),
      hr: num(p.hr),
      ufRateMlH: num(p.ufRateMlH),
      ufVolumeL: num(p.ufVolumeL),
      temperatureC: num(p.tempC),
      symptoms: Array.isArray(p.symptoms) ? (p.symptoms as unknown[]).filter((x): x is string => typeof x === 'string') : undefined,
    })).sort((a, b) => a.minute - b.minute);
    const systolics = telemetry.map((p) => p.systolic).filter((v): v is number => v !== undefined);
    const first = systolics[0];
    const nadir = systolics.length ? Math.min(...systolics) : undefined;
    const nadirPoint = telemetry.find((p) => p.systolic !== undefined && p.systolic === nadir);
    const maxDrop = first !== undefined && nadir !== undefined ? first - nadir : undefined;
    const symptoms = telemetry.flatMap((p) => p.symptoms ?? []);
    const stop = (s.nadirSbp as number | undefined);
    const observedNadir = stop ?? nadir;
    return {
      sessionId: str(s.sessionId) ?? 'unknown',
      startedAt: str(s.startedAt) ?? '',
      endedAt: str(s.endedAt),
      deliveredMinutes: num(s.deliveredMinutes) ?? 0,
      prescribedMinutes: num(s.prescribedMinutes),
      ufVolumeL: num(s.ufVolumeL),
      qbAvg: num(s.qbAvg) ?? num(s.qbSampleAvg),
      postWeightKg: num(s.postWeightKg),
      telemetry,
      telemetryPoints: telemetry.length,
      // event = nadir below the floor OR a ≥20 mmHg fall, plus any hypotension symptom
      idhEvent: (observedNadir !== undefined && observedNadir < IDH_NADIR_SBP)
        || (maxDrop !== undefined && maxDrop >= IDH_DROP_MMHG)
        || symptoms.some((x) => /hypotension|dizzy|syncope|cramp/i.test(x)),
      nadirSystolic: observedNadir,
      maxDropMmHg: maxDrop,
      minutesToNadir: nadirPoint?.minute,
      symptoms,
    };
  });
}

/**
 * Build the fluid twin: sessions (with telemetry) from patient state, plus any
 * ledger telemetry that never reached the ring (restored states). The IDH
 * prediction uses the model prior at each horizon so it can be scored against
 * the observed event.
 */
export function buildFluidTwin(input: {
  patientId: string;
  events: readonly FluidTwinEventInput[];
  patients?: readonly FluidTwinPatientInput[];
  asOf?: string;
}): FluidTwin {
  const knownPatientIds = [input.patientId, ...(input.patients ?? []).map((p) => p.patientId)];
  const state = (input.patients ?? []).find((p) => p.patientId === input.patientId)?.state ?? {};
  const sessions = sessionsFromState(state);
  let attributedBy: FluidTwin['provenance']['attributedBy'] = 'none';
  let telemetryEvents = 0;

  for (const event of input.events) {
    const payloadPatient = str(event.payload.patientId);
    const owner = payloadPatient ?? attributePatientIdFromOrder(str(event.payload.orderId) ?? '', knownPatientIds);
    if (owner !== input.patientId) continue;
    if (event.kind === 'record-session-telemetry') {
      telemetryEvents += 1;
      attributedBy = payloadPatient ? 'payload-patientId' : 'order-id-prefix';
      // sessions restored without a ring entry: materialise a minimal session
      if (sessions.length === 0) {
        sessions.push({
          sessionId: str(event.payload.sessionId) ?? 'ledger-session',
          startedAt: atOf(event),
          deliveredMinutes: 0,
          prescribedMinutes: undefined,
          telemetry: [],
          telemetryPoints: 0,
          idhEvent: false,
          symptoms: [],
        });
      }
      const target = sessions[sessions.length - 1]!;
      const point: FluidTelemetryPoint = {
        minute: num(event.payload.minute) ?? 0,
        at: atOf(event),
        bp: str(event.payload.bp),
        systolic: systolicOf(str(event.payload.bp)),
        hr: num(event.payload.hr),
        ufRateMlH: num(event.payload.ufRateMlH),
        ufVolumeL: num(event.payload.ufVolumeL),
        temperatureC: num(event.payload.tempC),
        symptoms: Array.isArray(event.payload.symptoms) ? (event.payload.symptoms as unknown[]).filter((x): x is string => typeof x === 'string') : undefined,
      };
      target.telemetry.push(point);
      target.telemetryPoints = target.telemetry.length;
      const systolics = target.telemetry.map((p) => p.systolic).filter((v): v is number => v !== undefined);
      if (systolics.length) {
        const first = systolics[0]!;
        const nadir = Math.min(...systolics);
        target.nadirSystolic = target.nadirSystolic !== undefined ? Math.min(target.nadirSystolic, nadir) : nadir;
        target.maxDropMmHg = Math.max(target.maxDropMmHg ?? 0, first - nadir);
        target.idhEvent = target.idhEvent || nadir < IDH_NADIR_SBP || first - nadir >= IDH_DROP_MMHG;
      }
      target.symptoms = [...target.symptoms, ...(point.symptoms ?? [])];
    }
  }

  // score every session with the model prior (same rule the advisor uses)
  for (const session of sessions) {
    const rate = session.ufVolumeL !== undefined && session.deliveredMinutes
      ? Math.round((session.ufVolumeL * 1000 * 60) / session.deliveredMinutes)
      : session.telemetry.map((p) => p.ufRateMlH).filter((v): v is number => v !== undefined).at(-1);
    const firstSystolic = session.telemetry.map((p) => p.systolic).filter((v): v is number => v !== undefined)[0];
    const weight = session.postWeightKg ?? 70;
    if (rate !== undefined) {
      const byMinute: Record<number, number> = {};
      for (const minute of FLUID_HORIZONS_MIN) {
        byMinute[minute] = idhProbability({
          ufRatePerKg: Math.round((rate / weight) * 100) / 100,
          currentSbp: firstSystolic ?? 120,
          minute,
        });
      }
      session.predictedRiskByMinute = byMinute;
      session.predictedRiskAtNadir = session.minutesToNadir !== undefined
        ? byMinute[FLUID_HORIZONS_MIN.slice().reverse().find((m) => m <= session.minutesToNadir!) ?? FLUID_HORIZONS_MIN[0]!]
        : Math.max(...Object.values(byMinute));
    }
  }

  const scored = sessions.filter((s) => s.telemetryPoints > 0);
  const events = scored.filter((s) => s.idhEvent).length;
  const nadirs = scored.map((s) => s.nadirSystolic).filter((v): v is number => v !== undefined);
  const rates = scored.map((s) => (s.ufVolumeL !== undefined && s.deliveredMinutes ? (s.ufVolumeL * 1000 * 60) / s.deliveredMinutes : undefined)).filter((v): v is number => v !== undefined);
  return {
    patientId: input.patientId,
    asOf: input.asOf ?? sessions.at(-1)?.endedAt ?? new Date().toISOString(),
    sessions,
    summary: {
      sessionCount: sessions.length,
      sessionsWithTelemetry: scored.length,
      idhEvents: events,
      idhRatePct: scored.length ? Math.round((events / scored.length) * 100) : undefined,
      meanNadirSystolic: nadirs.length ? Math.round(nadirs.reduce((a, b) => a + b, 0) / nadirs.length) : undefined,
      meanUfRateMlH: rates.length ? Math.round(rates.reduce((a, b) => a + b, 0) / rates.length) : undefined,
      meanTelemetryPoints: scored.length ? Math.round(scored.reduce((a, b) => a + b.telemetryPoints, 0) / scored.length) : undefined,
    },
    provenance: {
      source: 'realm-ledger',
      telemetryEvents,
      attributedBy,
      synthetic: true,
    },
  };
}

export interface FluidTwinDriftScore {
  n: number;
  events: number;
  auroc?: number | undefined;
  brier?: number | undefined;
  ece?: number | undefined;
  meanPredicted: number;
  observedRate: number;
  calibrationGap: number;
  leadTimeMinutes?: number | undefined;
  verdict: 'pass' | 'watch' | 'insufficient';
  targetAuroc: number;
  rows: Array<{ sessionId: string; at: string; observed: boolean; predicted?: number | undefined; nadirSystolic?: number | undefined; minutesToNadir?: number | undefined }>;
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
 * Score the IDH prior against observed sessions: discrimination (AUROC),
 * calibration (Brier + gap) and the observed event rate. Reporting an
 * "insufficient" verdict when there are too few scored sessions is deliberate.
 */
export function scoreFluidTwinDrift(twin: FluidTwin, opts: { targetAuroc?: number } = {}): FluidTwinDriftScore {
  const targetAuroc = opts.targetAuroc ?? FLUID_TWIN_TARGET_AUROC;
  const scored = twin.sessions.filter((s) => s.telemetryPoints > 0 && s.predictedRiskAtNadir !== undefined);
  const rows = scored.map((s) => ({
    sessionId: s.sessionId,
    at: s.endedAt ?? s.startedAt,
    observed: s.idhEvent,
    predicted: s.predictedRiskAtNadir,
    nadirSystolic: s.nadirSystolic,
    minutesToNadir: s.minutesToNadir,
  }));
  const events = rows.filter((r) => r.observed).length;
  const meanPredicted = rows.length ? Math.round((rows.reduce((a, r) => a + (r.predicted ?? 0), 0) / rows.length) * 1000) / 1000 : 0;
  const observedRate = rows.length ? Math.round((events / rows.length) * 1000) / 1000 : 0;
  const calibrationGap = Math.round((observedRate - meanPredicted) * 1000) / 1000;

  if (rows.length < 4 || events === 0 || events === rows.length) {
    return {
      n: rows.length,
      events,
      meanPredicted,
      observedRate,
      calibrationGap,
      verdict: 'insufficient',
      targetAuroc,
      rows,
      note: rows.length < 4
        ? `Only ${rows.length} scored session(s) with telemetry — at least 4 are needed (and both outcomes present) before the IDH model can be judged.`
        : `All ${rows.length} scored sessions are '${events === 0 ? 'no event' : 'event'}' — discrimination cannot be measured yet.`,
    };
  }

  const pairs = rows.map((r) => ({ score: r.predicted ?? 0, label: (r.observed ? 1 : 0) as 0 | 1 }));
  const auroc = aurocLocal(pairs);
  const brier = Math.round((pairs.reduce((a, p) => a + (p.score - p.label) ** 2, 0) / pairs.length) * 10000) / 10000;
  const ece = Math.round(Math.abs(calibrationGap) * 1000) / 1000;
  const leadTimes = rows.filter((r) => r.observed && r.minutesToNadir !== undefined).map((r) => r.minutesToNadir!);
  const leadTimeMinutes = leadTimes.length ? Math.round(leadTimes.reduce((a, b) => a + b, 0) / leadTimes.length) : undefined;
  const verdict: FluidTwinDriftScore['verdict'] = auroc !== undefined && auroc >= targetAuroc && Math.abs(calibrationGap) <= 0.15 ? 'pass' : 'watch';
  return {
    n: rows.length,
    events,
    auroc,
    brier,
    ece,
    meanPredicted,
    observedRate,
    calibrationGap,
    ...(leadTimeMinutes !== undefined ? { leadTimeMinutes } : {}),
    verdict,
    targetAuroc,
    rows,
    note: verdict === 'pass'
      ? `IDH prior discriminates at AUROC ${auroc} (≥${targetAuroc}) with a ${calibrationGap} calibration gap over ${rows.length} scored sessions.`
      : `IDH prior AUROC ${auroc ?? '—'} / calibration gap ${calibrationGap} does not yet meet the ${targetAuroc} target on ${rows.length} sessions — the learned head (step E) must improve it before any recommendation is trusted.`,
  };
}

/** Window for the advisor built from the twin's most recent session. */
export function fluidWindowFromTwin(twin: FluidTwin, extra: Partial<FluidPatientWindow> = {}): FluidPatientWindow {
  const scored = twin.sessions.filter((s) => s.telemetryPoints > 0);
  const last = scored.at(-1) ?? twin.sessions.at(-1);
  const lastTelemetry = last?.telemetry.at(-1);
  const prev = scored.slice(-2, -1)[0];
  return {
    patientId: twin.patientId,
    sessionCount: twin.summary.sessionsWithTelemetry,
    telemetryPoints: last?.telemetryPoints ?? 0,
    ...(last?.deliveredMinutes !== undefined ? { deliveredMinutes: last.deliveredMinutes } : {}),
    ...(last?.prescribedMinutes !== undefined ? { plannedMinutes: last.prescribedMinutes } : {}),
    ...(last?.ufVolumeL !== undefined ? { ufVolumeL: last.ufVolumeL } : {}),
    ...(lastTelemetry?.ufRateMlH !== undefined ? { ufRateMlH: lastTelemetry.ufRateMlH } : {}),
    ...(last?.postWeightKg !== undefined ? { postWeightKg: last.postWeightKg } : {}),
    ...(last?.nadirSystolic !== undefined ? { nadirSbp: last.nadirSystolic } : {}),
    ...(prev?.nadirSystolic !== undefined ? { nadirSbpPrev: prev.nadirSystolic } : {}),
    adherencePct: 100,
    asOf: twin.asOf,
    ...extra,
  };
}
