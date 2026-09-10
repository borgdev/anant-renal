/******************************************************************************
 * Anemia / ESA patient twin — Slice 4 (real ledger + online drift).
 *
 * Paper A builds its model from EVENT-STREAM data (labs anchored to ESA doses),
 * and validates it by comparing forecast vs observed Hb. This module derives a
 * governed ESA window for a REAL patient from two live sources:
 *
 *   1. the realm event ledger (HGB results, iron panel, medication orders), and
 *   2. the patient's twin state (current ESA dose / escalation count / labs),
 *
 * then scores the reference responder ONLINE: each weekly observed Hb is
 * compared with the value the kernel projected from the previous week's dose
 * (MAE / MAPE / RMSE — Paper A's Hb-forecast bar is < 10%). Drift snapshots are
 * durable so assurance can watch forecast calibration over time.
 *
 * Pure + deterministic given its inputs (no IO). Attribution is defensive: a
 * result lacks a patientId, so its orderId is matched against the known patient
 * id prefixes (the reducer builds `<patientId>-<code>-<seq>`).
 ******************************************************************************/

import { esaForecastSeries, esaForecastSubstrate } from './anemia-forecast.js';
import type { EsaPatientWindow } from './anemia.js';

const MS_PER_DAY = 86_400_000;
const MS_PER_WEEK = 7 * MS_PER_DAY;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const round = (v: number, digits = 2): number => {
  const m = 10 ** digits;
  return Math.round(v * m) / m;
};

/** Realm ledger entry (as the swarm event accessor projects it). */
export interface EsaTwinEventInput {
  realmId?: string;
  eventId?: string;
  kind: string;
  emittedAt: string;
  /** Realm-clock timestamp — the clinically meaningful time in accelerated sim
   *  realms (wall-clock emittedAt collapses months of realm time into minutes). */
  realmAt?: string;
  /** Present when the projection attributed the event to a patient. */
  patientId?: string;
  payload: Record<string, unknown>;
}

/** Live patient twin state (from the realm graph). */
export interface EsaTwinPatientInput {
  realmId: string;
  patientId: string;
  state: Record<string, unknown>;
}

export type EsaTwinDoseSource = 'ledger' | 'patient-state' | 'none';

export interface EsaTwinProvenance {
  realmId: string | null;
  eventsConsidered: number;
  hgbLabs: number;
  ironLabs: number;
  esaDoses: number;
  ironDoses: number;
  doseSource: EsaTwinDoseSource;
  derivedFrom: 'ledger' | 'patient-state' | 'insufficient';
}

export interface EsaTwin {
  patientId: string;
  realmId: string | null;
  asOf: string;
  window: EsaPatientWindow | null;
  hgbSeries: Array<{ at: string; hgb: number }>;
  dosingHistory: Array<{ at: string; dose: number }>;
  ironHistory: Array<{ at: string; mg: number }>;
  provenance: EsaTwinProvenance;
  note: string;
}

/* ------------------------------------------------------------------ *
 * Parsing helpers
 * ------------------------------------------------------------------ */

const HGB_CODES = new Set(['HGB', 'HB', 'HEMOGLOBIN']);
const IRON_LAB_FIELDS: Record<string, 'ferritin' | 'transferrinSat' | 'mcv' | 'crp' | 'pth' | 'calcium'> = {
  FERRITIN: 'ferritin', TSAT: 'transferrinSat', 'TRANSFERRIN SATURATION': 'transferrinSat',
  MCV: 'mcv', CRP: 'crp', PTH: 'pth', CALCIUM: 'calcium', CA: 'calcium',
};
const ESA_DRUG = /epo|esa|mircera|darbepo|methoxy|erythropo/i;
const IRON_DRUG = /iron|ferric|ferrous|ferumoxytol|sucrose|dextran/i;
const MED_KINDS = new Set(['order-med', 'titrate-med', 'administer-med', 'hold-med']);
const LAB_KINDS = new Set(['result-lab']);

const num = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const direct = Number(v);
    if (Number.isFinite(direct)) return direct;
    // Tolerate unit-suffixed values (e.g. "8000 u", "100 mg").
    const parsed = Number.parseFloat(v);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Attribute an event to a patient: explicit id, else an orderId/medOrderId prefix. */
export function attributePatientId(event: EsaTwinEventInput, knownIds: readonly string[]): string | undefined {
  if (event.patientId) return event.patientId;
  const explicit = str(event.payload.patientId);
  if (explicit) return explicit;
  for (const key of ['orderId', 'medOrderId'] as const) {
    const value = str(event.payload[key]);
    if (!value) continue;
    const match = knownIds.find((id) => value.startsWith(`${id}-`));
    if (match) return match;
  }
  return undefined;
}

