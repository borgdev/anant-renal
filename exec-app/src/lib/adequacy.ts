/**
 * Dialysis adequacy protocol pack (P1) — typed client for /admin/swarm/adequacy/*.
 *
 * Mirrors src/server/adequacy-routes.ts + src/swarm/adequacy*.ts. CDSS only:
 * recommendations for nephrologist review; the platform never writes a machine
 * parameter.
 */

import { responseOrThrow } from "./session";

export interface AdequacyFeature { id: string; label: string; unit: string; min: number; max: number; relevance: number }
export type AdequacyAction = "extend-time" | "raise-qb" | "reduce-time" | "review-access" | "adherence-first" | "hold" | "blocked";

export interface AdequacyGuardResult {
  flags: string[];
  blocked: boolean;
  blockReason: string | null;
  qbEscalationAllowed: boolean;
  timeEscalationAllowed: boolean;
}

export interface AdequacyRecommendation {
  patientId: string;
  inTargetBand: boolean;
  guardrails: AdequacyGuardResult;
  latent: { l1: number; l2: number; polarRadius: number; polarAngleRad: number };
  current: { prescribedMinutes?: number; deliveredMinutes?: number; qbAvg?: number; spKtV?: number; urrPct?: number; weeklyKtV?: number };
  action: AdequacyAction;
  recommended: { minutes?: number; qb?: number; expectedSpKtV?: number; expectedUrrPct?: number; expectedIdhRisk?: number; deltaMinutes: number; deltaQb: number };
  drivers: Array<{ id: string; label: string; relevance: number }>;
  model: { id: string; version: string; kind: "reference-surrogate" | "trained" };
  synthetic: boolean;
  note: string;
  trained?: { artifactId: string; predictedUrrPct: number; priorUrrPct: number; correction: number; band: { low: number; high: number } };
}

export interface AdequacyCoverageVerdict {
  covered: boolean;
  reason: string | null;
  clearanceDensity: { observed: number; required: number; metric: string };
  manifold: { distance: number; threshold: number; inside: boolean };
  range?: { feature: string; label: string; value: number; unit: string; min: number; max: number };
}

export interface AdequacyCandidate {
  label: string;
  minutesDelta: number;
  qbDelta: number;
  prescriptionMinutes: number;
  prescriptionQb?: number;
  allowed: boolean;
  blockedReason?: string;
  expectedSpKtV?: number;
  expectedUrrPct?: number;
  weeklyKtV?: number;
  meetsBand: boolean;
  overDelivery: boolean;
  expectedIdhRisk?: number;
  score: number;
}

export interface AdequacyWhatIfResult {
  patientId: string;
  current: { minutes?: number; qb?: number; spKtV?: number; urrPct?: number; idhRisk?: number };
  blocked: boolean;
  blockReason: string | null;
  candidates: AdequacyCandidate[];
  recommended?: AdequacyCandidate;
  model: { id: string; version: string; kind: string };
  synthetic: boolean;
  note: string;
}

export interface AdequacyFeaturesView {
  features: AdequacyFeature[];
  reference: { ktvTarget: number; ktvFrequent: number; urrFloorPct: number; idwgFlagKg: number; nadirSbpFloor: number; timeStepMinutes: number; qbStepMlMin: number; maxQb: number };
  governance: { ktvBand: { min: number; max: number }; maxQb: number; coverage: Record<string, number> };
  model: { id: string; version: string; kind: string; trainedArtifact: string };
  simulator: { id: string; version: string; kind: string };
  safety: { posture: Record<string, unknown>; synthetic: boolean; machineControl: string };
}

export interface AdequacyStateView {
  generatedAt: string;
  source: string;
  patients: number;
  withClearanceData: number;
  inBandPct: number;
  kpis: { sessionsTracked: number; blockedByGuardrails: number; coverageBlocked: number };
  windows: Array<{
    patientId: string;
    __displayFacility: string | null;
    recommendation: AdequacyRecommendation;
    coverage: AdequacyCoverageVerdict;
  }>;
}

