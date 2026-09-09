/******************************************************************************
 * DST-Q #2 — multi-signal early-warning.
 *
 * Fuses per-patient clinical signals — vitals, labs, missed treatments and ESA
 * no-response — into a Dempster–Shafer belief interval over {deteriorating}.
 *
 * Why D-S (and not a weighted sum):
 *   • A reassuring observation (e.g. vitals normal, recent URR 72) is modelled
 *     honestly as a mass on `stable`, so it *conflicts* with alarming evidence
 *     instead of silently averaging it away → conflict mass K rises.
 *   • Alerts fire only when the commitment to `deteriorating` clears the belief
 *     gate AND conflict stays low (K < contested gate). High-K states are held
 *     for human verification, never auto-flagged — the same "contested = verify"
 *     language as My Work and the ESA suggestion readout.
 *   • Weak / low-reliability telemetry widens Pl − Bel (honest ignorance) rather
 *     than pretending to know.
 *
 * This is an *advisory watch* that complements (not replaces) the liquid
 * CfC/LTC trajectory forecast: the forecast says where the patient is heading on
 * the learned manifold; this module says how much the *observed evidence* today
 * commits to deterioration, and whether the observations agree.
 ******************************************************************************/

import { belief as dstBelief, discount, fuse, plausibility as dstPlausibility, singleton, vacuous, type Mass } from '../evidence/dempster.js';
import { reliabilityBySource } from '../evidence/reliability.js';
import { DST_WORK_OPTIMISM, DST_WORK_HARM_GAMMA } from './work-dst.js';

export type EwPolarity = 'deteriorating' | 'stable';
export type EwSignalKind = 'vitals' | 'lab' | 'missed-treatment' | 'esa-no-response' | 'access';
export type EwPosture = 'corroborated' | 'weak' | 'contested' | 'reassured';

/** A single observed signal for a patient. */
export interface EarlyWarningSignal {
  patientId: string;
  facilityId?: string;
  kind: EwSignalKind;
  /** Human label shown on the watch (e.g. "K 5.9 mmol/L · trending up"). */
  label: string;
  /** Which hypothesis this observation supports. */
  polarity: EwPolarity;
  /** Credibility of the observation type in 0..1 (fact-heavy signals weigh more). */
  weight: number;
  /** Source id — drives the reliability dial (realm-ledger 0.95 / sim 0.3 / …). */
  sourceId: string;
  at: string;
}

export interface EarlyWarningSignalView {
  kind: EwSignalKind;
  label: string;
  polarity: EwPolarity;
  weight: number;
  alpha: number;
}

export interface EarlyWarningReadout {
  patientId: string;
  facilityId: string | null;
  belief: number;
  plausibility: number;
  uncertainty: number;
  conflictMass: number;
  posture: EwPosture;
  /** True when the watch auto-flags (posture corroborated). */
  alert: boolean;
  /** Belief-aware decision score in [0,1] (same rule as My Work / ESA). */
  score: number;
  signalCount: number;
  signals: EarlyWarningSignalView[];
}

/** Commitment to `deteriorating` before the watch auto-flags. */
export const EW_ALERT_BELIEF_GATE = 0.7;
/** Any material commitment (even low-reliability) reads as a "watch"; only
 *  near-zero committed deterioration reads as reassured. */
export const EW_WATCH_BELIEF_GATE = 0.25;
/** Fused conflict above this marks the watch contested (suppress auto-alert). */
export const EW_CONTESTED_K_GATE = 0.3;

const FRAME = new Set(['deteriorating', 'stable']);
const DETERIORATING = new Set(['deteriorating']);
const round = (n: number): number => Math.round(n * 1000) / 1000;
const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

function signalToMass(s: EarlyWarningSignal): Mass {
  const alpha = reliabilityBySource(s.sourceId);
  const singletonMass = singleton(s.polarity, clamp01(s.weight));
  return discount(singletonMass, alpha);
}

/** Fuse one patient's signals into a deterioration readout (undefined if none). */
export function fusePatientReadout(patientId: string, signals: EarlyWarningSignal[]): EarlyWarningReadout | undefined {
  const own = signals.filter((s) => s.patientId === patientId);
  if (own.length === 0) return undefined;
  const masses = own.map(signalToMass);
  const fusion = fuse(masses.length ? masses : [vacuous()]);
  const k = fusion.degenerate ? 1 : round(fusion.k);
  const bel = round(dstBelief(fusion.mass, FRAME, DETERIORATING));
  const pl = round(dstPlausibility(fusion.mass, FRAME, DETERIORATING));
  const uncertainty = round(Math.max(0, pl - bel));

  let posture: EwPosture;
  if (k >= EW_CONTESTED_K_GATE) posture = 'contested';
  else if (bel >= EW_ALERT_BELIEF_GATE) posture = 'corroborated';
  else if (bel >= EW_WATCH_BELIEF_GATE) posture = 'weak';
  else posture = 'reassured';

  const harmOffset = posture === 'contested' ? 0.4 : posture === 'weak' ? 0.2 : posture === 'corroborated' ? 0.1 : 0;
  const plHarm = Math.min(1, harmOffset + uncertainty * 0.5);
  const score = round(Math.max(0, Math.min(1, bel + DST_WORK_OPTIMISM * uncertainty - DST_WORK_HARM_GAMMA * plHarm)));

  return {
    patientId,
    facilityId: own[0]?.facilityId ?? null,
    belief: bel,
    plausibility: pl,
    uncertainty,
    conflictMass: k,
    posture,
    alert: posture === 'corroborated',
    score,
    signalCount: own.length,
    signals: own.map((s) => ({
      kind: s.kind,
      label: s.label,
      polarity: s.polarity,
      weight: s.weight,
      alpha: round(reliabilityBySource(s.sourceId)),
    })),
  };
}

