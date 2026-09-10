/**
 * Nutrition / electrolytes protocol pack (P5) — typed client for
 * /admin/swarm/nutrition/*.
 *
 * Mirrors src/server/nutrition-routes.ts + src/swarm/nutrition*.ts. CDSS only.
 * The safety contract is the point: EVERY hyperkalaemia action requires a
 * confirmatory lab, and a device ECG pattern is an adjunct that can never
 * trigger a potassium-lowering action on its own.
 */

import { responseOrThrow } from "./session";

export interface NutritionFeature { id: string; label: string; unit: string; min: number; max: number; relevance: number }

export type PewPathwayId = "poor-intake" | "inflammation" | "dilution" | "catabolism" | "inadequate-dialysis";

export interface PewPathwayScore {
  pathway: PewPathwayId;
  label: string;
  score: number;
  markers: Array<{ marker: string; value: number; unit: string; expected: string }>;
  because: string;
}

export interface PewAssessment {
  markersPresent: number;
  present: string[];
  pew: boolean;
  severity: "none" | "mild" | "moderate" | "severe";
  pathways: PewPathwayScore[];
  dominant: PewPathwayId;
}

export interface PotassiumForecast {
  current?: number;
  nextSession?: number;
  probabilityAbove6?: number;
  intervalHours?: number;
  drivers: Array<{ id: string; label: string; value: number }>;
  note: string;
}

export interface NutritionGuardResult {
  flags: string[];
  blocked: boolean;
  blockReason: string | null;
  emergency: boolean;
  requiresLabConfirmation: boolean;
  ecgAdjunctOnly: boolean;
}

export type NutritionAction =
  | "dietitian-referral"
  | "oral-nutrition-supplement"
  | "dialysis-dose-review"
  | "inflammation-review"
  | "target-weight-reassessment"
  | "k-binder-plan"
  | "diet-potassium-education"
  | "raasi-review"
  | "alkali-review"
  | "urgent-lab-confirmation"
  | "ed-triage"
  | "continue"
  | "blocked";

export interface NutritionRecommendation {
  patientId: string;
  guardrails: NutritionGuardResult;
  latent: { l1: number; l2: number; polarRadius: number; polarAngleRad: number };
  pew: PewAssessment;
  potassium: PotassiumForecast;
  current: { albumin?: number; crp?: number; handgripKg?: number; potassium?: number; bicarbonate?: number; ktV?: number };
  action: NutritionAction;
  plan: NutritionAction[];
  drivers: Array<{ id: string; label: string; relevance: number }>;
  model: { id: string; version: string; kind: "reference-surrogate" | "trained" };
  synthetic: boolean;
  safety: { requiresLabConfirmation: boolean; ecgAdjunctOnly: boolean; emergency: boolean };
  note: string;
}

export interface NutritionCoverageVerdict {
  covered: boolean;
  reason: string | null;
  serial: { observed: number; required: number };
  markers: { observed: number; required: number };
  manifold: { distance: number; threshold: number; inside: boolean };
}

export interface NutritionCandidate {
  label: string;
  action: string;
  pathway: string;
  projected: { albumin: number; crp: number; handgripKg: number; nonHdlMgDl: number; potassium: number; bicarbonate: number; ktV: number };
  markersResolved: number;
  projectedPotassiumRisk: number;
  riskTone: "low" | "moderate" | "high";
  allowed: boolean;
  blockedReason?: string;
  requiresLabConfirmation: boolean;
  burden: number;
  score: number;
}

export interface NutritionWhatIfResult {
  patientId: string;
  current: { albumin?: number; potassium?: number; bicarbonate?: number };
  pew: PewAssessment;
  blocked: boolean;
  blockReason: string | null;
  horizonsDays: number[];
  candidates: NutritionCandidate[];
  recommended?: NutritionCandidate;
  model: { id: string; version: string; kind: string };
  synthetic: boolean;
  note: string;
}

