/**
 * CKD-MBD protocol pack (P4) — typed client for /admin/swarm/mbd/*.
 *
 * Mirrors src/server/mbd-routes.ts + src/swarm/mbd*.ts. CDSS only: outputs are
 * therapy PROPOSALS for the renal team. The platform never prescribes a binder,
 * a calcimimetic or vitamin D, and the KDIGO hard envelope is enforced in code.
 */

import { responseOrThrow } from "./session";

export interface MbdFeature { id: string; label: string; unit: string; min: number; max: number; relevance: number }

export interface MbdTherapy {
  binderMgPerDay: number;
  binderClass: "sevelamer" | "calcium-acetate" | "lanthanum" | "none";
  calcimimeticMgPerDay: number;
  activeVitaminDMcgPerDay: number;
}

export type MbdAction =
  | "continue"
  | "increase-binder"
  | "reduce-binder"
  | "switch-binder"
  | "start-calcimimetic"
  | "increase-calcimimetic"
  | "reduce-calcimimetic"
  | "start-vitamin-d"
  | "reduce-vitamin-d"
  | "dialysis-dose-review"
  | "adherence-coaching"
  | "safety-review"
  | "hold"
  | "blocked";

export interface MbdGuardResult {
  flags: string[];
  blocked: boolean;
  blockReason: string | null;
  escalationAllowed: boolean;
  inTarget: boolean;
}

export interface MbdPoint { phosphate: number; correctedCalcium: number; pth: number }

export interface MbdProjection {
  points: Record<string, MbdPoint>;
  risk: {
    hyperphosphatemia: Record<string, number>;
    hypercalcemia: Record<string, number>;
    hypocalcemia: Record<string, number>;
    pthOutOfRange: Record<string, number>;
  };
  safe: boolean;
  violations: string[];
}

export interface MbdRecommendation {
  patientId: string;
  guardrails: MbdGuardResult;
  latent: { l1: number; l2: number; polarRadius: number; polarAngleRad: number };
  current: {
    phosphate?: number;
    correctedCalcium?: number;
    pth?: number;
    vitaminD?: number;
    therapy: MbdTherapy;
    triplets: number;
  };
  action: MbdAction;
  projection: MbdProjection;
  inTarget: boolean;
  drivers: Array<{ id: string; label: string; relevance: number }>;
  model: { id: string; version: string; kind: "reference-surrogate" | "trained" };
  synthetic: boolean;
  note: string;
}

export interface MbdCoverageVerdict {
  covered: boolean;
  reason: string | null;
  triplets: { observed: number; required: number };
  phosphateSeries: { observed: number; required: number };
  recency: { lastTripletAt?: string; ageDays?: number; maxAgeDays: number };
  manifold: { distance: number; threshold: number; inside: boolean };
}

export interface MbdCandidate {
  label: string;
  action: string;
  therapy: MbdTherapy;
  points: Record<string, MbdPoint>;
  risk: {
    hyperphosphatemia: Record<string, number>;
    hypercalcemia: Record<string, number>;
    hypocalcemia: Record<string, number>;
    pthOutOfRange: Record<string, number>;
  };
  allowed: boolean;
  violations: string[];
  pillBurden: number;
  score: number;
}

export interface MbdWhatIfResult {
  patientId: string;
  current: { phosphate?: number; correctedCalcium?: number; pth?: number };
  inTarget: boolean;
  blocked: boolean;
  blockReason: string | null;
  horizonsDays: number[];
  candidates: MbdCandidate[];
  recommended?: MbdCandidate;
  model: { id: string; version: string; kind: string };
  synthetic: boolean;
  note: string;
}

export interface MbdCouplingRow { lever: string; phosphate: number; correctedCalcium: number; pth: number }

export interface MbdWindowView {
  patientId: string;
  __displayFacility?: string | null;
  triplets: number;
  therapy: MbdTherapy | null;
  recommendation: MbdRecommendation;
  coverage: MbdCoverageVerdict;
}

export interface MbdStateView {
  generatedAt: string;
  source: string;
  patients: number;
  withCompleteTriplet: number;
  kpis: { patientsTracked: number; inTarget: number; hyperphosphatemic: number; hypercalcemic: number; safetyReviewProposed: number; coverageBlocked: number };
  windows: MbdWindowView[];
}

