/**
 * Harness adapter — re-points the prototype's runtime + control-plane clients at
 * the healthcare-harness backend (`/admin/swarm/*`). The harness remains the
 * single source of truth (Postgres); this module maps its live response shapes
 * into the RuntimeSnapshot / AgentOperationsSnapshot contracts the executive
 * components render, and fills demo-only fields from the reference portfolio.
 */

import type { AgentCategory, AgentOperationsSnapshot, AgentView } from "./contracts";
import type { NavigationId } from "./types";
import type { WorkflowDetail } from "./workflow-detail";
import { demoContext } from "./catalogs";
import { responseOrThrow } from "./session";

/* ---------- harness wire shapes (from src/swarm) ---------- */

export type ApprovalClass = "A" | "B" | "C" | "D";

export interface HarnessCell {
  id: string;
  version: string;
  displayName: string;
  domain: string;
  owner: string;
  consumes: string[];
  produces: string[];
  allowedActions: string[];
  approvalClass: ApprovalClass;
  evalGate: number;
  killSwitch: boolean;
  rollback?: string;
  observerRef?: string;
}

export interface HarnessInsight {
  insightId: string;
  kind: string;
  headline: string;
  summary: string;
  subject: string;
  scopeType: string;
  cells: string[];
  consensus: number;
  conflicts: string[];
  abstentions: string[];
  evidenceCount: number;
  review: string;
  approvalClass: string;
  retained: boolean;
  belief?: number;
  plausibility?: number;
  uncertainty?: number;
  conflictMass?: number;
  avgReliability?: number;
  evidenceFusion?: {
    sources: { cellId: string; option: string; weight: number; alpha: number }[];
    massVector: Record<string, number>;
    conflictMass: number;
    belief: number;
    plausibility: number;
  };
  producedAt: string;
  payload?: Record<string, unknown>;
}

export interface HarnessNba {
  nbaId: string;
  rank: number;
  title: string;
  cells: string[];
  scopeType: string;
  subject: string;
  owner: string;
  due: string;
  consensus: number;
  approvalClass: string;
  expectedOutcome: number;
  urgency: number;
  policyCost: number;
  risk: number;
  evidenceCount: number;
  score: number;
  status: string;
  rankedAt: string;
  /** Dempster–Shafer belief interval of the source insight (server-computed). */
  belief?: number;
  plausibility?: number;
  conflictMass?: number;
}

export interface HarnessEpisode {
  episodeId: string;
  state: string;
  kind: string;
  subject: string;
  scopeType: string;
  [key: string]: unknown;
}

export interface HarnessKpis {
  treatmentsProtected: number;
  capacityHours: number;
  cmsReadiness: number;
  valueAtRisk: number;
  consensus: Record<string, number>;
}

export interface HarnessDemoState {
  cells: HarnessCell[];
  insights: HarnessInsight[];
  nbas: HarnessNba[];
  conflictCount: number;
  episodes: HarnessEpisode[];
  kpis: HarnessKpis;
}

/* ---------- workspace wire shapes (from src/swarm/workspace) ---------- */

export type HarnessConfigRelease = {
  id: string;
  version: string;
  status: string;
  changeSummary: string;
  contentHash: string;
  objectCount: number;
  createdBy: string;
  createdAt: string;
  validatedAt?: string | null;
  activatedAt?: string | null;
  checks?: Array<{ name: string; passed: boolean; observed: string }>;
};

export type HarnessRedTeamRun = { evidenceHash: string; passed: boolean; checks: Array<{ name: string; passed: boolean; observed: string }> };

export type HarnessSimulation = {
  feasible: boolean;
  checks: Array<{ id: string; label: string; passed: boolean; evidenceEventIds: string[]; detail?: string }>;
  runtimeEffect: boolean;
  configuration: string;
};

export type HarnessSubmission = { id: string; status: string; manifestHash: string; liveTransmission: boolean; resultsIncluded: number };

export type HarnessReview = { id: string; status: string; entityId?: string; entityType?: string; requestedBy?: string; reason?: string; reviewer?: string; reviewedAt?: string; createdAt?: string };

export type HarnessNote = { id: string; nodeId: string; title: string; content: string; version: number; createdBy: string; comments: Array<{ body: string; by: string; at: string }>; createdAt: string };

export type HarnessTenant = { tenantId: string; environmentId: string; displayName: string; environmentName: string; deploymentMode: string; timeZone: string; dataRegion: string; status: string; persisted: boolean };

export type HarnessKafka = { bridgeUrl: string; clusterAlias: string; securityProtocol: string; secretRef: string; consumerGroup: string; topicMappings: Array<{ direction: string; topic: string; contract: string }>; status: string; lastTestedAt?: string | null; testMode?: string; testSummary?: string };

export type HarnessPolicy = { version: string; defaultDecision: string; escalationThresholdBasisPoints: number; minThresholdBasisPoints: number; maxThresholdBasisPoints: number; externalWritesEnabled: boolean };

/* ---------- runtime snapshot contract (ported) ---------- */

export type RuntimeEventRow = {
  eventId: string;
  eventType: string;
  subjectType: string;
  subjectId: string;
  patientId?: string;
  sourceSystem: string;
  recordedTime: string;
  correlationId: string | null;
  traceId: string;
  status: string;
  payload: Record<string, unknown>;
};

export type RuntimeActionRow = {
  actionId: string;
  episodeId: string | null;
  rank: number;
  title: string;
  outcome: string;
  scopeId: string;
  ownerRole: string;
  dueAt: string;
  valueLabel: string;
  confidenceBasisPoints: number;
  actionClass: "A" | "B" | "C" | "D";
  evidenceCount: number;
  agentIds: string[];
  audience: string[];
  status: string;
  /** Dempster–Shafer belief interval of the source insight (server-computed). */
  belief?: number;
  plausibility?: number;
  conflictMass?: number;
};

export type RuntimeInsightRow = {
  insightId: string;
  title: string;
  summary: string;
  scopeId: string;
  confidenceBasisPoints: number;
  state: string;
  agentIds: string[];
  conflicts: string[];
  /** Dempster–Shafer belief interval + conflict mass (server-computed). */
  belief?: number;
  plausibility?: number;
  uncertainty?: number;
  conflictMass?: number;
  /** P3 — mean reliability discount applied to the cells' evidence. */
  avgReliability?: number;
  /** P4 — decomposable evidence fusion (per-source masses + mass vector). */
  evidenceFusion?: {
    sources: { cellId: string; option: string; weight: number; alpha: number }[];
    massVector: Record<string, number>;
    conflictMass: number;
    belief: number;
    plausibility: number;
  };
};