export interface NutritionWindowView {
  patientId: string;
  __displayFacility?: string | null;
  serialObservations: number;
  ecgPatternCount: number;
  recommendation: NutritionRecommendation & { coverage: NutritionCoverageVerdict };
  coverage: NutritionCoverageVerdict;
}

export interface NutritionStateView {
  generatedAt: string;
  source: string;
  patients: number;
  withSerialSeries: number;
  kpis: {
    patientsTracked: number;
    pew: number;
    inflammationDominant: number;
    hyperkalemiaRisk: number;
    acidosis: number;
    labConfirmationRequired: number;
    ecgAdjuncts: number;
    coverageBlocked: number;
  };
  windows: NutritionWindowView[];
}

export interface NutritionArtifactStatus {
  present: boolean;
  id?: string;
  version?: string;
  trainedAt?: string;
  rows?: number;
  patients?: number;
  classifier?: { auroc: number; brier: number; ece: number; positives: number; negatives: number };
  priorAuroc?: number;
  regressor?: { mae: number; rmse: number; bias: number; correlation: number };
  regressorPrior?: { mae?: number; rmse?: number };
  attribution?: Array<{ feature: string; gain: number; share: number }>;
  pathwayAudit?: Array<{ pathway: string; rows: number; observedPewRate: number; meanScore: number }>;
  meetsPewTarget: boolean;
  beatsMarkerPrior: boolean;
  improvesPotassiumForecast: boolean;
  band: "pass" | "watch" | "insufficient";
  note: string;
}

export interface NutritionAssuranceView {
  generatedAt: string;
  model: { id: string; registered: boolean; artifact: NutritionArtifactStatus };
  posture: Record<string, unknown>;
  coverage: { defaults: Record<string, number> };
  gate: { status: "active" | "gated" | "blocked"; gates: Array<{ name: string; passed: boolean; observed: string }>; reasons: string[] };
  redTeam: {
    scenarios: Array<{ id: string; name: string; threatModel: string; probeLabel: string; probe: { passed: boolean; checks: Array<{ name: string; passed: boolean; observed: string }> } }>;
    latestRuns: Array<{ scenarioId: string; passed: boolean; at: string } | null>;
  };
  findings: Array<{ id: string; title: string; severity: string; status: string; scenarioId?: string }>;
  openFindings: number;
  drift: Array<{ metric: string; valueBasisPoints: number; status: string; updatedAt: string }>;
}

export interface NutritionValidationView {
  generatedAt: string;
  report: {
    artifactId: string;
    artifactPresent: boolean;
    trainedAt: string | null;
    rows: number;
    patients: number;
    classifier: NutritionArtifactStatus["classifier"] | null;
    priorAuroc: number | null;
    regressor: NutritionArtifactStatus["regressor"] | null;
    regressorPrior: { mae?: number; rmse?: number } | null;
    reliability: Array<{ bin?: string; n?: number; predicted?: number; observed?: number }> | null;
    pathwayAudit: NutritionArtifactStatus["pathwayAudit"] | null;
    band: "pass" | "watch" | "insufficient";
    verdict: string;
    criteria: Array<{ criterion: string; target: string; observed: unknown; met: boolean }>;
    acceptanceMet: boolean;
    synthetic: boolean;
    benchmarkNote: string;
    note: string;
  };
}

