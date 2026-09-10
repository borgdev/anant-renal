// Cross-pack assurance client surface (exec console).
//
// One page for the questions no single protocol pack can answer: is every pack
// wired the same way, do the patients break down fairly, what does the alert
// volume cost, and can this set be released. Every number comes from the durable
// ledger via /admin/assurance/*; nothing is computed twice in the browser.

import { responseOrThrow } from "./session";

export type ProtocolVerdict = "ship" | "hold" | "block";
export type CheckStatus = "pass" | "warn" | "fail" | "skip";
export type SliceVerdict = "ok" | "watch" | "breach" | "insufficient";
export type BurdenVerdict = "ok" | "watch" | "breach" | "not-measurable";
export type ProtocolMode = "active" | "silent";

export interface SliceMetrics {
  dimension: string;
  slice: string;
  label: string;
  n: number;
  coveredN: number;
  flaggedN: number;
  coverageRate: number;
  flagRate: number;
  meanScore?: number;
  verdict: SliceVerdict;
  findings: string[];
}

export interface DisparityReport {
  dimension: string;
  slices: SliceMetrics[];
  pooled: { n: number; coverageRate: number; flagRate: number; meanScore?: number };
  verdict: SliceVerdict;
  findings: string[];
  insufficientSlices: string[];
  insufficient: boolean;
}

export interface FairnessReport {
  protocol: string;
  cohortN: number;
  dimensions: DisparityReport[];
  verdict: SliceVerdict;
  findings: string[];
  reference: { minSliceN: number; coverageGapTolerance: number; flagRateGapTolerance: number };
}

export interface ProtocolBurden {
  protocol: string;
  alerts: number;
  patients: number;
  alertsPerPatientWeek: number;
  actionableRate: number;
  acceptedRate: number;
  dismissedRate: number;
  duplicateRate: number;
  falsePositiveRate?: number;
  labelled: number;
  minutes: number;
  minuteShare: number;
  verdict: BurdenVerdict;
  findings: string[];
}

export interface BurdenReport {
  window: { weeks: number; from?: string; to?: string };
  patients: number;
  totals: {
    alerts: number;
    actionable: number;
    dismissed: number;
    duplicates: number;
    labelled: number;
    minutes: number;
    alertsPerPatientWeek: number;
    actionableRate: number;
    dismissedRate: number;
    duplicateRate: number;
    falsePositiveRate?: number;
    costUnits: number;
    [key: string]: number | undefined;
  };
  byProtocol: ProtocolBurden[];
  hotspots: Array<{ patientId: string; alerts: number; share: number }>;
  verdict: BurdenVerdict;
  findings: string[];
  reference: {
    windowWeeks: number;
    minutesPerAlert: number;
    minutesPerActionable: number;
    maxAlertsPerPatientWeek: number;
    maxDismissalRate: number;
  };
}

export interface LedgerEvidence {
  model: "present" | "missing" | "stale";
  modelId: string;
  redTeamRuns: number;
  redTeamScenarios: number;
  redTeamFailed: number;
  redTeamPassedScenarios: number;
  driftRecords: number;
  latestDriftAt?: string;
  latestDriftStatus?: string;
  findings: number;
  openFindings: number;
  criticalOpen: number;
  highOpen: number;
}

export interface ProtocolAssessment {
  protocol: string;
  slice: string | null;
  modelId: string;
  routes: string | null;
  mdrKind: string | null;
  verdict: ProtocolVerdict;
  mode: ProtocolMode;
  rules: number;
  ruleGaps: string[];
  artifact: { present: boolean; band: "pass" | "watch" | "insufficient"; note: string };
  ledger: LedgerEvidence;
  checks: Array<{ id: string; label: string; status: CheckStatus; detail: string }>;
  coveredPatients: number;
  flaggedPatients: number;
}

export interface AssuranceOverview {
  generatedAt: string;
  decision: ProtocolVerdict;
  reference: {
    protocols: string[];
    dimensions: string[];
    driftStaleDays: number;
    findingAttribution: string;
    rule: string;
  };
  totals: {
    protocols: number;
    ship: number;
    hold: number;
    block: number;
    rules: number;
    openFindings: number;
    criticalOpen: number;
    silentPacks: number;
    artifactPass: number;
    artifactMissing: number;
  };
  protocols: ProtocolAssessment[];
  cohort: {
    patients: number;
    protocols: number;
    alerts: number;
    coveredByProtocol: Record<string, number>;
    flaggedByProtocol: Record<string, number>;
  };
  fairness: FairnessReport & { signature: string };
  burden: BurdenReport & { signature: string };
  findings: string[];
}

export interface GateCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  protocols: string[];
}

export interface AssuranceGate {
  generatedAt: string;
  decision: ProtocolVerdict;
  summary: string;
  activeOnly: boolean;
  checks: GateCheck[];
  mdrFiles: Array<{ protocol: string; kind: string; materialised: boolean; id: string; at?: string }>;
  modes: Array<{ protocol: string; mode: ProtocolMode; since: string; reason: string; by: string }>;
  rulePacks: {
    total: number;
    unenforced: string[];
    bySource: Record<string, number>;
    byEnforcement: Record<string, number>;
    byProtocol: Record<string, { rules: number; sources: string[] }>;
  };
  fairnessVerdict: SliceVerdict;
  burdenVerdict: BurdenVerdict;
  blockers: string[];
  warnings: string[];
  protocols: Array<{ protocol: string; verdict: ProtocolVerdict; mode: ProtocolMode; blockers: string[]; warnings: string[] }>;
}

