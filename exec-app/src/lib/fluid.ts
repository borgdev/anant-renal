/**
 * Fluid / dry weight / IDH protocol pack (P2) — typed client for
 * /admin/swarm/fluid/*.
 *
 * Mirrors src/server/fluid-routes.ts + src/swarm/fluid*.ts. CDSS only: the
 * platform recommends a UF profile for nursing/nephrology review; it never
 * writes a UF rate, target weight or machine setting.
 */

import { responseOrThrow } from "./session";

export interface FluidFeature { id: string; label: string; unit: string; min: number; max: number; relevance: number }
export type FluidAction = "reduce-uf-rate" | "extend-time-for-uf" | "review-dry-weight" | "profile-temperature-sodium" | "adherence-first" | "hold" | "blocked";

export interface FluidGuardResult {
  flags: string[];
  blocked: boolean;
  blockReason: string | null;
  ufEscalationAllowed: boolean;
  ufReductionAdvised: boolean;
  ufRatePerKg?: number;
}

export interface FluidRecommendation {
  patientId: string;
  guardrails: FluidGuardResult;
  latent: { l1: number; l2: number; polarRadius: number; polarAngleRad: number };
  current: {
    ufRateMlH?: number;
    ufRatePerKg?: number;
    ufVolumeL?: number;
    deliveredMinutes?: number;
    nadirSbp?: number;
    idwgKg?: number;
    idhRiskByMinute?: Record<string, number>;
  };
  action: FluidAction;
  recommended: {
    ufRateMlH?: number;
    extraMinutes?: number;
    ufVolumeCapL?: number;
    expectedIdhRiskByMinute?: Record<string, number>;
    fluidRemovedL?: number;
  };
  drivers: Array<{ id: string; label: string; relevance: number }>;
  model: { id: string; version: string; kind: "reference-surrogate" | "trained" };
  synthetic: boolean;
  note: string;
  trained?: { artifactId: string; priorRisk60: number; headRisk60: number; ranker: "head" | "prior"; horizon: Record<string, number> };
}

export interface FluidCoverageVerdict {
  covered: boolean;
  reason: string | null;
  telemetry: { sessions: number; requiredSessions: number; points: number; requiredPoints: number };
  manifold: { distance: number; threshold: number; inside: boolean };
  range?: { feature: string; label: string; value: number; unit: string; min: number; max: number };
}

export interface FluidCandidate {
  label: string;
  ufRateMlH: number;
  ufRatePerKg: number;
  minutes: number;
  fluidRemovedL: number;
  goalAchievedPct: number;
  allowed: boolean;
  blockedReason?: string;
  idhRiskByMinute: Record<string, number>;
  peakIdhRisk: number;
  aboveRefillCeiling: boolean;
  score: number;
}

export interface FluidWhatIfResult {
  patientId: string;
  prescribed: { ufVolumeL?: number; ufRateMlH?: number; minutes: number; postWeightKg: number; idwgKg?: number };
  blocked: boolean;
  blockReason: string | null;
  horizonsMin: number[];
  candidates: FluidCandidate[];
  recommended?: FluidCandidate;
  model: { id: string; version: string; kind: string };
  synthetic: boolean;
  note: string;
}

export interface FluidWindowView {
  patientId: string;
  __displayFacility?: string | null;
  dryWeightSource?: string;
  recommendation: FluidRecommendation;
  coverage: FluidCoverageVerdict;
}

export interface FluidStateView {
  generatedAt: string;
  source: string;
  patients: number;
  withTelemetry: number;
  kpis: { sessionsTracked: number; telemetryPoints: number; hypotensionRatePct: number; blockedByGuardrails: number; coverageBlocked: number };
  windows: FluidWindowView[];
}

export interface FluidArtifactStatus {
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
    priorOnlyHeadAuroc?: number;
    positives: number;
    negatives: number;
  };
  attribution?: Array<{ feature: string; gain: number; share: number }>;
  meetsSyntheticAurocTarget: boolean;
  beatsPriorDiscrimination: boolean;
  improvesCalibration: boolean;
  ranker: "head" | "prior";
  note: string;
}