export interface MbdArtifactStatus {
  present: boolean;
  id?: string;
  version?: string;
  trainedAt?: string;
  rows?: number;
  patients?: number;
  metrics?: {
    mae: { phosphate: number; correctedCalcium: number; pth: number };
    priorMae: { phosphate: number; correctedCalcium: number; pth: number };
    couplingCorrelation: number;
  };
  attribution?: Record<string, Array<{ feature: string; gain: number; share: number }>>;
  beatsPriorOnAllHeads: boolean;
  band: "pass" | "watch" | "insufficient";
  note: string;
}

export interface MbdAssuranceView {
  generatedAt: string;
  model: { id: string; registered: boolean; artifact: MbdArtifactStatus };
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

export interface MbdValidationView {
  generatedAt: string;
  report: {
    artifactId: string;
    artifactPresent: boolean;
    trainedAt: string | null;
    rows: number;
    patients: number;
    horizonDays: number;
    metrics: MbdArtifactStatus["metrics"] | null;
    band: "pass" | "watch" | "insufficient";
    verdict: string;
    criteria: Array<{ criterion: string; target: string; observed: unknown; met: boolean }>;
    acceptanceMet: boolean;
    synthetic: boolean;
    benchmarkNote: string;
    note: string;
  };
}

export interface MbdTwinView {
  twin: {
    patientId: string;
    asOf: string;
    triplets: Array<{ at: string; phosphate?: number; calcium?: number; albumin?: number; correctedCalcium?: number; pth?: number; vitaminD?: number; complete: boolean }>;
    therapy: Array<{ at: string; code: string; doseMg: number; kind: string }>;
    currentTherapy: MbdTherapy;
    summary: {
      triplets: number;
      completeTriplets: number;
      latestPhosphate?: number;
      latestCorrectedCalcium?: number;
      latestPth?: number;
      phosphateDelta30d?: number;
      calciumDelta30d?: number;
      pthDelta30d?: number;
      inTarget: boolean;
      therapySteps: number;
    };
    provenance: { source: string; labEvents: number; medEvents: number; attributedBy: string; synthetic: boolean };
  };
  drift: {
    n: number;
    steps: number;
    mae: { phosphate?: number; correctedCalcium?: number; pth?: number };
    overallMae?: number;
    bias: { phosphate?: number; correctedCalcium?: number; pth?: number };
    verdict: "pass" | "watch" | "insufficient";
    targetMaeMgDl: number;
    rows: Array<{
      at: string;
      step: string;
      observedDelta: { phosphate?: number; correctedCalcium?: number; pth?: number };
      projectedDelta: { phosphate?: number; correctedCalcium?: number; pth?: number };
      error: { phosphate?: number; correctedCalcium?: number; pth?: number };
    }>;
    note: string;
  };
  window: Record<string, unknown>;
}

export const MBD_ACTION_LABEL: Record<MbdAction, string> = {
  continue: "Continue current therapy",
  "increase-binder": "Increase phosphate binder",
  "reduce-binder": "Reduce phosphate binder",
  "switch-binder": "Switch to a non-calcium binder",
  "start-calcimimetic": "Consider a calcimimetic",
  "increase-calcimimetic": "Increase the calcimimetic",
  "reduce-calcimimetic": "Reduce the calcimimetic",
  "start-vitamin-d": "Consider active vitamin D",
  "reduce-vitamin-d": "Reduce active vitamin D",
  "dialysis-dose-review": "Review the dialysis dose",
  "adherence-coaching": "Binder adherence coaching",
  "safety-review": "Safety review",
  hold: "Hold and reassess",
  blocked: "Blocked by the KDIGO contract",
};

export function mbdActionTone(action: MbdAction): "red" | "amber" | "mint" | "neutral" | "blue" | "violet" {
  if (action === "hold" || action === "safety-review") return "red";
  if (action === "blocked") return "neutral";
  if (action === "switch-binder" || action === "start-calcimimetic" || action === "reduce-vitamin-d" || action === "reduce-binder") return "amber";
  if (action === "increase-binder" || action === "start-vitamin-d" || action === "dialysis-dose-review" || action === "adherence-coaching") return "blue";
  if (action === "continue") return "mint";
  return "violet";
}

/** Analyte → tone relative to the KDIGO target range. */
export function mbdAnalyteTone(analyte: "phosphate" | "correctedCalcium" | "pth", value: number | undefined): "mint" | "amber" | "red" | "neutral" {
  if (value === undefined) return "neutral";
  const [lo, hi] = analyte === "phosphate" ? [2.5, 5.5] : analyte === "correctedCalcium" ? [8.4, 10.2] : [130, 585];
  if (value < lo || value > hi) return "amber";
  return "mint";
}

async function mbdJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: "no-store", credentials: "same-origin", ...init });
  return responseOrThrow<T>(path, response);
}

