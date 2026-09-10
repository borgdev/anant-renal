/**
 * Anemia & ESA CDSS (P0) — typed client for /admin/swarm/anemia/*.
 *
 * Mirrors the server contracts in src/swarm/anemia.ts + src/server/anemia-routes.ts.
 * This is a CDSS: it recommends, it never orders. The dose is Class C
 * (nephrologist) human-approved before any command, and the demo lens stays
 * 'provider' (it never flips the operating lens the way the payer demo does).
 */

import { responseOrThrow } from "./session";

export interface EsaFeature {
  id: string;
  label: string;
  loinc?: string;
  unit: string;
  min: number;
  max: number;
  /** Reference surrogate relevance Rᵢ (paper Fig. 10). */
  relevance: number;
}

export interface EsaTargetBand { min: number; max: number }
export type EsaModelKind = "reference-surrogate" | "trained";
export interface EsaModelInfo { id: string; version: string; kind: EsaModelKind }
export interface EsaSafety { posture: string; approvalClass: string; synthetic: boolean }

export interface EsaFeaturesView {
  features: EsaFeature[];
  exposureFeatures?: Array<{ id: string; label: string; unit: string; detail: string }>;
  hgbTarget: EsaTargetBand;
  model: EsaModelInfo;
  safety: EsaSafety;
}

export type EsaDirection = "hold" | "increase" | "reduce" | "suspend" | "blocked";

export type EsaEvidenceStatus = "corroborated" | "weak" | "contested";

/** DST-Q #3 — Dempster–Shafer readout for the Class-C suggestion itself. */
export interface EsaSuggestionDst {
  belief: number;
  plausibility: number;
  uncertainty: number;
  conflictMass: number;
  evidenceStatus: EsaEvidenceStatus;
  score: number;
  sources: Array<{ sourceId: string; contentType: string; weight: number; alpha: number }>;
  refs: Array<{ sourceId: string; contentType: string }>;
}

export interface EsaLatent { l1: number; l2: number; polarRadius: number; polarAngleRad: number }

/** P1 — coverage verdict attached to every recommendation. */
export interface EsaCoverageVerdict {
  covered: boolean;
  reason: string | null;
  labDensity: { observed: number; required: number; metric: "weekly-hgb-trend" };
  manifold: { distance: number; threshold: number; inside: boolean };
  range?: { feature: string; label: string; value: number; unit: string; min: number; max: number };
}

export interface EsaRecommendation {
  patientId: string;
  inTargetBand: boolean;
  guardrails: { flags: string[]; blocked: boolean; blockReason: string | null };
  latent: EsaLatent;
  currentDose: number;
  recommendedDose: number | null;
  delta: number;
  direction: EsaDirection;
  drivers: Array<{ id: string; label: string; relevance: number }>;
  model: EsaModelInfo;
  synthetic: boolean;
  note: string;
  coverage?: EsaCoverageVerdict;
  /** Paper-A PK-informed cumulative / time-weighted exposure. */
  exposure?: EsaExposureReadout;
}

export interface EsaPatientWindow {
  patientId: string;
  currentHgb: number;
  mcv?: number;
  ferritin?: number;
  transferrinSat?: number;
  crp?: number;
  calcium?: number;
  pth?: number;
  onESA: boolean;
  currentDose: number;
  hgbTrendLast90d?: number[];
  esaEscalationsLast90d?: number;
  lastIronPanelAt?: string;
  /** PK exposure inputs (Paper A) — ESA administrations (ISO timestamps). */
  esaDosingHistory?: Array<{ at: string; dose: number }>;
  ivIronHistory?: Array<{ at: string; mg: number }>;
  asOf?: string;
}

export interface AnemiaEpisode {
  episodeId: string;
  kind: string;
  subject: string;
  scopeType: string;
  state: string;
  openedAt: string;
  dossierHash: string;
  proposal?: {
    proposalId?: string;
    approvalClass?: string;
    cellId?: string;
    kind?: string;
    recommendation?: string;
    payload?: {
      advisor?: EsaRecommendation;
      dose?: number;
      hgb?: number;
      direction?: string;
      step?: number;
    };
  };
  approval?: { decision?: string; by?: string; approvalClass?: string; at?: string };
  command?: { effect?: string; at?: string };
  measureResult?: { measureId?: string; met?: boolean; at?: string };
}

