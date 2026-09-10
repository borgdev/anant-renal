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

// F1 — Renal cohort projection.
// Pure, ledger-derived patient facts that the protocol layer (F2) and the
// protocol cockpit (F3) read. Nothing here is invented: every field is derived
// from realm patient state written by the effect reducer (dialysis sessions,
// telemetry, access observations, labs, med exposures). Synthetic sim data.

/** CKD-MBD / nutrition / inflammation / infection panel keys as stored on patient state. */
export const RENAL_PANEL_KEYS = ['calcium', 'pth', 'albumin', 'creatinine', 'bicarb', 'crp', 'wbc', 'procalcitonin'] as const;
/** Dialysis-relevant labs already carried on patient state. */
export const RENAL_CORE_LAB_KEYS = ['K', 'HGB', 'URR', 'PHOS', 'FERRITIN', 'TSAT'] as const;

export type RenalPanelKey = (typeof RENAL_PANEL_KEYS)[number];

export interface RenalSessionFacts {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  deliveredMinutes: number;
  prescribedMinutes?: number;
  /** delivered / prescribed, % */
  adherencePct?: number;
  ufVolumeL: number;
  targetUfL?: number;
  /** achieved UF as a share of the prescribed target, % */
  ufAchievementPct?: number;
  /** inter-dialytic weight gain (kg) = this pre-weight − previous post-weight */
  idwgKg?: number;
  qbAvg?: number;
  recirculationPct?: number;
  nadirSbp?: number;
  meanSbp?: number;
  stoppedEarly: boolean;
  complication?: string;
  symptoms?: string[];
  telemetryPoints: number;
}

export interface RenalAccessFacts {
  type?: string;
  site?: string;
  ageDays?: number;
  observations: number;
  lastEvent?: string;
  lastEventAt?: string;
  /** true when the access shows a dysfunction pattern (thrombosis / declot / angioplasty / cannulation difficulty) */
  dysfunction: boolean;
}

export interface RenalPatientFacts {
  patientId: string;
  realmId: string;
  facilityId?: string;
  unitId?: string;
  trajectory?: string;
  age?: number;
  sex?: string;
  access: RenalAccessFacts;
  sessions: {
    count: number;
    lastAt?: string;
    avgDeliveredMinutes?: number;
    avgUfVolumeL?: number;
    avgUfAchievementPct?: number;
    avgAdherencePct?: number;
    minNadirSbp?: number;
    avgRecirculationPct?: number;
    /** mean inter-dialytic weight gain across computable pairs, kg */
    avgIdwgKg?: number;
    stoppedEarlyCount: number;
    complicationCount: number;
    telemetryPoints: number;
  };
  labs: Record<string, number>;
  panel: { present: RenalPanelKey[]; missing: RenalPanelKey[]; completenessPct: number };
  exposure: {
    esaDoseUnits?: number;
    maintenanceMeds: string[];
    phosphateBinders: string[];
    calcimimetics: string[];
    vitaminD: string[];
    ivIron: boolean;
  };
  signals: {
    hypotensiveSessions: number;
    shortSessions: number;
    highRecirculation: boolean;
    hyperphosphatemia: boolean;
    hypercalcemia: boolean;
    hyperparathyroidism: boolean;
    lowAlbumin: boolean;
    inflammation: boolean;
    metabolicAcidosis: boolean;
    infectionRisk: boolean;
    accessRisk: boolean;
  };
}

export interface RenalCohortSummary {
  patients: number;
  realms: number;
  sessions: number;
  patientsWithSessions: number;
  avgSessionsPerPatient: number;
  avgRecirculationPct?: number;
  hypotensionRatePct: number;
  shortSessionRatePct: number;
  avgPanelCompletenessPct: number;
  hyperphosphatemiaCount: number;
  hyperparathyroidismCount: number;
  lowAlbuminCount: number;
  inflammationCount: number;
  infectionRiskCount: number;
  accessRiskCount: number;
}