export interface FluidAssuranceView {
  generatedAt: string;
  model: { id: string; registered: boolean; artifact: FluidArtifactStatus };
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

export interface FluidTwinView {
  twin: {
    patientId: string;
    asOf: string;
    sessions: Array<{
      sessionId: string;
      startedAt: string;
      endedAt?: string;
      deliveredMinutes: number;
      prescribedMinutes?: number;
      ufVolumeL?: number;
      postWeightKg?: number;
      telemetryPoints: number;
      idhEvent: boolean;
      nadirSystolic?: number;
      maxDropMmHg?: number;
      minutesToNadir?: number;
      symptoms: string[];
      predictedRiskAtNadir?: number;
      predictedRiskByMinute?: Record<string, number>;
    }>;
    summary: { sessionCount: number; sessionsWithTelemetry: number; idhEvents: number; idhRatePct?: number; meanNadirSystolic?: number; meanUfRateMlH?: number; meanTelemetryPoints?: number };
    provenance: { source: string; telemetryEvents: number; attributedBy: string; synthetic: boolean };
  };
  drift: {
    n: number;
    events: number;
    auroc?: number;
    brier?: number;
    ece?: number;
    meanPredicted: number;
    observedRate: number;
    calibrationGap: number;
    leadTimeMinutes?: number;
    verdict: "pass" | "watch" | "insufficient";
    targetAuroc: number;
    note: string;
  };
  window: Record<string, unknown>;
}

export interface FluidValidationView {
  generatedAt: string;
  report: {
    artifactId: string;
    artifactPresent: boolean;
    trainedAt: string | null;
    rows: number;
    patients: number;
    metrics: null | {
      auroc?: number;
      brier?: number;
      ece?: number;
      priorAuroc?: number;
      priorBrier?: number;
      priorOnlyHeadAuroc?: number;
      positives: number;
      negatives: number;
    };
    reliability: null | Array<{ bin?: string; n?: number; predicted?: number; observed?: number }>;
    ranker: "head" | "prior";
    verdict: string;
    criteria: Array<{ criterion: string; target: string; observed: unknown; met: boolean }>;
    acceptanceMet: boolean;
    synthetic: boolean;
    note: string;
  };
}

export const FLUID_ACTION_LABEL: Record<FluidAction, string> = {
  "reduce-uf-rate": "Reduce UF rate",
  "extend-time-for-uf": "Extend time to keep the goal",
  "review-dry-weight": "Review target weight",
  "profile-temperature-sodium": "Cool + sodium profile",
  "adherence-first": "Adherence intervention first",
  hold: "Hold current prescription",
  blocked: "Blocked by guardrails",
};

export function fluidActionTone(action: FluidAction): "red" | "amber" | "mint" | "neutral" | "blue" {
  if (action === "blocked") return "red";
  if (action === "reduce-uf-rate" || action === "extend-time-for-uf") return "amber";
  if (action === "adherence-first") return "red";
  if (action === "review-dry-weight" || action === "profile-temperature-sodium") return "blue";
  return "mint";
}

/** Post-session IDH event tone for the twin table. */
export function idhEventTone(event: boolean): "red" | "mint" {
  return event ? "red" : "mint";
}

async function fluidJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: "no-store", credentials: "same-origin", ...init });
  return responseOrThrow<T>(path, response);
}

export const fetchFluidFeatures = (): Promise<{ features: FluidFeature[]; reference: { ufRatePerKgSafe: number; ufRatePerKgHigh: number; horizonsMin: number[]; ufRateStep: number; nadirSbpFloor: number; idwgFlagKg: number; ufAchievementFloorPct: number }; model: { id: string; version: string; kind: string; trainedArtifact: string }; simulator: { id: string; version: string; kind: string }; safety: { synthetic: boolean; machineControl: string } }> =>
  fluidJson("/admin/swarm/fluid/features");
export const fetchFluidState = (): Promise<FluidStateView> => fluidJson<FluidStateView>("/admin/swarm/fluid/state");
export const fetchFluidAssurance = (): Promise<FluidAssuranceView> => fluidJson<FluidAssuranceView>("/admin/swarm/fluid/assurance");
export const fetchFluidValidation = (): Promise<FluidValidationView> => fluidJson<FluidValidationView>("/admin/swarm/fluid/validation");
export const fetchFluidArtifact = (): Promise<{ generatedAt: string; artifact: FluidArtifactStatus }> => fluidJson("/admin/swarm/fluid/artifact");
export const fetchFluidMdr = (): Promise<{ generatedAt: string; mdr: Record<string, unknown> }> => fluidJson("/admin/swarm/fluid/mdr");
export const fetchFluidStudy = (): Promise<{ generatedAt: string; count: number; records: Array<Record<string, unknown>> }> => fluidJson("/admin/swarm/fluid/study");

export const adviseFluid = (body: Record<string, unknown>): Promise<{ patientId: string; recommendation: FluidRecommendation; coverage: FluidCoverageVerdict; whatIf: FluidWhatIfResult }> =>
  fluidJson("/admin/swarm/fluid/advise", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const fluidWhatIf = (body: Record<string, unknown>): Promise<{ patientId: string; result: FluidWhatIfResult }> =>
  fluidJson("/admin/swarm/fluid/what-if", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const fetchFluidTwin = (patientId: string): Promise<FluidTwinView> =>
  fluidJson("/admin/swarm/fluid/twin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ patientId }) });

export const runFluidRedTeam = (): Promise<{ runs: unknown[]; probes: Array<{ scenarioId: string; passed: boolean }>; passed: boolean }> =>
  fluidJson("/admin/swarm/fluid/red-team", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ranBy: "exec-ui" }) });

export const recordFluidStudy = (body: { patientId: string; action: "accept" | "modify" | "reject"; clinician?: string; note?: string }): Promise<{ ok: boolean }> =>
  fluidJson("/admin/swarm/fluid/study/record", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