export const fetchMbdFeatures = (): Promise<{
  features: MbdFeature[];
  reference: Record<string, unknown>;
  referenceSummary: Record<string, unknown>;
  model: { id: string; kind: string; trainedArtifact: string };
  coupling: { note: string; map: MbdCouplingRow[] };
  safety: { prescribingAuthority: string; orderAuthority: string; hardContract: Record<string, number>; referenceArchitecture: string };
}> => mbdJson("/admin/swarm/mbd/features");

export const fetchMbdState = (): Promise<MbdStateView> => mbdJson<MbdStateView>("/admin/swarm/mbd/state");
export const fetchMbdCoupling = (): Promise<{ generatedAt: string; map: MbdCouplingRow[]; responseFractions: Record<string, number>; note: string }> => mbdJson("/admin/swarm/mbd/coupling");
export const fetchMbdArtifact = (): Promise<{ generatedAt: string; artifact: MbdArtifactStatus }> => mbdJson("/admin/swarm/mbd/artifact");
export const fetchMbdAssurance = (): Promise<MbdAssuranceView> => mbdJson<MbdAssuranceView>("/admin/swarm/mbd/assurance");
export const fetchMbdValidation = (): Promise<MbdValidationView> => mbdJson<MbdValidationView>("/admin/swarm/mbd/validation");
export const fetchMbdMdr = (): Promise<{ generatedAt: string; mdr: Record<string, unknown> }> => mbdJson("/admin/swarm/mbd/mdr");

export const adviseMbd = (body: Record<string, unknown>): Promise<{
  patientId: string;
  recommendation: MbdRecommendation;
  coverage: MbdCoverageVerdict;
  guardrails: MbdGuardResult;
  coupling: MbdCouplingRow[];
  trained?: { artifactId: string; point: MbdPoint; priorPoint: MbdPoint; ranker: string };
}> => mbdJson("/admin/swarm/mbd/advise", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const mbdWhatIf = (body: Record<string, unknown>): Promise<{
  patientId: string;
  result: MbdWhatIfResult;
  coupling: MbdCouplingRow[];
  contract: { envelope: Record<string, number>; recommendedViolations: string[]; refused: Array<{ label: string; violations: string[] }> };
}> => mbdJson("/admin/swarm/mbd/what-if", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const fetchMbdTwin = (patientId: string): Promise<MbdTwinView> =>
  mbdJson("/admin/swarm/mbd/twin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ patientId }) });

export const runMbdRedTeam = (): Promise<{ passed: boolean; probes: Array<{ scenarioId: string; passed: boolean }> }> =>
  mbdJson("/admin/swarm/mbd/red-team", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ranBy: "exec-ui" }) });

export const snapshotMbdDrift = (): Promise<{ snapshot: { verdict: string; ksStatistic: number; latentShift: number; metric: string } }> =>
  mbdJson("/admin/swarm/mbd/drift", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

export const seedMbdDemo = (): Promise<{ opened: string[]; existing: string[]; closed: string[] }> =>
  mbdJson("/admin/swarm/mbd/demo", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

export const resetMbdDemo = (): Promise<{ removed: number }> =>
  mbdJson("/admin/swarm/mbd/reset", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

export const recordMbdStudy = (body: { patientId: string; action: "accept" | "modify" | "reject"; clinician?: string }): Promise<{ ok: boolean }> =>
  mbdJson("/admin/swarm/mbd/study/record", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