export interface RenalPatientInput {
  id: string;
  realmId: string;
  state: Record<string, unknown>;
  /** Medication codes ordered for this patient (from the realm ledger, order-med effects). */
  medCodes?: readonly string[];
}

const BINDERS = ['sevelamer', 'calcium-acetate', 'lanthanum', 'sucroferric-oxyhydroxide'];
const CALCIMIMETICS = ['cinacalcet', 'etelcalcetide'];
const VITAMIN_D = ['calcitriol', 'paricalcitol', 'doxercalciferol', 'alfacalcidol'];
const IRON_MEDS = ['ferric-sucrose', 'iron-sucrose', 'ferumoxytol', 'iron-dextran', 'ferric-carboxymaltose'];

const num = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number.parseFloat(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
};

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const avg = (xs: number[]): number | undefined => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : undefined);

function toSessionFacts(raw: Record<string, unknown>, previous: Record<string, unknown> | undefined): RenalSessionFacts {
  const deliveredMinutes = num(raw.deliveredMinutes) ?? 0;
  const prescribedMinutes = num(raw.prescribedMinutes);
  const ufVolumeL = num(raw.ufVolumeL) ?? 0;
  const targetUfL = num(raw.targetUfL);
  const preWeightKg = num(raw.preWeightKg);
  const prevPostWeightKg = previous ? num(previous.postWeightKg) : undefined;
  const symptoms = Array.isArray(raw.symptoms) ? raw.symptoms.filter((s): s is string => typeof s === 'string') : undefined;
  return {
    sessionId: str(raw.sessionId) ?? 'unknown',
    startedAt: str(raw.startedAt) ?? '',
    endedAt: str(raw.endedAt) ?? '',
    deliveredMinutes,
    ...(prescribedMinutes !== undefined ? { prescribedMinutes } : {}),
    ...(prescribedMinutes ? { adherencePct: Math.round((deliveredMinutes / prescribedMinutes) * 100) } : {}),
    ufVolumeL,
    ...(targetUfL !== undefined ? { targetUfL } : {}),
    ...(targetUfL && targetUfL > 0 ? { ufAchievementPct: Math.round((ufVolumeL / targetUfL) * 100) } : {}),
    ...(preWeightKg !== undefined && prevPostWeightKg !== undefined ? { idwgKg: Math.round((preWeightKg - prevPostWeightKg) * 10) / 10 } : {}),
    ...(num(raw.qbAvg) !== undefined ? { qbAvg: num(raw.qbAvg) } : {}),
    ...(num(raw.recirculationPct) !== undefined ? { recirculationPct: num(raw.recirculationPct) } : {}),
    ...(num(raw.nadirSbp) !== undefined ? { nadirSbp: num(raw.nadirSbp) } : {}),
    ...(num(raw.meanSbp) !== undefined ? { meanSbp: num(raw.meanSbp) } : {}),
    stoppedEarly: raw.stoppedEarly === true,
    ...(str(raw.complication) ? { complication: str(raw.complication) } : {}),
    ...(symptoms?.length ? { symptoms } : {}),
    telemetryPoints: num(raw.telemetryPoints) ?? 0,
  };
}

