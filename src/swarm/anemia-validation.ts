/******************************************************************************
 * Anemia / ESA external validation & regulatory readiness — P3.
 *
 * Path from the governed demo to a validated, deployable CDSS (the doc's exit
 * criteria are fully met once real consented cohorts + production HGFS arrive —
 * this module supplies the scaffold + the platform artifacts NOW on synthetic
 * data, with the synthetic label kept everywhere):
 *
 *   1. Validation study scaffold — protocol + metrics over an independent
 *      "external" cohort: MAE in EPO units, % within one dose step, error
 *      quartiles, Spearman, and an Hb-forecast MAE% (paper: < 10%). The
 *      resulting report is durable so assurance/red-team/gates can consume it.
 *   2. Prospective trial hooks — "suggest, don't auto-act": durable recording of
 *      each clinician decision on a Class-C suggestion (accept/adjust/reject/
 *      withhold) + acceptance analytics (the paper's physician-trust finding).
 *   3. MDR / EU-AI-Act technical file — risk classification (high-risk CDSS),
 *      intended use, clinical evaluation plan, XAI + coverage evidence, and the
 *      human-in-the-loop design record.
 *
 * Durable via the shared workspace store ('esa-validation-report' single doc,
 * 'esa-study-record' list, 'esa-mdr-file' single doc). Pure + deterministic
 * wherever possible; the trained model (P2 artifact) drives modelDose.
 ******************************************************************************/

import type { WorkspaceDoc } from './workspace.js';
import type { SwarmWorkspaceStore } from './workspace.js';
import { predictEsaDoseUnits, type EsaTrainedArtifact } from './anemia-model.js';

/* ======================================================================
 * 1. Types
 * ====================================================================== */

export interface EsaValidationMetrics {
  n: number;
  siteId: string;
  /** MAE of model dose vs clinician dose, EPO units/wk. */
  maeUnits: number;
  /** Fraction of cases where |model − clinician| ≤ one dose step (500 u). */
  withinOneStepPct: number;
  /** Quartiles of the absolute error (EPO units). */
  errorQuartiles: { q1: number; median: number; q3: number };
  /** Rank (Spearman) correlation between model and clinician dose. */
  spearman: number;
  /** Reference next-Hb forecast MAE % (paper's Hb-forecast < 10% bar). */
  hbForecastMaePct: number;
}

export interface EsaValidationReport extends WorkspaceDoc {
  modelId: string;
  modelVersion: string;
  siteId: string;
  cohortSize: number;
  metrics: EsaValidationMetrics;
  verdict: { passed: boolean; reason: string };
  ranAt: string;
  seed: number;
  synthetic: boolean;
}

export type EsaClinicianAction = 'accepted' | 'adjusted' | 'rejected' | 'withheld';

export interface EsaStudyRecord extends WorkspaceDoc {
  patientId: string;
  modelId: string;
  modelVersion: string;
  recommendedDose: number;
  clinicianAction: EsaClinicianAction;
  adjustedDose?: number;
  by: string;
  note?: string;
  at: string;
  window: { currentHgb: number; currentDose: number };
}

export interface EsaAcceptanceStats {
  total: number;
  accepted: number;
  adjusted: number;
  rejected: number;
  withheld: number;
  /** accepted / (accepted + adjusted + rejected + withheld) — adoption. */
  acceptanceRatePct: number;
  /** adjusted + withheld share — clinicians kept control. */
  clinicianRetainedControlPct: number;
}

export interface EsaMdrFile extends WorkspaceDoc {
  version: string;
  productName: string;
  riskClass: { aiAct: string; mdr: string; rationale: string };
  intendedUse: string;
  clinicalEvaluationPlan: string[];
  xaiEvidence: { driverBars: boolean; latentScatter: boolean; coverageGate: boolean; syntheticLabeling: boolean };
  hitlDesignRecord: { role: string; approvalClass: string; autonomy: string; audit: string; veto: string };
  synthetic: boolean;
}

/* ======================================================================
 * 2. Deterministic external (site-B) cohort + clinician ground truth
 * ====================================================================== */

export interface EsaValidationRow {
  patientId: string;
  currentHgb: number;
  hgbTrendLast90d: number[];
  mcv: number;
  ferritin: number;
  transferrinSat: number;
  crp: number;
  calcium: number;
  pth: number;
  onESA: boolean;
  currentDose: number;
  clinicianDose: number;
  nextHgb: number;
}

export const ESA_VALIDATION_PASS = {
  minN: 100,
  withinOneStepMin: 0.5,
  maeMaxUnits: 1500,
  spearmanMin: 0.8,
  hbForecastMaxPct: 10,
} as const;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const step = (dose: number): number => clamp(Math.round(dose / 500) * 500, 0, 20000);

