// P6 — infection / vaccination client surface (exec console).
//
// Two halves, two colours: the TRIAGE is statistical (scored, banded, with
// drivers), the PREVENTION is deterministic (rule-referenced tasks with due
// dates and a "no model involved" badge). The UI must never blur them, so the
// types keep them apart and the labels say which is which.

import { responseOrThrow } from "./session";
import type { RankedActionsPayload } from "./ranked-actions";

export interface InfectionFeature { id: string; label: string; unit: string; min: number; max: number; relevance: number }

export interface InfectionDriver { id: string; label: string; value: number; contribution: number; boundary?: string }

export interface BsiAssessment {
  probability: number;
  band: "low" | "watch" | "high";
  febrile: boolean;
  measured: {
    temperatureC?: number;
    peakTemperatureC?: number;
    procalcitoninNgMl?: number;
    nlr?: number;
    wbc?: number;
    catheterDays?: number;
  };
  drivers: InfectionDriver[];
  criteria: Array<{ id: string; met: boolean; detail: string; source: string }>;
  temperatureReadings: number;
  culture: { result?: number; at?: string; status: "none" | "pending" | "negative" | "positive"; turnAroundHours: number };
}

export interface InfectionGuardResult {
  flags: string[];
  blocked: boolean;
  blockReason: string | null;
  cultureAllowed: boolean;
  antibioticDiscussionAllowed: boolean;
  escalateNow: boolean;
  requiresCultureFirst: boolean;
}

export type PreventionTaskKind =
  | "vaccination-due"
  | "immunisation-series-incomplete"
  | "serology-followup"
  | "audit-due"
  | "catheter-escalation"
  | "access-care-review";

export interface PreventionTask {
  id: string;
  kind: PreventionTaskKind;
  label: string;
  because: string;
  dueAt: string;
  overdue: boolean;
  daysUntilDue: number;
  ownerRole: string;
  approvalClass: string;
  deterministic: true;
  modelFree: true;
  rule: { ruleId: string; source: string; read: Array<{ record: string; value: string }>; threshold: string };
  satisfied: boolean;
}

export interface PreventionPlan {
  patientId: string;
  asOf: string;
  tasks: PreventionTask[];
  dueCount: number;
  overdueCount: number;
  schedule: Array<{ vaccine: string; label: string; intervalDays: number; seriesDoses: number }>;
}

export interface InfectionPreventionScheduleEntry {
  horizonDays: number;
  taskId: string;
  kind: string;
  label: string;
  dueAt: string;
  overdue: boolean;
  ruleId: string;
  source: string;
}

export type InfectionAction =
  | "continue"
  | "temperature-surveillance"
  | "blood-culture-order"
  | "culture-then-antibiotic-discussion"
  | "empiric-antibiotic-discussion"
  | "isolation-review"
  | "catheter-removal-escalation"
  | "vaccination-outreach"
  | "serology-followup"
  | "access-care-review"
  | "audit-task"
  | "urgent-clinical-review"
  | "blocked";

export interface InfectionRecommendation {
  patientId: string;
  guardrails: InfectionGuardResult;
  latent: { l1: number; l2: number; polarRadius: number; polarAngleRad: number };
  assessment: BsiAssessment;
  prevention: PreventionTask[];
  current: {
    temperatureC?: number;
    peakTemperatureC?: number;
    procalcitoninNgMl?: number;
    nlr?: number;
    accessType?: string;
    catheterDays?: number;
    cultureStatus: string;
  };
  action: InfectionAction;
  plan: InfectionAction[];
  drivers: Array<{ id: string; label: string; relevance: number }>;
  model: { id: string; version: string; kind: string };
  synthetic: boolean;
  authority: { antimicrobial: "none"; cultureOrder: string; isolation: string; authority: string };
  note: string;
}

export interface InfectionCoverageVerdict {
  covered: boolean;
  reason: string | null;
  serial: { observed: number; required: number };
  markers: { observed: number; required: number };
  manifold: { distance: number; threshold: number; inside: boolean };
}

export interface InfectionCandidate {
  label: string;
  action: string;
  half: "triage" | "prevention";
  projected: {
    probability: number;
    cultureHours: number;
    catheterDays: number;
    immunisationCoverage: number;
    auditCompliance: number;
  };
  score: number;
  allowed: boolean;
  refusedReason?: string;
  falsePositiveCost: number;
  requiresCultureFirst: boolean;
  deterministic: boolean;
  burden: number;
  ruleId?: string;
}

