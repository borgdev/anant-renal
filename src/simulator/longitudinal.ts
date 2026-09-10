/******************************************************************************
 * R1 — deterministic longitudinal patient history generator.
 *
 * "Complete data" for the demo: every patient starts with a full 90-day
 * longitudinal record (daily vitals, weekly dialysis labs, missed treatments,
 * ESA escalations) that is *consistent with its trajectory label* and fully
 * deterministic (mulberry32 seeded from patientId + scenario seed), so:
 *
 *   • patient charts / CfC-LTC context / early-warning readouts have history
 *     from day one instead of waiting for the sim clock to accrete it;
 *   • the same patient id + seed always yields the same history run-to-run;
 *   • a demo can fast-forward to "a quarter of real operations" instantly.
 *
 * The profile returned also carries `latest`, shaped to seed a realm patient's
 * `state.labs` / `state.lastVitals` on creation (see sim-populator).
 ******************************************************************************/

import { mulberry32 } from './rng.js';

export type LongitudinalTrajectory =
  | 'stable' | 'decompensating' | 'recovering' | 'anemic-worsening'
  | 'anemic-recovering' | 'underdialyzed' | 'hyperphosphatemia';

export const LONGITUDINAL_TRAJECTORIES: readonly LongitudinalTrajectory[] = [
  'stable', 'decompensating', 'recovering', 'anemic-worsening',
  'anemic-recovering', 'underdialyzed', 'hyperphosphatemia',
];

export interface LongitudinalLabs { K: number; HGB: number; URR: number; PHOS: number }

/** F1 — CKD-MBD / nutrition / inflammation baseline panel (deterministic per trajectory). */
export interface LongitudinalPanel {
  calcium: number; pth: number; albumin: number; creatinine: number;
  bicarb: number; crp: number; wbc: number; procalcitonin: number;
}

export function baselinePanelFor(trajectory: LongitudinalTrajectory): LongitudinalPanel {
  const anemic = trajectory === 'anemic-worsening' || trajectory === 'anemic-recovering';
  const inflamed = anemic || trajectory === 'decompensating';
  const mbd = trajectory === 'hyperphosphatemia';
  return {
    calcium: mbd ? 9.7 : 9.0,
    pth: mbd ? 640 : anemic ? 420 : 320,
    albumin: anemic || trajectory === 'underdialyzed' ? 3.4 : 3.8,
    creatinine: trajectory === 'decompensating' ? 7.1 : 8.6,
    bicarb: trajectory === 'underdialyzed' ? 20 : 23,
    crp: inflamed ? 14.5 : 6.2,
    wbc: inflamed ? 8.9 : 7.1,
    procalcitonin: inflamed ? 0.8 : 0.3,
  };
}
export interface LongitudinalVitals { hr: number; bp: string; spo2: number; tempC: number }

export interface DailyHistoryPoint {
  /** ISO date of this point (dayOffset 0 = the `asOf` date). */
  date: string;
  /** Negative: how many days before `asOf` this point is. */
  dayOffset: number;
  vitals: LongitudinalVitals;
  /** Weekly dialysis labs — present on lab days only. */
  labs?: LongitudinalLabs;
  /** True on a dialysis day where the patient missed treatment. */
  treatmentMissed: boolean;
  /** ESA dose in units/week when the patient is on ESA (else absent). */
  esaDose?: number;
}

export interface PatientLongitudinalProfile {
  patientId: string;
  facilityId: string;
  trajectory: LongitudinalTrajectory;
  onEsa: boolean;
  asOf: string;
  days: number;
  seed: number;
  history: DailyHistoryPoint[];
  latest: {
    labs: LongitudinalLabs;
    vitals: LongitudinalVitals;
    missedTreatmentsLast90d: number;
    esaEscalationsLast90d: number;
  };
}

