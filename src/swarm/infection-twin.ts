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

// P6 step D — the infection twin over the REAL ledger.
//
// Two things are replayed here, and the point of the twin is to keep them apart:
//
//   1. the TRIAGE series — temperature readings (`vital.observed`), the
//      inflammatory panel, cultures and the access state. The reference triage
//      is walked forward culture-by-culture and scored (AUROC / Brier) against
//      what the culture actually grew. If there are not enough cultures with
//      both outcomes, the verdict is "insufficient" — never a fabricated score.
//
//   2. the PREVENTION provenance — immunisation records, serology results and
//      audit assessments. The twin asserts that the prevention plan derived from
//      these records is BIT-IDENTICAL across repeated builds, i.e. it carries no
//      dependence on the triage series at all.
//
// The catheter-day count comes from the access state (a catheter's age is its
// catheter days); the mature-alternative signal needs BOTH a documented mature
// access age and a catheter in situ.

import {
  INFECTION_REFERENCE, assessBsi, computeNlr, guardInfectionTriage,
  type InfectionInput,
} from './infection.js';
import type { ImmunisationRecord } from './infection-types.js';
import { preventionPlan, preventionDeterminismSignature } from './infection-prevention.js';
import { attributePatientIdFromOrder } from './renal-cohort.js';

export const INFECTION_TWIN_TARGET_AUROC = 0.8;
export const INFECTION_TWIN_TARGET_BRIER = 0.2;

export interface InfectionTwinEventInput {
  realmId?: string;
  eventId?: string;
  kind: string;
  emittedAt: string;
  realmAt?: string;
  patientId?: string;
  payload: Record<string, unknown>;
}

export interface InfectionTwinPatientInput { patientId: string; realmId?: string; state: Record<string, unknown> }

export interface TemperatureReading {
  at: string;
  tempC: number;
  hr?: number | undefined;
  spo2?: number | undefined;
}

export interface InfectionObservation {
  at: string;
  procalcitoninNgMl?: number | undefined;
  wbc?: number | undefined;
  crp?: number | undefined;
  albumin?: number | undefined;
  neutrophilPct?: number | undefined;
  lymphocytePct?: number | undefined;
}

export interface CultureRecord {
  at: string;
  /** 1 = organism grown, 0 = no growth */
  result: number;
  positive: boolean;
  orderId?: string | undefined;
}