export interface AnemiaStateView {
  source: "anemia";
  features: EsaFeature[];
  cells: Array<{ id: string; version: string; displayName: string; owner: string; approvalClass: string; allowedActions: string[] }>;
  proposals: Array<Record<string, unknown>>;
  insights: Array<Record<string, unknown>>;
  nbas: Array<Record<string, unknown>>;
  conflictCount: number;
  episodes: AnemiaEpisode[];
  kpis: { hgbInBandPct: number; esaLowEpoRequirement: number; atRiskEscalation: number; valueAtRiskUsd: number };
}

export interface AnemiaSeedResult {
  ok: boolean;
  seeded: boolean;
  lens: "provider";
  opened: string[];
  existing: string[];
  closed: string[];
  episodes: AnemiaEpisode[];
}

async function anemiaJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: "no-store", credentials: "same-origin", ...init });
  return responseOrThrow<T>(path, response);
}

export function fetchAnemiaFeatures(): Promise<EsaFeaturesView> {
  return anemiaJson<EsaFeaturesView>("/admin/swarm/anemia/features");
}

export function fetchAnemiaState(): Promise<AnemiaStateView> {
  return anemiaJson<AnemiaStateView>("/admin/swarm/anemia/state");
}

export function adviseEsa(window: EsaPatientWindow): Promise<{ recommendation: EsaRecommendation; dst?: EsaSuggestionDst }> {
  return anemiaJson<{ recommendation: EsaRecommendation; dst?: EsaSuggestionDst }>("/admin/swarm/anemia/advise", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(window),
  });
}

export function seedAnemiaDemo(): Promise<AnemiaSeedResult> {
  return anemiaJson<AnemiaSeedResult>("/admin/swarm/anemia/demo", { method: "POST" });
}

export function resetAnemiaDemo(): Promise<{ ok: boolean; removed: number }> {
  return anemiaJson<{ ok: boolean; removed: number }>("/admin/swarm/anemia/reset", { method: "POST" });
}

/** Human-friendly episode title — mirrors My Work's kind→title transform. */
export function episodeTitle(kind: string, subject: string): string {
  const label = kind.replace(/[-.]/g, " ");
  return `${label} · ${subject}`;
}

/* ======================================================================
 * P1 governance — safe by default (assurance / red-team / drift)
 * ====================================================================== */

export type EsaGateStatus = "active" | "gated" | "blocked";
export interface EsaGateCheck { name: string; passed: boolean; observed: string }
export const ESA_MODEL_ID = "anemia.esa-dose-v0";
export interface EsaAdvisorGate {
  status: EsaGateStatus;
  model: { id: string; version: string; kind: string };
  gates: EsaGateCheck[];
  reasons: string[];
  posture?: { posture: string; approvalClass: string; autonomy: string };
  at: string;
}

export interface EsaRedTeamProbe { scenarioId: string; passed: boolean; checks: Array<{ name: string; passed: boolean; observed: string }> }
export interface EsaDriftRow { driftId: string; targetId: string; metric: string; valueBasisPoints: number; thresholdBasisPoints: number; status: string }
export interface EsaFindingRow { id: string; severity: string; status: string; title: string; scenarioId?: string; threatModel?: string }

export interface EsaAssuranceView {
  source: "anemia";
  model: { registered: boolean; record?: { modelId: string; modelVersion: string; status: string } };
  coverage: { enabled: boolean; defaults: { minTrendSamples: number; manifoldRadius: number }; features: number };
  gate: EsaAdvisorGate;
  redTeam: { scenarios: Array<{ id: string; name: string; threatModel: string; probe: EsaRedTeamProbe }>; latestRuns: Array<{ scenarioId: string; passed: boolean; at: string }> };
  drift: EsaDriftRow[];
  findings: EsaFindingRow[];
}

export function fetchAnemiaAssurance(): Promise<EsaAssuranceView> {
  return anemiaJson<EsaAssuranceView>("/admin/swarm/anemia/assurance");
}

export function runAnemiaRedTeam(): Promise<{ ok: boolean; runs: Array<{ scenarioId: string; passed: boolean }>; findings: EsaFindingRow[]; passed: boolean }> {
  return anemiaJson("/admin/swarm/anemia/red-team", { method: "POST" });
}

export function snapshotAnemiaDrift(): Promise<{ ok: boolean; snapshot: { metric: string; status: string; ksStatistic: number; valueBasisPoints: number } }> {
  return anemiaJson("/admin/swarm/anemia/drift", { method: "POST" });
}