export interface InfectionWhatIfResult {
  patientId: string;
  current: Record<string, string | number | undefined>;
  blocked: boolean;
  blockReason: string | null;
  horizonsDays: number[];
  candidates: InfectionCandidate[];
  refused: InfectionCandidate[];
  recommended?: InfectionCandidate;
  prevention: {
    horizonsDays: number[];
    schedule: InfectionPreventionScheduleEntry[];
    counts: { at30: number; at90: number; at180: number; overdue: number };
    determinismSignature: string;
    modelFree: true;
  };
  model: { id: string; version: string; kind: string };
  synthetic: boolean;
  note: string;
}

export interface InfectionStateView {
  generatedAt: string;
  source: string;
  patients: number;
  withSerialReadings: number;
  kpis: Record<string, number>;
  windows: Array<{
    patientId: string;
    __displayFacility: string | null;
    serialReadings: number;
    preventionDue: number;
    preventionOverdue: number;
    recommendation: InfectionRecommendation;
    coverage: InfectionCoverageVerdict;
    preventionSignature: string;
  }>;
  actions?: RankedActionsPayload;
}

export interface InfectionArtifactStatus {
  present: boolean;
  id?: string;
  version?: string;
  trainedAt?: string;
  rows?: number;
  patients?: number;
  classifier?: { auroc: number; brier: number; ece: number; positives: number; negatives: number };
  priorAuroc?: number;
  aurocGain?: number;
  attribution?: Array<{ feature: string; gain: number; share: number }>;
  generatorAudit?: Array<{ generator: string; rows: number; observedRate: number; meanScore: number }>;
  meetsTarget: boolean;
  beatsRulePrior: boolean;
  band: "pass" | "watch" | "insufficient";
  note: string;
}

export interface InfectionTwinScore {
  n: number;
  cultureRows: number;
  positives: number;
  negatives: number;
  auroc?: number;
  brier?: number;
  ece?: number;
  bandAgreement?: number;
  verdict: "pass" | "watch" | "insufficient";
  targetAuroc: number;
  targetBrier: number;
  rows: Array<{ at: string; score: number; label: 0 | 1; band: string; observedTemperatureC?: number; readings: number }>;
  note: string;
}

export interface InfectionTwinView {
  generatedAt: string;
  patientId?: string;
  twin: {
    patientId: string;
    asOf: string;
    temperatures: Array<{ at: string; tempC: number; hr?: number; spo2?: number }>;
    observations: Array<{ at: string; procalcitoninNgMl?: number; wbc?: number; crp?: number; neutrophilPct?: number; lymphocytePct?: number }>;
    cultures: Array<{ at: string; result: number; positive: boolean }>;
    immunisations: Array<{ at: string; vaccine: string; seriesDose: number; seriesTotal?: number }>;
    serology: Array<{ at: string; iuL: number }>;
    audits: Array<{ at: string; assessmentId: string }>;
    access: { accessType?: string; catheterDays?: number; accessAgeDays?: number; matureAvfAvailable: boolean; accessInfectionSigns: boolean };
    summary: Record<string, number | undefined>;
    preventionPlan: PreventionTask[];
    preventionSignature: string;
    provenance: { source: string; temperatureEvents: number; labEvents: number; cultureResults: number; immunisationEvents: number; auditAssessments: number; attributedBy: string; synthetic: boolean };
  };
  score: InfectionTwinScore;
  stability: { stable: boolean; modelIndependent: boolean; signature: string; taskCount: number; ruleIds: string[]; note: string };
  guardrails: InfectionGuardResult;
}

export interface InfectionAssuranceView {
  generatedAt: string;
  model: { id: string; registered: boolean; artifact: InfectionArtifactStatus };
  posture: Record<string, unknown>;
  halves: Record<string, { kind: string; model: string | null; input: string; governedBy: readonly string[] }>;
  gate: {
    status: string;
    gates: Array<{ name: string; passed: boolean; observed: string }>;
    reasons: string[];
    separation: { deterministic: boolean; modelIndependent: boolean; signature: string; taskCount: number; ruleIds: string[]; detail: string };
  };
  separation: { deterministic: boolean; modelIndependent: boolean; detail: string };
  redTeam: {
    scenarios: Array<{ id: string; name: string; threatModel: string; probeLabel: string; probe: { passed: boolean; checks: Array<{ name: string; passed: boolean; observed: string }> } }>;
    latestRuns: Array<{ scenarioId: string; passed: boolean; at: string }>;
  };
  findings: Array<{ id: string; severity: string; title: string; status: string; scenarioId?: string }>;
  openFindings: number;
  drift: Array<{ targetId: string; metric: string; valueBasisPoints: number; status: string; recordedAt?: string }>;
}