export interface InfectionTwin {
  patientId: string;
  asOf: string;
  temperatures: TemperatureReading[];
  observations: InfectionObservation[];
  cultures: CultureRecord[];
  /** the deterministic half's raw material, straight off the ledger */
  immunisations: Array<ImmunisationRecord & { at: string }>;
  serology: Array<{ at: string; iuL: number }>;
  audits: Array<{ at: string; assessmentId: string }>;
  access: {
    accessType?: 'avf' | 'avg' | 'catheter' | undefined;
    catheterDays?: number | undefined;
    accessAgeDays?: number | undefined;
    matureAvfAvailable: boolean;
    accessInfectionSigns: boolean;
  };
  summary: {
    readings: number;
    peakTemperatureC?: number | undefined;
    latestTemperatureC?: number | undefined;
    febrileEpisodes: number;
    latestProcalcitoninNgMl?: number | undefined;
    latestWbc?: number | undefined;
    latestNlr?: number | undefined;
    latestCrp?: number | undefined;
    cultures: number;
    positiveCultures: number;
    /** the coverage inputs, stated explicitly */
    serialReadings: number;
    inflammatoryMarkers: number;
    immunisationRecords: number;
    duePreventionTasks: number;
    overduePreventionTasks: number;
  };
  /** the triage input window rebuilt from the twin */
  window: InfectionInput;
  /** the deterministic prevention plan derived from the ledger records */
  preventionPlan: ReturnType<typeof preventionPlan>;
  preventionSignature: string;
  provenance: {
    source: 'realm-ledger';
    temperatureEvents: number;
    labEvents: number;
    cultureResults: number;
    immunisationEvents: number;
    auditAssessments: number;
    attributedBy: 'payload-patientId' | 'order-id-prefix' | 'none';
    synthetic: true;
  };
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
const atOf = (e: InfectionTwinEventInput): string => e.realmAt ?? e.emittedAt;

/** Lab codes the twin reads as triage inputs. */
const INFECTION_LAB_CODES = new Set(['PROCALCITONIN', 'WBC', 'CRP', 'ALBUMIN', 'NEUTPCT', 'LYMPHPCT']);
const CULTURE_CODE = 'BCULT';
const SEROLOGY_CODE = 'HBSAB';

export function buildInfectionTwin(input: {
  patientId: string;
  events: readonly InfectionTwinEventInput[];
  patients?: readonly InfectionTwinPatientInput[];
  asOf?: string;
}): InfectionTwin {
  const knownPatientIds = [input.patientId, ...(input.patients ?? []).map((p) => p.patientId)];
  const state = (input.patients ?? []).find((p) => p.patientId === input.patientId)?.state ?? {};

  const temperatures: TemperatureReading[] = [];
  const observationMap = new Map<string, InfectionObservation>();
  const cultures: CultureRecord[] = [];
  const immunisations: Array<ImmunisationRecord & { at: string }> = [];
  const serology: Array<{ at: string; iuL: number }> = [];
  const audits: Array<{ at: string; assessmentId: string }> = [];
  let attributedBy: InfectionTwin['provenance']['attributedBy'] = 'none';
  let temperatureEvents = 0;
  let labEvents = 0;
  let cultureResults = 0;
  let immunisationEvents = 0;
  let auditAssessments = 0;

  const obsAt = (at: string): InfectionObservation => {
    const existing = observationMap.get(at);
    if (existing) return existing;
    const fresh: InfectionObservation = { at };
    observationMap.set(at, fresh);
    return fresh;
  };

  // Seed from the state cache (latest vitals + panel) ONLY when the ledger gave
  // us nothing: the ledger is authoritative, and the state cache is a snapshot
  // that would otherwise duplicate the newest reading and — worse — stamp an
  // EMPTY observation at the newest timestamp whenever the cached panel is
  // partial (which then becomes "the latest values" and blanks the triage).
  const ledgerTemps = input.events.some((e) => e.kind === 'record-vitals' && str(e.payload.temp) !== undefined && num(e.payload.temp) !== undefined);
  const ledgerLabs = input.events.some((e) => e.kind === 'result-lab');
  const lastVitals = (state.lastVitals ?? {}) as Record<string, unknown>;
  if (!ledgerTemps) {
    const seededTemp = num(lastVitals.temp);
    if (seededTemp !== undefined) {
      temperatures.push({ at: str(lastVitals.at) ?? new Date().toISOString(), tempC: seededTemp });
    }
  }
  const labs = (state.labs ?? {}) as Record<string, unknown>;
  if (!ledgerLabs && Object.keys(labs).length > 0) {
    const seeded = obsAt(str(lastVitals.at) ?? new Date().toISOString());
    const put = (key: keyof InfectionObservation, value: number | undefined): void => {
      if (value !== undefined) (seeded[key] as number | undefined) = value;
    };
    put('procalcitoninNgMl', num(labs.procalcitonin));
    put('wbc', num(labs.WBC));
    put('crp', num(labs.crp));
    put('albumin', num(labs.albumin));
    put('neutrophilPct', num(labs.neutPct));
    put('lymphocytePct', num(labs.lymphPct));
  }
  // immunisations recorded on the state ring are the same records the events carry
  const stateImmunisations = Array.isArray(state.immunisations) ? (state.immunisations as Array<Record<string, unknown>>) : [];

  for (const event of input.events) {
    const payloadPatient = str(event.payload.patientId);
    const owner = payloadPatient ?? attributePatientIdFromOrder(str(event.payload.orderId) ?? '', knownPatientIds);
    if (owner !== input.patientId) continue;
    const at = atOf(event);
    attributedBy = payloadPatient ? 'payload-patientId' : 'order-id-prefix';

    if (event.kind === 'record-vitals') {
      const temp = num(event.payload.temp);
      if (temp !== undefined) {
        temperatureEvents += 1;
        temperatures.push({
          at,
          tempC: temp,
          ...(num(event.payload.hr) !== undefined ? { hr: num(event.payload.hr) } : {}),
          ...(num(event.payload.spo2) !== undefined ? { spo2: num(event.payload.spo2) } : {}),
        });
      }
      continue;
    }

    if (event.kind === 'result-lab') {
      const code = str(event.payload.code);
      const value = num(event.payload.value);
      if (code === undefined || value === undefined) continue;
      labEvents += 1;
      if (code === CULTURE_CODE) {
        cultureResults += 1;
        cultures.push({
          at,
          result: value,
          positive: value > 0,
          ...(str(event.payload.orderId) !== undefined ? { orderId: str(event.payload.orderId) } : {}),
        });
        continue;
      }
      if (code === SEROLOGY_CODE) {
        serology.push({ at, iuL: value });
        continue;
      }
      if (!INFECTION_LAB_CODES.has(code)) continue;
      const obs = obsAt(at);
      if (code === 'PROCALCITONIN') obs.procalcitoninNgMl = value;
      else if (code === 'WBC') obs.wbc = value;
      else if (code === 'CRP') obs.crp = value;
      else if (code === 'ALBUMIN') obs.albumin = value;
      else if (code === 'NEUTPCT') obs.neutrophilPct = value;
      else if (code === 'LYMPHPCT') obs.lymphocytePct = value;
      continue;
    }

    if (event.kind === 'record-immunisation') {
      const vaccine = str(event.payload.vaccine);
      if (vaccine === undefined) continue;
      immunisationEvents += 1;
      immunisations.push({
        vaccine,
        seriesDose: num(event.payload.seriesDose) ?? 1,
        ...(num(event.payload.seriesTotal) !== undefined ? { seriesTotal: num(event.payload.seriesTotal) } : {}),
        at,
      });
      continue;
    }

    if (event.kind === 'record-assessment') {
      const assessmentId = str(event.payload.assessmentId);
      if (assessmentId === undefined) continue;
      if (assessmentId === 'hand-hygiene-audit' || assessmentId === 'access-care-audit') {
        auditAssessments += 1;
        // an audit disclosed today may have been observed weeks ago; the rule
        // reads when the audit HAPPENED, not when it was recorded
        audits.push({ at: str(event.payload.observedAt) ?? at, assessmentId });
      }
      continue;
    }
  }

  // state-ring immunisations that never produced a ledger event
  for (const rec of stateImmunisations) {
    const vaccine = str(rec.vaccine);
    const at = str(rec.at);
    if (vaccine === undefined || at === undefined) continue;
    if (immunisations.some((i) => i.vaccine === vaccine && i.at === at)) continue;
    immunisations.push({
      vaccine,
      seriesDose: num(rec.seriesDose) ?? 1,
      ...(num(rec.seriesTotal) !== undefined ? { seriesTotal: num(rec.seriesTotal) } : {}),
      at,
    });
  }

  temperatures.sort((a, b) => a.at.localeCompare(b.at));
  const observations = [...observationMap.values()].sort((a, b) => a.at.localeCompare(b.at));
  cultures.sort((a, b) => a.at.localeCompare(b.at));
  immunisations.sort((a, b) => a.at.localeCompare(b.at));
  serology.sort((a, b) => a.at.localeCompare(b.at));
  audits.sort((a, b) => a.at.localeCompare(b.at));

  const accessRaw = (state.access ?? {}) as Record<string, unknown>;
  const accessTypeRaw = str(accessRaw.type);
  const accessType: 'avf' | 'avg' | 'catheter' | undefined =
    accessTypeRaw === 'catheter' ? 'catheter' : accessTypeRaw === 'avg' ? 'avg' : accessTypeRaw === 'avf' ? 'avf' : undefined;
  const accessAgeDays = num(accessRaw.ageDays);
  const catheterDays = accessType === 'catheter' ? accessAgeDays : 0;
  // a mature alternative requires a documented patent access age on a NON-catheter access
  const matureAvfAvailable = accessType === 'catheter' && (accessAgeDays ?? 0) > 0 && state.matureAccessAvailable === true;
  const accessInfectionSigns = state.accessInfectionSigns === true;

  // "latest" is the last KNOWN value per marker, not the last row: a panel can
  // arrive in pieces, and a batch that carried only albumin must not erase the
  // procalcitonin that is still the most recent one we actually have.
  const latestKnown: InfectionObservation = { at: '' };
  for (const obs of observations) {
    for (const key of ['procalcitoninNgMl', 'wbc', 'crp', 'albumin', 'neutrophilPct', 'lymphocytePct'] as const) {
      if (obs[key] !== undefined) (latestKnown[key] as number | undefined) = obs[key];
    }
    if (obs.procalcitoninNgMl !== undefined || obs.wbc !== undefined || obs.crp !== undefined) latestKnown.at = obs.at;
  }
  const latestSerology = serology.at(-1);
  // the cadence rules are per audit TYPE, so each type needs its own latest
  const latestHandHygiene = [...audits].reverse().find((a) => a.assessmentId === 'hand-hygiene-audit');
  const latestAccessCare = [...audits].reverse().find((a) => a.assessmentId === 'access-care-audit');
  const peak = temperatures.length ? Math.max(...temperatures.map((t) => t.tempC)) : undefined;

  const window: InfectionInput = {
    patientId: input.patientId,
    ...(temperatures.length ? { temperatureC: temperatures.at(-1)!.tempC } : {}),
    ...(temperatures.length ? { temperatureSeries: temperatures.slice(-8).map((t) => t.tempC) } : {}),
    ...(latestKnown.procalcitoninNgMl !== undefined ? { procalcitoninNgMl: latestKnown.procalcitoninNgMl } : {}),
    ...(latestKnown.neutrophilPct !== undefined ? { neutrophilPct: latestKnown.neutrophilPct } : {}),
    ...(latestKnown.lymphocytePct !== undefined ? { lymphocytePct: latestKnown.lymphocytePct } : {}),
    ...(latestKnown.wbc !== undefined ? { wbc: latestKnown.wbc } : {}),
    ...(latestKnown.crp !== undefined ? { crp: latestKnown.crp } : {}),
    ...(latestKnown.albumin !== undefined ? { albumin: latestKnown.albumin } : {}),
    ...(accessType !== undefined ? { accessType } : {}),
    ...(catheterDays !== undefined ? { catheterDays } : {}),
    ...(accessAgeDays !== undefined ? { accessAgeDays } : {}),
    matureAvfAvailable,
    accessInfectionSigns,
    ...(cultures.length ? { cultureResult: cultures.at(-1)!.result, cultureAt: cultures.at(-1)!.at } : {}),
    ...(immunisations.length ? { immunisations } : {}),
    ...(latestSerology ? { hepatitisBSurfaceAntibodyIuL: latestSerology.iuL, serologyAt: latestSerology.at } : {}),
    ...(latestHandHygiene ? { lastHandHygieneAuditAt: latestHandHygiene.at } : {}),
    ...(latestAccessCare ? { lastAccessCareAuditAt: latestAccessCare.at } : {}),
    asOf: input.asOf ?? new Date().toISOString(),
  };

  const plan = preventionPlan(window);

  return {
    patientId: input.patientId,
    asOf: window.asOf as string,
    temperatures,
    observations,
    cultures,
    immunisations,
    serology,
    audits,
    access: {
      ...(accessType !== undefined ? { accessType } : {}),
      ...(catheterDays !== undefined ? { catheterDays } : {}),
      ...(accessAgeDays !== undefined ? { accessAgeDays } : {}),
      matureAvfAvailable,
      accessInfectionSigns,
    },
    summary: {
      readings: temperatures.length,
      ...(peak !== undefined ? { peakTemperatureC: peak } : {}),
      ...(temperatures.length ? { latestTemperatureC: temperatures.at(-1)!.tempC } : {}),
      febrileEpisodes: temperatures.filter((t) => t.tempC >= INFECTION_REFERENCE.feverC).length,
      ...(latestKnown.procalcitoninNgMl !== undefined ? { latestProcalcitoninNgMl: latestKnown.procalcitoninNgMl } : {}),
      ...(latestKnown.wbc !== undefined ? { latestWbc: latestKnown.wbc } : {}),
      ...(computeNlr(latestKnown.neutrophilPct, latestKnown.lymphocytePct) !== undefined ? { latestNlr: computeNlr(latestKnown.neutrophilPct, latestKnown.lymphocytePct) } : {}),
      ...(latestKnown.crp !== undefined ? { latestCrp: latestKnown.crp } : {}),
      cultures: cultures.length,
      positiveCultures: cultures.filter((c) => c.positive).length,
      serialReadings: temperatures.length,
      inflammatoryMarkers: [
        latestKnown.procalcitoninNgMl !== undefined,
        latestKnown.wbc !== undefined,
        computeNlr(latestKnown.neutrophilPct, latestKnown.lymphocytePct) !== undefined,
        latestKnown.crp !== undefined,
      ].filter(Boolean).length,
      immunisationRecords: immunisations.length,
      duePreventionTasks: plan.length,
      overduePreventionTasks: plan.filter((t) => t.overdue).length,
    },
    window,
    preventionPlan: plan,
    preventionSignature: preventionDeterminismSignature(plan),
    provenance: {
      source: 'realm-ledger',
      temperatureEvents,
      labEvents,
      cultureResults,
      immunisationEvents,
      auditAssessments,
      attributedBy,
      synthetic: true,
    },
  };
}

/* ======================================================================
 * Prevention determinism over the ledger
 * ====================================================================== */

export interface InfectionPreventionStability {
  /** the plan is identical on every rebuild of the same records */
  stable: boolean;
  signature: string;
  taskCount: number;
  /** the same plan, with the triage series replaced by a septic-looking one */
  modelIndependent: boolean;
  signatureUnderSepticSeries: string;
  ruleIds: string[];
  note: string;
}

/**
 * The step-D version of the separation proof: build the plan twice from the SAME
 * twin, then once more with the triage-side physiology pushed into a septic
 * range. A prevention task must not move.
 */
export function infectionPreventionStability(twin: InfectionTwin): InfectionPreventionStability {
  const a = preventionDeterminismSignature(twin.preventionPlan);
  const b = preventionDeterminismSignature(preventionPlan(twin.window));
  const septic = preventionPlan({
    ...twin.window,
    temperatureC: 39.4,
    temperatureSeries: [38.6, 39.1, 39.4],
    procalcitoninNgMl: 8.8,
    nlr: 14,
    wbc: 19.5,
    symptoms: ['rigors', 'hypotension'],
  });
  const c = preventionDeterminismSignature(septic);
  const stable = a === b;
  const modelIndependent = a === c;
  return {
    stable,
    signature: a,
    taskCount: twin.preventionPlan.length,
    modelIndependent,
    signatureUnderSepticSeries: c,
    ruleIds: [...new Set(twin.preventionPlan.map((t) => t.rule.ruleId))].sort(),
    note: stable && modelIndependent
      ? `Prevention is a pure function of the ledger records: ${twin.preventionPlan.length} task(s), identical on rebuild and unchanged by a septic-range triage series (signature ${a}).`
      : `Prevention determinism FAILED over the ledger: stable=${stable} modelIndependent=${modelIndependent} (${a} vs ${c}).`,
  };
}

/* ======================================================================
 * Triage scoring against the observed cultures
 * ====================================================================== */

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

export interface InfectionTwinScore {
  n: number;
  cultureRows: number;
  positives: number;
  negatives: number;
  auroc?: number | undefined;
  brier?: number | undefined;
  ece?: number | undefined;
  /** the fraction of cultures where the triage and the culture agree by band */
  bandAgreement?: number | undefined;
  verdict: 'pass' | 'watch' | 'insufficient';
  targetAuroc: number;
  targetBrier: number;
  rows: Array<{ at: string; score: number; label: 0 | 1; band: string; observedTemperatureC?: number | undefined; readings: number }>;
  note: string;
}

/**
 * Walk the triage forward to each culture. The window at culture time contains
 * ONLY what was known before the result arrived (the temperature series up to
 * that point plus the latest labs), so this is a genuine prospective score, not
 * a retrospective fit.
 */
export function scoreInfectionTwinTriage(twin: InfectionTwin, opts: { targetAuroc?: number; targetBrier?: number } = {}): InfectionTwinScore {
  const targetAuroc = opts.targetAuroc ?? INFECTION_TWIN_TARGET_AUROC;
  const targetBrier = opts.targetBrier ?? INFECTION_TWIN_TARGET_BRIER;
  const rows: InfectionTwinScore['rows'] = [];
  const pairs: Array<{ score: number; label: 0 | 1 }> = [];

  for (const culture of twin.cultures) {
    const priorTemps = twin.temperatures.filter((t) => t.at <= culture.at).slice(-8);
    if (priorTemps.length < INFECTION_REFERENCE.minTemperatureReadings) continue;
    const priorObs = twin.observations.filter((o) => o.at <= culture.at).at(-1);
    const probe: InfectionInput = {
      ...twin.window,
      temperatureC: priorTemps.at(-1)!.tempC,
      temperatureSeries: priorTemps.map((t) => t.tempC),
      // the culture itself must NOT be visible: this is the pre-result window
      cultureResult: undefined,
      cultureAt: undefined,
      ...(priorObs?.procalcitoninNgMl !== undefined ? { procalcitoninNgMl: priorObs.procalcitoninNgMl } : { procalcitoninNgMl: undefined }),
      ...(priorObs?.wbc !== undefined ? { wbc: priorObs.wbc } : { wbc: undefined }),
      ...(priorObs?.neutrophilPct !== undefined ? { neutrophilPct: priorObs.neutrophilPct } : { neutrophilPct: undefined }),
      ...(priorObs?.lymphocytePct !== undefined ? { lymphocytePct: priorObs.lymphocytePct } : { lymphocytePct: undefined }),
      ...(priorObs?.crp !== undefined ? { crp: priorObs.crp } : { crp: undefined }),
    };
    const assessment = assessBsi(probe);
    const label: 0 | 1 = culture.positive ? 1 : 0;
    rows.push({
      at: culture.at,
      score: assessment.probability,
      label,
      band: assessment.band,
      ...(assessment.measured.peakTemperatureC !== undefined ? { observedTemperatureC: assessment.measured.peakTemperatureC } : {}),
      readings: priorTemps.length,
    });
    pairs.push({ score: assessment.probability, label });
  }

  const positives = pairs.filter((p) => p.label === 1).length;
  const negatives = pairs.length - positives;
  const auroc = aurocLocal(pairs);
  const brier = pairs.length ? Math.round((pairs.reduce((sum, p) => sum + (p.score - p.label) ** 2, 0) / pairs.length) * 10000) / 10000 : undefined;
  // 5-bin calibration gap (mean |predicted − observed|)
  let ece: number | undefined;
  if (pairs.length >= 10) {
    const bins = new Array(5).fill(0).map(() => ({ n: 0, predicted: 0, observed: 0 }));
    for (const p of pairs) {
      const idx = Math.min(4, Math.floor(p.score * 5));
      const bin = bins[idx]!;
      bin.n += 1;
      bin.predicted += p.score;
      bin.observed += p.label;
    }
    let sum = 0;
    let covered = 0;
    for (const bin of bins) {
      if (!bin.n) continue;
      sum += (bin.n / pairs.length) * Math.abs(bin.predicted / bin.n - bin.observed / bin.n);
      covered += bin.n;
    }
    ece = covered ? Math.round(sum * 10000) / 10000 : undefined;
  }
  const bandAgreement = rows.length
    ? Math.round((rows.filter((r) => (r.label === 1) === (r.band !== 'low')).length / rows.length) * 1000) / 1000
    : undefined;

  if (rows.length < 4 || positives === 0 || negatives === 0) {
    return {
      n: twin.temperatures.length,
      cultureRows: rows.length,
      positives,
      negatives,
      auroc,
      brier,
      ece,
      bandAgreement,
      verdict: 'insufficient',
      targetAuroc,
      targetBrier,
      rows,
      note: rows.length < 4
        ? `Only ${rows.length} culture(s) with ≥ ${INFECTION_REFERENCE.minTemperatureReadings} prior temperature readings — at least 4 (with both a positive and a negative) are needed before the triage can be judged.`
        : `Cultures present but not both outcomes (${positives} positive, ${negatives} negative) — the discrimination AUROC cannot be measured yet.`,
    };
  }

  const verdict: InfectionTwinScore['verdict'] = (auroc ?? 0) >= targetAuroc && (brier ?? 9) <= targetBrier ? 'pass' : 'watch';
  return {
    n: twin.temperatures.length,
    cultureRows: rows.length,
    positives,
    negatives,
    auroc,
    brier,
    ece,
    bandAgreement,
    verdict,
    targetAuroc,
    targetBrier,
    rows,
    note: verdict === 'pass'
      ? `Triage discriminates at AUROC ${auroc} (≥ ${targetAuroc}) with Brier ${brier} (≤ ${targetBrier}) over ${rows.length} prospectively-scored cultures (${positives} positive).`
      : `Triage AUROC ${auroc ?? '—'} / Brier ${brier ?? '—'} over ${rows.length} cultures does not yet meet the ${targetAuroc} / ${targetBrier} targets — the learned head (step E) must improve it before the triage is trusted.`,
  };
}

/** Rebuild a window from the twin with overrides (used by the routes + tests). */
export function infectionWindowFromTwin(twin: InfectionTwin, extra: Partial<InfectionInput> = {}): InfectionInput {
  return { ...twin.window, ...extra };
}

/** Guardrail view over the twin — what the platform refuses to do with this patient. */
export function infectionTwinGuardrails(twin: InfectionTwin): ReturnType<typeof guardInfectionTriage> {
  return guardInfectionTriage(twin.window);
}
