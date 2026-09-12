/**
 * Vascular access protocol pack (P3) — typed client for /admin/swarm/access/*.
 *
 * Mirrors src/server/access-routes.ts + src/swarm/access*.ts. CDSS only: outputs
 * are surveillance recommendations and referral PROPOSALS for the access team.
 * The platform never books an imaging study or an intervention, and the audio
 * path is gated behind ACCESS_ACOUSTIC_ENABLED.
 */

import { responseOrThrow } from "./session";
import type { RankedActionsPayload } from "./ranked-actions";

export interface AccessFeature { id: string; label: string; unit: string; min: number; max: number; relevance: number }
export type AccessAction =
  | "refer-duplex-ultrasound"
  | "access-team-review"
  | "change-cannulation-technique"
  | "increase-surveillance"
  | "escalate-now"
  | "catheter-removal-escalation"
  | "no-action"
  | "blocked";

export interface AccessGuardResult {
  flags: string[];
  blocked: boolean;
  blockReason: string | null;
  referralAllowed: boolean;
  escalateNow: boolean;
  venousPressureDeltaPct?: number;
  accessFlowDeltaPct?: number;
}

export interface AccessRecommendation {
  patientId: string;
  guardrails: AccessGuardResult;
  latent: { l1: number; l2: number; polarRadius: number; polarAngleRad: number };
  current: {
    accessType?: string;
    accessAgeDays?: number;
    observations: number;
    venousPressureMmHg?: number;
    venousPressureDeltaPct?: number;
    recirculationPct?: number;
    accessFlowMlMin?: number;
    accessFlowDeltaPct?: number;
    deliveredClearancePct?: number;
    cannulationDifficulty?: string;
    daysSinceIntervention?: number;
  };
  stenosisProbability: number;
  thrombosisRiskByHorizon: Record<string, number>;
  action: AccessAction;
  recommended: { surveillanceIntervalDays?: number; projectedStenosisProbability?: number; projectedThrombosisRisk30d?: number };
  drivers: Array<{ id: string; label: string; relevance: number }>;
  model: { id: string; version: string; kind: "reference-surrogate" | "trained" };
  synthetic: boolean;
  note: string;
}

export interface AccessCoverageVerdict {
  covered: boolean;
  reason: string | null;
  observations: { measured: number; required: number; withMeasurements: number };
  recency: { lastObservationAt?: string; gapDays?: number; maxGapDays: number };
  manifold: { distance: number; threshold: number; inside: boolean };
  range?: { feature: string; label: string; value: number; unit: string; min: number; max: number };
}

export interface AccessCandidate {
  label: string;
  arm: "surveillance-only" | "refer-now";
  surveillanceIntervalDays: number;
  thrombosisRiskByHorizon: Record<string, number>;
  projectedStenosisProbability: number;
  detectionDelayDays: number;
  procedureBurden: number;
  allowed: boolean;
  blockedReason?: string;
  score: number;
}

export interface AccessWhatIfResult {
  patientId: string;
  current: { stenosisProbability: number; thrombosisRiskByHorizon: Record<string, number>; accessType?: string };
  blocked: boolean;
  blockReason: string | null;
  horizonsDays: number[];
  candidates: AccessCandidate[];
  recommended?: AccessCandidate;
  model: { id: string; version: string; kind: string };
  synthetic: boolean;
  note: string;
}

export interface AccessRiskSurfacePoint {
  intervalDays: number;
  surveillanceOnly: number;
  surveillanceOnly30d: number;
  referNow: number;
  referNow30d: number;
}

export interface AccessWindowView {
  patientId: string;
  __displayFacility?: string | null;
  lastObservationAt?: string;
  acousticCaptures: number;
  recommendation: AccessRecommendation;
  coverage: AccessCoverageVerdict;
}

export interface AccessStateView {
  generatedAt: string;
  source: string;
  patients: number;
  withMeasuredSeries: number;
  kpis: { accessesTracked: number; observations: number; catheterAccesses: number; referralProposed: number; coverageBlocked: number };
  windows: AccessWindowView[];
  actions?: RankedActionsPayload;
}

