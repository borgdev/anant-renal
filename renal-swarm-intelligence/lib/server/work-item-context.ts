import agentManifests from "../../config/agent-manifests.json";
import measurePacks from "../../config/measure-packs.json";
import operatingModel from "../../config/enterprise-operating-model.json";
import publicSources from "../../config/public-sources.json";
import type { WorkItemReference } from "../control-plane/contracts";
import type { NavigationId } from "../types";
import type { WorkflowDetail, WorkflowTone } from "../workflow-detail";
import { authorizedForScope, type RuntimeActor } from "../runtime/authorization";
import { runtimeSnapshot } from "../runtime/engine";
import { ControlPlaneError } from "./request-security";

const navigationTargets = new Set<NavigationId>([
  "ecosystem",
  "agents",
  "command",
  "patient",
  "intelligence",
  "assessments",
  "facility",
  "cms",
  "executive",
  "assurance",
  "admin",
  "configuration",
]);

type Snapshot = Awaited<ReturnType<typeof runtimeSnapshot>>;

function normalizeTarget(target: NavigationId | undefined, fallback: NavigationId) {
  return target && navigationTargets.has(target) ? target : fallback;
}

function navigationLabel(target: NavigationId) {
  const labels: Record<NavigationId, string> = {
    ecosystem: "Swarm Control",
    agents: "Agent Operations",
    command: "Outcome Command",
    patient: "Patient Intelligence",
    intelligence: "Shared Intelligence",
    assessments: "Assessment Intelligence",
    facility: "Facility Operations",
    cms: "CMS Operations",
    executive: "Executive Outcomes",
    assurance: "AI Assurance",
    admin: "Platform Admin",
    configuration: "Configuration Studio",
  };
  return labels[target];
}

function primary(target: NavigationId) {
  return { label: "Open " + navigationLabel(target), target };
}