/* ======================================================================
 * P3 — external validation & regulatory readiness
 * ====================================================================== */

export interface EsaValidationMetricsView {
  n: number;
  siteId: string;
  maeUnits: number;
  withinOneStepPct: number;
  errorQuartiles: { q1: number; median: number; q3: number };
  spearman: number;
  hbForecastMaePct: number;
}
export interface EsaValidationReportView {
  modelId: string;
  modelVersion: string;
  siteId: string;
  cohortSize: number;
  verdict: { passed: boolean; reason: string };
  ranAt: string;
  seed: number;
  synthetic: boolean;
  metrics: EsaValidationMetricsView;
}
export interface EsaAcceptanceStatsView {
  total: number;
  accepted: number;
  adjusted: number;
  rejected: number;
  withheld: number;
  acceptanceRatePct: number;
  clinicianRetainedControlPct: number;
}
export type EsaClinicianAction = "accepted" | "adjusted" | "rejected" | "withheld";
export interface EsaStudyRecordView {
  id: string;
  patientId: string;
  modelId: string;
  recommendedDose: number;
  clinicianAction: EsaClinicianAction;
  adjustedDose?: number;
  by: string;
  window: { currentHgb: number; currentDose: number };
}
export interface EsaMdrFileView {
  version: string;
  riskClass: { aiAct: string; mdr: string; rationale: string };
  intendedUse: string;
  clinicalEvaluationPlan: string[];
  xaiEvidence: Record<string, boolean>;
  hitlDesignRecord: { role: string; approvalClass: string; autonomy: string; audit: string; veto: string };
  synthetic: boolean;
}

export interface EsaValidationView {
  registered: boolean;
  report?: EsaValidationReportView;
}
export interface EsaStudyView {
  records: EsaStudyRecordView[];
  stats: EsaAcceptanceStatsView;
}

export function fetchAnemiaValidation(): Promise<EsaValidationView> {
  return anemiaJson<EsaValidationView>("/admin/swarm/anemia/validation");
}

export function runAnemiaValidation(): Promise<{ ok: boolean; report: EsaValidationReportView }> {
  return anemiaJson("/admin/swarm/anemia/validation/run", { method: "POST" });
}

export function fetchAnemiaStudy(): Promise<EsaStudyView> {
  return anemiaJson<EsaStudyView>("/admin/swarm/anemia/study");
}

export function recordAnemiaStudy(payload: {
  patientId: string; recommendedDose: number; clinicianAction: EsaClinicianAction; adjustedDose?: number; by?: string; note?: string;
  window: { currentHgb: number; currentDose: number };
}): Promise<{ ok: boolean; record: EsaStudyRecordView; stats: EsaAcceptanceStatsView }> {
  return anemiaJson("/admin/swarm/anemia/study/record", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
}

export function fetchAnemiaMdr(): Promise<{ file: EsaMdrFileView }> {
  return anemiaJson<{ file: EsaMdrFileView }>("/admin/swarm/anemia/mdr");
}

/* ======================================================================
 * Slice 1/2 — dose what-if trajectory forecast + MPC controller
 * ====================================================================== */

export interface EsaForecastPoint { week: number; hgb: number; inBand: boolean }

export type EsaCandidateRelation = "suspend" | "reduce" | "hold" | "increase" | "initiate" | "none";

export interface EsaCandidateForecast {
  dose: number;
  label: string;
  relation: EsaCandidateRelation;
  series: EsaForecastPoint[];
  weeksBelow: number;
  weeksInBand: number;
  weeksAbove: number;
  weeksOutOfBand: number;
  pctInBand: number;
  endHgb: number;
  peakHgb: number;
  troughHgb: number;
  variabilityGd: number;
  maxWeeklyRise: number;
  projectedCostUsd: number;
  overshoot: boolean;
  rapidRise: boolean;
  score: number;
}

export interface EsaMpcController {
  horizonWeeks: number;
  weights: { outOfBand: number; overshoot: number; rapidRise: number; doseCost: number };
  constraints: { targetBand: { min: number; max: number }; maxWeeklyRiseGd: number; overshootHgb: number; unitCostUsd: number };
  chosenIndex: number;
  expected: { weeksInBand: number; pctInBand: number; projectedCostUsd: number; endHgb: number; peakHgb: number };
}

export interface EsaWhatIfResult {
  patientId: string;
  asOf: string;
  currentHgb: number;
  currentDose: number;
  onESA: boolean;
  horizonWeeks: number;
  guardrails: { flags: string[]; blocked: boolean; blockReason: string | null };
  blocked: boolean;
  blockReason: string | null;
  candidates: EsaCandidateForecast[];
  chosenIndex: number | null;
  controller: EsaMpcController | null;
  note: string;
  /** PK-informed exposure readout (Paper A) used for the hold candidate. */
  exposure: EsaExposureReadout;
}

/** Project the 12-week Hb path under each candidate dose + the MPC choice. */
export function forecastEsa(window: EsaPatientWindow, horizonWeeks?: number): Promise<{ whatIf: EsaWhatIfResult }> {
  return anemiaJson<{ whatIf: EsaWhatIfResult }>("/admin/swarm/anemia/what-if", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...window, ...(horizonWeeks !== undefined ? { horizonWeeks } : {}) }),
  });
}