export interface InfectionValidationView {
  generatedAt: string;
  report: {
    artifactId: string;
    artifactPresent: boolean;
    rows: number;
    patients: number;
    classifier: InfectionArtifactStatus["classifier"] | null;
    priorAuroc: number | null;
    aurocGain: number | null;
    reliability: Array<{ bin: number; meanPredicted: number; observedRate: number; n: number }> | null;
    generatorAudit: InfectionArtifactStatus["generatorAudit"] | null;
    band: string;
    verdict: string;
    criteria: Array<{ criterion: string; target: string; observed: unknown; met: boolean }>;
    acceptanceMet: boolean;
    synthetic: boolean;
    benchmarkNote: string;
    note: string;
  };
}

export interface InfectionPreventionPanel {
  generatedAt: string;
  patientId: string;
  source: string;
  modelFree: boolean;
  deterministic: boolean;
  plan: PreventionPlan;
  schedule: InfectionWhatIfResult["prevention"];
  determinism: { signature: string; stable: boolean };
  rules: string[];
}

export interface InfectionSafetyView {
  generatedAt: string;
  contract: string;
  antimicrobialAuthority: string;
  cultureTurnaroundHours: number;
  minTemperatureReadings: number;
  rules: string[];
  refused: Array<{ label: string; action: string; reason: string }>;
  probe: { window: Record<string, unknown>; guardrails: InfectionGuardResult; recommendation: InfectionRecommendation; assessment: BsiAssessment };
  note: string;
}

export interface InfectionSeparationView {
  generatedAt: string;
  claim: string;
  halves: InfectionAssuranceView["halves"];
  separation: { deterministic: boolean; modelIndependent: boolean; signature: string; taskCount: number; ruleIds: string[]; detail: string };
}

export const INFECTION_ACTION_LABEL: Record<InfectionAction, string> = {
  continue: "Continue routine screening",
  "temperature-surveillance": "Intensify temperature surveillance",
  "blood-culture-order": "Order blood cultures (two sites)",
  "culture-then-antibiotic-discussion": "Culture on file — antimicrobial discussion",
  "empiric-antibiotic-discussion": "Empiric antimicrobial discussion",
  "isolation-review": "Isolation review",
  "catheter-removal-escalation": "Catheter removal escalation",
  "vaccination-outreach": "Vaccination outreach",
  "serology-followup": "Hepatitis B serology follow-up",
  "access-care-review": "Access-site care review",
  "audit-task": "Infection-prevention audit task",
  "urgent-clinical-review": "Urgent clinical review",
  blocked: "Blocked by guardrails",
};

export function infectionActionTone(action: InfectionAction): "red" | "amber" | "mint" | "neutral" | "blue" | "violet" {
  switch (action) {
    case "urgent-clinical-review":
    case "blocked":
      return "red";
    case "blood-culture-order":
    case "culture-then-antibiotic-discussion":
    case "isolation-review":
      return "amber";
    case "catheter-removal-escalation":
    case "access-care-review":
      return "violet";
    case "vaccination-outreach":
    case "serology-followup":
    case "audit-task":
      return "blue";
    case "temperature-surveillance":
      return "amber";
    case "continue":
    default:
      return "mint";
  }
}

export function bandTone(band: string): "red" | "amber" | "mint" | "neutral" {
  if (band === "high") return "red";
  if (band === "watch") return "amber";
  if (band === "low") return "mint";
  return "neutral";
}

export function preventionTone(task: PreventionTask): "red" | "amber" | "blue" | "violet" | "neutral" {
  if (task.kind === "catheter-escalation") return "violet";
  if (task.overdue) return "red";
  if (task.kind === "serology-followup") return "blue";
  if (task.kind === "audit-due") return "amber";
  return "blue";
}

export function cultureTone(status: string): "red" | "mint" | "amber" | "neutral" {
  if (status === "positive") return "red";
  if (status === "negative") return "mint";
  if (status === "pending") return "amber";
  return "neutral";
}

async function infectionJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: "no-store", credentials: "same-origin", ...init });
  return responseOrThrow<T>(path, response);
}