export type RuntimeSnapshot = {
  runtime: { status: "active" | "empty"; tenantId: string; configuration: string; policyVersion: string; source: string; eventTransport: string; externalWritesEnabled: boolean; replayEventsAvailable: number };
  counts: { events: number; evidence: number; evidenceReviews: number; temporalStates: number; topologyNodes: number; topologyEdges: number; executions: number; proposals: number; insights: number; actions: number; commands: number; acknowledgements: number; measures: number; auditEvents: number };
  health: { completedExecutions: number; failedExecutions: number; abstentions: number; averageLatencyMs: number; totalCostMicrounits: number; conflicts: number; pendingOutbox: number; failedOutbox: number };
  events: RuntimeEventRow[];
  evidence: Array<{ evidenceId: string; evidenceType: string; sourceEventId: string; subjectId: string; exactText: string | null; confidenceBasisPoints: number; validFrom: string; recordedAt: string; contentHash: string; structured: Record<string, unknown> }>;
  evidenceReviews: Array<{ reviewId: string; evidenceId: string; decision: string; reviewer: string; reviewerRole: string; contentHash: string; createdAt: string }>;
  temporalStates: Array<Record<string, unknown>>;
  topology: { nodes: Array<{ id: string; label: string; type: string; x: number; y: number; z: number; attributes: Record<string, unknown> }>; edges: Array<{ id: string; source: string; target: string; relation: string; confidence: number; provenance: Record<string, unknown> }> };
  episodes: Array<{ episodeId: string; status?: string; confidenceBasisPoints?: number; [key: string]: unknown }>;
  executions: Array<{ executionId: string; agentId: string; status: string; latencyMs: number; confidenceBasisPoints: number | null; costMicrounits: number; traceId: string }>;
  proposals: Array<Record<string, unknown>>;
  insights: RuntimeInsightRow[];
  actions: RuntimeActionRow[];
  policies: Array<Record<string, unknown>>;
  commands: Array<{ commandId: string; actionId: string; status: string; commandType: string; payload: Record<string, unknown> }>;
  acknowledgements: Array<Record<string, unknown>>;
  outbox: Array<{ outboxId: string; topic: string; status: string; attempts: number; envelope: Record<string, unknown> }>;
  traces: Array<{ spanId: string; traceId: string; name: string; system: string; status: string; durationMs: number; attributes: Record<string, unknown> }>;
  measures: Array<Record<string, unknown>>;
  submissionPackages: Array<Record<string, unknown>>;
  models: Array<{ registryId: string; modelId: string; modelVersion: string; status: string; evaluationScoreBasisPoints: number; costMicrounitsPerCall: number; killSwitch: boolean }>;
  drift: Array<{ driftId: string; targetId: string; metric: string; valueBasisPoints: number; thresholdBasisPoints: number; status: string }>;
  incidents: Array<{ incidentId: string; severity: number; status: string; summary: string }>;
  authoritySnapshots: Array<Record<string, unknown>>;
  audits: Array<Record<string, unknown>>;
  rollups: OutcomeRollups | null;
  nbaDecisions: NbaDecisionRow[];
};

export type PolicySimulation = {
  thresholdBasisPoints: number;
  eventsReplayed: number;
  episodesSurfaced: number;
  treatmentsProtected: number;
  humanReviews: number;
  estimatedValueDollars: number;
  blockedActions: number;
  conflicts: number;
  policyVersion: string;
};

/** Real enterprise outcome rollups computed server-side from the live swarm. */
export type OutcomeRollup = { label: string; value: number; unit: string; detail: string; source: string };

export type OutcomeRollups = {
  clinical: OutcomeRollup;
  operational: OutcomeRollup;
  regulatory: OutcomeRollup;
  economic: OutcomeRollup;
  treatmentsProtected: number;
  capacityHours: number;
  cmsReadiness: number;
  valueAtRisk: number;
  generatedAt: string;
};

export type NbaDecisionRow = {
  nbaId: string;
  title: string;
  subject: string;
  scopeType: string;
  decision: "approved" | "dismissed";
  approver: string;
  evidenceCount: number;
  expectedOutcome: number;
  episodeId?: string;
  createdAt: string;
  updatedAt: string;
};

/* ---------- harness fetch helpers ---------- */

async function harnessJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: "no-store", credentials: "same-origin", ...init });
  return responseOrThrow<T>(path, response);
}

/** DST-Q #2 — multi-signal early-warning watch (per-patient Bel/Pl/K readout). */
export type EwPosture = "corroborated" | "weak" | "contested" | "reassured";
export interface EarlyWarningSignalView { kind: string; label: string; polarity: "deteriorating" | "stable"; weight: number; alpha: number }
export interface EarlyWarningReadout {
  patientId: string;
  facilityId: string | null;
  belief: number;
  plausibility: number;
  uncertainty: number;
  conflictMass: number;
  posture: EwPosture;
  alert: boolean;
  score: number;
  signalCount: number;
  signals: EarlyWarningSignalView[];
}
export interface EarlyWarningView {
  asOf: string;
  gates: { alertBelief: number; watchBelief: number; contestedK: number };
  cohort: EarlyWarningReadout[];
  signalCount: number;
}

/** Fetch the fused early-warning cohort (vitals + labs + missed-Tx + ESA). */
export async function fetchEarlyWarning(): Promise<EarlyWarningView> {
  return harnessJson<EarlyWarningView>("/admin/swarm/early-warning");
}

export interface HarnessPatient {
  realmId: string;
  id: string;
  urn: string;
  state: {
    admitted?: boolean;
    facilityId?: string;
    unitId?: string;
    age?: number;
    sex?: string;
    trajectory?: string;
    admittedAt?: string;
    problemList?: string[];
    lastVitals?: { hr?: number; bp?: string; spo2?: number; at?: string };
    labs?: { K?: number; HGB?: number; URR?: number; PHOS?: number };
    risk?: number;
    lastAssessment?: { id?: string; score?: number; band?: string; at?: string };
  };
}

/* ---------- Patient / Member intelligence (lightweight ledger) ---------- */

/** One patient's recent realm events (newest-first, small JSON) — the Patient
 *  intelligence page uses this instead of the full global runtime substrate. */
export async function fetchPatientEvents(patientId: string, limit = 120): Promise<{ patientId: string; total: number; events: RuntimeEventRow[] }> {
  return harnessJson<{ patientId: string; total: number; events: RuntimeEventRow[] }>(`/admin/swarm/patients/${encodeURIComponent(patientId)}/events?limit=${limit}`);
}

/** Fetch every patient across live realms — backs the Patient Intelligence selector. */
export async function fetchPatients(): Promise<HarnessPatient[]> {
  try {
    const realms = await harnessJson<{ realms: Array<{ id: string; counts: Record<string, number> }> }>("/admin/realms");
    const populated = (realms.realms ?? []).filter((realm) => (realm.counts?.patient ?? 0) > 0);
    const lists = await Promise.all(
      populated.map(async (realm) => {
        try {
          const res = await harnessJson<{ patients: Array<{ id: string; urn: string; state: Record<string, unknown> }> }>(
            `/admin/realms/${encodeURIComponent(realm.id)}/patients`,
          );
          return (res.patients ?? []).map((p) => ({ realmId: realm.id, id: p.id, urn: p.urn, state: p.state as HarnessPatient["state"] }));
        } catch {
          return [];
        }
      }),
    );
    return lists.flat();
  } catch {
    return [];
  }
}

async function demoState(): Promise<HarnessDemoState> {
  // Read-only live snapshot (no reseeding side effect). NBA status is already
  // overlaid with the durable decision ledger by the server.
  const payload = await harnessJson<HarnessDemoState>("/admin/swarm/state");
  return payload as HarnessDemoState;
}

function valueLabel(nba: HarnessNba): string {
  const dollars = Math.round(nba.expectedOutcome * 1000);
  return `$${dollars >= 1000 ? `${Math.round(dollars / 1000)}K` : dollars.toLocaleString()}`;
}

function statusOf(nba: HarnessNba): string {
  if (nba.status === "executed") return "completed";
  if (nba.status === "dismissed") return "dismissed";
  return nba.status === "awaiting-approval" ? "review" : "queued";
}

/* ---------- R2/R3 — regional operations (census + region D-S watch) ---------- */

export interface RegionCensus {
  regionId: string;
  label: string;
  realms: number;
  units: number;
  patients: number;
  liveEffects: number;
  presences: number;
}
export interface RegionDeterioration {
  regionId: string;
  label: string;
  patients: number;
  alerts: number;
  contested: number;
  watch: number;
  reassured: number;
  maxBelief: number | null;
}
export interface RegionOpsView {
  asOf: string;
  census: RegionCensus[];
  deterioration: RegionDeterioration[];
  enterprise: { patients: number; alerts: number; contested: number; watch: number; reassured: number; maxBelief: number | null };
}

/** Fetch the regional operations board (census + region-level D-S watch). */
export async function fetchRegionOps(): Promise<RegionOpsView> {
  return harnessJson<RegionOpsView>("/admin/region-ops");
}

export interface RegionAssignmentResult {
  ok: boolean;
  assigned: number;
  assignments: Array<{ regionId: string; label: string; facilityIds: string[] }>;
}