export interface AccessAssuranceView {
  generatedAt: string;
  model: { id: string; registered: boolean; artifact: AccessArtifactStatus };
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

export interface AccessArtifactStatus {
  present: boolean;
  id?: string;
  version?: string;
  trainedAt?: string;
  rows?: number;
  patients?: number;
  metrics?: {
    auroc?: number;
    brier?: number;
    ece?: number;
    priorAuroc?: number;
    priorBrier?: number;
    baselineAuroc?: number;
    longitudinalOnlyAuroc?: number;
    positives: number;
    negatives: number;
  };
  attribution?: Array<{ feature: string; gain: number; share: number }>;
  acoustic?: { flag: string; enabledAtTrainTime: boolean; captures: number; synthetic: boolean; note: string };
  meetsLongitudinalTarget: boolean;
  beatsPriorDiscrimination: boolean;
  band: "pass" | "watch" | "insufficient";
  note: string;
}

export interface AccessTwinView {
  twin: {
    patientId: string;
    asOf: string;
    accessType?: string;
    observations: Array<{
      at: string;
      event: string;
      venousPressureMmHg?: number;
      accessFlowMlMin?: number;
      recirculationPct?: number;
      deliveredClearancePct?: number;
      cannulationDifficulty?: string;
      venousPressureDeltaPct?: number;
      accessFlowDeltaPct?: number;
      stenosisProbability?: number;
      thrombosisRisk30d?: number;
      thrombosisRisk90d?: number;
      outcome?: boolean;
      outcomeEvent?: string;
      acousticDeltaScore?: number;
    }>;
    interventions: Array<{ at: string; event: string }>;
    acoustic: { captures: number; provenance: string[]; synthetic: boolean; enabled: boolean };
    summary: {
      observations: number;
      measured: number;
      venousPressureDeltaPct?: number;
      recirculationPct?: number;
      accessFlowMlMin?: number;
      accessFlowDeltaPct?: number;
      latestStenosisProbability?: number;
      peakStenosisProbability?: number;
      interventions: number;
      thromboses: number;
      surveillanceGapDays?: number;
    };
    provenance: { source: string; accessEvents: number; acousticEvents: number; attributedBy: string; synthetic: boolean };
  };
  drift: {
    n: number;
    outcomes: number;
    auroc?: number;
    brier?: number;
    ece?: number;
    meanPredicted: number;
    observedRate: number;
    calibrationGap: number;
    leadTimeDays?: number;
    verdict: "pass" | "watch" | "insufficient";
    targetAuroc: number;
    note: string;
  };
  window: Record<string, unknown>;
}

export interface AccessValidationView {
  generatedAt: string;
  report: {
    artifactId: string;
    artifactPresent: boolean;
    trainedAt: string | null;
    rows: number;
    patients: number;
    metrics: AccessArtifactStatus["metrics"] | null;
    reliability: Array<{ bin?: string; n?: number; predicted?: number; observed?: number }> | null;
    band: "pass" | "watch" | "insufficient";
    verdict: string;
    criteria: Array<{ criterion: string; target: string; observed: unknown; met: boolean }>;
    acceptanceMet: boolean;
    synthetic: boolean;
    benchmarkNote: string;
    note: string;
  };
}

export interface AccessAcousticView {
  generatedAt: string;
  flag: string;
  enabled: boolean;
  eventKind: string;
  payload: { featureKind: string; dimensions: number; maxStored: number; note: string };
  gating: string[];
  capturesOnLedger: number;
  patients: Array<{ patientId: string; captures: number }>;
  enabledDelta?: number;
  note: string;
}

export const ACCESS_ACTION_LABEL: Record<AccessAction, string> = {
  "refer-duplex-ultrasound": "Refer for duplex ultrasound",
  "access-team-review": "Access-team review",
  "change-cannulation-technique": "Change cannulation technique",
  "increase-surveillance": "Intensify surveillance",
  "escalate-now": "Escalate now",
  "catheter-removal-escalation": "Catheter-removal escalation",
  "no-action": "Routine surveillance",
  blocked: "Blocked by guardrails",
};

export function accessActionTone(action: AccessAction): "red" | "amber" | "mint" | "neutral" | "blue" | "violet" {
  if (action === "escalate-now") return "red";
  if (action === "blocked") return "neutral";
  if (action === "refer-duplex-ultrasound") return "amber";
  if (action === "catheter-removal-escalation") return "violet" as "blue";
  if (action === "increase-surveillance" || action === "change-cannulation-technique") return "blue";
  return "mint";
}

/** Stenosis probability → tone for the progress bars and tags. */
export function stenosisTone(probability: number | undefined): "mint" | "amber" | "red" | "neutral" {
  if (probability === undefined) return "neutral";
  if (probability >= 0.5) return "red";
  if (probability >= 0.3) return "amber";
  return "mint";
}

async function accessJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: "no-store", credentials: "same-origin", ...init });
  return responseOrThrow<T>(path, response);
}

