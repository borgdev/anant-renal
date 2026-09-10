/**
 * Protocol operations shell (F3) — typed client for /admin/swarm/protocols/*.
 *
 * Mirrors src/server/protocol-routes.ts + src/protocols/registry.ts. The cockpit
 * is registry-driven: adding a protocol server-side makes it appear here with no
 * page changes. Every status is derived from real realm patient state (F1).
 */

import { responseOrThrow } from "./session";

export type ProtocolStatus = "green" | "amber" | "red" | "unknown";

export interface ProtocolModelPlan {
  family: string;
  rationale: string;
  prior: string;
  targets: readonly string[];
  baseline: string;
  validationGate: string;
}

export interface ProtocolDescriptor {
  id: string;
  substate: string;
  label: string;
  domain: string;
  inputs: readonly string[];
  model: ProtocolModelPlan;
  safetyClass: "A" | "B" | "C";
  cells: readonly string[];
  workspaceKinds: readonly string[];
  routes: readonly string[];
  ui: { panel: string; route: string };
  status: "implemented" | "planned";
  requiredSignals: readonly string[];
}

export interface ProtocolSignal {
  label: string;
  value: string;
  severity: "info" | "watch" | "alert";
}

export interface ProtocolStatusReport {
  protocol: string;
  substate: string;
  label: string;
  status: ProtocolStatus;
  evaluated: number;
  counts: { green: number; amber: number; red: number; unknown: number };
  attentionPct: number;
  topDrivers: string[];
  examples: Array<{ patientId: string; realmId: string; status: ProtocolStatus; drivers: string[] }>;
}

export interface CockpitForecast {
  protocol: string;
  substate: string;
  target: string;
  unit: string;
  horizonDays: number;
  value: number;
  band: { low: number; high: number };
  threshold: number | null;
  meetsTarget: boolean | null;
}

export interface CockpitPatient {
  patientId: string;
  realmId: string;
  facilityId: string | null;
  trajectory: string | null;
  instabilityIndex: number;
  latent: number[];
  protocols: Array<{ protocol: string; substate: string; status: ProtocolStatus; severity: number; drivers: string[] }>;
  forecasts: CockpitForecast[];
}

export interface CockpitView {
  generatedAt: string;
  horizonsDays: number[];
  index: { status: ProtocolStatus; redProtocols: number; amberProtocols: number; patients: number; sessions: number };
  summary: Record<string, number>;
  protocols: ProtocolStatusReport[];
  patients: CockpitPatient[];
  patientCount: number;
}

export interface ProtocolRegistryView {
  generatedAt: string;
  count: number;
  substates: Array<{ protocol: string; substate: string; label: string; stateDims: readonly string[] }>;
  priors: Array<{ id: string; domain: string; basis: string; reference: string }>;
  protocols: ProtocolDescriptor[];
}

export interface RegressionHeadReport {
  protocol: string;
  substate: string;
  target: string;
  unit: string;
  horizonDays: number;
  trainRows: number;
  testRows: number;
  comparison: {
    n: number;
    persistence: { mae?: number; rmse?: number };
    baseline?: { mae?: number; rmse?: number };
    head: { mae?: number; rmse?: number };
    headVsBaselineImprovementPct?: number;
    headVsPersistenceImprovementPct?: number;
    winner: "head" | "baseline" | "persistence";
  };
  split: { trainPatients: number; testPatients: number };
}

export interface ClassificationHeadReport {
  protocol: string;
  substate: string;
  target: string;
  horizonDays: number;
  testRows: number;
  stateScoreMetrics: { auroc?: number; brier?: number; ece?: number; positives: number };
  baselineMetrics: { auroc?: number; brier?: number; ece?: number };
  reliability: Array<{ bin: number; lo: number; hi: number; n: number; meanPredicted: number; observedRate: number; calibrationGap: number }>;
  winner: "state" | "baseline" | "tie";
}

export interface EvaluationView {
  generatedAt: string;
  cachedAt: string;
  report: {
    generatedAt: string;
    noPatientOverlap: boolean;
    rows: { regression: number; classification: number };
    coverage: { protocols: string[]; horizonsDays: number[]; protocolHorizonPairs: number };
    summary: {
      headsBeatingPersistence: number;
      headsBeatingBaseline: number;
      totalHeads: number;
      meanHeadMae?: number;
      meanPersistenceMae?: number;
    };
    regressionHeads: RegressionHeadReport[];
    classificationHeads: ClassificationHeadReport[];
  };
}

export interface ProtocolDetailView {
  generatedAt: string;
  protocol: ProtocolDescriptor;
  report?: ProtocolStatusReport;
  summary: Record<string, number>;
  patientCount: number;
  patients: Array<{
    patientId: string;
    realmId: string;
    status: ProtocolStatus;
    severity: number;
    signals: ProtocolSignal[];
    drivers: string[];
    instabilityIndex: number;
    latent: number[];
    forecasts: CockpitForecast[];
  }>;
}

async function protocolsJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: "no-store", credentials: "same-origin", ...init });
  return responseOrThrow<T>(path, response);
}

export function fetchProtocolRegistry(): Promise<ProtocolRegistryView> {
  return protocolsJson<ProtocolRegistryView>("/admin/swarm/protocols");
}

export function fetchProtocolCockpit(): Promise<CockpitView> {
  return protocolsJson<CockpitView>("/admin/swarm/protocols/cockpit");
}

export function fetchProtocolEvaluation(): Promise<EvaluationView> {
  return protocolsJson<EvaluationView>("/admin/swarm/protocols/evaluation");
}

export function fetchProtocolDetail(id: string): Promise<ProtocolDetailView> {
  return protocolsJson<ProtocolDetailView>(`/admin/swarm/protocols/${encodeURIComponent(id)}`);
}

export const PROTOCOL_STATUS_TONE: Record<ProtocolStatus, "mint" | "amber" | "red" | "neutral"> = {
  green: "mint",
  amber: "amber",
  red: "red",
  unknown: "neutral",
};

export const SUBSTATE_LABELS: Record<string, string> = {
  SF: "Fluid / UF",
  SG: "Adequacy",
  SH: "Anemia / iron",
  SI: "CKD-MBD",
  SJ: "Nutrition / electrolytes",
  SK: "Vascular access",
  SL: "Infection",
  GLOBAL: "Global instability",
};