export interface NutritionTwinView {
  twin: {
    patientId: string;
    asOf: string;
    observations: Array<{
      at: string;
      albumin?: number;
      crp?: number;
      creatinineMgDl?: number;
      nonHdlMgDl?: number;
      potassium?: number;
      bicarbonate?: number;
      handgripKg?: number;
    }>;
    sessions: Array<{ sessionId: string; endedAt: string; deliveredMinutes: number; predictedSpKtV?: number }>;
    observedUrr: Array<{ at: string; urrPct: number; spKtV?: number }>;
    summary: {
      observations: number;
      latestAlbumin?: number;
      albuminTrend30d?: number;
      latestCrp?: number;
      latestHandgripKg?: number;
      latestNonHdlMgDl?: number;
      latestPotassium?: number;
      latestBicarbonate?: number;
      ktV?: number;
      interdialyticHours?: number;
      pewMarkers: number;
      pew: boolean;
      dominantPathway: string;
      ecgFlags: number;
    };
    ecgFlags: Array<{ at: string; pattern: string }>;
    provenance: { source: string; labEvents: number; assessmentEvents: number; urrResults: number; ktVSource: string; attributedBy: string; synthetic: boolean };
  };
  drift: {
    n: number;
    potassiumPairs: number;
    potassiumMae?: number;
    potassiumBias?: number;
    auroc?: number;
    events: number;
    verdict: "pass" | "watch" | "insufficient";
    targetMae: number;
    targetAuroc: number;
    rows: Array<{ at: string; observed?: number; projected?: number; event: boolean }>;
    note: string;
  };
  window: Record<string, unknown>;
}

export const NUTRITION_ACTION_LABEL: Record<NutritionAction, string> = {
  "dietitian-referral": "Dietitian referral",
  "oral-nutrition-supplement": "Oral nutrition supplement",
  "dialysis-dose-review": "Review the dialysis dose",
  "inflammation-review": "Review the inflammation source",
  "target-weight-reassessment": "Reassess the target weight",
  "k-binder-plan": "Consider a potassium binder",
  "diet-potassium-education": "Dietary potassium education",
  "raasi-review": "Review the RAASi",
  "alkali-review": "Review alkali therapy",
  "urgent-lab-confirmation": "Confirm with a fresh potassium",
  "ed-triage": "Emergency (ECG + ED/urgent dialysis) triage",
  continue: "Continue routine care",
  blocked: "Blocked by guardrails",
};

export function nutritionActionTone(action: NutritionAction): "red" | "amber" | "mint" | "neutral" | "blue" | "violet" {
  if (action === "ed-triage") return "red";
  if (action === "urgent-lab-confirmation") return "amber";
  if (action === "blocked") return "neutral";
  if (action === "continue") return "mint";
  if (action === "k-binder-plan" || action === "inflammation-review" || action === "dialysis-dose-review" || action === "alkali-review") return "amber";
  return "blue";
}

/** Pathway → tone: the leading pathway is the one the plan targets. */
export function pathwayTone(index: number): "red" | "amber" | "blue" | "neutral" {
  if (index === 0) return "red";
  if (index === 1) return "amber";
  if (index === 2) return "blue";
  return "neutral";
}

/** Potassium tone: ≥6.0 is the action threshold, ≥6.5 the emergency band. */
export function potassiumTone(k: number | undefined): "mint" | "amber" | "red" | "neutral" {
  if (k === undefined) return "neutral";
  if (k >= 6.5) return "red";
  if (k >= 5.5) return "amber";
  return "mint";
}

async function nutritionJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: "no-store", credentials: "same-origin", ...init });
  return responseOrThrow<T>(path, response);
}

export const fetchNutritionFeatures = (): Promise<{
  features: NutritionFeature[];
  reference: Record<string, unknown>;
  model: { id: string; kind: string; trainedArtifact: string };
  tradeoffWeights: Record<string, number>;
  pathways: { note: string; list: Array<{ pathway: string; label: string; because: string }> };
  safety: { orderAuthority: string; ecgStandaloneAuthority: string; hardContract: string; benchmarkNote: string };
}> => nutritionJson("/admin/swarm/nutrition/features");