/** F1 — derive the renal fact sheet for one patient from its realm state. */
export function renalPatientFacts(input: RenalPatientInput): RenalPatientFacts {
  const s = input.state;
  const rawSessions = Array.isArray(s.sessions) ? (s.sessions as Array<Record<string, unknown>>) : [];
  const sessions = rawSessions.map((raw, i) => toSessionFacts(raw, i > 0 ? rawSessions[i - 1] : undefined));
  const accessRaw = (s.access ?? {}) as Record<string, unknown>;
  const observations = Array.isArray(s.accessObservations) ? (s.accessObservations as Array<Record<string, unknown>>) : [];
  const lastObservation = observations.length ? observations[observations.length - 1] : undefined;

  const labs: Record<string, number> = {};
  const rawLabs = (s.labs ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(rawLabs)) {
    const n = num(v);
    if (n !== undefined) labs[k] = n;
  }

  const present: RenalPanelKey[] = [];
  const missing: RenalPanelKey[] = [];
  for (const key of RENAL_PANEL_KEYS) (labs[key] !== undefined ? present : missing).push(key);

  const orders = Array.isArray(s.medOrders) ? (s.medOrders as Array<Record<string, unknown>>) : [];
  const medCodes = new Set<string>([
    ...(input.medCodes ?? []),
    ...orders.map((o) => str(o.code) ?? ''),
    ...(Array.isArray(s.medCodes) ? (s.medCodes as unknown[]).map((c) => str(c) ?? '') : []),
  ].filter((c) => c.length > 0));

  const recirc = sessions.map((x) => x.recirculationPct).filter((v): v is number => v !== undefined);
  const nadir = sessions.map((x) => x.nadirSbp).filter((v): v is number => v !== undefined);
  const idwg = sessions.map((x) => x.idwgKg).filter((v): v is number => v !== undefined);
  const delivered = sessions.map((x) => x.deliveredMinutes).filter((v) => v > 0);
  const uf = sessions.map((x) => x.ufVolumeL);
  const ufAch = sessions.map((x) => x.ufAchievementPct).filter((v): v is number => v !== undefined);
  const adherence = sessions.map((x) => x.adherencePct).filter((v): v is number => v !== undefined);
  const hypotensive = sessions.filter((x) => (x.nadirSbp ?? 999) < 90 || x.complication === 'intradialytic-hypotension').length;
  const shortSessions = sessions.filter((x) => (x.adherencePct ?? 100) < 90).length;
  const accessRisk = Boolean(lastObservation && ['thrombosis', 'declot', 'angioplasty', 'cannulation-difficulty', 'infection'].includes(str(lastObservation.event) ?? ''));
  const avgRecirculationPct = avg(recirc);

  const calcium = labs.calcium;
  const pth = labs.pth;
  const albumin = labs.albumin;
  const crp = labs.crp;
  const bicarb = labs.bicarb;
  const wbc = labs.wbc;
  const procalcitonin = labs.procalcitonin;
  const temp = num((s.lastVitals as Record<string, unknown> | undefined)?.temp);
  const phos = labs.PHOS;

  return {
    patientId: input.id,
    realmId: input.realmId,
    ...(str(s.facilityId) ? { facilityId: str(s.facilityId) } : {}),
    ...(str(s.unitId) ? { unitId: str(s.unitId) } : {}),
    ...(str(s.trajectory) ? { trajectory: str(s.trajectory) } : {}),
    ...(num(s.age) !== undefined ? { age: num(s.age) } : {}),
    ...(str(s.sex) ? { sex: str(s.sex) } : {}),
    access: {
      ...(str(accessRaw.type) ? { type: str(accessRaw.type) } : {}),
      ...(str(accessRaw.site) ? { site: str(accessRaw.site) } : {}),
      ...(num(accessRaw.ageDays) !== undefined ? { ageDays: num(accessRaw.ageDays) } : {}),
      observations: observations.length,
      ...(lastObservation && str(lastObservation.event) ? { lastEvent: str(lastObservation.event) } : {}),
      ...(lastObservation && str(lastObservation.at) ? { lastEventAt: str(lastObservation.at) } : {}),
      dysfunction: accessRisk,
    },
    sessions: {
      count: sessions.length,
      ...(sessions.length ? { lastAt: sessions[sessions.length - 1]?.endedAt } : {}),
      ...(avg(delivered) !== undefined ? { avgDeliveredMinutes: avg(delivered) } : {}),
      ...(avg(uf) !== undefined ? { avgUfVolumeL: avg(uf) } : {}),
      ...(avg(ufAch) !== undefined ? { avgUfAchievementPct: avg(ufAch) } : {}),
      ...(avg(adherence) !== undefined ? { avgAdherencePct: avg(adherence) } : {}),
      ...(nadir.length ? { minNadirSbp: Math.min(...nadir) } : {}),
      ...(avgRecirculationPct !== undefined ? { avgRecirculationPct } : {}),
      ...(avg(idwg) !== undefined ? { avgIdwgKg: avg(idwg) } : {}),
      stoppedEarlyCount: sessions.filter((x) => x.stoppedEarly).length,
      complicationCount: sessions.filter((x) => x.complication !== undefined).length,
      telemetryPoints: sessions.reduce((acc, x) => acc + x.telemetryPoints, 0),
    },
    labs,
    panel: { present, missing, completenessPct: Math.round((present.length / RENAL_PANEL_KEYS.length) * 100) },
    exposure: {
      ...(num(s.esaDose) !== undefined ? { esaDoseUnits: num(s.esaDose) } : {}),
      maintenanceMeds: [...medCodes],
      phosphateBinders: [...medCodes].filter((c) => BINDERS.includes(c)),
      calcimimetics: [...medCodes].filter((c) => CALCIMIMETICS.includes(c)),
      vitaminD: [...medCodes].filter((c) => VITAMIN_D.includes(c)),
      ivIron: [...medCodes].some((c) => IRON_MEDS.includes(c)),
    },
    signals: {
      hypotensiveSessions: hypotensive,
      shortSessions,
      highRecirculation: (avgRecirculationPct ?? 0) >= 10,
      hyperphosphatemia: (phos ?? 0) > 5.5,
      hypercalcemia: (calcium ?? 0) > 10.2,
      hyperparathyroidism: (pth ?? 0) > 600,
      lowAlbumin: (albumin ?? 99) < 3.5,
      inflammation: (crp ?? 0) > 10,
      metabolicAcidosis: (bicarb ?? 99) < 22,
      infectionRisk: (temp ?? 0) > 38 || (procalcitonin ?? 0) > 0.5 || ((wbc ?? 0) > 12 && (crp ?? 0) > 10),
      accessRisk,
    },
  };
}