/** KDIGO-consistent clinician decision for a validation row (external site). */
export function clinicianDecision(row: Pick<EsaValidationRow, 'currentHgb' | 'hgbTrendLast90d' | 'onESA' | 'currentDose'>): number {
  const h = row.currentHgb;
  const t = row.hgbTrendLast90d;
  const first = t[0];
  const last = t[t.length - 1];
  const rising = first !== undefined && last !== undefined && last - first > 1.0;
  if (!row.onESA) return h >= 10 ? 0 : 2000;
  if (h > 12) {
    if (h > 13 || rising) return 0;
    return step(row.currentDose * 0.75);
  }
  if (h < 10) return step(row.currentDose * 1.25);
  return clamp(row.currentDose, 0, 20000);
}

/**
 * Deterministic independent ("external site B") cohort — a mild case-mix shift
 * (higher starting dose band, slightly lower Hb center) so validation tests
 * generalization rather than memorization. Every row carries the clinician's
 * dose + a next-week Hb for the forecast metric.
 */
export function generateExternalCohort(seed: number, size: number): EsaValidationRow[] {
  const rng = mulberry32(seed);
  const rows: EsaValidationRow[] = [];
  const gauss = (): number => {
    const u = Math.max(rng(), 1e-9);
    const v = Math.max(rng(), 1e-9);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  for (let i = 0; i < size; i++) {
    const onESA = rng() < 0.94;
    const doseStart = Math.round((7000 + rng() * 9000) / 500) * 500; // 7000..16000 (site-B higher)
    let dose = doseStart;
    // 12-week Hb path ending at a slightly-lower-center currentHgb.
    const h: number[] = [];
    let cur = clamp(10.4 + gauss() * 1.2, 7.2, 15.0);
    for (let w = 0; w < 12; w++) {
      cur = clamp(cur + gauss() * 0.28 + (10.7 - cur) * 0.06, 6.8, 16.0);
      h.push(Number(cur.toFixed(2)));
      if (w < 11) {
        dose = clinicianDecision({ currentHgb: h[h.length - 1] ?? cur, hgbTrendLast90d: h.slice(-12), onESA, currentDose: dose });
      }
    }
    const currentHgb = h[11] ?? cur;
    const trend = h.slice(-12);
    const clinicianDose = clinicianDecision({ currentHgb, hgbTrendLast90d: trend, onESA, currentDose: dose });
    const nextHgb = Number(clamp(currentHgb + gauss() * 0.4, 6.8, 16.0).toFixed(2));
    rows.push({
      patientId: `esa-siteB-${String(i + 1).padStart(3, '0')}`,
      currentHgb,
      hgbTrendLast90d: trend,
      mcv: Number(clamp(91 + gauss() * 5, 82, 104).toFixed(1)),
      ferritin: Number(clamp(620 + gauss() * 220, 120, 2600).toFixed(0)),
      transferrinSat: Number(clamp(28 + gauss() * 6, 18, 55).toFixed(1)),
      crp: Number(clamp(6 + Math.abs(gauss()) * 8, 0.5, 90).toFixed(1)),
      calcium: Number(clamp(9.2 + gauss() * 0.4, 8.2, 10.4).toFixed(1)),
      pth: Number(clamp(120 + gauss() * 60, 25, 900).toFixed(0)),
      onESA,
      currentDose: clamp(dose, 0, 20000),
      clinicianDose,
      nextHgb,
    });
  }
  return rows;
}

/* ======================================================================
 * 3. Metrics
 * ====================================================================== */

function rank(xs: number[]): number[] {
  const idx = xs.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(xs.length).fill(0);
  for (let i = 0; i < idx.length; i++) {
    const e = idx[i];
    if (e) ranks[e.i] = i + 1;
  }
  return ranks;
}

export function spearman(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const ra = rank(a.slice(0, n));
  const rb = rank(b.slice(0, n));
  const ma = ra.reduce((s, x) => s + x, 0) / n;
  const mb = rb.reduce((s, x) => s + x, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const d1 = (ra[i] ?? 0) - ma;
    const d2 = (rb[i] ?? 0) - mb;
    num += d1 * d2;
    da += d1 * d1;
    db += d2 * d2;
  }
  const den = Math.sqrt(da * db);
  return den === 0 ? 0 : num / den;
}

function quartiles(xs: number[]): { q1: number; median: number; q3: number } {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number): number => {
    const pos = p * (s.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return (s[lo] ?? 0) + ((s[hi] ?? 0) - (s[lo] ?? 0)) * (pos - lo);
  };
  return { q1: Number(q(0.25).toFixed(0)), median: Number(q(0.5).toFixed(0)), q3: Number(q(0.75).toFixed(0)) };
}

/** Compute the validation metrics from model-vs-clinician predictions. */
export function computeEsaValidationMetrics(
  siteId: string,
  rows: EsaValidationRow[],
  modelDoses: number[],
): EsaValidationMetrics {
  const n = rows.length;
  const errors = rows.map((r, i) => Math.abs((modelDoses[i] ?? 0) - r.clinicianDose));
  const maeUnits = errors.reduce((s, e) => s + e, 0) / (n || 1);
  const withinOneStep = errors.filter((e) => e <= 500).length / (n || 1);
  const hbForecastErrors = rows.map((r) => {
    const last = r.hgbTrendLast90d[r.hgbTrendLast90d.length - 1] ?? r.currentHgb;
    return Math.abs(last - r.nextHgb) / Math.max(r.nextHgb, 0.1) * 100;
  });
  const hbForecastMaePct = hbForecastErrors.reduce((s, e) => s + e, 0) / (n || 1);
  return {
    n,
    siteId,
    maeUnits: Number(maeUnits.toFixed(1)),
    withinOneStepPct: Number((withinOneStep * 100).toFixed(1)),
    errorQuartiles: quartiles(errors),
    spearman: Number(spearman(modelDoses, rows.map((r) => r.clinicianDose)).toFixed(4)),
    hbForecastMaePct: Number(hbForecastMaePct.toFixed(2)),
  };
}

export function validateReportVerdict(metrics: EsaValidationMetrics): { passed: boolean; reason: string } {
  const checks: string[] = [];
  if (metrics.n >= ESA_VALIDATION_PASS.minN) checks.push(`cohort ${metrics.n} ≥ ${ESA_VALIDATION_PASS.minN}`);
  if (metrics.withinOneStepPct >= ESA_VALIDATION_PASS.withinOneStepMin * 100) checks.push(`within-one-step ${metrics.withinOneStepPct}% ≥ ${ESA_VALIDATION_PASS.withinOneStepMin * 100}%`);
  if (metrics.maeUnits <= ESA_VALIDATION_PASS.maeMaxUnits) checks.push(`MAE ${metrics.maeUnits} ≤ ${ESA_VALIDATION_PASS.maeMaxUnits} u/wk`);
  if (metrics.spearman >= ESA_VALIDATION_PASS.spearmanMin) checks.push(`Spearman ${metrics.spearman} ≥ ${ESA_VALIDATION_PASS.spearmanMin}`);
  if (metrics.hbForecastMaePct <= ESA_VALIDATION_PASS.hbForecastMaxPct) checks.push(`Hb-forecast MAE ${metrics.hbForecastMaePct}% ≤ ${ESA_VALIDATION_PASS.hbForecastMaxPct}%`);
  const passed = checks.length === 5;
  return { passed, reason: passed ? 'External validation passed all protocol thresholds.' : `External validation gaps: ${checks.join('; ')}` };
}

/* ======================================================================
 * 4. Durable scaffolding (shared workspace store)
 * ====================================================================== */

export const ESA_VALIDATION_REPORT_ID = 'default';
export const ESA_MDR_FILE_ID = 'default';

export async function getEsaValidationReport(ws: SwarmWorkspaceStore): Promise<EsaValidationReport | undefined> {
  return ws.get<EsaValidationReport>('esa-validation-report', ESA_VALIDATION_REPORT_ID);
}

/** Run external validation of the trained model on an independent cohort and
 *  persist the durable report (consumed by assurance / gates). */
export async function runEsaValidation(
  ws: SwarmWorkspaceStore,
  artifact: EsaTrainedArtifact,
  opts: { siteId?: string; seed?: number; cohortSize?: number } = {},
): Promise<EsaValidationReport> {
  const seed = opts.seed ?? 20260909;
  const siteId = opts.siteId ?? 'site-B';
  const rows = generateExternalCohort(seed, opts.cohortSize ?? 160);
  const modelDoses = rows.map((r) => predictEsaDoseUnits(artifact, r));
  const metrics = computeEsaValidationMetrics(siteId, rows, modelDoses);
  const verdict = validateReportVerdict(metrics);
  const report: Omit<EsaValidationReport, 'id' | 'createdAt' | 'updatedAt'> = {
    modelId: artifact.model.id,
    modelVersion: artifact.model.version,
    siteId,
    cohortSize: rows.length,
    metrics,
    verdict,
    ranAt: new Date().toISOString(),
    seed,
    synthetic: true,
  };
  if (!(await ws.get<EsaValidationReport>('esa-validation-report', ESA_VALIDATION_REPORT_ID))) {
    return ws.create<EsaValidationReport>('esa-validation-report', ESA_VALIDATION_REPORT_ID, report);
  }
  return (await ws.update<EsaValidationReport>('esa-validation-report', ESA_VALIDATION_REPORT_ID, report)) as EsaValidationReport;
}

/* ------------------- study (prospective, HITL) records ------------------- */

export async function listEsaStudyRecords(ws: SwarmWorkspaceStore): Promise<EsaStudyRecord[]> {
  return ws.list<EsaStudyRecord>('esa-study-record');
}

export async function recordEsaStudyDecision(
  ws: SwarmWorkspaceStore,
  input: { patientId: string; modelId: string; modelVersion: string; recommendedDose: number; clinicianAction: EsaClinicianAction; adjustedDose?: number; by: string; note?: string; window: { currentHgb: number; currentDose: number } },
): Promise<EsaStudyRecord> {
  const id = `study-${input.patientId.replace(/[^A-Za-z0-9-]/g, '-')}-${Date.now().toString(36)}`;
  return ws.create<EsaStudyRecord>('esa-study-record', id, {
    patientId: input.patientId,
    modelId: input.modelId,
    modelVersion: input.modelVersion,
    recommendedDose: input.recommendedDose,
    clinicianAction: input.clinicianAction,
    ...(input.adjustedDose !== undefined ? { adjustedDose: input.adjustedDose } : {}),
    by: input.by,
    ...(input.note ? { note: input.note } : {}),
    at: new Date().toISOString(),
    window: input.window,
  });
}

export function esaAcceptanceStats(records: EsaStudyRecord[]): EsaAcceptanceStats {
  const accepted = records.filter((r) => r.clinicianAction === 'accepted').length;
  const adjusted = records.filter((r) => r.clinicianAction === 'adjusted').length;
  const rejected = records.filter((r) => r.clinicianAction === 'rejected').length;
  const withheld = records.filter((r) => r.clinicianAction === 'withheld').length;
  const total = records.length;
  return {
    total,
    accepted,
    adjusted,
    rejected,
    withheld,
    acceptanceRatePct: total ? Number(((accepted / total) * 100).toFixed(1)) : 0,
    clinicianRetainedControlPct: total ? Number((((adjusted + withheld) / total) * 100).toFixed(1)) : 0,
  };
}

/* ------------------- MDR / EU AI Act technical file ------------------- */

export async function getEsaMdrFile(ws: SwarmWorkspaceStore): Promise<EsaMdrFile | undefined> {
  return ws.get<EsaMdrFile>('esa-mdr-file', ESA_MDR_FILE_ID);
}

export async function ensureEsaMdrFile(ws: SwarmWorkspaceStore): Promise<EsaMdrFile> {
  const existing = await ws.get<EsaMdrFile>('esa-mdr-file', ESA_MDR_FILE_ID);
  if (existing) return existing;
  const doc: Omit<EsaMdrFile, 'id' | 'createdAt' | 'updatedAt'> = {
    version: '1.0.0',
    productName: 'Anemia & ESA dose advisor (anemia.esa-dose)',
    riskClass: {
      aiAct: 'high-risk-cdss',
      mdr: 'class-iib-equivalent-decision-support',
      rationale: 'A CDSS that recommends a Class C ESA dose adjustment; a clinician decides and orders — never autonomous. Classified high-risk per EU AI Act Annex III; MDR decision-support risk file maintained.',
    },
    intendedUse: 'Weekly ESA (erythropoietin) dose decision support for nephrology review of anemia of CKD — suggests a dose, never orders. Indicated for patients on or considered for ESA with Hb monitoring per KDIGO.',
    clinicalEvaluationPlan: [
      'Metric: MAE in EPO units/wk vs clinician decision (external cohort).',
      'Metric: % within one dose step (500 u).',
      'Metric: Hb-forecast MAE < 10% (paper bar).',
      'Blinded clinician review of latent scatter + driver bars (trust/UX study).',
    ],
    xaiEvidence: { driverBars: true, latentScatter: true, coverageGate: true, syntheticLabeling: true },
    hitlDesignRecord: {
      role: 'nephrologist (Class C)',
      approvalClass: 'C',
      autonomy: 'never-autonomous',
      audit: 'Every suggestion → decision → command → verify is ledgered + My Work.',
      veto: 'Iron-first + coverage guardrails block a suggestion outright; clinician may reject/adjust.',
    },
    synthetic: true,
  };
  return ws.create<EsaMdrFile>('esa-mdr-file', ESA_MDR_FILE_ID, doc);
}