export const fetchNutritionState = (): Promise<NutritionStateView> => nutritionJson<NutritionStateView>("/admin/swarm/nutrition/state");
export const fetchNutritionAssurance = (): Promise<NutritionAssuranceView> => nutritionJson<NutritionAssuranceView>("/admin/swarm/nutrition/assurance");
export const fetchNutritionValidation = (): Promise<NutritionValidationView> => nutritionJson<NutritionValidationView>("/admin/swarm/nutrition/validation");
export const fetchNutritionArtifact = (): Promise<{ generatedAt: string; artifact: NutritionArtifactStatus }> => nutritionJson("/admin/swarm/nutrition/artifact");
export const fetchNutritionMdr = (): Promise<{ generatedAt: string; mdr: Record<string, unknown> }> => nutritionJson("/admin/swarm/nutrition/mdr");

export const fetchNutritionPathways = (patientId?: string): Promise<{
  patientId: string;
  source: string;
  markersPresent: number;
  present: string[];
  pew: boolean;
  severity: string;
  dominant: string;
  pathways: PewPathwayScore[];
  latent: { l1: number; l2: number; polarRadius: number; polarAngleRad: number };
  potassium: PotassiumForecast;
}> => nutritionJson(`/admin/swarm/nutrition/pathways${patientId ? `?patientId=${encodeURIComponent(patientId)}` : ""}`);

export interface NutritionSafetyView {
  generatedAt: string;
  contract: string;
  maxLabAgeHours: number;
  escalationThreshold: number;
  ecgAuthority: string;
  rules: string[];
  probe: { window: Record<string, unknown>; guardrails: NutritionGuardResult; recommendation: NutritionRecommendation; forecast: PotassiumForecast };
  note: string;
}

export const fetchNutritionSafety = (): Promise<NutritionSafetyView> => nutritionJson("/admin/swarm/nutrition/safety");

export const adviseNutrition = (body: Record<string, unknown>): Promise<{
  patientId: string;
  recommendation: NutritionRecommendation & { coverage: NutritionCoverageVerdict };
  coverage: NutritionCoverageVerdict;
  guardrails: NutritionGuardResult;
  safety: { requiresLabConfirmation: boolean; ecgAdjunctOnly: boolean; emergency: boolean };
  pathways: PewPathwayScore[];
  potassium: PotassiumForecast;
  trained?: { artifactId: string; pewProbability: number; drivers: Array<{ feature: string; gain: number; share: number }> };
}> => nutritionJson("/admin/swarm/nutrition/advise", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const nutritionWhatIf = (body: Record<string, unknown>): Promise<{
  patientId: string;
  result: NutritionWhatIfResult;
  pathwayShift: Array<{ pathway: string; before: number; after: number }>;
  potassiumContract: { maxLabAgeHours: number; threshold: number; escalationThreshold: number; requiresLabConfirmation: boolean };
}> => nutritionJson("/admin/swarm/nutrition/what-if", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const fetchNutritionTwin = (patientId: string): Promise<NutritionTwinView> =>
  nutritionJson("/admin/swarm/nutrition/twin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ patientId }) });

export const runNutritionRedTeam = (): Promise<{ passed: boolean; probes: Array<{ scenarioId: string; passed: boolean }> }> =>
  nutritionJson("/admin/swarm/nutrition/red-team", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ranBy: "exec-ui" }) });

export const snapshotNutritionDrift = (): Promise<{ snapshot: { verdict: string; ksStatistic: number; latentShift: number; metric: string } }> =>
  nutritionJson("/admin/swarm/nutrition/drift", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

export const seedNutritionDemo = (): Promise<{ opened: string[]; existing: string[]; closed: string[] }> =>
  nutritionJson("/admin/swarm/nutrition/demo", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

export const resetNutritionDemo = (): Promise<{ removed: number }> =>
  nutritionJson("/admin/swarm/nutrition/reset", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

export const recordNutritionStudy = (body: { patientId: string; action: "accept" | "modify" | "reject"; clinician?: string }): Promise<{ ok: boolean }> =>
  nutritionJson("/admin/swarm/nutrition/study/record", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