/** Small deterministic string hash so a patientId gives a stable sub-seed. */
export function hashSeed(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Deterministic (jittered) baseline labs for a trajectory. */
export function baselineLabsFor(trajectory: LongitudinalTrajectory, rng: () => number): LongitudinalLabs {
  const j = (amount: number): number => (rng() - 0.5) * amount;
  switch (trajectory) {
    case 'stable': return { K: round1(4.3 + j(0.4)), HGB: round1(11.4 + j(0.6)), URR: Math.round(71 + j(4)), PHOS: round1(4.6 + j(0.6)) };
    case 'decompensating': return { K: round1(5.6 + j(0.4)), HGB: round1(9.2 + j(0.6)), URR: Math.round(60 + j(5)), PHOS: round1(5.6 + j(0.6)) };
    case 'recovering': return { K: round1(4.5 + j(0.4)), HGB: round1(11.0 + j(0.5)), URR: Math.round(70 + j(4)), PHOS: round1(4.5 + j(0.6)) };
    case 'anemic-worsening': return { K: round1(5.2 + j(0.3)), HGB: round1(8.6 + j(0.5)), URR: Math.round(64 + j(4)), PHOS: round1(5.0 + j(0.5)) };
    case 'anemic-recovering': return { K: round1(4.6 + j(0.3)), HGB: round1(10.4 + j(0.5)), URR: Math.round(68 + j(4)), PHOS: round1(4.6 + j(0.5)) };
    case 'underdialyzed': return { K: round1(5.8 + j(0.4)), HGB: round1(10.2 + j(0.6)), URR: Math.round(57 + j(5)), PHOS: round1(5.4 + j(0.6)) };
    case 'hyperphosphatemia': return { K: round1(5.0 + j(0.4)), HGB: round1(10.8 + j(0.5)), URR: Math.round(66 + j(4)), PHOS: round1(6.9 + j(0.6)) };
  }
}

/** Whether this trajectory is on ESA (Hb-lowering CKD anemia trajectories). */
export function trajectoryOnEsa(trajectory: LongitudinalTrajectory): boolean {
  return trajectory === 'anemic-worsening' || trajectory === 'anemic-recovering'
    || trajectory === 'underdialyzed' || trajectory === 'decompensating';
}

/** Missed-treatment probability per dialysis day, by trajectory. */
function missProbability(trajectory: LongitudinalTrajectory): number {
  switch (trajectory) {
    case 'decompensating': return 0.14;
    case 'anemic-worsening': return 0.08;
    case 'underdialyzed': return 0.12;
    case 'recovering': case 'anemic-recovering': return 0.04;
    case 'stable': return 0.02;
    default: return 0.06;
  }
}

/** Dialysis cadence 3×/week on Mon/Wed/Fri — returns ISO date at dayOffset. */
function dialysisDay(date: Date): boolean {
  const weekday = date.getUTCDay(); // 0 Sun … 6 Sat
  return weekday === 1 || weekday === 3 || weekday === 5;
}

const VITALS_MEAN: Record<LongitudinalTrajectory, { hr: number; spo2: number; sys: number; dia: number; temp: number }> = {
  stable: { hr: 76, spo2: 97, sys: 130, dia: 78, temp: 36.7 },
  // a decompensating patient is the inflamed one — the P6 triage needs a real
  // febrile signal, not a decorative one
  decompensating: { hr: 102, spo2: 90, sys: 96, dia: 60, temp: 38.3 },
  recovering: { hr: 80, spo2: 96, sys: 124, dia: 76, temp: 37.0 },
  'anemic-worsening': { hr: 94, spo2: 94, sys: 118, dia: 72, temp: 37.1 },
  'anemic-recovering': { hr: 84, spo2: 96, sys: 122, dia: 74, temp: 36.9 },
  underdialyzed: { hr: 88, spo2: 95, sys: 126, dia: 76, temp: 36.9 },
  hyperphosphatemia: { hr: 84, spo2: 96, sys: 132, dia: 80, temp: 36.8 },
};

export interface LongitudinalOptions {
  patientId: string;
  facilityId: string;
  trajectory: LongitudinalTrajectory;
  /** History length in days (default 90). */
  days?: number;
  /** Scenario/site seed (default 1). */
  seed?: number;
  /** Anchor date (default: today UTC). */
  asOf?: Date;
}

/** Generate a full deterministic longitudinal history for one patient. */
export function generateLongitudinalHistory(opts: LongitudinalOptions): PatientLongitudinalProfile {
  const days = Math.max(7, Math.min(365, opts.days ?? 90));
  const seed = opts.seed ?? 1;
  const asOf = opts.asOf ?? new Date();
  const onEsa = trajectoryOnEsa(opts.trajectory);
  const rng = mulberry32((hashSeed(opts.patientId) ^ Math.imul(seed, 2654435761)) >>> 0);
  const baseline = baselineLabsFor(opts.trajectory, rng);
  const mean = VITALS_MEAN[opts.trajectory];

  const start = new Date(asOf.getTime());
  start.setUTCDate(start.getUTCDate() - (days - 1));
  start.setUTCHours(6, 0, 0, 0);

  const history: DailyHistoryPoint[] = [];
  let missedTreatments = 0;
  let esaEscalations = 0;
  // Current ESA dose starts low and drifts up for worsening trajectories.
  let esaDose = 4000;

  for (let i = 0; i < days; i += 1) {
    const date = new Date(start.getTime() + i * 86_400_000);
    const dayOffset = i - (days - 1); // 0 today, negative in the past
    const progress = i / days; // 0 oldest → 1 today

    // Vitals drift toward the trajectory's concerning end as we approach today
    // for worsening trajectories, and toward healthy for recovering ones.
    const drift = opts.trajectory === 'decompensating' || opts.trajectory === 'anemic-worsening' || opts.trajectory === 'underdialyzed'
      ? progress
      : opts.trajectory === 'recovering' || opts.trajectory === 'anemic-recovering'
        ? 1 - progress
        : 0;
    const hr = Math.round(mean.hr + (rng() - 0.5) * 8 + drift * (102 - mean.hr) * 0.4);
    const spo2 = Math.round(Math.max(82, Math.min(100, mean.spo2 + (rng() - 0.5) * 2 - drift * 6)));
    const sys = Math.round(mean.sys + (rng() - 0.5) * 6);
    const dia = Math.round(mean.dia + (rng() - 0.5) * 5);
    // temperature: the trajectory's baseline plus a real low-grade/ febrile
    // swing, so a serial series carries a triage signal (P6) and a trend (fluid)
    const tempC = round1(Math.max(35.8, Math.min(39.6, mean.temp + (rng() - 0.5) * 0.6 + drift * (38.6 - mean.temp) * 0.35)));
    const vitals: LongitudinalVitals = { hr, bp: `${sys}/${dia}`, spo2, tempC };

    // Dialysis on Mon/Wed/Fri.
    const isDialysis = dialysisDay(date);
    const treatmentMissed = isDialysis && rng() < missProbability(opts.trajectory);
    if (treatmentMissed) missedTreatments += 1;

    // ESA: weekly dose adjustments on dialysis weeks; worsening escalates.
    let pointEsa: number | undefined;
    if (onEsa) {
      pointEsa = esaDose;
      if (isDialysis && rng() < 0.12) {
        if (opts.trajectory === 'anemic-worsening' || opts.trajectory === 'decompensating') {
          esaDose = Math.min(20000, esaDose + 500);
          if (esaDose % 2000 === 0) esaEscalations += 1;
        } else if (opts.trajectory === 'anemic-recovering') {
          esaDose = Math.max(0, esaDose - 500);
        }
      }
    }

    // Weekly labs (every 7th day counting from today).
    let labs: LongitudinalLabs | undefined;
    if ((days - 1 - i) % 7 === 0) {
      let trend = 0;
      switch (opts.trajectory) {
        case 'anemic-worsening': case 'decompensating': trend = -progress; break; // HGB falling
        case 'anemic-recovering': trend = progress; break;                        // HGB rising
        case 'underdialyzed': trend = -progress * 0.5; break;                     // URR creeping down
        case 'hyperphosphatemia': trend = progress * 0.4; break;                  // PHOS drifting up
        default: trend = 0;
      }
      const j = (amount: number): number => (rng() - 0.5) * amount;
      labs = {
        K: round1(baseline.K + j(0.3)),
        HGB: round1(baseline.HGB + j(0.3) + trend * 1.6),
        URR: Math.max(40, Math.min(85, Math.round(baseline.URR + j(3) + trend * 12))),
        PHOS: round1(baseline.PHOS + j(0.4) + trend * 1.2),
      };
    }

    history.push({
      date: date.toISOString().slice(0, 10),
      dayOffset,
      vitals,
      ...(labs ? { labs } : {}),
      treatmentMissed,
      ...(pointEsa !== undefined ? { esaDose: pointEsa } : {}),
    });
  }

  // Latest labs/vitals from the most recent lab day / today.
  const todayPoint = history[history.length - 1]!;
  const lastLabPoint = [...history].reverse().find((p) => p.labs) ?? todayPoint;
  return {
    patientId: opts.patientId,
    facilityId: opts.facilityId,
    trajectory: opts.trajectory,
    onEsa,
    asOf: asOf.toISOString(),
    days,
    seed,
    history,
    latest: {
      labs: lastLabPoint.labs ?? baseline,
      vitals: todayPoint.vitals,
      missedTreatmentsLast90d: missedTreatments,
      esaEscalationsLast90d: onEsa ? esaEscalations : 0,
    },
  };
}