/** Auto-assign master-data facilities to operating-model region nodes. */
export async function autofillRegionAssignments(): Promise<RegionAssignmentResult> {
  return harnessJson<RegionAssignmentResult>("/admin/ontology/regions/autofill", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

/* ---------- Simulator driver (start / stop / step the fleet) ---------- */

export type SimulatorRunState = "idle" | "running" | "paused";
export interface SimulatorStatusView {
  status: SimulatorRunState;
  scenario: string | null;
  scenarioLabel: string | null;
  pace: { realmHoursPerTick: number; wallMsPerTick: number } | null;
  tickCount: number;
  eventCount: number;
  startedAt: string | null;
  totals: { realms: number; patients: number; presences: number; effects: number };
}
export interface SimScenarioMeta { id: string; label: string; description: string; seed: number; realms: number }

export async function fetchSimulatorStatus(): Promise<SimulatorStatusView> {
  try {
    const res = await harnessJson<{ simulator: SimulatorStatusView }>("/admin/simulator/status");
    return res.simulator;
  } catch {
    return { status: "idle", scenario: null, scenarioLabel: null, pace: null, tickCount: 0, eventCount: 0, startedAt: null, totals: { realms: 0, patients: 0, presences: 0, effects: 0 } };
  }
}
export async function fetchSimulatorScenarios(): Promise<SimScenarioMeta[]> {
  try {
    const res = await harnessJson<{ scenarios: SimScenarioMeta[] }>("/admin/simulator/scenarios");
    return res.scenarios ?? [];
  } catch {
    return [];
  }
}

export async function startSimulator(scenario: string, opts: { autoRun?: boolean; wallMsPerTick?: number } = {}): Promise<SimulatorStatusView> {
  const res = await harnessJson<{ simulator: SimulatorStatusView }>("/admin/simulator/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenario, ...(opts.autoRun !== undefined ? { autoRun: opts.autoRun } : {}), ...(opts.wallMsPerTick ? { wallMsPerTick: opts.wallMsPerTick } : {}) }),
  });
  return res.simulator;
}
export async function pauseSimulator(): Promise<SimulatorStatusView> {
  const res = await harnessJson<{ simulator: SimulatorStatusView }>("/admin/simulator/pause", { method: "POST" });
  return res.simulator;
}
export async function resumeSimulator(): Promise<SimulatorStatusView> {
  const res = await harnessJson<{ simulator: SimulatorStatusView }>("/admin/simulator/resume", { method: "POST" });
  return res.simulator;
}
export async function stopSimulator(): Promise<{ ok: boolean }> {
  return harnessJson<{ ok: boolean }>("/admin/simulator/reset", { method: "POST" });
}

/* ---------- R0 — broker-fed live event wall ---------- */

export interface LiveEventRow {
  eventId: string;
  eventType: string;
  subjectId?: string;
  subjectType?: string;
  patientId?: string;
  realmId?: string;
  facilityId?: string;
  sourceSystem: string;
  recordedTime: string;
  traceId: string;
  status: string;
  payload?: Record<string, unknown>;
}
export interface LiveFeedView {
  driver: string;
  topic: string;
  retained: number;
  events: LiveEventRow[];
}

/** Fetch the bounded broker-fed live tail (/api/live/events). */
export async function fetchLiveEvents(): Promise<LiveFeedView> {
  try {
    return await harnessJson<LiveFeedView>("/api/live/events");
  } catch {
    // Feed not wired (e.g. an app instance without a live feed) — empty is the
    // signal to fall back to the runtime replay feed.
    return { driver: "", topic: "", retained: 0, events: [] };
  }
}

/** Live wall subscription — polls /api/live/events; empty driver = unavailable. */
export function startLiveFeed(
  onView: (view: LiveFeedView) => void,
  opts: { intervalMs?: number } = {},
): () => void {
  let stop = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const poll = async () => {
    if (stop) return;
    const view = await fetchLiveEvents();
    if (!stop) onView(view);
  };
  void poll();
  timer = setInterval(() => void poll(), opts.intervalMs ?? 3000);
  return () => { stop = true; if (timer) clearInterval(timer); };
}

/* ---------- demo → RuntimeSnapshot mapping ---------- */

function sha256ish(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  const toHex = (v: number) => (v >>> 0).toString(16).padStart(8, "0");
  return (toHex(h1) + toHex(h2)).repeat(4).slice(0, 64);
}

/* ---------- executive substrate (real backend enrichment) ---------- */

type Substrate = {
  events: RuntimeEventRow[];
  temporalStates: number;
  evidence: RuntimeSnapshot["evidence"];
  reviews: HarnessReview[];
  traces: RuntimeSnapshot["traces"];
  models: RuntimeSnapshot["models"];
  drift: RuntimeSnapshot["drift"];
  authoritySnapshots: Array<Record<string, unknown>>;
  audits: Array<Record<string, unknown>>;
  topology: RuntimeSnapshot["topology"];
  rollups: OutcomeRollups | null;
  nbaDecisions: NbaDecisionRow[];
};

async function fetchSubstrate(): Promise<Substrate> {
  const [eventsRes, evidenceRes, reviewsRes, tracesRes, modelsRes, driftRes, authorityRes, auditsRes, topologyRes, rollupsRes, nbaDecisionsRes] = await Promise.all([
    // Cap the projected ledger feed — the full realm ledger is tens of thousands of
    // events (20MB+ JSON). The server distributes the cap across realms so every
    // patient's ledger stays represented; 1500 keeps each patient's latest ~50 rows.
    harnessJson<{ events: RuntimeEventRow[]; temporalStates: number }>("/admin/swarm/events?limit=1500"),
    harnessJson<{ evidence: RuntimeSnapshot["evidence"] }>("/admin/swarm/evidence"),
    harnessJson<{ reviews: HarnessReview[] }>("/admin/swarm/reviews"),
    harnessJson<{ traces: RuntimeSnapshot["traces"] }>("/admin/swarm/traces"),
    harnessJson<{ models: RuntimeSnapshot["models"] }>("/admin/swarm/models"),
    harnessJson<{ drift: RuntimeSnapshot["drift"] }>("/admin/swarm/drift"),
    harnessJson<{ sources: Array<Record<string, unknown>> }>("/admin/swarm/authority"),
    harnessJson<{ audits: Array<Record<string, unknown>> }>("/admin/swarm/audits"),
    harnessJson<{ nodes: RuntimeSnapshot["topology"]["nodes"]; edges: RuntimeSnapshot["topology"]["edges"] }>("/admin/swarm/topology"),
    harnessJson<OutcomeRollups>("/admin/swarm/rollups").catch(() => null),
    harnessJson<{ decisions: NbaDecisionRow[] }>("/admin/swarm/nba/decisions").catch(() => ({ decisions: [] })),
  ]);
  return {
    events: eventsRes.events,
    temporalStates: eventsRes.temporalStates,
    evidence: evidenceRes.evidence.map((e) => ({ ...e, exactText: e.exactText ?? null, structured: e.structured ?? {} })),
    reviews: reviewsRes.reviews,
    traces: tracesRes.traces,
    models: modelsRes.models,
    drift: driftRes.drift,
    authoritySnapshots: authorityRes.sources,
    audits: auditsRes.audits,
    topology: {
      nodes: topologyRes.nodes,
      edges: topologyRes.edges.map((e) => ({ ...e, id: e.id ?? `${e.source}->${e.target}`, provenance: e.provenance ?? {} })),
    },
    rollups: rollupsRes,
    nbaDecisions: nbaDecisionsRes.decisions,
  };
}

export type CmsMeasureReadiness = { measure: string; complete: number; records: string; owner: string; state: string };
export type CmsReadiness = {
  asOf: string;
  source: "real" | "reference";
  measures: CmsMeasureReadiness[];
  totals: { facilities: number; scoredByMeasure: Record<string, number> };
  national: Record<string, number | string>;
};

/** Real CMS QIP readiness — server-parsed from the public CMS CSVs (cms-data/). */
export async function fetchCmsReadiness(): Promise<CmsReadiness | null> {
  return harnessJson<{ readiness: CmsReadiness }>("/admin/cms/readiness")
    .then((r) => r.readiness)
    .catch(() => null);
}

function mapSnapshot(demo: HarnessDemoState, substrate: Substrate): RuntimeSnapshot {
  const resolved = demo.episodes.filter((e) => e.state === "Resolved" || e.state === "Verifying" || e.state === "Coordinating");
  const evidenceReviews = substrate.reviews
    .filter((r) => r.status === "confirmed" || r.status === "rejected")
    .map((r) => ({
      reviewId: r.id,
      evidenceId: r.entityId ?? "evidence",
      decision: r.status,
      reviewer: r.reviewer ?? "reviewer",
      reviewerRole: "fa",
      contentHash: sha256ish(r.id),
      createdAt: r.reviewedAt ?? r.createdAt ?? new Date().toISOString(),
    }));
  const actions: RuntimeActionRow[] = demo.nbas.map((nba) => ({
    actionId: nba.nbaId,
    episodeId: null,
    rank: nba.rank,
    title: nba.title,
    outcome: nba.subject,
    scopeId: nba.scopeType,
    ownerRole: nba.owner.toLowerCase().replaceAll(" ", "-"),
    dueAt: new Date(Date.now() + (nba.due.includes("hour") ? 120 : nba.due.includes("Today") ? 6 : nba.due.includes("week") ? 168 : 48) * 3600000).toISOString(),
    valueLabel: valueLabel(nba),
    confidenceBasisPoints: Math.round(nba.consensus * 10000),
    actionClass: nba.approvalClass as "A" | "B" | "C" | "D",
    evidenceCount: nba.evidenceCount,
    agentIds: nba.cells,
    audience: [nba.owner.toLowerCase().replaceAll(" ", "-"), "evp", "dvp"],
    status: statusOf(nba),
    belief: nba.belief,
    plausibility: nba.plausibility,
    conflictMass: nba.conflictMass,
  }));
  const insights: RuntimeInsightRow[] = demo.insights.map((i) => ({
    insightId: i.insightId,
    title: i.headline,
    summary: i.summary,
    scopeId: i.scopeType,
    confidenceBasisPoints: Math.round(i.consensus * 10000),
    state: i.retained ? "retained" : "accepted",
    agentIds: i.cells,
    conflicts: i.conflicts,
    belief: i.belief,
    plausibility: i.plausibility,
    uncertainty: i.uncertainty,
    conflictMass: i.conflictMass,
    avgReliability: i.avgReliability,
    evidenceFusion: i.evidenceFusion,
  }));
  const commands = resolved.map((e, index) => ({
    commandId: `cmd-${e.episodeId}`,
    actionId: `nba-${index + 1}`,
    status: e.state === "Resolved" ? "acknowledged" : "emitted",
    commandType: "schedule-followup",
    payload: { episode: e.episodeId },
  }));
  const executions = demo.cells.map((cell, index) => ({
    executionId: `exec-${cell.id}`,
    agentId: cell.id,
    status: "completed" as const,
    latencyMs: 40 + ((index * 13) % 60),
    confidenceBasisPoints: Math.round(cell.evalGate * 10000),
    costMicrounits: 60 + ((index * 9) % 40),
    traceId: `trace-${index + 1}`,
  }));
  const traces = substrate.traces;
  const avgLatencyMs = traces.length ? Math.round(traces.reduce((sum, t) => sum + t.durationMs, 0) / traces.length) : 64;
  const totalCostMicrounits = substrate.models.reduce((sum, m) => sum + m.costMicrounitsPerCall, 0) * Math.max(demo.cells.length, 1);
  return {
    runtime: {
      status: "active",
      tenantId: "realm:dialysis-1",
      configuration: "reference-portfolio@2026.1.0",
      policyVersion: "policy-4.2",
      source: "healthcare-harness",
      eventTransport: "postgres-outbox",
      externalWritesEnabled: false,
      replayEventsAvailable: 11,
    },
    counts: {
      // True persisted-event total (substrate.temporalStates is unaffected by the
      // feed cap); `events` below is the capped slice for rendering.
      events: substrate.temporalStates,
      evidence: substrate.evidence.length,
      evidenceReviews: evidenceReviews.length,
      temporalStates: substrate.temporalStates,
      topologyNodes: substrate.topology.nodes.length,
      topologyEdges: substrate.topology.edges.length,
      executions: demo.cells.length,
      proposals: demo.insights.length + demo.nbas.length,
      insights: demo.insights.length,
      actions: demo.nbas.length,
      commands: commands.length,
      acknowledgements: resolved.length,
      measures: resolved.length,
      auditEvents: substrate.audits.length,
    },
    health: {
      completedExecutions: demo.cells.length,
      failedExecutions: 0,
      abstentions: demo.insights.reduce((sum, i) => sum + i.abstentions.length, 0),
      averageLatencyMs: avgLatencyMs,
      totalCostMicrounits: totalCostMicrounits,
      conflicts: demo.conflictCount,
      pendingOutbox: 0,
      failedOutbox: 0,
    },
    events: substrate.events,
    evidence: substrate.evidence,
    evidenceReviews,
    temporalStates: [],
    topology: substrate.topology,
    episodes: demo.episodes as RuntimeSnapshot["episodes"],
    executions,
    proposals: [],
    insights,
    actions,
    policies: [],
    commands,
    acknowledgements: resolved.map((e) => ({ episodeId: e.episodeId, state: "verified" })),
    outbox: [],
    traces,
    measures: resolved.map((e) => ({ episodeId: e.episodeId, measureId: "ecqm:M21Basic/1.0.0", met: true })),
    submissionPackages: [],
    models: substrate.models,
    drift: substrate.drift,
    incidents: [],
    authoritySnapshots: substrate.authoritySnapshots,
    audits: substrate.audits,
    rollups: substrate.rollups,
    nbaDecisions: substrate.nbaDecisions,
  };
}

/* ---------- runtime client (re-pointed) ---------- */

export async function fetchRuntimeSnapshot(): Promise<RuntimeSnapshot> {
  return mapSnapshot(await demoState(), await fetchSubstrate());
}

export async function ensureRuntime(_roleId?: string): Promise<RuntimeSnapshot> {
  return fetchRuntimeSnapshot();
}

/**
 * Live runtime subscription — fetches the runtime snapshot immediately, then
 * re-fetches on a fixed interval so the console reflects a running simulator in
 * near-realtime. Errors are reported via `onError(error | null)` (null clears a
 * previous error on recovery). Returns an unsubscribe fn. Each mount polls only
 * while its page is mounted (the shell renders one module at a time).
 */
export function startLiveRuntime(
  onSnapshot: (snapshot: RuntimeSnapshot) => void,
  opts: { roleId?: string; intervalMs?: number; live?: boolean; onError?: (error: Error | null) => void } = {},
): () => void {
  let stop = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const poll = async () => {
    if (stop) return;
    try {
      const snapshot = await fetchRuntimeSnapshot();
      if (stop) return;
      onSnapshot(snapshot);
      opts.onError?.(null);
    } catch (error) {
      if (stop) return;
      opts.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  };
  void poll();
  if (opts.live ?? true) {
    timer = setInterval(() => void poll(), opts.intervalMs ?? 4000);
  }
  return () => { stop = true; if (timer) clearInterval(timer); };
}

/** Live patient list subscription (new sim patients appear without a reload). */
export function startLivePatients(
  onPatients: (patients: HarnessPatient[]) => void,
  opts: { intervalMs?: number; live?: boolean } = {},
): () => void {
  let stop = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const poll = async () => {
    if (stop) return;
    const list = await fetchPatients();
    if (!stop) onPatients(list);
  };
  void poll();
  if (opts.live ?? true) {
    timer = setInterval(() => void poll(), opts.intervalMs ?? 8000);
  }
  return () => { stop = true; if (timer) clearInterval(timer); };
}

export async function mutateRuntime<T>(action: string, roleId: string, body: Record<string, unknown> = {}): Promise<T> {
  if (action === "simulate") {
    const thresholdBasisPoints = Number(body.thresholdBasisPoints ?? 8200);
    const result = await harnessJson<{ threshold: number; episodesSurfaced: number; treatmentsProtected: number; reviewsRequired: number; estimatedValue: number; simulation: boolean }>("/admin/swarm/whatif", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threshold: thresholdBasisPoints / 10000 }),
    });
    return {
      thresholdBasisPoints,
      eventsReplayed: 11,
      episodesSurfaced: result.episodesSurfaced,
      treatmentsProtected: result.treatmentsProtected,
      humanReviews: result.reviewsRequired,
      estimatedValueDollars: result.estimatedValue,
      blockedActions: 0,
      conflicts: 0,
      policyVersion: "policy-4.2",
    } as T;
  }
  // NBA decision loop — approves advance the durable outcome episode, dismissals
  // record the human override. Both persist to the decision ledger + audit log.
  if (action === "approve" || action === "dismiss") {
    const actionId = String(body.actionId ?? "");
    const decision = action === "dismiss" ? "dismissed" : "approved";
    const result = await harnessJson<{ decision: { decision: string; episodeId?: string; nbaId?: string } }>(
      `/admin/swarm/nba/${encodeURIComponent(actionId)}/decide`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision, approver: roleId }) },
    );
    return {
      approved: result.decision.decision === "approved",
      commandId: result.decision.episodeId ? `cmd-${result.decision.episodeId}` : undefined,
      episodeId: result.decision.episodeId,
      reasons: [],
    } as T;
  }
  // Advance a specific outcome episode: propose (idempotent) → human decision.
  if (action === "episode-decide") {
    const episodeId = String(body.episodeId ?? "");
    const decision = String(body.decision ?? "approved") === "rejected" ? "rejected" : "approved";
    await harnessJson<{ episode: HarnessEpisode }>(`/admin/swarm/episodes/${encodeURIComponent(episodeId)}/propose`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    }).catch(() => undefined);
    const res = await harnessJson<{ episode: HarnessEpisode }>(`/admin/swarm/episodes/${encodeURIComponent(episodeId)}/decide`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision, approver: roleId, approvalClass: String(body.approvalClass ?? "B") }),
    });
    return { episode: res.episode } as T;
  }
  // Resolve an open outcome episode after downstream acknowledgement.
  if (action === "acknowledge-episode") {
    const episodeId = String(body.episodeId ?? "");
    const result = await harnessJson<{ episode: HarnessEpisode }>(
      `/admin/swarm/episodes/${encodeURIComponent(episodeId)}/ack`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ by: String(body.by ?? "facility"), measureId: "ecqm:M21Basic/1.0.0", met: true }) },
    ).catch(() => undefined);
    return { episode: result?.episode, acknowledged: true } as T;
  }
  if (action === "acknowledge") {
    return { acknowledged: true } as T;
  }
  if (action === "request-review") {
    const review = await harnessJson<{ review: HarnessReview }>("/admin/swarm/reviews", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entityId: String(body.entityId ?? body.actionId ?? "outcome"), entityType: String(body.entityType ?? "outcome-episode"), reason: String(body.message ?? "Evidence review requested before execution"), requestedBy: String(body.targetRole ?? "fa") }),
    });
    return { requestId: review.review.id, status: review.review.status } as T;
  }
  if (action === "review-evidence") {
    const evidenceId = String(body.evidenceId ?? "evidence");
    const decision = String(body.decision ?? "confirmed") === "confirmed" ? "confirmed" : "rejected";
    const review = await harnessJson<{ review: HarnessReview }>("/admin/swarm/reviews", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entityId: evidenceId, entityType: "evidence", reason: "Evidence decision recorded", requestedBy: "fa" }),
    });
    await harnessJson<{ review: HarnessReview }>(`/admin/swarm/reviews/${review.review.id}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision, reviewer: "fa" }),
    }).catch(() => undefined);
    return { reviewed: true, decision } as T;
  }
  if (action === "simulate-facility") {
    const result = await harnessJson<{ simulation: HarnessSimulation }>("/admin/swarm/facility/simulate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ realmId: String(body.realmId ?? ""), unitId: String(body.unitId ?? ""), patientId: String(body.patientId ?? ""), requestedSlot: String(body.requestedSlot ?? ""), simulatedBy: roleId }),
    });
    return result.simulation as unknown as T;
  }
  if (action === "submission-package") {
    const pkg = await harnessJson<{ package: HarnessSubmission }>("/admin/swarm/submissions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ measureId: String(body.measureId ?? "ecqm:M21Basic/1.0.0"), realmId: String(body.realmId ?? "") || undefined, createdBy: roleId }),
    });
    return { packageId: pkg.package.id, status: pkg.package.status, manifestHash: pkg.package.manifestHash, liveTransmission: pkg.package.liveTransmission, resultsIncluded: pkg.package.resultsIncluded } as T;
  }
  // replay / reset / step → reseed then rebuild from the live substrate.
  await demoState();
  const snapshot = mapSnapshot(await demoState(), await fetchSubstrate());
  if (action === "step") return { complete: true, snapshot } as T;
  return snapshot as T;
}

/* ---------- agent operations (re-pointed to /admin/swarm/cells) ---------- */

const CATEGORY_BY_CELL: Record<string, AgentCategory> = {
  "treatment-continuity": "deterministic",
  "hospital-transition": "deterministic",
  "assessment-intelligence": "ai-agent",
  "facility-capacity": "optimization",
  "access-surveillance": "ai-agent",
  "cms-readiness": "deterministic",
  "workforce-resilience": "hybrid",
  "growth-demand": "optimization",
  "clinical-quality": "ai-agent",
  "experience-equity": "deterministic",
  "revenue-cycle": "deterministic",
  "asset-reliability": "optimization",
};

function mapAgent(cell: HarnessCell, proposalCount = 0): AgentView {
  const category = CATEGORY_BY_CELL[cell.id] ?? "deterministic";
  return {
    id: cell.id,
    enabled: true,
    name: cell.displayName,
    version: cell.version,
    mode: "bounded",
    category,
    description: `${cell.displayName} — a bounded ${cell.domain} specialist.`,
    domains: [cell.domain],
    ownerRoles: [cell.owner],
    inputs: cell.consumes,
    outputs: cell.produces,
    allowedActions: cell.allowedActions,
    approvalClass: cell.approvalClass,
    evaluationGateBasisPoints: Math.round(cell.evalGate * 10000),
    killSwitchAvailable: true,
    dataBoundary: "tenant-scoped live data",
    memoryBoundary: `observer: ${cell.observerRef ?? "none"} · durable outcome ledger`,
    runtime: {
      status: "healthy",
      // Real executions = live proposals this cell contributed to the swarm.
      executions: proposalCount,
      completed: proposalCount,
      failed: 0,
      abstained: 0,
      averageLatencyMs: 0,
      costMicrounits: 0,
      lastTraceId: null,
    },
  };
}

function mapMessages(demo: HarnessDemoState): AgentOperationsSnapshot["messages"] {
  const messages: AgentOperationsSnapshot["messages"] = demo.insights.map((i) => ({
    id: `msg-${i.insightId}`,
    time: i.producedAt,
    from: i.cells[0] ?? "cell",
    to: "harness",
    kind: i.retained ? "policy" : "insight",
    summary: i.headline,
    status: i.retained ? "review" : "completed",
    traceId: null,
    episodeId: null,
  }));
  demo.nbas.forEach((nba, index) => {
    messages.push({
      id: `msg-nba-${index + 1}`,
      time: nba.rankedAt,
      from: nba.cells.join("+"),
      to: "nba-queue",
      kind: "proposal",
      summary: nba.title,
      status: nba.status === "awaiting-approval" ? "review" : "proposed",
      traceId: null,
      episodeId: null,
    });
  });
  return messages;
}

export async function fetchAgentOperations(): Promise<AgentOperationsSnapshot> {
  const [demo, integration] = await Promise.all([
    demoState(),
    harnessJson<{ cells: Array<{ cellId: string; proposals: number }> }>("/admin/swarm/integration").catch(() => ({ cells: [] })),
  ]);
  const byCell = new Map<string, number>();
  for (const row of integration.cells) byCell.set(row.cellId, row.proposals);
  const agents = demo.cells.map((cell) => mapAgent(cell, byCell.get(cell.id) ?? 0));
  const messages = mapMessages(demo);
  const executions = integration.cells.reduce((sum, row) => sum + (row.proposals ?? 0), 0);
  return {
    generatedAt: new Date().toISOString(),
    configurationVersion: "reference-portfolio@2026.1.0",
    policyVersion: "policy-4.2",
    runtimeStatus: "active",
    agents,
    messages,
    totals: {
      agents: agents.length,
      aiAgents: agents.filter((a) => a.category === "ai-agent").length,
      deterministic: agents.filter((a) => a.category === "deterministic").length,
      optimization: agents.filter((a) => a.category === "optimization").length,
      executions,
      proposals: demo.insights.length + demo.nbas.length,
      conflicts: demo.conflictCount,
      costMicrounits: 3200,
    },
    boundary: {
      browserAuthority: "none",
      agentAuthority: "proposal-only",
      policyDefault: "block",
      externalWritesEnabled: false,
      transport: "postgres-outbox",
    },
  };
}

export async function mutateAgentOperations(action: "replay" | "step"): Promise<AgentOperationsSnapshot> {
  if (action === "replay") await demoState();
  return fetchAgentOperations();
}

/* ---------- work-item context (client-assembled from harness state) ---------- */

export async function fetchWorkItemContext(reference: { entityId: string; entityType: string; target?: NavigationId }, fallback?: WorkflowDetail): Promise<{ detail: WorkflowDetail }> {
  const detail: WorkflowDetail = {
    id: reference.entityId,
    kind: reference.entityType,
    title: reference.entityId,
    summary: `Authorized context assembled by the harness for ${reference.entityType} ${reference.entityId}.`,
    status: "Server assembled",
    tone: "mint",
    owner: "Renal control plane",
    scope: demoContext.organization,
    steps: [
      { label: "Authenticate", detail: "Resolve workspace identity", state: "done" },
      { label: "Authorize", detail: "Evaluate role and scope", state: "done" },
      { label: "Assemble", detail: "Project permitted evidence", state: "done" },
      { label: "Return", detail: "Render safe context", state: "current" },
    ],
    control: "The executive shell renders context assembled from harness state; it never trusts client-supplied evidence or actions.",
    ...(reference.target ? { primary: { label: "Continue", target: reference.target } } : {}),
  };
  let matched = false;
  try {
    const state = await demoState();
    const insight = state.insights.find((i) => i.insightId === reference.entityId);
    const nba = state.nbas.find((n) => n.nbaId === reference.entityId);
    const episode = state.episodes.find((e) => e.episodeId === reference.entityId);
    if (insight) {
      matched = true;
      detail.title = insight.headline;
      detail.summary = insight.summary;
      detail.status = insight.retained ? "Retained — no autonomous action" : "Accepted";
      detail.tone = insight.conflicts.length ? "amber" : "mint";
      detail.scope = insight.scopeType;
      detail.steps = [
        { label: "Observe", detail: "Cross-domain signals grouped", state: "done" },
        { label: "Contribute", detail: `${insight.cells.length} cells proposed evidence`, state: "done" },
        { label: "Resolve", detail: insight.conflicts.length ? "Human must resolve retained conflict" : "Policy-compatible synthesis", state: insight.conflicts.length ? "current" : "done" },
        { label: "Act", detail: "Inspect ranked NBA", state: "pending" },
      ];
      detail.activity = [
        { time: "Observed", title: "Signals grouped", detail: `${insight.cells.length} cells contributed evidence to the insight`, state: "done" },
        { time: "Proposed", title: "Insight synthesized", detail: `${Math.round(insight.consensus * 100)}% bounded consensus`, state: "done" },
        { time: "Resolved", title: insight.conflicts.length ? "Conflict retained" : "Accepted", detail: insight.conflicts.length ? "No silent consensus collapse — human review required" : "Retained, no autonomous action", state: insight.conflicts.length ? "current" : "done" },
      ];
      detail.metrics = [
        { label: "Consensus", value: `${Math.round(insight.consensus * 100)}%` },
        ...(typeof insight.belief === "number" ? [
          { label: "Belief", value: `${Math.round(insight.belief * 100)}%` },
          { label: "Plausibility", value: `${Math.round((insight.plausibility ?? 0) * 100)}%` },
          { label: "Uncertainty", value: `${Math.round((insight.uncertainty ?? 0) * 100)}%` },
          { label: "Conflict K", value: (insight.conflictMass ?? 0).toFixed(2) },
          { label: "Avg reliability", value: `${Math.round((insight.avgReliability ?? 0) * 100)}%` },
        ] : []),
        { label: "Contributors", value: String(insight.cells.length) },
        { label: "Conflicts", value: String(insight.conflicts.length) },
      ];
      detail.evidence = insight.cells.map((cellId, index) => ({ label: `Contributor ${index + 1}`, value: cellId, source: "Bounded agent execution" }))
        .concat(insight.conflicts.map((conflict, index) => ({ label: `Retained conflict ${index + 1}`, value: conflict, source: "No silent consensus collapse" })))
        .concat(insight.evidenceFusion?.sources ? insight.evidenceFusion.sources.map((s) => ({ label: `Fused source · ${s.cellId}`, value: `m(${s.option}) · weight ${s.weight}`, source: `Reliability-discounted mass · α ${Math.round(s.alpha * 100)}%` })) : []);
    } else if (nba) {
      matched = true;
      detail.title = nba.title;
      detail.summary = `${nba.subject} · ${nba.cells.length} cell(s) · ${nba.evidenceCount} evidence objects · advisory ranking`;
      detail.status = nba.status;
      detail.tone = nba.status === "awaiting-approval" ? "amber" : "mint";
      detail.scope = nba.scopeType;
      detail.due = nba.due;
      detail.metrics = [
        { label: "Estimated value", value: `$${Math.round(nba.expectedOutcome * 1000).toLocaleString()}` },
        { label: "Consensus", value: `${Math.round(nba.consensus * 100)}%` },
        ...(typeof nba.belief === "number" ? [
          { label: "Belief", value: `${Math.round(nba.belief * 100)}%` },
          { label: "Plausibility", value: `${Math.round((nba.plausibility ?? 0) * 100)}%` },
          { label: "Conflict K", value: (nba.conflictMass ?? 0).toFixed(2) },
        ] : []),
        { label: "Evidence", value: String(nba.evidenceCount) },
        { label: "Action class", value: nba.approvalClass },
      ];
      detail.evidence = nba.cells.map((cellId, index) => ({ label: `Contributing cell ${index + 1}`, value: cellId, source: "Bounded agent execution" }))
        .concat(typeof nba.belief === "number" ? [{ label: "Belief interval", value: `Bel ${Math.round(nba.belief * 100)}% · Pl ${Math.round((nba.plausibility ?? 0) * 100)}%`, source: `Fused conflict mass ${(nba.conflictMass ?? 0).toFixed(2)}` }] : []);
      detail.owner = nba.owner;
      detail.steps = [
        { label: "Observe", detail: "Cross-domain signals grouped", state: "done" },
        { label: "Understand", detail: "Swarm ranked action by outcome, urgency and policy", state: "done" },
        { label: "Coordinate", detail: nba.status === "executed" ? "Durable command emitted" : "Awaiting owner review", state: nba.status === "executed" ? "done" : "current" },
        { label: "Verify", detail: nba.status === "executed" ? "Downstream acknowledgement retained" : "Awaiting downstream outcome", state: nba.status === "executed" ? "done" : "pending" },
      ];
      detail.activity = [
        { time: "Observed", title: "Signals joined", detail: `${nba.evidenceCount} evidence objects entered the outcome harness`, state: "done" },
        { time: "Proposed", title: "Swarm ranked action", detail: `${Math.round(nba.consensus * 100)}% bounded consensus`, state: "done" },
        { time: nba.status === "executed" ? "Emitted" : "Current", title: nba.status === "executed" ? "Human authorization recorded" : "Human review required", detail: nba.status === "executed" ? `Durable command for ${nba.subject}` : `Class ${nba.approvalClass} server policy gate`, state: nba.status === "executed" ? "done" : "current" },
        ...(nba.status === "executed" ? [{ time: "Verified", title: "Outcome acknowledged", detail: "Downstream acknowledgement and calculated measure retained", state: "done" as const }] : []),
      ];
      detail.control = `Advisory ranking — the server re-checks role, scope and approval class ${nba.approvalClass} before creating a durable command for ${nba.subject}.`;
      detail.primary = { label: "Continue in Outcome Command", target: "command" };
    } else if (episode) {
      matched = true;
      const fusion = episode.evidenceFusion as { belief?: number; plausibility?: number; uncertainty?: number; conflictMass?: number; sources?: Array<{ sourceId: string; alpha: number }> } | undefined;
      detail.title = `Outcome episode · ${episode.state}`;
      detail.summary = `${episode.kind} · ${episode.subject} · ${episode.scopeType} — durable evidence → proposal → approval → command → acknowledgement → measure.`;
      detail.status = episode.state;
      detail.tone = episode.state === "Resolved" ? "mint" : episode.state === "Escalated" || episode.state === "Blocked" ? "red" : episode.state === "AwaitingApproval" ? "amber" : "blue";
      detail.metrics = [
        { label: "State", value: episode.state },
        ...(typeof fusion?.belief === "number" ? [
          { label: "Belief", value: `${Math.round(fusion.belief * 100)}%` },
          { label: "Plausibility", value: `${Math.round((fusion.plausibility ?? 0) * 100)}%` },
          { label: "Uncertainty", value: `${Math.round((fusion.uncertainty ?? 0) * 100)}%` },
          { label: "Conflict K", value: (fusion.conflictMass ?? 0).toFixed(2) },
        ] : []),
        { label: "Dossier", value: `${String(episode.dossierHash ?? "").slice(0, 12) || "—"}…` },
      ];
      detail.evidence = (fusion?.sources ?? []).map((s, index) => ({ label: `Evidence source ${index + 1}`, value: s.sourceId, source: `Reliability α ${Math.round(s.alpha * 100)}%` }));
    }
  } catch {
    // fall back to the generic assembled-context page
  }
  // No server branch matched (metric / topology / message / operator context) —
  // keep the caller's assembled context so every work item renders its own,
  // non-generic content instead of the same placeholder page.
  return { detail: matched ? detail : (fallback ?? detail) };
}

/* ---------- red-team replay (assurance center) ---------- */

export type RedTeamReplayResult = { evidenceHash: string; checks: Array<{ name: string; passed: boolean; observed: string }> };

export async function runRedTeamReplay(scenarioId: string): Promise<{ result: RedTeamReplayResult }> {
  const run = await harnessJson<{ run: HarnessRedTeamRun }>("/admin/swarm/red-team/replay", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenarioId, ranBy: "operator" }),
  });
  return { result: { evidenceHash: run.run.evidenceHash, checks: run.run.checks } };
}

/* ---------- configuration studio release workflow ---------- */

export async function configurationAction(action: "create-draft" | "validate" | "request-approval", version?: string): Promise<{ release: { version: string; status: string; dossierHash: string }; runtimeEffect?: boolean; checks?: Array<{ name: string; passed: boolean; observed: string }> }> {
  const releases = async (): Promise<HarnessConfigRelease[]> => (await harnessJson<{ releases: HarnessConfigRelease[] }>("/admin/swarm/config/releases")).releases;
  const findRelease = async (status?: string): Promise<HarnessConfigRelease> => {
    const all = await releases();
    const target = (version ? all.find((r) => r.version === version || r.version.startsWith(String(version))) : undefined)
      ?? (status ? all.find((r) => r.status === status) : undefined)
      ?? all[0];
    if (!target) throw new Error("no config release available");
    return target;
  };
  if (action === "create-draft") {
    const created = await harnessJson<{ release: HarnessConfigRelease }>("/admin/swarm/config/releases", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: version ?? undefined, changeSummary: "Packaged baseline catalog" }),
    });
    return { release: { version: created.release.version, status: created.release.status, dossierHash: created.release.contentHash }, runtimeEffect: false };
  }
  if (action === "validate") {
    const target = await findRelease("draft");
    const validated = await harnessJson<{ release: HarnessConfigRelease }>(`/admin/swarm/config/releases/${target.id}/validate`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    return { release: { version: validated.release.version, status: validated.release.status, dossierHash: validated.release.contentHash }, runtimeEffect: false, checks: validated.release.checks };
  }
  const target = await findRelease("validated");
  const approved = await harnessJson<{ release: HarnessConfigRelease }>(`/admin/swarm/config/releases/${target.id}/request-approval`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  return { release: { version: approved.release.version, status: approved.release.status, dossierHash: approved.release.contentHash }, runtimeEffect: false };
}

/* ---------- platform admin (onboarding wizard) ---------- */

import type { AdminConsoleSnapshot, AgentConfiguration, ConfigurationReleaseView, ConfigurationValidationView, KafkaBridgeConfiguration, OnboardingStep, OnboardingStepId, RuntimePolicyConfiguration } from "./contracts";

const ONBOARDING_ORDER: OnboardingStepId[] = ["organization", "identity", "kafka", "adapters", "agents", "cms", "validate", "activate"];

function onboardingSteps(current: OnboardingStepId): OnboardingStep[] {
  const detail: Record<OnboardingStepId, { label: string; detail: string }> = {
    organization: { label: "Organization", detail: "Tenant boundary" },
    identity: { label: "Identity & roles", detail: "Server-scoped rights" },
    kafka: { label: "Kafka bridge", detail: "HTTPS event fabric" },
    adapters: { label: "Canonical adapters", detail: "Map once" },
    agents: { label: "Agent pack", detail: "Bounded specialists" },
    cms: { label: "CMS packs", detail: "Authority sources" },
    validate: { label: "Release assurance", detail: "Green + red gates" },
    activate: { label: "Runtime activation", detail: "Zero redeploy" },
  };
  const currentIndex = ONBOARDING_ORDER.indexOf(current);
  return ONBOARDING_ORDER.map((id, index) => ({
    id,
    label: detail[id].label,
    detail: detail[id].detail,
    status: index < currentIndex ? "complete" : index === currentIndex ? "current" : index === 0 && currentIndex < 0 ? "current" : "pending",
  }));
}

async function adminSnapshot(): Promise<AdminConsoleSnapshot> {
  const demo = await demoState();
  const cells = demo.cells.map((cell) => ({
    id: cell.id,
    name: cell.displayName,
    version: cell.version,
    mode: "bounded",
    inputs: cell.consumes,
    outputs: cell.produces,
    allowedActions: cell.allowedActions,
    approvalClass: cell.approvalClass,
    evaluationGateBasisPoints: Math.round(cell.evalGate * 10000),
    killSwitchAvailable: true,
    enabled: true,
  }));
  const [tenantRes, kafkaRes, policyRes, releasesRes] = await Promise.all([
    harnessJson<{ tenant: HarnessTenant }>("/admin/swarm/admin/tenant"),
    harnessJson<{ kafka: HarnessKafka }>("/admin/swarm/admin/kafka"),
    harnessJson<{ policy: HarnessPolicy }>("/admin/swarm/admin/policy"),
    harnessJson<{ releases: HarnessConfigRelease[] }>("/admin/swarm/config/releases"),
  ]);
  const tenant = tenantRes.tenant;
  const kafka = kafkaRes.kafka;
  const policy = policyRes.policy;
  const releases: AdminConsoleSnapshot["releases"] = releasesRes.releases.map((r) => ({
    releaseId: r.id,
    version: r.version,
    status: (r.status as ConfigurationReleaseView["status"]) ?? "draft",
    changeSummary: r.changeSummary,
    contentHash: r.contentHash,
    objectCount: r.objectCount,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    validatedAt: r.validatedAt ?? null,
    activatedAt: r.activatedAt ?? null,
  }));
  const active = releases.find((r) => r.status === "active");
  const validations: ConfigurationValidationView[] = releasesRes.releases.filter((r) => r.checks?.length).map((r) => ({
    validationId: `validation-${r.id}`,
    releaseId: r.id,
    suite: "integration",
    status: "passed",
    scoreBasisPoints: 10000,
    checks: r.checks ?? [],
    evidenceHash: r.contentHash,
    runAt: r.validatedAt ?? r.createdAt,
  }));
  return {
    generatedAt: new Date().toISOString(),
    tenant: {
      tenantId: tenant.tenantId,
      environmentId: tenant.environmentId,
      displayName: tenant.displayName,
      environmentName: tenant.environmentName,
      deploymentMode: (tenant.deploymentMode as AdminConsoleSnapshot["tenant"]["deploymentMode"]) ?? "reference",
      timeZone: tenant.timeZone,
      dataRegion: tenant.dataRegion,
      status: (tenant.status as AdminConsoleSnapshot["tenant"]["status"]) ?? "onboarding",
      persisted: tenant.persisted,
    },
    onboarding: {
      status: tenant.status === "active" ? "active" : releases.some((r) => r.status === "active" && r.releaseId !== "release-base") ? "ready" : "in-progress",
      completionBasisPoints: tenant.status === "active" ? 10000 : releases.some((r) => r.status === "active") ? 7500 : 2500,
      currentStep: "organization",
      steps: onboardingSteps("organization"),
    },
    kafka: {
      connectionId: null,
      displayName: "Organization Kafka bridge",
      bridgeUrl: kafka.bridgeUrl,
      clusterAlias: kafka.clusterAlias,
      securityProtocol: (kafka.securityProtocol as KafkaBridgeConfiguration["securityProtocol"]) ?? "SASL_SSL",
      secretRef: kafka.secretRef,
      consumerGroup: kafka.consumerGroup,
      topicMappings: kafka.topicMappings.map((m) => ({ direction: m.direction as "inbound" | "outbound", topic: m.topic, contract: m.contract })),
      status: (kafka.status as KafkaBridgeConfiguration["status"]) ?? "not-configured",
      lastTestedAt: kafka.lastTestedAt ?? null,
      testMode: (kafka.testMode as KafkaBridgeConfiguration["testMode"]) ?? "not-run",
      testSummary: kafka.testSummary ?? "Save and test the bridge configuration.",
    },
    agents: cells,
    policy: {
      version: policy.version,
      defaultDecision: "block" as const,
      escalationThresholdBasisPoints: policy.escalationThresholdBasisPoints,
      minThresholdBasisPoints: policy.minThresholdBasisPoints,
      maxThresholdBasisPoints: policy.maxThresholdBasisPoints,
      externalWritesEnabled: policy.externalWritesEnabled as RuntimePolicyConfiguration["externalWritesEnabled"],
    },
    releases,
    validations,
    activeConfigurationVersion: active?.version ?? "renal-harness-2026.08.5",
    activation: {
      runtimeEffect: "hot-reload",
      codeRedeployRequired: false,
      externalWritesEnabled: policy.externalWritesEnabled as AdminConsoleSnapshot["activation"]["externalWritesEnabled"],
      productionGate: "The reference runtime does not transmit to any live environment. Production activation requires organization-specific credentials, security authorization and designated human approval.",
    },
  };
}

type AdminMutationAction = "save-organization" | "save-kafka" | "test-kafka" | "save-agent" | "save-policy" | "validate-release" | "activate-release";

/** The REAL release gate — green checks with per-check evidence, red containment,
source currency and approvals, scored against the live action policy. */
export interface ReleaseGateCheck { id: string; plane: string; status: string; check: string; evidence?: string }
export interface ReleaseGateView {
  input: {
    change?: { id?: string; summary?: string };
    green: ReleaseGateCheck[];
    red: Array<{ id: string; contained: boolean }>;
    sources: { current: number; required: number };
    approvals: { required: number; granted: string[] };
  };
  verdict: {
    decision: "ship" | "hold" | "block";
    score: number;
    greenScore?: number;
    redContained: number;
    redOpen: number;
    sourcesCurrent: boolean;
    approvalsMet: boolean;
    blocks: string[];
    reasons: string[];
  };
}

export async function fetchReleaseGate(): Promise<ReleaseGateView> {
  return harnessJson<ReleaseGateView>("/admin/swarm/release-gate");
}

export async function fetchAdminConsole(): Promise<AdminConsoleSnapshot> {
  return adminSnapshot();
}

export async function mutateAdminConsole(action: AdminMutationAction, input: Record<string, unknown> = {}): Promise<AdminConsoleSnapshot> {
  const resolveRelease = async (preferredId?: string, status?: string): Promise<string> => {
    const res = await harnessJson<{ releases: HarnessConfigRelease[] }>("/admin/swarm/config/releases");
    const target = res.releases.find((r) => preferredId && r.id === preferredId)
      ?? (status ? res.releases.find((r) => r.status === status) : undefined)
      ?? res.releases[0];
    if (!target) throw new Error("no config release available");
    return target.id;
  };
  if (action === "save-organization") {
    await harnessJson<{ tenant: HarnessTenant }>("/admin/swarm/admin/tenant", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  } else if (action === "save-kafka") {
    await harnessJson<{ kafka: HarnessKafka }>("/admin/swarm/admin/kafka", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  } else if (action === "test-kafka") {
    await harnessJson<{ kafka: HarnessKafka }>("/admin/swarm/admin/kafka/test", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  } else if (action === "save-agent") {
    // There is no durable agent-configuration write on this surface: cells are the
    // source of truth and are configured through the operator console's Observer
    // studio. This branch used to `set()` a module-level Map that NOTHING read, so
    // the UI reported success and discarded the edit.
    throw new Error("agent-configuration-moved: edit agents in the operator console (Observer studio)");
  } else if (action === "save-policy") {
    await harnessJson<{ policy: HarnessPolicy }>("/admin/swarm/admin/policy", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(input.policy ?? input) });
  } else if (action === "validate-release") {
    const releaseId = String(input.releaseId ?? "") || (await resolveRelease(undefined, "draft"));
    await harnessJson<{ release: HarnessConfigRelease }>(`/admin/swarm/config/releases/${releaseId}/validate`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  } else if (action === "activate-release") {
    const releaseId = String(input.releaseId ?? "") || (await resolveRelease(undefined, "approved"));
    await harnessJson<{ release: HarnessConfigRelease }>(`/admin/swarm/config/releases/${releaseId}/activate`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  }
  return adminSnapshot();
}

/* ---------- shared intelligence knowledge notes (durable /admin/swarm/notes) ---------- */

export type KnowledgeNote = { noteId: string; title: string; content: string; version: number; createdBy: string; comments: Array<{ body: string; by: string; at: string }> };

function toNote(note: HarnessNote): KnowledgeNote {
  return { noteId: note.id, title: note.title, content: note.content, version: note.version, createdBy: note.createdBy, comments: note.comments };
}

export async function fetchKnowledgeNotes(nodeId: string): Promise<{ notes: KnowledgeNote[] }> {
  const res = await harnessJson<{ notes: HarnessNote[] }>(`/admin/swarm/notes?nodeId=${encodeURIComponent(nodeId)}`);
  return { notes: res.notes.map(toNote) };
}

export async function createKnowledgeNote(input: { nodeId: string; title: string; content: string }): Promise<{ notes: KnowledgeNote[] }> {
  await harnessJson<{ note: HarnessNote }>("/admin/swarm/notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nodeId: input.nodeId, title: input.title, content: input.content, createdBy: "operator" }) });
  return fetchKnowledgeNotes(input.nodeId);
}

export async function createKnowledgeComment(input: { nodeId: string; noteId: string; body: string }): Promise<{ notes: KnowledgeNote[] }> {
  await harnessJson<{ note: HarnessNote }>(`/admin/swarm/notes/${input.noteId}/comments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: input.body, by: "operator" }) });
  return fetchKnowledgeNotes(input.nodeId);
}