export interface ProtocolModeRecord {
  protocol: string;
  mode: ProtocolMode;
  since: string;
  reason: string;
  by: string;
  routes?: string | null;
}

export interface ModeSummary {
  total: number;
  active: string[];
  silent: string[];
  records: ProtocolModeRecord[];
}

export interface ModeProbe {
  generatedAt: string;
  protocol: string;
  patientId: string;
  mode: ProtocolModeRecord;
  probe: { active: string; silent: string; identical: boolean; surfacedWhenSilent: boolean };
  allModes: Array<{ protocol: string; mode: ProtocolMode }>;
}

export interface RuleDefinitionView {
  id: string;
  protocol: string;
  name: string;
  metric: string;
  unit: string;
  comparator: string;
  bounds: { min?: number; max?: number; value?: number };
  enforcement: string;
  implementedIn: string;
  reference: { source: string; edition: string; statement: string; url?: string };
}

export interface RulePacksView {
  generatedAt: string;
  summary: {
    total: number;
    unenforced: string[];
    bySource: Record<string, number>;
    byEnforcement: Record<string, number>;
    byProtocol: Record<string, { rules: number; sources: string[] }>;
  };
  editions: Array<{ source: string; edition: string; rules: number }>;
  protocols: Array<{ protocol: string; rules: RuleDefinitionView[]; gaps: string[] }>;
  packs: RuleDefinitionView[];
  sources: string[];
  bindings: number;
  driftCheck: string;
  packTable: Array<{ protocol: string; slice: string; modelId: string; routes: string; mdrKind: string }>;
}

export interface CrossPackAction {
  generatedAt: string;
  action: string;
  ranBy: string;
  triggered: Array<{ protocol: string; path: string; status: number; ok: boolean; detail: string }>;
  ran: number;
  failed: number;
  gate: AssuranceGate;
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin" });
  return responseOrThrow<T>(path, response);
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return responseOrThrow<T>(path, response);
}

export const assuranceApi = {
  overview: () => get<AssuranceOverview>("/admin/assurance/overview"),
  gate: (activeOnly = false) =>
    get<AssuranceGate>(`/admin/assurance/gate${activeOnly ? "?activeOnly=true" : ""}`),
  fairness: () => get<{ report: FairnessReport; signature: string; reference: FairnessReport["reference"] }>("/admin/assurance/fairness"),
  fairnessDimension: (dimension: string) =>
    get<{ dimension: DisparityReport }>(`/admin/assurance/fairness?dimension=${encodeURIComponent(dimension)}`),
  burden: (weeks?: number) =>
    get<{ report: BurdenReport; signature: string }>(`/admin/assurance/burden${weeks ? `?weeks=${weeks}` : ""}`),
  modes: () => get<{ summary: ModeSummary; modes: ProtocolModeRecord[] }>("/admin/assurance/modes"),
  setMode: (body: { protocol: string; mode: ProtocolMode; reason: string; by?: string }) =>
    post<{ record: ProtocolModeRecord; summary: ModeSummary }>("/admin/assurance/modes", body),
  probeMode: (protocol: string, patientId?: string) =>
    post<ModeProbe>("/admin/assurance/mode-probe", { protocol, ...(patientId ? { patientId } : {}) }),
  rules: (protocol?: string) =>
    get<RulePacksView>(`/admin/assurance/rules${protocol ? `?protocol=${encodeURIComponent(protocol)}` : ""}`),
  runAllRedTeams: (ranBy?: string) =>
    post<CrossPackAction>("/admin/assurance/red-team/run-all", { ...(ranBy ? { ranBy } : {}) }),
  snapshotAllDrift: (ranBy?: string) =>
    post<CrossPackAction>("/admin/assurance/drift/snapshot-all", { ...(ranBy ? { ranBy } : {}) }),
  cohortRows: () =>
    get<{ patients: number; rows: unknown[]; alerts: unknown[] }>("/admin/assurance/cohort-rows"),
};

export const VERDICT_TONE: Record<ProtocolVerdict, "mint" | "amber" | "red"> = {
  ship: "mint",
  hold: "amber",
  block: "red",
};

export const SLICE_TONE: Record<SliceVerdict, "mint" | "amber" | "red" | "neutral"> = {
  ok: "mint",
  watch: "amber",
  breach: "red",
  insufficient: "neutral",
};

export const CHECK_TONE: Record<CheckStatus, "mint" | "amber" | "red" | "neutral"> = {
  pass: "mint",
  warn: "amber",
  fail: "red",
  skip: "neutral",
};

export const ENFORCEMENT_LABEL: Record<string, string> = {
  guardrail: "Guardrail — refuses or suppresses an action",
  "coverage-gate": "Coverage gate — refuses to answer without enough data",
  authority: "Authority — bounds what the platform may ever do",
  escalation: "Escalation — routes to a human",
  surveillance: "Surveillance — observes without acting",
};

export function pct(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return "—";
  return `${Math.round(value * 1000) / 10}%`;
}

export function hours(minutes: number): string {
  const h = minutes / 60;
  return h >= 10 ? `${Math.round(h)} h` : `${Math.round(h * 10) / 10} h`;
}