const POSTURE_RANK: Record<EwPosture, number> = { corroborated: 0, weak: 1, contested: 2, reassured: 3 };

/** Fuse all patients, alerts first, then by score within posture. */
export function fuseEarlyWarningCohort(signals: EarlyWarningSignal[]): EarlyWarningReadout[] {
  const patientIds = [...new Set(signals.map((s) => s.patientId))];
  return patientIds
    .map((id) => fusePatientReadout(id, signals))
    .filter((r): r is EarlyWarningReadout => r !== undefined)
    .sort((a, b) => {
      const byPosture = POSTURE_RANK[a.posture] - POSTURE_RANK[b.posture];
      if (byPosture !== 0) return byPosture;
      const byScore = b.score - a.score;
      if (byScore !== 0) return byScore;
      return a.patientId.localeCompare(b.patientId);
    });
}

/* ---------------------------------------------------------------------
 * Deterministic demo cohort — mirrors the anemia seed style: fixed ids,
 * fixed weights, no randomness, so tests can assert exact postures.
 * --------------------------------------------------------------------- */

const NOW = '2026-09-01T00:00:00Z';

function sig(
  patientId: string,
  facilityId: string,
  kind: EwSignalKind,
  label: string,
  polarity: EwPolarity,
  weight: number,
  sourceId: string,
): EarlyWarningSignal {
  return { patientId, facilityId, kind, label, polarity, weight, sourceId, at: NOW };
}

/** A default renal cohort: one alert, one weak/watch, one contested, one
 *  reassured, one ESA-only (single channel → weak) and one low-reliability
 *  sparse-telemetry patient. */
export function defaultEarlyWarningSignals(): EarlyWarningSignal[] {
  const rl = (facility: string, suffix: string) => `realm-ledger:${facility}:${suffix}`;
  const f = 'fac-1';
  return [
    // A — ALERT: multiple agreeing realm-ledger deteriorating facts + events.
    sig('f1-pt-0001', f, 'lab', 'K 5.9 mmol/L · above 5.5', 'deteriorating', 0.7, rl(f, 'lab:k')),
    sig('f1-pt-0001', f, 'lab', 'HGB 8.9 g/dL · below 10', 'deteriorating', 0.7, rl(f, 'lab:hgb')),
    sig('f1-pt-0001', f, 'lab', 'URR 58% · below 65', 'deteriorating', 0.7, rl(f, 'lab:urr')),
    sig('f1-pt-0001', f, 'vitals', 'HR 104 bpm · SpO2 90%', 'deteriorating', 0.7, rl(f, 'vitals')),
    sig('f1-pt-0001', f, 'missed-treatment', '2 missed treatments this week', 'deteriorating', 0.5, rl(f, 'events:missed-tx')),
    sig('f1-pt-0001', f, 'esa-no-response', 'ESA escalated 2× with flat Hb', 'deteriorating', 0.5, rl(f, 'esa:no-response')),

    // B — WATCH: one strong deteriorating fact only, below the alert gate.
    sig('f1-pt-0002', f, 'lab', 'K 5.7 mmol/L · single elevated result', 'deteriorating', 0.7, rl(f, 'lab:k')),

    // C — CONTESTED: strong deteriorating labs vs strong reassuring vitals/Hb —
    //     conflicting evidence raises K → held for human verification, not auto-flag.
    sig('f1-pt-0003', f, 'lab', 'K 5.6 mmol/L', 'deteriorating', 0.7, rl(f, 'lab:k')),
    sig('f1-pt-0003', f, 'lab', 'URR 60%', 'deteriorating', 0.7, rl(f, 'lab:urr')),
    sig('f1-pt-0003', f, 'vitals', 'SpO2 97% · HR 74 bpm · reassuring vitals', 'stable', 0.7, rl(f, 'vitals')),
    sig('f1-pt-0003', f, 'lab', 'HGB 11.2 g/dL · in band', 'stable', 0.7, rl(f, 'lab:hgb')),

    // D — REASSURED: all stable, nothing committed to deterioration.
    sig('f1-pt-0004', f, 'lab', 'K 4.2 mmol/L', 'stable', 0.7, rl(f, 'lab:k')),
    sig('f1-pt-0004', f, 'lab', 'HGB 11.5 g/dL', 'stable', 0.7, rl(f, 'lab:hgb')),
    sig('f1-pt-0004', f, 'lab', 'URR 72%', 'stable', 0.7, rl(f, 'lab:urr')),
    sig('f1-pt-0004', f, 'lab', 'PHOS 4.4 mg/dL', 'stable', 0.7, rl(f, 'lab:phos')),
    sig('f1-pt-0004', f, 'vitals', 'HR 74 bpm · SpO2 98%', 'stable', 0.7, rl(f, 'vitals')),

    // E — WEAK single-channel: ESA no-response alone, otherwise clean — one
    //     channel can escalate but is not enough to auto-alert.
    sig('f1-pt-0005', f, 'esa-no-response', 'ESA escalated without response', 'deteriorating', 0.5, rl(f, 'esa:no-response')),

    // F — WEAK + wide ignorance: deteriorating signals only from low-reliability
    //     (simulated) sources — commitment is low and Pl − Bel is wide.
    sig('f1-pt-0006', f, 'lab', 'K 5.8 mmol/L · sim-derived', 'deteriorating', 0.7, 'sim:f1-pt-0006:lab:k'),
    sig('f1-pt-0006', f, 'missed-treatment', 'missed treatment · sim-derived', 'deteriorating', 0.5, 'sim:f1-pt-0006:missed-tx'),
  ];
}