/** F1 — cohort + fleet-level roll-up derived from realm patient state. */
export function buildRenalCohort(inputs: RenalPatientInput[]): { patients: RenalPatientFacts[]; summary: RenalCohortSummary } {
  const patients = inputs.map(renalPatientFacts);
  const sessionCounts = patients.map((p) => p.sessions.count);
  const recirc = patients.map((p) => p.sessions.avgRecirculationPct).filter((v): v is number => v !== undefined);
  const withSessions = patients.filter((p) => p.sessions.count > 0);
  const totalSessions = sessionCounts.reduce((a, b) => a + b, 0);
  const hypotensiveTotal = patients.reduce((acc, p) => acc + p.signals.hypotensiveSessions, 0);
  const shortTotal = patients.reduce((acc, p) => acc + p.signals.shortSessions, 0);
  return {
    patients,
    summary: {
      patients: patients.length,
      realms: new Set(patients.map((p) => p.realmId)).size,
      sessions: totalSessions,
      patientsWithSessions: withSessions.length,
      avgSessionsPerPatient: patients.length ? Math.round((totalSessions / patients.length) * 10) / 10 : 0,
      ...(avg(recirc) !== undefined ? { avgRecirculationPct: avg(recirc) } : {}),
      hypotensionRatePct: totalSessions ? Math.round((hypotensiveTotal / totalSessions) * 100) : 0,
      shortSessionRatePct: totalSessions ? Math.round((shortTotal / totalSessions) * 100) : 0,
      avgPanelCompletenessPct: patients.length ? Math.round(patients.reduce((a, p) => a + p.panel.completenessPct, 0) / patients.length) : 0,
      hyperphosphatemiaCount: patients.filter((p) => p.signals.hyperphosphatemia).length,
      hyperparathyroidismCount: patients.filter((p) => p.signals.hyperparathyroidism).length,
      lowAlbuminCount: patients.filter((p) => p.signals.lowAlbumin).length,
      inflammationCount: patients.filter((p) => p.signals.inflammation).length,
      infectionRiskCount: patients.filter((p) => p.signals.infectionRisk).length,
      accessRiskCount: patients.filter((p) => p.signals.accessRisk).length,
    },
  };
}
