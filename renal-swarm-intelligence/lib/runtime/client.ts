export type RuntimeEventRow = {
  eventId: string;
  eventType: string;
  subjectType: string;
  subjectId: string;
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
  episodes: Array<Record<string, unknown>>;
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
  authoritySnapshots: Array<{ sourceId: string; authority: string; status: string; effectiveFrom: string; sourceUrl: string; contentHash: string; retrievedAt: string }>;
  audits: Array<{ eventId: string; category: string; actor: string; action: string; entityType: string; entityId: string; decision: string; evidenceHash: string; detail: string; createdAt: string }>;
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

export async function fetchRuntimeSnapshot(): Promise<RuntimeSnapshot> {
  const response = await fetch("/api/runtime", { cache: "no-store" });
  const payload = await response.json() as RuntimeSnapshot & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? "Runtime snapshot failed");
  return payload;
}

export async function ensureRuntime(roleId = "dvp"): Promise<RuntimeSnapshot> {
  const snapshot = await fetchRuntimeSnapshot();
  if (snapshot.runtime.status === "active") return snapshot;
  return mutateRuntime<RuntimeSnapshot>("replay", roleId);
}

export async function mutateRuntime<T>(action: string, roleId: string, body: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch("/api/runtime", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, roleId, ...body }),
  });
  const payload = await response.json() as { result?: T; error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Runtime ${action} failed`);
  return payload.result as T;
}
