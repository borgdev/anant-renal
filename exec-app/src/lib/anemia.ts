/**
 * Anemia & ESA CDSS (P0) — typed client for /admin/swarm/anemia/*.
 *
 * Mirrors the server contracts in src/swarm/anemia.ts + src/server/anemia-routes.ts.
 * This is a CDSS: it recommends, it never orders. The dose is Class C
 * (nephrologist) human-approved before any command, and the demo lens stays
 * 'provider' (it never flips the operating lens the way the payer demo does).
 */

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
export interface EsaModelInfo { id: string; version: string; kind: "reference-surrogate" }
export interface EsaSafety { posture: string; approvalClass: string; synthetic: boolean }

export interface EsaFeaturesView {
  features: EsaFeature[];
  hgbTarget: EsaTargetBand;
  model: EsaModelInfo;
  safety: EsaSafety;
}

export type EsaDirection = "hold" | "increase" | "reduce" | "suspend" | "blocked";

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
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `anemia request failed: ${path}`);
  return payload;
}

export function fetchAnemiaFeatures(): Promise<EsaFeaturesView> {
  return anemiaJson<EsaFeaturesView>("/admin/swarm/anemia/features");
}

export function fetchAnemiaState(): Promise<AnemiaStateView> {
  return anemiaJson<AnemiaStateView>("/admin/swarm/anemia/state");
}

export function adviseEsa(window: EsaPatientWindow): Promise<{ recommendation: EsaRecommendation }> {
  return anemiaJson<{ recommendation: EsaRecommendation }>("/admin/swarm/anemia/advise", {
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