export interface AdequacyAssuranceView {
  generatedAt: string;
  model: { id: string; registered: boolean; entry: unknown; artifact: AdequacyArtifactStatus };
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

export interface AdequacyArtifactStatus {
  present: boolean;
  id?: string;
  version?: string;
  trainedAt?: string;
  rows?: number;
  patients?: number;
  mae?: number;
  mapePct?: number;
  attribution?: Array<{ feature: string; gain: number; share: number }>;
}

export interface AdequacyTwinView {
  twin: {
    patientId: string;
    asOf: string;
    sessions: Array<{ sessionId: string; startedAt: string; deliveredMinutes: number; prescribedMinutes?: number; qbAvg?: number; ufVolumeL?: number; nadirSbp?: number; telemetryPoints: number; stoppedEarly: boolean; predictedSpKtV?: number; predictedUrrPct?: number }>;
    observedUrr: Array<{ at: string; urrPct: number }>;
    summary: { sessionCount: number; avgDeliveredMinutes?: number; avgAdherencePct?: number; avgQb?: number; avgPredictedSpKtV?: number; latestObservedUrrPct?: number; inBandPct?: number };
    provenance: { source: string; sessionEvents: number; urrResults: number; attributedBy: string; synthetic: boolean };
  };
  drift: { n: number; mae?: number; mapePct?: number; bias?: number; verdict: "pass" | "watch" | "insufficient"; targetMapePct: number; note: string; rows: Array<{ at: string; observedUrrpct: number; predictedUrrPct?: number; errorPct?: number }> };
  window: Record<string, unknown>;
}

export interface AdequacyValidationView {
  generatedAt: string;
  report: {
    artifactId: string;
    artifactPresent: boolean;
    trainedAt: string | null;
    rows: number;
    patients: number;
    metrics: null | {
      head: { n: number; mae?: number; rmse?: number; mape?: number; bias?: number; correlation?: number };
      persistence: { mae?: number };
      referencePrior: { mae?: number; mape?: number };
      headVsPersistenceImprovementPct?: number;
      headVsReferenceImprovementPct?: number;
    };
    modelCard: null | Record<string, unknown>;
    criteria: Array<{ criterion: string; target: string; observed: unknown; met: boolean }>;
    acceptanceMet: boolean;
    synthetic: boolean;
    note: string;
  };
}

export interface QipTieInView {
  generatedAt: string;
  source: string;
  asOf: string;
  measure: null | { measure: string; complete: number; records: string; owner: string; state: string };
  national: Record<string, number | string>;
  note: string;
}

async function adequacyJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: "no-store", credentials: "same-origin", ...init });
  return responseOrThrow<T>(path, response);
}

export const fetchAdequacyFeatures = (): Promise<AdequacyFeaturesView> => adequacyJson<AdequacyFeaturesView>("/admin/swarm/adequacy/features");
export const fetchAdequacyState = (): Promise<AdequacyStateView> => adequacyJson<AdequacyStateView>("/admin/swarm/adequacy/state");
export const fetchAdequacyAssurance = (): Promise<AdequacyAssuranceView> => adequacyJson<AdequacyAssuranceView>("/admin/swarm/adequacy/assurance");
export const fetchAdequacyValidation = (): Promise<AdequacyValidationView> => adequacyJson<AdequacyValidationView>("/admin/swarm/adequacy/validation");
export const fetchAdequacyMdr = (): Promise<{ generatedAt: string; mdr: Record<string, unknown> }> => adequacyJson("/admin/swarm/adequacy/mdr");
export const fetchAdequacyQip = (): Promise<QipTieInView> => adequacyJson<QipTieInView>("/admin/swarm/adequacy/qip");

export const adviseAdequacy = (body: Record<string, unknown>): Promise<{ patientId: string; recommendation: AdequacyRecommendation; coverage: AdequacyCoverageVerdict; whatIf: AdequacyWhatIfResult }> =>
  adequacyJson("/admin/swarm/adequacy/advise", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const adequacyWhatIf = (body: Record<string, unknown>): Promise<{ patientId: string; result: AdequacyWhatIfResult }> =>
  adequacyJson("/admin/swarm/adequacy/what-if", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const fetchAdequacyTwin = (patientId: string): Promise<AdequacyTwinView> =>
  adequacyJson("/admin/swarm/adequacy/twin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ patientId }) });

export const runAdequacyRedTeam = (): Promise<{ passed: boolean; probes: Array<{ scenarioId: string; passed: boolean; checks: Array<{ name: string; passed: boolean; observed: string }> }>; findings: unknown[] }> =>
  adequacyJson("/admin/swarm/adequacy/red-team", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

export const snapshotAdequacyDrift = (): Promise<{ snapshot: { verdict: string; ksStatistic: number; latentShift: number; features: Array<{ feature: string; ks: number; drifted: boolean }> } }> =>
  adequacyJson("/admin/swarm/adequacy/drift", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

export const seedAdequacyDemo = (): Promise<{ opened: string[]; existing: string[]; closed: string[] }> =>
  adequacyJson("/admin/swarm/adequacy/demo", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

export const resetAdequacyDemo = (): Promise<{ removed: number }> =>
  adequacyJson("/admin/swarm/adequacy/reset", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

export const runAdequacyValidation = (): Promise<{ report: AdequacyValidationView["report"] }> =>
  adequacyJson("/admin/swarm/adequacy/validation/run", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

export const ADEQUACY_ACTION_LABEL: Record<AdequacyAction, string> = {
  "extend-time": "Extend treatment time",
  "raise-qb": "Raise blood flow (Qb)",
  "reduce-time": "Reduce treatment time",
  "review-access": "Access review before flow change",
  "adherence-first": "Adherence intervention first",
  hold: "Hold prescription",
  blocked: "Blocked",
};