/* ======================================================================
 * Slice 3 (Paper A) — PK cumulative / time-weighted exposure
 * ====================================================================== */

export interface EsaExposureFeature { id: string; label: string; unit: string; value: number; detail: string }

export interface EsaExposureReadout {
  basis: "history" | "window";
  halfLifeHours: number;
  intervalDays: number;
  administrations: number;
  nominalWeeklyDose: number;
  effectiveWeeklyDose: number;
  exposureIntensity: number;
  decayedActivity: number;
  cumulativeDose90d: number;
  timeWeightedExposure90d: number;
  doseTimeProduct: number;
  cumulativeIron14d: number;
  daysSinceLastDose: number | null;
  features: EsaExposureFeature[];
}

/** PK exposure readout (130 h decay): effective weekly dose + decayed activity. */
export function fetchEsaExposure(
  window: EsaPatientWindow,
  opts?: { halfLifeHours?: number; intervalDays?: number },
): Promise<{ exposure: EsaExposureReadout; catalog: Array<{ id: string; label: string; unit: string; detail: string }> }> {
  return anemiaJson("/admin/swarm/anemia/exposure", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...window, ...(opts ?? {}) }),
  });
}

/* ======================================================================
 * Slice 4 (Paper A) — patient twin over the real ledger + online drift
 * ====================================================================== */

export interface EsaTwinProvenance {
  realmId: string | null;
  eventsConsidered: number;
  hgbLabs: number;
  ironLabs: number;
  esaDoses: number;
  ironDoses: number;
  doseSource: "ledger" | "patient-state" | "none";
  derivedFrom: "ledger" | "patient-state" | "insufficient";
}

export interface EsaTwinDriftRow { at: string; observed: number; predicted: number; error: number; pctError: number }

export interface EsaTwinDriftScore {
  patientId: string;
  n: number;
  mae: number;
  mape: number;
  rmse: number;
  withinBandPct: number;
  verdict: "pass" | "watch" | "insufficient";
  targetMapePct: number;
  rows: EsaTwinDriftRow[];
  note: string;
}

export interface EsaTwinView {
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

export interface EsaTwinBuildResult {
  twin: EsaTwinView;
  whatIf: EsaWhatIfResult | null;
  drift: EsaTwinDriftScore;
  persisted: boolean;
}

/** Build the patient twin from the real ledger/patient state + score drift. */
export function fetchEsaTwin(patientId: string, opts?: { horizonWeeks?: number; persist?: boolean }): Promise<EsaTwinBuildResult> {
  return anemiaJson("/admin/swarm/anemia/twin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ patientId, ...(opts ?? {}) }),
  });
}

/** Persist / refresh the online forecast-vs-observed drift snapshot. */
export function persistEsaTwinDrift(patientId: string): Promise<{ drift: EsaTwinDriftScore; persisted: boolean; provenance: EsaTwinProvenance; hasWindow: boolean }> {
  return anemiaJson("/admin/swarm/anemia/twin/score", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ patientId }),
  });
}

/** Durable drift snapshots. */
export function fetchEsaTwinDrift(patientId?: string): Promise<{ rows: Array<{ id: string; patientId: string; asOf: string; score: EsaTwinDriftScore; provenance: EsaTwinProvenance }> }> {
  return anemiaJson(`/admin/swarm/anemia/twin/drift${patientId ? `?patientId=${encodeURIComponent(patientId)}` : ""}`);
}