function payloadLabValue(payload: Record<string, unknown>, code: string): number | undefined {
  const direct = num(payload.value);
  if (direct !== undefined) return direct;
  const labs = payload.labs;
  if (labs && typeof labs === 'object') {
    const v = (labs as Record<string, unknown>)[code];
    const parsed = num(v);
    if (parsed !== undefined) return parsed;
  }
  const result = payload.result;
  if (result && typeof result === 'object') {
    const parsed = num((result as Record<string, unknown>)[code]);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function eventCode(payload: Record<string, unknown>): string | undefined {
  return str(payload.code) ?? str(payload.lab) ?? str(payload.analyte);
}

function eventDrug(payload: Record<string, unknown>): string {
  return [str(payload.code), str(payload.drug), str(payload.medication), str(payload.name), str(payload.indication)]
    .filter(Boolean)
    .join(' ');
}

/* ------------------------------------------------------------------ *
 * Weekly bucketing (lab draws are more frequent than weekly in the sim)
 * ------------------------------------------------------------------ */

/** Collapse an observation series to its most recent value per 7-day bucket. */
export function toWeeklySeries<T extends { at: string }>(observations: readonly T[], asOfMs: number): T[] {
  const byBucket = new Map<number, T>();
  for (const o of observations) {
    const atMs = Date.parse(o.at);
    if (!Number.isFinite(atMs) || atMs > asOfMs) continue;
    const bucket = Math.floor((asOfMs - atMs) / MS_PER_WEEK);
    const existing = byBucket.get(bucket);
    if (!existing || Date.parse(existing.at) < atMs) byBucket.set(bucket, o);
  }
  return [...byBucket.entries()].sort((a, b) => b[0] - a[0]).map(([, o]) => o);
}

/* ------------------------------------------------------------------ *
 * Twin construction
 * ------------------------------------------------------------------ */

export interface EsaTwinInput {
  patientId: string;
  events: readonly EsaTwinEventInput[];
  patients?: readonly EsaTwinPatientInput[];
  asOf?: string;
}

export function buildEsaTwin(input: EsaTwinInput): EsaTwin {
  const knownIds = (input.patients ?? [])
    .map((p) => p.patientId)
    .filter((id) => id.length > 0)
    .sort((a, b) => b.length - a.length);
  const state = input.patients?.find((p) => p.patientId === input.patientId)?.state ?? {};
  const stateLabs = (state.labs && typeof state.labs === 'object' ? state.labs : {}) as Record<string, unknown>;

  const hgb: Array<{ at: string; hgb: number }> = [];
  const labs: Partial<Record<'ferritin' | 'transferrinSat' | 'mcv' | 'crp' | 'pth' | 'calcium', { at: string; value: number }>> = {};
  const dosingHistory: Array<{ at: string; dose: number }> = [];
  const ironHistory: Array<{ at: string; mg: number }> = [];
  let realmId: string | null = null;
  let eventsConsidered = 0;
  let ironLabs = 0;
  let ironDoses = 0;

  for (const event of input.events) {
    const patientId = attributePatientId(event, knownIds);
    if (patientId !== input.patientId) continue;
    eventsConsidered += 1;
    realmId = realmId ?? event.realmId ?? null;
    // Realm time is the clinical time when a realm clock is accelerated.
    const at = event.realmAt ?? event.emittedAt;
    const payload = event.payload ?? {};

    if (LAB_KINDS.has(event.kind)) {
      const code = eventCode(payload)?.toUpperCase();
      const value = code ? payloadLabValue(payload, code) : undefined;
      if (code && value !== undefined) {
        if (HGB_CODES.has(code)) hgb.push({ at, hgb: value });
        const field = IRON_LAB_FIELDS[code];
        if (field) {
          const current = labs[field];
          if (!current || Date.parse(current.at) < Date.parse(at)) labs[field] = { at, value };
          if (field === 'ferritin' || field === 'transferrinSat') ironLabs += 1;
        }
      }
      continue;
    }

    if (MED_KINDS.has(event.kind)) {
      const drug = eventDrug(payload);
      const dose = num(payload.dose) ?? num(payload.esaDose);
      if (dose === undefined) continue;
      if (ESA_DRUG.test(drug)) {
        dosingHistory.push({ at, dose: event.kind === 'hold-med' ? 0 : dose });
      } else if (IRON_DRUG.test(drug)) {
        ironHistory.push({ at, mg: dose });
        ironDoses += 1;
      }
    }
  }

  // Patient-state fallbacks (the realm twin keeps the current ESA picture).
  const stateDose = num(state.esaDose) ?? num(state.currentDose);
  const stateHistory = Array.isArray(state.esaDosingHistory)
    ? (state.esaDosingHistory as unknown[])
        .map((entry): { at: string; dose: number } | null => {
          if (!entry || typeof entry !== 'object') return null;
          const at = str((entry as { at?: unknown }).at);
          const dose = num((entry as { dose?: unknown }).dose);
          return at && dose !== undefined ? { at, dose } : null;
        })
        .filter((entry): entry is { at: string; dose: number } => entry !== null)
    : [];
  const ledgersDosing = dosingHistory.length > 0;
  if (!ledgersDosing && stateHistory.length) dosingHistory.push(...stateHistory);
  const doseSource: EsaTwinDoseSource = ledgersDosing ? 'ledger' : stateHistory.length || stateDose !== undefined ? 'patient-state' : 'none';

  // Sort ascending.
  hgb.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  dosingHistory.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  ironHistory.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  // Anchor "as of" to the latest OBSERVATION (realm time) when not supplied, so
  // the 90-day look-back is measured on the clinical clock, not wall time.
  const observationTimes = [...hgb.map((h) => Date.parse(h.at)), ...dosingHistory.map((d) => Date.parse(d.at))]
    .filter((t) => Number.isFinite(t));
  const asOfMs = input.asOf ? Date.parse(input.asOf) : observationTimes.length ? Math.max(...observationTimes) : Date.now();
  const usableAsOf = Number.isFinite(asOfMs) ? asOfMs : Date.now();
  const asOf = new Date(usableAsOf).toISOString();

  const latestHgb = hgb.length ? hgb[hgb.length - 1]?.hgb : num(stateLabs.HGB);
  const currentDose = dosingHistory.length
    ? (dosingHistory[dosingHistory.length - 1]?.dose ?? 0)
    : Math.max(0, stateDose ?? 0);
  const within90 = (at: string): boolean => {
    const age = (usableAsOf - Date.parse(at)) / MS_PER_DAY;
    return age >= 0 && age <= 90;
  };
  const recentDoses = dosingHistory.filter((d) => within90(d.at));
  const recentTrend = toWeeklySeries(hgb.filter((h) => within90(h.at)), usableAsOf)
    .slice(-12)
    .map((h) => h.hgb);

  const provenance: EsaTwinProvenance = {
    realmId,
    eventsConsidered,
    hgbLabs: hgb.length,
    ironLabs,
    esaDoses: recentDoses.length,
    ironDoses,
    doseSource,
    derivedFrom: 'insufficient',
  };

  if (latestHgb === undefined || !Number.isFinite(latestHgb)) {
    return {
      patientId: input.patientId,
      realmId,
      asOf,
      window: null,
      hgbSeries: hgb,
      dosingHistory,
      ironHistory,
      provenance,
      note: `No haemoglobin observation on the ledger or patient state for ${input.patientId} — the twin cannot build a governed window yet.`,
    };
  }

  const lastIron = labs.ferritin ?? labs.transferrinSat;
  const escalations = num(state.esaEscalationsLast90d) ?? (() => {
    let count = 0;
    for (let i = 1; i < recentDoses.length; i++) {
      const prev = recentDoses[i - 1];
      const cur = recentDoses[i];
      if (prev && cur && cur.dose > prev.dose) count += 1;
    }
    return count;
  })();

  // Freshness for the iron-first guardrail: a recent iron panel means the
  // substrate was checked. When only ESA state exists, keep it absent (honest).
  const window: EsaPatientWindow = {
    patientId: input.patientId,
    ...(realmId ? { facilityId: realmId } : {}),
    currentHgb: round(latestHgb, 1),
    ...(labs.mcv ? { mcv: labs.mcv.value } : {}),
    ...(labs.ferritin ? { ferritin: labs.ferritin.value } : {}),
    ...(labs.transferrinSat ? { transferrinSat: labs.transferrinSat.value } : {}),
    ...(labs.crp ? { crp: labs.crp.value } : {}),
    ...(labs.calcium ? { calcium: labs.calcium.value } : {}),
    ...(labs.pth ? { pth: labs.pth.value } : {}),
    onESA: currentDose > 0 || state.onEsa === true,
    currentDose,
    hgbTrendLast90d: recentTrend,
    esaEscalationsLast90d: escalations,
    ...(lastIron ? { lastIronPanelAt: lastIron.at } : {}),
    ...(dosingHistory.length ? { esaDosingHistory: dosingHistory.filter((d) => within90(d.at)) } : {}),
    ...(ironHistory.length ? { ivIronHistory: ironHistory.filter((d) => within90(d.at)) } : {}),
    asOf,
  };

  const derivedFrom: EsaTwinProvenance['derivedFrom'] = hgb.length > 0 ? 'ledger' : 'patient-state';
  provenance.derivedFrom = derivedFrom;
  const note = derivedFrom === 'ledger'
    ? `Twin built from ${hgb.length} ledger Hb result(s)${recentDoses.length ? ` and ${recentDoses.length} ESA dose(s)` : doseSource === 'patient-state' ? ' and the patient-state ESA dose' : ''}.`
    : `Ledger is thin — twin fell back to patient-state labs/dose (${eventsConsidered} attributed event(s)).`;

  return { patientId: input.patientId, realmId, asOf, window, hgbSeries: hgb, dosingHistory, ironHistory, provenance, note };
}

/* ------------------------------------------------------------------ *
 * Online forecast-vs-observed drift
 * ------------------------------------------------------------------ */

export interface EsaTwinDriftRow {
  at: string;
  observed: number;
  predicted: number;
  error: number;
  pctError: number;
}

export interface EsaTwinDriftScore {
  patientId: string;
  n: number;
  mae: number;
  mape: number;
  rmse: number;
  withinBandPct: number;
  verdict: 'pass' | 'watch' | 'insufficient';
  targetMapePct: number;
  rows: EsaTwinDriftRow[];
  note: string;
}

/** Paper-A Hb-forecast bar. */
export const ESA_TWIN_DRIFT_TARGET_MAPE_PCT = 10;

function latestDoseAt(dosing: readonly { at: string; dose: number }[], atMs: number): number | undefined {
  let dose: number | undefined;
  for (const d of dosing) {
    if (Date.parse(d.at) <= atMs) dose = d.dose;
    else break;
  }
  return dose;
}

/**
 * Score the reference responder ONLINE against observed Hb: for each weekly
 * pair, project forward from the first observation using the dose on record at
 * that time, and compare with what was actually observed.
 */
export function scoreEsaTwinDrift(twin: EsaTwin, opts: { horizonWeeksCap?: number } = {}): EsaTwinDriftScore {
  const cap = clamp(opts.horizonWeeksCap ?? 12, 1, 26);
  const asOfMs = Date.parse(twin.asOf);
  const weekly = toWeeklySeries(twin.hgbSeries, asOfMs);
  const rows: EsaTwinDriftRow[] = [];
  const base = twin.window;
  if (base && weekly.length >= 2) {
    const { iron, resistance } = esaForecastSubstrate(base);
    for (let i = 1; i < weekly.length; i++) {
      const prev = weekly[i - 1];
      const cur = weekly[i];
      if (!prev || !cur) continue;
      const t0 = Date.parse(prev.at);
      const t1 = Date.parse(cur.at);
      const gapWeeks = (t1 - t0) / MS_PER_WEEK;
      if (gapWeeks < 0.75 || gapWeeks > cap) continue;
      const dose = latestDoseAt(twin.dosingHistory, t0) ?? base.currentDose;
      const horizon = clamp(Math.round(gapWeeks), 1, cap);
      const series = esaForecastSeries({ ...base, currentHgb: prev.hgb }, dose, { horizonWeeks: horizon, iron, resistance });
      const predicted = series[Math.min(series.length - 1, Math.max(0, horizon - 1))]?.hgb ?? prev.hgb;
      const error = round(predicted - cur.hgb, 3);
      rows.push({
        at: cur.at,
        observed: cur.hgb,
        predicted: round(predicted, 2),
        error,
        pctError: cur.hgb > 0 ? round((Math.abs(error) / cur.hgb) * 100, 2) : 0,
      });
    }
  }

  const n = rows.length;
  if (!n) {
    return {
      patientId: twin.patientId, n: 0, mae: 0, mape: 0, rmse: 0, withinBandPct: 0,
      verdict: 'insufficient', targetMapePct: ESA_TWIN_DRIFT_TARGET_MAPE_PCT, rows,
      note: 'Fewer than two weekly Hb observations — not enough history to score forecast-vs-observed drift.',
    };
  }
  const mae = rows.reduce((sum, r) => sum + Math.abs(r.error), 0) / n;
  const mape = rows.reduce((sum, r) => sum + r.pctError, 0) / n;
  const rmse = Math.sqrt(rows.reduce((sum, r) => sum + r.error ** 2, 0) / n);
  const withinBand = rows.filter((r) => r.observed >= 10 && r.observed <= 12).length;
  const verdict: EsaTwinDriftScore['verdict'] = mape <= ESA_TWIN_DRIFT_TARGET_MAPE_PCT ? 'pass' : 'watch';
  return {
    patientId: twin.patientId,
    n,
    mae: round(mae, 3),
    mape: round(mape, 2),
    rmse: round(rmse, 3),
    withinBandPct: Math.round((withinBand / n) * 100),
    verdict,
    targetMapePct: ESA_TWIN_DRIFT_TARGET_MAPE_PCT,
    rows: rows.slice(-24),
    note: `Online Hb-forecast MAPE ${round(mape, 2)}% over ${n} weekly step(s) (target ≤ ${ESA_TWIN_DRIFT_TARGET_MAPE_PCT}%) — ${verdict === 'pass' ? 'within Paper-A calibration' : 'watching drift'}.`,
  };
}