function humanize(value: string) {
  const prefixes = [
    "METRIC-",
    "TOPOLOGY-",
    "PATIENT-STATE-",
    "FACILITY-",
    "CMS-",
    "EXEC-",
    "ASSURANCE-",
    "CONFIG-",
    "DOMAIN-",
    "CELL-",
    "LEDGER-",
  ];
  let normalized = value;
  for (const prefix of prefixes) {
    if (normalized.startsWith(prefix)) normalized = normalized.slice(prefix.length);
  }
  return normalized
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function scopeAllowed(actor: RuntimeActor, scopeId: string) {
  const result = authorizedForScope(actor, scopeId);
  if (!result.allowed) throw new ControlPlaneError("WORK_ITEM_SCOPE_DENIED", 403);
  return result.reason;
}

function patientEvidenceAllowed(actor: RuntimeActor) {
  return ["fa", "medical", "quality"].includes(actor.role);
}

function secure(
  detail: WorkflowDetail,
  actor: RuntimeActor,
  snapshot: Snapshot,
  redactions: string[] = [],
): WorkflowDetail {
  return {
    ...detail,
    control:
      detail.control ??
      "This context was assembled by the server after identity, role, scope and purpose checks. The browser has no execution authority.",
    security: {
      serverAssembled: true,
      role: actor.role.toUpperCase(),
      scope: actor.scopeId,
      purpose: "authorized renal outcome coordination",
      redactions,
      policyVersion: snapshot.runtime.policyVersion,
      configurationVersion: snapshot.runtime.configuration,
      traceId: crypto.randomUUID(),
    },
  };
}

function toneForStatus(status: string): WorkflowTone {
  const normalized = status.toLowerCase();
  if (normalized.includes("block") || normalized.includes("fail") || normalized.includes("critical")) return "red";
  if (normalized.includes("review") || normalized.includes("await") || normalized.includes("watch")) return "amber";
  if (normalized.includes("complete") || normalized.includes("resolve") || normalized.includes("healthy")) return "mint";
  return "blue";
}

function agentFor(referenceId: string) {
  const normalized = referenceId
    .replace(/^CELL-/, "")
    .replace(/^AGENT-/, "")
    .replaceAll("-", " ")
    .toLowerCase();
  return agentManifests.find((item) =>
    item.id === referenceId ||
    item.id.replace("-cell", "").replaceAll("-", " ") === normalized ||
    item.name.toLowerCase() === normalized ||
    normalized.startsWith(item.name.toLowerCase()),
  );
}

function genericSummary(kind: string) {
  const normalized = kind.toLowerCase();
  if (normalized.includes("cms")) return "Server-resolved regulatory context joins pinned authority versions, deterministic measure results, readiness gaps and approval boundaries.";
  if (normalized.includes("facility")) return "Server-resolved facility state joins chairs, staffing, machines, arrivals and constraint-safe simulation evidence.";
  if (normalized.includes("patient")) return "Server-resolved temporal patient context preserves valid time, recorded time, provenance and role-based evidence redaction.";
  if (normalized.includes("configuration")) return "Server-resolved configuration context preserves versions, evaluation gates, approvals, effective windows and rollback.";
  if (normalized.includes("assurance") || normalized.includes("observability")) return "Server-resolved assurance context joins executions, traces, drift, incidents, evaluations and audit evidence.";
  if (normalized.includes("topology")) return "Server-resolved topology context uses typed, time-aware relations with provenance and scope controls.";
  return "The control plane assembled current evidence, operating state and closed-loop progress for this work item.";
}

function resolveAgentDetail(
  reference: WorkItemReference,
  actor: RuntimeActor,
  snapshot: Snapshot,
): WorkflowDetail | null {
  const manifest = agentFor(reference.entityId);
  if (!manifest) return null;
  const executions = snapshot.executions.filter((item) => item.agentId === manifest.id);
  const proposals = snapshot.proposals.filter((item) => String((item as Record<string, unknown>).agentId) === manifest.id);
  const domains = operatingModel.domains.filter((domain) => domain.agentIds.includes(manifest.id));
  const target = normalizeTarget(reference.target, "agents");
  const last = executions.at(-1);
  return secure({
    id: manifest.id,
    kind: "Bounded intelligence agent",
    title: manifest.name,
    summary: "A governed " + manifest.mode + " specialist. It can publish typed proposals but cannot directly change care, schedules, source systems or submissions.",
    status: executions.some((item) => item.status === "failed") ? "Watch" : executions.length ? "Healthy" : "Idle",
    tone: executions.some((item) => item.status === "failed") ? "amber" : "mint",
    owner: domains.flatMap((domain) => domain.ownerRoles).join(" · ") || "AI assurance",
    scope: actor.scopeId,
    metrics: [
      { label: "Executions", value: String(executions.length) },
      { label: "Proposals", value: String(proposals.length) },
      { label: "Evaluation gate", value: Math.round(manifest.evalGate * 100) + "%" },
      { label: "Authority", value: "Class " + manifest.approvalClass },
    ],
    evidence: [
      { label: "Mode", value: manifest.mode, source: manifest.id + "@" + manifest.version },
      { label: "Input contract", value: manifest.inputs.join(" · "), source: "Versioned manifest" },
      { label: "Output contract", value: manifest.outputs.join(" · "), source: "Versioned manifest" },
      { label: "Allowed proposals", value: manifest.allowedActions.join(" · "), source: "Proposal-only boundary" },
      ...(last ? [{ label: "Latest trace", value: last.traceId, source: last.status + " · " + last.latencyMs + " ms" }] : []),
    ],
    activity: executions.slice(-6).reverse().map((item) => ({
      time: item.executionId,
      title: item.status,
      detail: item.latencyMs + " ms · " + item.costMicrounits + " cost microunits",
      state: item.status === "failed" || item.status === "blocked" ? "blocked" as const : "done" as const,
    })),
    steps: [
      { label: "Eligibility", detail: "Typed triggering events only", state: "done" },
      { label: "Execute", detail: "Scoped evidence and tool allowlist", state: executions.length ? "done" : "current" },
      { label: "Propose", detail: "No direct system write", state: proposals.length ? "done" : "pending" },
      { label: "Govern", detail: "Policy and human authority", state: proposals.length ? "current" : "pending" },
    ],
    primary: primary(target),
  }, actor, snapshot);
}

function resolveActionDetail(
  reference: WorkItemReference,
  actor: RuntimeActor,
  snapshot: Snapshot,
): WorkflowDetail | null {
  const action = snapshot.actions.find((item) => item.actionId === reference.entityId);
  if (!action) return null;
  const scopeReason = scopeAllowed(actor, action.scopeId);
  const command = snapshot.commands.find((item) => item.actionId === action.actionId);
  const target = normalizeTarget(reference.target, "command");
  return secure({
    id: action.actionId,
    kind: "Next-best action",
    title: action.title,
    summary: action.outcome,
    status: action.status,
    tone: toneForStatus(action.status),
    owner: action.ownerRole.toUpperCase(),
    scope: action.scopeId,
    due: action.dueAt,
    metrics: [
      { label: "Consensus", value: Math.round(action.confidenceBasisPoints / 100) + "%" },
      { label: "Evidence", value: String(action.evidenceCount) },
      { label: "Estimated value", value: action.valueLabel },
      { label: "Action class", value: action.actionClass },
    ],
    evidence: [
      { label: "Contributing agents", value: action.agentIds.join(" · "), source: "Persisted agent proposals" },
      { label: "Policy boundary", value: action.status, source: snapshot.runtime.policyVersion },
      { label: "Scope authorization", value: scopeReason, source: actor.role.toUpperCase() },
      ...(command ? [{ label: "Durable command", value: command.commandId, source: command.status }] : []),
    ],
    activity: [
      { time: "Observed", title: "Evidence joined", detail: action.evidenceCount + " authorized objects", state: "done" },
      { time: "Proposed", title: "Swarm contribution retained", detail: action.agentIds.length + " bounded specialists", state: "done" },
      { time: command ? "Emitted" : "Current", title: command ? "Command persisted" : "Human review required", detail: command?.commandId ?? "Server-side policy gate", state: command ? "done" : "current" },
      { time: action.status === "completed" ? "Verified" : "Pending", title: action.status === "completed" ? "Outcome acknowledged" : "Awaiting outcome evidence", detail: action.status, state: action.status === "completed" ? "done" : "pending" },
    ],
    steps: [
      { label: "Observe", detail: "Authorized evidence joined", state: "done" },
      { label: "Understand", detail: "Bounded proposals compared", state: "done" },
      { label: "Coordinate", detail: command ? "Durable command emitted" : "Human authorization", state: command ? "done" : "current" },
      { label: "Verify", detail: action.status === "completed" ? "Acknowledgement retained" : "Outcome pending", state: action.status === "completed" ? "done" : "pending" },
    ],
    primary: primary(target),
  }, actor, snapshot);
}

function resolveEpisodeDetail(
  reference: WorkItemReference,
  actor: RuntimeActor,
  snapshot: Snapshot,
): WorkflowDetail | null {
  const episode = snapshot.episodes.find((item) => String(item.episodeId) === reference.entityId);
  if (!episode) return null;
  const scopeId = String(episode.scopeId ?? actor.scopeId);
  scopeAllowed(actor, scopeId);
  const episodeId = String(episode.episodeId);
  const events = snapshot.events.filter((item) => item.correlationId === episodeId);
  const actions = snapshot.actions.filter((item) => item.episodeId === episodeId);
  const canReadEvidence = patientEvidenceAllowed(actor);
  const redactions = canReadEvidence ? [] : ["Exact patient-authored text withheld at this role"];
  const target = normalizeTarget(reference.target, "command");
  return secure({
    id: episodeId,
    kind: "Outcome episode",
    title: String(episode.title ?? humanize(episodeId)),
    summary: String(episode.currentRecommendation ?? "Outcome coordination is active."),
    status: String(episode.status ?? "observed"),
    tone: toneForStatus(String(episode.status ?? "observed")),
    owner: String(episode.ownerRole ?? "outcome owner"),
    scope: scopeId,
    due: String(episode.updatedAt ?? ""),
    metrics: [
      { label: "Confidence", value: Math.round(Number(episode.confidenceBasisPoints ?? 0) / 100) + "%" },
      { label: "Evidence", value: String(episode.evidenceCount ?? events.length) },
      { label: "Actions", value: String(actions.length) },
      { label: "Version", value: String(episode.version ?? 1) },
    ],
    evidence: events.slice(0, 6).map((event) => ({
      label: event.eventType,
      value: canReadEvidence ? event.subjectId : "Patient identifier redacted",
      source: event.sourceSystem + " · " + event.traceId.slice(0, 12),
    })),
    activity: events.slice(0, 6).map((event) => ({
      time: event.recordedTime,
      title: event.eventType,
      detail: event.status,
      state: "done" as const,
    })),
    steps: [
      { label: "Observe", detail: events.length + " correlated events", state: "done" },
      { label: "Understand", detail: "Evidence sufficiency evaluated", state: "done" },
      { label: "Coordinate", detail: String(episode.status), state: String(episode.status) === "resolved" ? "done" : "current" },
      { label: "Verify", detail: String(episode.resolvedAt ?? "Awaiting outcome event"), state: episode.resolvedAt ? "done" : "pending" },
    ],
    primary: primary(target),
  }, actor, snapshot, redactions);
}

function resolveEvidenceDetail(
  reference: WorkItemReference,
  actor: RuntimeActor,
  snapshot: Snapshot,
): WorkflowDetail | null {
  const evidence = snapshot.evidence.find((item) => item.evidenceId === reference.entityId);
  if (!evidence) return null;
  const canReadEvidence = patientEvidenceAllowed(actor);
  const review = snapshot.evidenceReviews.find((item) => item.evidenceId === evidence.evidenceId);
  const redactions = canReadEvidence ? [] : ["Exact assessment answer withheld at this role"];
  const target = normalizeTarget(reference.target, "assessments");
  return secure({
    id: evidence.evidenceId,
    kind: "Assessment evidence",
    title: evidence.evidenceType,
    summary: canReadEvidence
      ? evidence.exactText ?? "Structured evidence object"
      : "Patient-authored content is available only to authorized patient-care roles.",
    status: review?.decision ?? "Review required",
    tone: review?.decision === "confirmed" ? "mint" : "amber",
    owner: review?.reviewerRole ?? "Assessment reviewer",
    scope: evidence.subjectId,
    metrics: [
      { label: "Confidence", value: Math.round(evidence.confidenceBasisPoints / 100) + "%" },
      { label: "Human review", value: review?.decision ?? "Pending" },
      { label: "Valid from", value: evidence.validFrom },
      { label: "Recorded", value: evidence.recordedAt },
    ],
    evidence: [
      { label: "Exact answer", value: canReadEvidence ? evidence.exactText ?? "Structured response" : "Redacted", source: evidence.sourceEventId },
      { label: "Integrity", value: evidence.contentHash, source: "Server-side evidence ledger" },
    ],
    activity: [
      { time: evidence.validFrom, title: "Answer became valid", detail: evidence.sourceEventId, state: "done" },
      { time: evidence.recordedAt, title: "Evidence recorded", detail: evidence.contentHash.slice(0, 16) + "…", state: "done" },
      { time: review?.createdAt ?? "Current", title: review ? "Human decision retained" : "Human review pending", detail: review?.decision ?? "No downstream use without policy", state: review ? "done" : "current" },
    ],
    steps: [
      { label: "Capture", detail: "Exact source retained", state: "done" },
      { label: "Extract", detail: "Cited candidate produced", state: "done" },
      { label: "Review", detail: review?.decision ?? "Human confirmation", state: review ? "done" : "current" },
      { label: "Use", detail: "Purpose and role constrained", state: review ? "current" : "pending" },
    ],
    primary: primary(target),
  }, actor, snapshot, redactions);
}

function resolveInsightDetail(
  reference: WorkItemReference,
  actor: RuntimeActor,
  snapshot: Snapshot,
): WorkflowDetail | null {
  const insight = snapshot.insights.find((item) => item.insightId === reference.entityId);
  if (!insight) return null;
  scopeAllowed(actor, insight.scopeId);
  const target = normalizeTarget(reference.target, "intelligence");
  return secure({
    id: insight.insightId,
    kind: "Swarm insight",
    title: insight.title,
    summary: insight.summary,
    status: insight.conflicts.length ? "Human conflict review" : insight.state,
    tone: insight.conflicts.length ? "amber" : "mint",
    owner: actor.role.toUpperCase(),
    scope: insight.scopeId,
    metrics: [
      { label: "Confidence", value: Math.round(insight.confidenceBasisPoints / 100) + "%" },
      { label: "Contributors", value: String(insight.agentIds.length) },
      { label: "Conflicts", value: String(insight.conflicts.length) },
    ],
    evidence: [
      ...insight.agentIds.map((id: string, index: number) => ({ label: "Contributor " + (index + 1), value: id, source: "Persisted bounded execution" })),
      ...insight.conflicts.map((value: string, index: number) => ({ label: "Conflict " + (index + 1), value, source: "No silent consensus collapse" })),
    ],
    steps: [
      { label: "Observe", detail: "Signals grouped by scope", state: "done" },
      { label: "Contribute", detail: insight.agentIds.length + " agents", state: "done" },
      { label: "Resolve", detail: insight.conflicts.length ? "Human review required" : "No conflict retained", state: insight.conflicts.length ? "current" : "done" },
      { label: "Act", detail: "Review ranked actions", state: "pending" },
    ],
    primary: primary(target),
  }, actor, snapshot);
}

function resolveGenericDetail(
  reference: WorkItemReference,
  actor: RuntimeActor,
  snapshot: Snapshot,
): WorkflowDetail {
  const kind = reference.entityType;
  const normalized = kind.toLowerCase();
  const target = normalizeTarget(
    reference.target,
    normalized.includes("cms")
      ? "cms"
      : normalized.includes("facility")
        ? "facility"
        : normalized.includes("patient")
          ? "patient"
          : normalized.includes("assurance") || normalized.includes("observability")
            ? "assurance"
            : normalized.includes("configuration")
              ? "configuration"
              : "ecosystem",
  );
  const authorityEvidence = normalized.includes("cms")
    ? publicSources.slice(0, 5).map((source) => ({
        label: source.authority,
        value: source.title,
        source: source.status + " · effective " + source.effectiveFrom,
      }))
    : [];
  return secure({
    id: reference.entityId,
    kind,
    title: humanize(reference.entityId) || kind,
    summary: genericSummary(kind),
    status: "Server context active",
    tone: "blue",
    owner: actor.role.toUpperCase() + " operating scope",
    scope: actor.scopeId,
    metrics: [
      { label: "Persisted events", value: String(snapshot.counts.events) },
      { label: "Evidence objects", value: String(snapshot.counts.evidence) },
      { label: "Agent executions", value: String(snapshot.counts.executions) },
      { label: "Audit events", value: String(snapshot.counts.auditEvents) },
    ],
    evidence: authorityEvidence.length
      ? authorityEvidence
      : [
          { label: "Runtime configuration", value: snapshot.runtime.configuration, source: "Server-side configuration registry" },
          { label: "Policy version", value: snapshot.runtime.policyVersion, source: "Default block boundary" },
          { label: "Portable store", value: "SQLite/D1 demonstration adapter", source: "PostgreSQL-compatible domain contract" },
          { label: "Measure packs", value: String(measurePacks.length), source: "Versioned server configuration" },
        ],
    activity: [
      { time: "Request", title: "Identity resolved", detail: actor.authentication, state: "done" },
      { time: "Authorize", title: "Role and scope evaluated", detail: actor.role + " · " + actor.scopeId, state: "done" },
      { time: "Assemble", title: "Context projected", detail: "No client evidence trusted", state: "done" },
      { time: "Current", title: "Operator review", detail: "Action remains server governed", state: "current" },
    ],
    steps: [
      { label: "Authenticate", detail: "Workspace identity", state: "done" },
      { label: "Authorize", detail: "Role, scope and purpose", state: "done" },
      { label: "Assemble", detail: "Server projections only", state: "done" },
      { label: "Act", detail: "Governed continuation", state: "current" },
    ],
    primary: primary(target),
  }, actor, snapshot);
}

export async function resolveWorkItemContext(
  reference: WorkItemReference,
  actor: RuntimeActor,
) {
  const snapshot = await runtimeSnapshot();
  return (
    resolveActionDetail(reference, actor, snapshot) ??
    resolveEpisodeDetail(reference, actor, snapshot) ??
    resolveEvidenceDetail(reference, actor, snapshot) ??
    resolveInsightDetail(reference, actor, snapshot) ??
    resolveAgentDetail(reference, actor, snapshot) ??
    resolveGenericDetail(reference, actor, snapshot)
  );
}