export const fetchAccessFeatures = (): Promise<{ features: AccessFeature[]; reference: Record<string, unknown>; model: { id: string; kind: string; trainedArtifact: string }; acoustic: { flag: string; enabled: boolean; note: string }; safety: { machineControl: string; procedureOrdering: string; referralRequiresHumanApproval: boolean } }> =>
  accessJson("/admin/swarm/access/features");
export const fetchAccessState = (): Promise<AccessStateView> => accessJson<AccessStateView>("/admin/swarm/access/state");
export const fetchAccessAssurance = (): Promise<AccessAssuranceView> => accessJson<AccessAssuranceView>("/admin/swarm/access/assurance");
export const fetchAccessValidation = (): Promise<AccessValidationView> => accessJson<AccessValidationView>("/admin/swarm/access/validation");
export const fetchAccessArtifact = (): Promise<{ generatedAt: string; artifact: AccessArtifactStatus }> => accessJson("/admin/swarm/access/artifact");
export const fetchAccessAcoustic = (): Promise<AccessAcousticView> => accessJson<AccessAcousticView>("/admin/swarm/access/acoustic");
export const fetchAccessMdr = (): Promise<{ generatedAt: string; mdr: Record<string, unknown> }> => accessJson("/admin/swarm/access/mdr");

export const adviseAccess = (body: Record<string, unknown>): Promise<{ patientId: string; recommendation: AccessRecommendation; coverage: AccessCoverageVerdict; whatIf: AccessWhatIfResult; trained?: { artifactId: string; priorRisk: number; headRisk: number; ranker: string } }> =>
  accessJson("/admin/swarm/access/advise", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const accessWhatIf = (body: Record<string, unknown>): Promise<{ patientId: string; result: AccessWhatIfResult; riskSurface: AccessRiskSurfacePoint[] }> =>
  accessJson("/admin/swarm/access/what-if", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const fetchAccessTwin = (patientId: string): Promise<AccessTwinView> =>
  accessJson("/admin/swarm/access/twin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ patientId }) });

export const runAccessRedTeam = (): Promise<{ passed: boolean; probes: Array<{ scenarioId: string; passed: boolean }> }> =>
  accessJson("/admin/swarm/access/red-team", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ranBy: "exec-ui" }) });

export const snapshotAccessDrift = (): Promise<{ snapshot: { verdict: string; ksStatistic: number; latentShift: number; metric: string } }> =>
  accessJson("/admin/swarm/access/drift", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

export const seedAccessDemo = (): Promise<{ opened: string[]; existing: string[]; closed: string[] }> =>
  accessJson("/admin/swarm/access/demo", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

export const resetAccessDemo = (): Promise<{ removed: number }> =>
  accessJson("/admin/swarm/access/reset", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

export const recordAccessStudy = (body: { patientId: string; action: "accept" | "modify" | "reject"; clinician?: string }): Promise<{ ok: boolean }> =>
  accessJson("/admin/swarm/access/study/record", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