export const fetchInfectionFeatures = (): Promise<{
  features: InfectionFeature[];
  reference: Record<string, unknown>;
  model: { id: string; kind: string; trainedArtifact: string };
  tradeoffWeights: Record<string, number>;
  halves: Record<string, { kind: string; model: string | null; input: string; governedBy: readonly string[] }>;
  preventionRules: { note: string; vaccines: Array<{ vaccine: string; label: string; intervalDays: number; seriesDoses: number }>; audits: Array<{ id: string; label: string; intervalDays: number }>; serology: Record<string, unknown> };
  authority: { antimicrobial: string; prescribing: string; cultureOrder: string; refused: Array<{ label: string; action: string; reason: string }> };
  safety: { hardContract: string; cultureBeforeAntibiotic: string; benchmarkNote: string };
}> => infectionJson("/admin/swarm/infection/features");

export const fetchInfectionState = (): Promise<InfectionStateView> => infectionJson<InfectionStateView>("/admin/swarm/infection/state");
export const fetchInfectionAssurance = (): Promise<InfectionAssuranceView> => infectionJson<InfectionAssuranceView>("/admin/swarm/infection/assurance");
export const fetchInfectionValidation = (): Promise<InfectionValidationView> => infectionJson<InfectionValidationView>("/admin/swarm/infection/validation");
export const fetchInfectionArtifact = (): Promise<{ generatedAt: string; artifact: InfectionArtifactStatus }> => infectionJson("/admin/swarm/infection/artifact");
export const fetchInfectionMdr = (): Promise<{ generatedAt: string; mdr: Record<string, unknown> }> => infectionJson("/admin/swarm/infection/mdr");
export const fetchInfectionSeparation = (patientId?: string): Promise<InfectionSeparationView> =>
  infectionJson(`/admin/swarm/infection/separation${patientId ? `?patientId=${encodeURIComponent(patientId)}` : ""}`);
export const fetchInfectionPrevention = (patientId?: string): Promise<InfectionPreventionPanel> =>
  infectionJson(`/admin/swarm/infection/prevention${patientId ? `?patientId=${encodeURIComponent(patientId)}` : ""}`);
export const fetchInfectionSafety = (): Promise<InfectionSafetyView> => infectionJson("/admin/swarm/infection/safety");

export const adviseInfection = (body: Record<string, unknown>): Promise<{
  patientId: string;
  window: Record<string, unknown>;
  recommendation: InfectionRecommendation;
  coverage: InfectionCoverageVerdict;
  guardrails: InfectionGuardResult;
  assessment: BsiAssessment;
  prevention: PreventionTask[];
  preventionSignature: string;
  priorScore: number;
  trained?: { artifactId: string; probability: number; drivers: Array<{ feature: string; gain: number; share: number }>; reference: { probability: number; band: string }; prior: number };
}> => infectionJson("/admin/swarm/infection/advise", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const infectionWhatIf = (body: Record<string, unknown>): Promise<{
  patientId: string;
  result: InfectionWhatIfResult;
  sensitivity: Array<{ variant: string; probability: number; band: string; readings: number }>;
  cultureContract: { turnaroundHours: number; requiresCultureFirst: boolean; refused: Array<{ action: string; reason: string }>; antimicrobialAuthority: string };
}> => infectionJson("/admin/swarm/infection/what-if", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const runInfectionPrevention = (body: Record<string, unknown>): Promise<InfectionPreventionPanel & { note: string }> =>
  infectionJson("/admin/swarm/infection/prevention/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const fetchInfectionTwin = (patientId: string): Promise<InfectionTwinView> =>
  infectionJson("/admin/swarm/infection/twin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ patientId }) });

export const runInfectionRedTeam = (): Promise<{ passed: boolean; probes: Array<{ scenarioId: string; passed: boolean; checks: Array<{ name: string; passed: boolean; observed: string }> }> }> =>
  infectionJson("/admin/swarm/infection/red-team", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ranBy: "exec-ui" }) });

export const snapshotInfectionDrift = (): Promise<{ snapshot: { verdict: string; ksStatistic: number; latentShift: number; metric: string; separation: { deterministic: boolean; modelIndependent: boolean } } }> =>
  infectionJson("/admin/swarm/infection/drift", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

export const seedInfectionDemo = (): Promise<{ opened: string[]; existing: string[]; closed: string[] }> =>
  infectionJson("/admin/swarm/infection/demo", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

export const resetInfectionDemo = (): Promise<{ removed: number }> =>
  infectionJson("/admin/swarm/infection/reset", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

export const recordInfectionStudy = (body: { patientId: string; action: "accept" | "modify" | "reject"; clinician?: string }): Promise<{ ok: boolean }> =>
  infectionJson("/admin/swarm/infection/study/record", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
