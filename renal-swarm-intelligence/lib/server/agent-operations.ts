import operatingModel from "../../config/enterprise-operating-model.json";
import type {
  AgentCategory,
  AgentMessage,
  AgentOperationsSnapshot,
} from "../control-plane/contracts";
import { runtimeSnapshot } from "../runtime/engine";
import {
  activeConfigurationVersion,
  effectiveAgentManifests,
} from "./configuration-repository";

function categoryFor(mode: string): AgentCategory {
  const normalized = mode.toLowerCase();
  if (normalized.includes("deterministic") || normalized === "stream rules") return "deterministic";
  if (normalized.includes("constraint optimization")) return "optimization";
  if (normalized.includes("language extraction")) return "ai-agent";
  return "hybrid";
}

function descriptionFor(agentId: string) {
  const descriptions: Record<string, string> = {
    "continuity-cell": "Protect treatment continuity by detecting avoidable breaks and proposing human coordination.",
    "transition-cell": "Detect post-discharge gaps and request appropriate clinical or service review.",
    "assessment-cell": "Convert exact structured and free-text answers into cited fact candidates for human confirmation.",
    "capacity-cell": "Evaluate policy-compatible chair, staffing and machine options without changing schedules.",
    "access-cell": "Surface vascular-access observations and bounded nurse-review proposals.",
    "cms-cell": "Calculate deterministic readiness measures and prepare reviewable regulatory evidence.",
    "workforce-cell": "Detect coverage exposure and propose constraint-compatible staffing options.",
    "demand-cell": "Forecast referral demand against viable capacity and operating constraints.",
    "quality-cell": "Detect quality variation and prepare evidence-backed review briefs.",
    "experience-cell": "Identify grounded experience, equity and social-barrier themes for human follow-up.",
    "revenue-cell": "Detect eligibility and clean-claim risk and prepare reviewable claim evidence.",
    "asset-cell": "Protect treatment capacity through predictive maintenance and supply-risk proposals.",
  };
  return descriptions[agentId] ?? "A bounded renal-care intelligence specialist.";
}

function messagesFromRuntime(snapshot: Awaited<ReturnType<typeof runtimeSnapshot>>) {
  const messages: AgentMessage[] = [];
  for (const event of snapshot.events.slice(-6)) {
    messages.push({
      id: "signal-" + event.eventId,
      time: event.recordedTime,
      from: event.sourceSystem,
      to: "eligibility-router",
      kind: "signal",
      summary: event.eventType + " accepted for " + event.subjectType,
      status: "accepted",
      traceId: event.traceId,
      episodeId: event.correlationId,
    });
  }
  for (const execution of snapshot.executions.slice(-8)) {
    messages.push({
      id: "execution-" + execution.executionId,
      time: new Date().toISOString(),
      from: "eligibility-router",
      to: execution.agentId,
      kind: "execution",
      summary: execution.status + " in " + execution.latencyMs + " ms",
      status: execution.status === "failed" || execution.status === "blocked" ? "blocked" : "completed",
      traceId: execution.traceId,
      episodeId: null,
    });
  }
  for (const proposal of snapshot.proposals.slice(-6)) {
    const row = proposal as Record<string, unknown>;
    messages.push({
      id: "proposal-" + String(row.proposalId ?? crypto.randomUUID()),
      time: String(row.createdAt ?? new Date().toISOString()),
      from: String(row.agentId ?? "bounded-agent"),
      to: "outcome-harness",
      kind: "proposal",
      summary: String(row.proposalType ?? "bounded proposal"),
      status: String(row.status) === "blocked" ? "blocked" : "proposed",
      traceId: null,
      episodeId: row.episodeId ? String(row.episodeId) : null,
    });
  }
  for (const insight of snapshot.insights.slice(-4)) {
    messages.push({
      id: "insight-" + insight.insightId,
      time: new Date().toISOString(),
      from: insight.agentIds.join(" + "),
      to: "policy-arbiter",
      kind: "insight",
      summary: insight.title + (insight.conflicts.length ? " · conflict retained" : " · consensus retained"),
      status: insight.conflicts.length ? "review" : "completed",
      traceId: null,
      episodeId: null,
    });
  }
  return messages
    .sort((left, right) => right.time.localeCompare(left.time))
    .slice(0, 24);
}

export async function agentOperationsSnapshot(): Promise<AgentOperationsSnapshot> {
  const snapshot = await runtimeSnapshot();
  const manifests = await effectiveAgentManifests(snapshot.runtime.tenantId);
  const agents = manifests.map((manifest) => {
    const executions = snapshot.executions.filter((item) => item.agentId === manifest.id);
    const domains = operatingModel.domains.filter((domain) => domain.agentIds.includes(manifest.id));
    const costMicrounits = executions.reduce((sum, item) => sum + item.costMicrounits, 0);
    const averageLatencyMs = executions.length
      ? Math.round(executions.reduce((sum, item) => sum + item.latencyMs, 0) / executions.length)
      : 0;
    const failed = executions.filter((item) => item.status === "failed" || item.status === "blocked").length;
    const completed = executions.filter((item) => item.status === "completed").length;
    const abstained = executions.filter((item) => item.status === "abstained").length;
    const last = executions.at(-1);
    return {
      id: manifest.id,
      enabled: manifest.enabled,
      name: manifest.name,
      version: manifest.version,
      mode: manifest.mode,
      category: categoryFor(manifest.mode),
      description: descriptionFor(manifest.id),
      domains: domains.map((domain) => domain.label),
      ownerRoles: [...new Set(domains.flatMap((domain) => domain.ownerRoles))],
      inputs: manifest.inputs,
      outputs: manifest.outputs,
      allowedActions: manifest.allowedActions,
      approvalClass: manifest.approvalClass as "A" | "B" | "C" | "D",
      evaluationGateBasisPoints: Math.round(manifest.evalGate * 10000),
      killSwitchAvailable: manifest.killSwitch,
      dataBoundary: "Tenant, purpose and role scoped evidence only",
      memoryBoundary: "No private agent memory; shared evidence is provenance controlled",
      runtime: {
        status: !manifest.enabled ? "idle" as const : failed ? "watch" as const : executions.length ? "healthy" as const : "idle" as const,
        executions: executions.length,
        completed,
        failed,
        abstained,
        averageLatencyMs,
        costMicrounits,
        lastTraceId: last?.traceId ?? null,
      },
    };
  });
  return {
    generatedAt: new Date().toISOString(),
    configurationVersion: await activeConfigurationVersion(snapshot.runtime.tenantId),
    policyVersion: snapshot.runtime.policyVersion,
    runtimeStatus: snapshot.runtime.status === "active" ? "active" : "empty",
    agents,
    messages: messagesFromRuntime(snapshot),
    totals: {
      agents: agents.length,
      aiAgents: agents.filter((item) => item.category === "ai-agent").length,
      deterministic: agents.filter((item) => item.category === "deterministic").length,
      optimization: agents.filter((item) => item.category === "optimization").length,
      executions: snapshot.counts.executions,
      proposals: snapshot.counts.proposals,
      conflicts: snapshot.health.conflicts,
      costMicrounits: snapshot.health.totalCostMicrounits,
    },
    boundary: {
      browserAuthority: "none",
      agentAuthority: "proposal-only",
      policyDefault: "block",
      externalWritesEnabled: snapshot.runtime.externalWritesEnabled,
      transport: snapshot.runtime.eventTransport,
    },
  };
}
