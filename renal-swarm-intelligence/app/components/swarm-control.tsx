"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowRight,
  Bot,
  Building2,
  CheckCircle2,
  ChevronRight,
  Network,
  Pause,
  Play,
  RotateCcw,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  StepForward,
  Users,
  Zap,
} from "lucide-react";
import agentManifests from "../../config/agent-manifests.json";
import ecosystemDemo from "../../config/ecosystem-demo.json";
import operatingModel from "../../config/enterprise-operating-model.json";
import { fetchRuntimeSnapshot, mutateRuntime, type PolicySimulation, type RuntimeSnapshot } from "../../lib/runtime/client";
import type { NavigationId, RoleId } from "../../lib/types";
import type { OpenWorkflowDetail } from "../../lib/workflow-detail";
import { Eyebrow, ProgressBar, Tag } from "./ui";
type ScopeLevel = "enterprise" | "division" | "region" | "market" | "facility";
type TopologyView = "topology" | "propagation" | "regulatory" | "dependencies";
type ActionState = "idle" | "saving" | "recorded" | "error";

type DashboardAction = {
  id: string;
  rank: number;
  title: string;
  outcome: string;
  scope: string;
  ownerRole: string;
  due: string;
  value: string;
  confidence: number;
  actionClass: "A" | "B" | "C" | "D";
  evidenceCount: number;
  audience: string[];
  status: string;
};

const topologyViews: Record<TopologyView, { label: string; summary: string; nodes: { label: string; detail: string; tone: string }[] }> = {
  topology: {
    label: "Care topology",
    summary: "Typed edges connect the person, operating context, intervention, verified outcome and downstream measure.",
    nodes: [
      { label: "Patient", detail: "48.6K temporal states", tone: "mint" },
      { label: "Facility", detail: "312 digital twins", tone: "blue" },
      { label: "Intervention", detail: "human-authorized", tone: "amber" },
      { label: "Outcome", detail: "event verified", tone: "mint" },
      { label: "Measure", detail: "versioned logic", tone: "violet" },
    ],
  },
  propagation: {
    label: "Risk propagation",
    summary: "An emerging workforce signal is projected through facility constraints before it becomes patient risk.",
    nodes: [
      { label: "11 shift gaps", detail: "source signal", tone: "red" },
      { label: "3 facilities", detail: "constraint overlap", tone: "amber" },
      { label: "43 treatments", detail: "continuity exposure", tone: "red" },
      { label: "Coverage plan", detail: "bounded proposal", tone: "blue" },
      { label: "ROD review", detail: "human decision", tone: "mint" },
    ],
  },
  regulatory: {
    label: "Regulatory impact",
    summary: "A policy or source change resolves through measure packs, eligible records, owners and submission windows.",
    nodes: [
      { label: "CMS authority", detail: "effective snapshot", tone: "violet" },
      { label: "Measure pack", detail: "2026.2", tone: "blue" },
      { label: "74 facilities", detail: "division impact", tone: "amber" },
      { label: "4,237 rows", detail: "recalculate", tone: "blue" },
      { label: "Readiness", detail: "−1.4 pts simulated", tone: "red" },
    ],
  },
  dependencies: {
    label: "Swarm dependencies",
    summary: "Cells exchange typed proposals through the harness; they do not call one another or write to care systems directly.",
    nodes: [
      { label: "Kafka facts", detail: "signed envelopes", tone: "violet" },
      { label: "Workforce cell", detail: "97% eval gate", tone: "blue" },
      { label: "Capacity cell", detail: "98% eval gate", tone: "blue" },
      { label: "Policy harness", detail: "default deny", tone: "amber" },
      { label: "NBA queue", detail: "human review", tone: "mint" },
    ],
  },
};

const messageTone: Record<string, "neutral" | "mint" | "amber" | "red" | "blue" | "violet"> = {
  fact: "mint",
  signal: "amber",
  episode: "red",
  proposal: "blue",
  control: "violet",
  measure: "blue",
  insight: "mint",
  action: "violet",
};

export default function SwarmControl({
  onNavigate,
  onOpenDetail,
  roleId: roleIdProp,
  onRoleChange,
}: {
  onNavigate: (id: NavigationId) => void;
  onOpenDetail: OpenWorkflowDetail;
  roleId?: RoleId;
  onRoleChange?: (id: RoleId) => void;
}) {
  const [internalRoleId, setInternalRoleId] = useState<RoleId>(roleIdProp ?? "dvp");
  const roleId = roleIdProp ?? internalRoleId;

  // Sync when parent changes the controlled prop
  useEffect(() => {
    if (roleIdProp) setInternalRoleId(roleIdProp);
  }, [roleIdProp]);

  function handleRoleChange(id: RoleId) {
    setInternalRoleId(id);
    onRoleChange?.(id);
  }
  const [topologyView, setTopologyView] = useState<TopologyView>("topology");
  const [selectedAgentId, setSelectedAgentId] = useState(agentManifests[0].id);
  const [threshold, setThreshold] = useState(82);
  const [playing, setPlaying] = useState(false);
  const [actionStates, setActionStates] = useState<Record<string, ActionState>>({});
  const [runtime, setRuntime] = useState<RuntimeSnapshot | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [runtimeBusy, setRuntimeBusy] = useState(true);
  const [simulation, setSimulation] = useState<PolicySimulation | null>(null);
  const [lastNotice, setLastNotice] = useState<string | null>(null);

  const role = operatingModel.roles.find((item) => item.id === roleId) ?? operatingModel.roles[1];
  const scope = operatingModel.scopePath.find((item) => item.level === role.scopeLevel) ?? operatingModel.scopePath[0];
  const metrics = ecosystemDemo.metricsByLevel[role.scopeLevel as ScopeLevel];
  const selectedAgent = agentManifests.find((agent) => agent.id === selectedAgentId) ?? agentManifests[0];
  const selectedDomain = operatingModel.domains.find((domain) => domain.agentIds.includes(selectedAgent.id));
  const activeTopology = useMemo(() => {
    const view = topologyViews[topologyView];
    if (!runtime || topologyView !== "topology") return view;
    return {
      ...view,
      nodes: view.nodes.map((node) => {
        if (node.label === "Patient") return { ...node, detail: `${runtime.counts.temporalStates} temporal states` };
        if (node.label === "Facility") return { ...node, detail: `${runtime.topology.nodes.filter((item) => item.type === "facility").length} projected twins` };
        if (node.label === "Intervention") return { ...node, detail: `${runtime.counts.commands} governed commands` };
        if (node.label === "Outcome") return { ...node, detail: `${runtime.counts.acknowledgements} verified acks` };
        if (node.label === "Measure") return { ...node, detail: `${runtime.counts.measures} calculated results` };
        return node;
      }),
    };
  }, [runtime, topologyView]);

  const nextBestActions = useMemo<DashboardAction[]>(() => {
    const actions: DashboardAction[] = runtime?.actions.length ? runtime.actions.map((action) => ({
      id: action.actionId,
      rank: action.rank,
      title: action.title,
      outcome: action.outcome,
      scope: action.scopeId,
      ownerRole: action.ownerRole.toUpperCase(),
      due: new Date(action.dueAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
      value: action.valueLabel,
      confidence: action.confidenceBasisPoints / 10000,
      actionClass: action.actionClass,
      evidenceCount: action.evidenceCount,
      audience: action.audience,
      status: action.status,
    })) : ecosystemDemo.nextBestActions.map((action) => ({ ...action, actionClass: action.actionClass as DashboardAction["actionClass"], status: "reference-only" }));
    return actions
      .sort((left, right) => Number(right.audience.includes(roleId)) - Number(left.audience.includes(roleId)) || left.rank - right.rank)
      .slice(0, 5);
  }, [roleId, runtime]);

  const visibleMessages = useMemo(() => runtime?.events.length ? runtime.events.slice(0, 6).map((event) => ({
    time: new Date(event.recordedTime).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    topic: event.eventType,
    key: event.subjectId,
    partition: event.sourceSystem,
    offset: event.traceId.slice(0, 8),
    type: messageType(event.eventType),
    summary: messageSummary(event.eventType, event.payload),
  })) : ecosystemDemo.messages.slice(0, 6), [runtime]);

  const stepReplay = useCallback(async () => {
    if (runtimeBusy) return;
    setRuntimeBusy(true);
    try {
      const result = await mutateRuntime<{ complete: boolean; snapshot: RuntimeSnapshot }>("step", roleId);
      setRuntime(result.snapshot);
      if (result.complete || result.snapshot.counts.events >= result.snapshot.runtime.replayEventsAvailable) setPlaying(false);
      setRuntimeError(null);
    } catch (error) {
      setPlaying(false);
      setRuntimeError(error instanceof Error ? error.message : "Replay step failed");
    } finally {
      setRuntimeBusy(false);
    }
  }, [roleId, runtimeBusy]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        let snapshot = await fetchRuntimeSnapshot();
        if (snapshot.runtime.status === "empty") snapshot = await mutateRuntime<RuntimeSnapshot>("replay", roleId);
        if (active) setRuntime(snapshot);
      } catch (error) {
        if (active) setRuntimeError(error instanceof Error ? error.message : "Runtime unavailable");
      } finally {
        if (active) setRuntimeBusy(false);
      }
    })();
    return () => { active = false; };
  }, [roleId]);

  useEffect(() => {
    if (!runtime?.counts.events) return;
    const timer = window.setTimeout(() => {
      void mutateRuntime<PolicySimulation>("simulate", roleId, { thresholdBasisPoints: threshold * 100 })
        .then(setSimulation)
        .catch((error) => setRuntimeError(error instanceof Error ? error.message : "Simulation failed"));
    }, 260);
    return () => window.clearTimeout(timer);
  }, [roleId, runtime?.counts.events, threshold]);

  useEffect(() => {
    if (!playing || runtimeBusy) return;
    const timer = window.setTimeout(() => void stepReplay(), 950);
    return () => window.clearTimeout(timer);
  }, [playing, runtimeBusy, runtime?.counts.events, stepReplay]);

  async function routeAction(actionId: string) {
    setActionStates((current) => ({ ...current, [actionId]: "saving" }));
    setLastNotice(null);
    try {
      const command = runtime?.commands.find((item) => item.actionId === actionId && item.status !== "acknowledged");
      if (command) {
        await mutateRuntime("acknowledge", roleId, { commandId: command.commandId });
        setLastNotice(`${command.commandId} acknowledged; outcome and calculated measure were updated.`);
      } else {
        const result = await mutateRuntime<{ approved: boolean; commandId?: string; reasons: string[] }>("approve", roleId, { actionId });
        if (!result.approved) throw new Error(result.reasons.join(" · "));
        setLastNotice(`${result.commandId} persisted to the Kafka outbox. External writes remain disabled.`);
      }
      setRuntime(await fetchRuntimeSnapshot());
      setActionStates((current) => ({ ...current, [actionId]: "recorded" }));
    } catch (error) {
      setLastNotice(error instanceof Error ? error.message : "Action failed");
      setActionStates((current) => ({ ...current, [actionId]: "error" }));
    }
  }

  async function startReplay() {
    setRuntimeBusy(true);
    try {
      if ((runtime?.counts.events ?? 0) >= (runtime?.runtime.replayEventsAvailable ?? 0)) {
        await mutateRuntime("reset", roleId);
        setRuntime(await fetchRuntimeSnapshot());
      }
      setPlaying(true);
      setRuntimeError(null);
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : "Replay failed");
    } finally {
      setRuntimeBusy(false);
    }
  }

  async function resetReplay() {
    setPlaying(false);
    setRuntimeBusy(true);
    try {
      await mutateRuntime("reset", roleId);
      setRuntime(await fetchRuntimeSnapshot());
      setSimulation(null);
      setActionStates({});
      setRuntimeError(null);
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : "Reset failed");
    } finally {
      setRuntimeBusy(false);
    }
  }

  function openMetricDetail(metric: (typeof metrics)[number]) {
    onOpenDetail({
      id: `METRIC-${scope.level.toUpperCase()}-${metric.label.replaceAll(" ", "-").toUpperCase()}`,
      kind: "Enterprise metric",
      title: metric.label,
      summary: `${metric.detail} The displayed value is resolved at the ${scope.level} scope for the ${role.shortLabel} operating perspective.`,
      status: metric.tone === "red" ? "Needs attention" : metric.tone === "amber" ? "Watch" : "On plan",
      tone: metric.tone === "red" ? "red" : metric.tone === "amber" ? "amber" : "mint",
      owner: role.label,
      scope: scope.label,
      metrics: [{ label: "Current", value: metric.value, detail: metric.detail }, { label: "Facilities", value: String(scope.facilities) }, { label: "Patients", value: scope.patients.toLocaleString() }],
      evidence: [{ label: "Scope model", value: `${scope.level} · ${scope.id}`, source: "enterprise-operating-model@2026.1.0" }, { label: "Runtime fabric", value: `${runtime?.counts.events ?? 0} persisted events`, source: runtime?.runtime.configuration ?? "reference portfolio" }],
      steps: [{ label: "Observe", detail: "Scope evidence aggregated", state: "done" }, { label: "Understand", detail: "Metric and dependencies calculated", state: "done" }, { label: "Coordinate", detail: metric.tone === "red" ? "Owner action required" : "Portfolio monitoring", state: metric.tone === "red" ? "current" : "done" }, { label: "Verify", detail: "Outcome trend retained", state: metric.tone === "red" ? "pending" : "current" }],
      primary: { label: "Open Executive Outcomes", target: "executive" },
    });
  }

  function openTopologyDetail(node: (typeof activeTopology.nodes)[number]) {
    const target: NavigationId = node.label === "Patient" ? "patient" : node.label === "Facility" ? "facility" : node.label === "Measure" || topologyView === "regulatory" ? "cms" : node.label === "Intervention" || node.label === "Outcome" ? "command" : topologyView === "dependencies" ? "assurance" : "intelligence";
    onOpenDetail({
      id: `TOPOLOGY-${topologyView.toUpperCase()}-${node.label.replaceAll(" ", "-").toUpperCase()}`,
      kind: activeTopology.label,
      title: node.label,
      summary: activeTopology.summary,
      status: node.detail,
      tone: node.tone as "mint" | "blue" | "amber" | "red" | "violet",
      owner: role.label,
      scope: scope.label,
      metrics: [{ label: "Projection", value: node.detail }, { label: "Perspective", value: activeTopology.label }, { label: "Edges", value: String(Math.max(0, activeTopology.nodes.length - 1)) }],
      evidence: [{ label: "Topology projection", value: node.label, source: `${runtime?.counts.topologyNodes ?? 0} D1 nodes · ${runtime?.counts.topologyEdges ?? 0} typed edges` }, { label: "Current view", value: activeTopology.summary, source: "Versioned enterprise topology configuration" }],
      steps: [{ label: "Source", detail: "Canonical facts accepted", state: "done" }, { label: "Relate", detail: "Typed edges projected", state: "done" }, { label: "Interpret", detail: `${activeTopology.label} selected`, state: "current" }, { label: "Act", detail: `Continue in ${target}`, state: "pending" }],
      primary: { label: `Open ${target === "cms" ? "CMS Operations" : target === "facility" ? "Facility Operations" : target === "patient" ? "Patient Intelligence" : target === "command" ? "Outcome Command" : target === "assurance" ? "AI Assurance" : "Shared Intelligence"}`, target },
    });
  }

  function openActionDetail(action: DashboardAction) {
    const command = runtime?.commands.find((item) => item.actionId === action.id);
    const completed = action.status === "completed";
    onOpenDetail({
      id: action.id,
      kind: "Next-best action",
      title: action.title,
      summary: action.outcome,
      status: completed ? "Outcome verified" : command ? "Command emitted" : action.status,
      tone: completed ? "mint" : action.status === "blocked" ? "red" : "amber",
      owner: action.ownerRole,
      scope: action.scope,
      due: action.due,
      metrics: [{ label: "Estimated value", value: action.value }, { label: "Consensus", value: `${Math.round(action.confidence * 100)}%` }, { label: "Evidence", value: String(action.evidenceCount) }, { label: "Action class", value: action.actionClass }],
      evidence: [{ label: "Contributing cells", value: runtime?.actions.find((item) => item.actionId === action.id)?.agentIds.join(" · ") || "Reference swarm contributors", source: `${action.evidenceCount} retained evidence objects` }, { label: "Policy decision", value: action.status, source: runtime?.runtime.policyVersion ?? "reference action boundary" }, ...(command ? [{ label: "Durable command", value: command.commandId, source: command.status }] : [])],
      activity: [{ time: "Observed", title: "Signals joined", detail: `${action.evidenceCount} evidence objects entered the outcome harness`, state: "done" }, { time: "Proposed", title: "Swarm ranked action", detail: `${Math.round(action.confidence * 100)}% bounded consensus`, state: "done" }, { time: command ? "Emitted" : "Current", title: command ? "Human authorization recorded" : "Human review required", detail: command?.commandId ?? `Class ${action.actionClass} server policy gate`, state: command ? "done" : "current" }, ...(completed ? [{ time: "Verified", title: "Outcome acknowledged", detail: "Downstream acknowledgement and calculated measure retained", state: "done" as const }] : [])],
      steps: [{ label: "Observe", detail: "Evidence joined", state: "done" }, { label: "Understand", detail: "Swarm proposal ranked", state: "done" }, { label: "Coordinate", detail: command ? "Authorized command emitted" : "Awaiting owner review", state: command ? "done" : "current" }, { label: "Verify", detail: completed ? "Acknowledgement retained" : "Awaiting downstream outcome", state: completed ? "done" : "pending" }],
      primary: { label: "Continue in Outcome Command", target: "command" },
    });
  }

  function openMessageDetail(message: (typeof visibleMessages)[number]) {
    onOpenDetail({
      id: String(message.offset),
      kind: "Canonical event",
      title: message.topic,
      summary: message.summary,
      status: "Accepted",
      tone: messageTone[message.type] ?? "neutral",
      owner: String(message.partition),
      scope: String(message.key),
      metrics: [{ label: "Recorded", value: String(message.time) }, { label: "Type", value: String(message.type) }, { label: "Trace", value: String(message.offset) }],
      evidence: [{ label: "Partition key", value: String(message.key), source: "canonical-event@1" }, { label: "Source system", value: String(message.partition), source: `trace ${message.offset}` }, { label: "Integrity", value: "Payload hash verified before projection", source: runtime?.runtime.configuration ?? "runtime" }],
      steps: [{ label: "Ingest", detail: "Envelope authenticated and validated", state: "done" }, { label: "Persist", detail: "D1 event + evidence retained", state: "done" }, { label: "Evaluate", detail: "Eligible cells traced", state: "done" }, { label: "Resolve", detail: "Inspect downstream trace", state: "current" }],
      primary: { label: "Open AI Assurance", target: "assurance" },
    });
  }

  function openInsightDetail(insight: { insightId: string; title: string; summary: string; confidenceBasisPoints: number; scopeId: string; state: string; agentIds: string[]; conflicts: string[] }) {
    onOpenDetail({
      id: insight.insightId,
      kind: "Swarm insight",
      title: insight.title,
      summary: insight.summary,
      status: insight.conflicts.length ? `${insight.conflicts.length} conflict retained` : insight.state,
      tone: insight.conflicts.length ? "amber" : "mint",
      owner: role.label,
      scope: insight.scopeId,
      metrics: [{ label: "Confidence", value: `${Math.round(insight.confidenceBasisPoints / 100)}%` }, { label: "Contributors", value: String(insight.agentIds.length) }, { label: "Conflicts", value: String(insight.conflicts.length) }],
      evidence: insight.agentIds.map((agentId, index) => ({ label: `Contributor ${index + 1}`, value: agentId, source: "Bounded agent execution" })).concat(insight.conflicts.map((conflict, index) => ({ label: `Retained conflict ${index + 1}`, value: conflict, source: "No silent consensus collapse" }))),
      steps: [{ label: "Observe", detail: "Cross-domain signals grouped", state: "done" }, { label: "Contribute", detail: `${insight.agentIds.length} cells proposed`, state: "done" }, { label: "Resolve", detail: insight.conflicts.length ? "Human must resolve retained conflict" : "Policy-compatible synthesis", state: insight.conflicts.length ? "current" : "done" }, { label: "Act", detail: "Inspect ranked NBA", state: "pending" }],
      primary: { label: "Open Shared Intelligence", target: "intelligence" },
    });
  }

  return (
    <div className="view-stack ecosystem-view">
      <header className="view-heading ecosystem-heading">
        <div>
          <Eyebrow>Swarm Control · enterprise renal-care cockpit</Eyebrow>
          <h1>See the whole system. Decide at the right level.</h1>
          <p>Enterprise topology, cross-facility intelligence, next-best actions, governed agents and event traffic in one operational view.</p>
        </div>
        <div className="heading-actions">
          <Tag tone={runtime?.runtime.status === "active" ? "mint" : runtimeError ? "red" : "violet"}><Sparkles size={11} /> {runtimeBusy ? "Connecting runtime" : runtime?.runtime.status === "active" ? "Persistent runtime active" : runtimeError ? "Reference fallback" : "Synthetic enterprise replay"}</Tag>
          <button className="button button-secondary" onClick={() => onNavigate("admin")} type="button"><Settings2 size={15} /> Launch & configure</button>
        </div>
      </header>

      <section className="enterprise-context panel">
        <div className="role-perspective">
          <span className="context-icon"><Users size={17} /></span>
          <label><small>Operator perspective</small><select value={roleId} onChange={(event) => handleRoleChange(event.target.value as RoleId)}>{operatingModel.roles.map((item) => <option value={item.id} key={item.id}>{item.shortLabel} · {item.label}</option>)}</select></label>
          <p>{role.purpose}</p>
        </div>
        <div className="scope-path" aria-label="Enterprise hierarchy">
          {operatingModel.scopePath.map((item, index) => <div className={item.level === scope.level ? "is-active" : ""} key={item.id}><span><small>{item.level}</small><strong>{item.label}</strong></span>{index < operatingModel.scopePath.length - 1 ? <ChevronRight size={13} /> : null}</div>)}
        </div>
        <div className="scope-count"><Building2 size={17} /><span><strong>{scope.facilities}</strong><small>facilities</small></span><span><strong>{scope.patients.toLocaleString()}</strong><small>patients</small></span></div>
      </section>

      <section className="ecosystem-metrics" aria-label={`${scope.label} outcome metrics`}>
        {metrics.map((metric) => <button className={`ecosystem-metric ecosystem-metric-${metric.tone} drillable-surface`} type="button" onClick={() => openMetricDetail(metric)} aria-label={`Inspect ${metric.label}`} key={metric.label}><span>{metric.label}</span><strong>{metric.value}</strong><small>{metric.detail}</small></button>)}
      </section>

      <section className="what-if-panel panel">
        <div className="what-if-heading"><span className="context-icon"><SlidersHorizontal size={17} /></span><div><Eyebrow>Server-side policy replay · isolated sandbox</Eyebrow><strong>What changes if the escalation threshold moves?</strong></div></div>
        <label className="threshold-control"><span>Current policy <strong>{threshold}%</strong></span><input aria-label="Escalation confidence threshold" type="range" min="70" max="95" value={threshold} onChange={(event) => setThreshold(Number(event.target.value))} /></label>
        <div className="simulation-impact"><span><small>Episodes surfaced</small><strong>{simulation?.episodesSurfaced ?? "—"}</strong></span><span><small>Treatments protected</small><strong>{simulation?.treatmentsProtected ?? "—"}</strong></span><span><small>Human reviews</small><strong>{simulation?.humanReviews ?? "—"}</strong></span><span><small>Estimated value</small><strong>{simulation ? `$${Math.round(simulation.estimatedValueDollars / 1000)}K` : "—"}</strong></span></div>
        <Tag tone="amber"><ShieldCheck size={11} /> {simulation ? `${simulation.eventsReplayed} persisted events · ${simulation.blockedActions} blocked` : "simulation isolated"}</Tag>
      </section>

      <section className="ecosystem-command-grid">
        <article className="panel topology-cockpit">
          <div className="panel-title-row"><div><Eyebrow>Enterprise renal-care topology</Eyebrow><h2>Relationships, propagation and impact</h2></div><button className="button button-ghost" onClick={() => onNavigate("intelligence")} type="button">Open shared canvas <ArrowRight size={14} /></button></div>
          <div className="topology-tabs" role="tablist" aria-label="Topology perspectives">{(Object.keys(topologyViews) as TopologyView[]).map((view) => <button className={topologyView === view ? "is-active" : ""} role="tab" aria-selected={topologyView === view} onClick={() => setTopologyView(view)} type="button" key={view}>{topologyViews[view].label}</button>)}</div>
          <div className="topology-flow" aria-label={activeTopology.label}>
            {activeTopology.nodes.map((node, index) => <div className="topology-flow-step" key={node.label}><button className={`topology-node topology-node-${node.tone} drillable-surface`} type="button" onClick={() => openTopologyDetail(node)}><strong>{node.label}</strong><small>{node.detail}</small></button>{index < activeTopology.nodes.length - 1 ? <span className="topology-edge"><ArrowRight size={14} /><i /></span> : null}</div>)}
          </div>
          <p className="topology-summary"><Network size={14} /> {activeTopology.summary}</p>
          <div className="domain-pulse">
            {ecosystemDemo.domainPulse.map((domain) => <button onClick={() => { const configured = operatingModel.domains.find((item) => item.id === domain.id)?.agentIds[0]; if (configured) setSelectedAgentId(configured); onOpenDetail({ id: `DOMAIN-${domain.id}`, kind: "Outcome domain", title: domain.label, summary: domain.detail, status: domain.status, tone: domain.status === "risk" ? "red" : domain.status === "watch" ? "amber" : "mint", owner: role.label, scope: scope.label, metrics: [{ label: "Current", value: domain.value }, { label: "Configured cells", value: String(operatingModel.domains.find((item) => item.id === domain.id)?.agentIds.length ?? 0) }], evidence: [{ label: "Domain configuration", value: domain.id, source: "enterprise-operating-model@2026.1.0" }], steps: [{ label: "Observe", detail: "Domain signal projected", state: "done" }, { label: "Understand", detail: "Cell contribution selected", state: "current" }, { label: "Coordinate", detail: "Inspect bounded agent", state: "pending" }, { label: "Verify", detail: "Outcome measure pending", state: "pending" }], primary: { label: "Open Shared Intelligence", target: "intelligence" } }); }} type="button" key={domain.id}><i className={`domain-status domain-status-${domain.status}`} /><span><small>{domain.label}</small><strong>{domain.value}</strong><em>{domain.detail}</em></span></button>)}
          </div>
        </article>

        <article className="panel nba-cockpit">
          <div className="panel-title-row"><div><Eyebrow>Next-best actions · {role.shortLabel}</Eyebrow><h2>Ranked by outcome, urgency and policy</h2></div><Tag tone="mint"><Zap size={11} /> {runtime ? `${nextBestActions.length} persisted` : `${nextBestActions.length} reference`}</Tag></div>
          <div className="nba-list">
            {nextBestActions.map((action) => {
              const relevant = action.audience.includes(roleId);
              const state = actionStates[action.id] ?? "idle";
              const command = runtime?.commands.find((item) => item.actionId === action.id);
              const completed = action.status === "completed";
              const label = completed ? "Outcome verified" : command?.status === "emitted" ? "Acknowledge downstream outcome" : `Approve ${action.title}`;
              return <article className={relevant ? "is-relevant" : ""} key={action.id}><span className="nba-rank">{action.rank}</span><button className="nba-copy nba-detail-trigger" type="button" onClick={() => openActionDetail(action)} aria-label={`Inspect ${action.title}`}><div><strong>{action.title}</strong><Tag tone={completed ? "mint" : action.status === "blocked" ? "red" : relevant ? "mint" : "neutral"}>{completed ? "verified" : action.status === "emitted" ? "command emitted" : relevant ? "your scope" : action.scope}</Tag></div><p>{action.outcome} · {action.value} · {Math.round(action.confidence * 100)}% consensus</p><small>{action.ownerRole} · due {action.due} · {action.evidenceCount} evidence objects · Class {action.actionClass}</small></button><button className="nba-action-button" title={label} aria-label={label} disabled={!runtime || state === "saving" || completed} onClick={() => routeAction(action.id)} type="button">{state === "saving" ? <Activity size={14} /> : completed || state === "recorded" ? <CheckCircle2 size={14} /> : <ChevronRight size={15} />}</button></article>;
            })}
          </div>
          <div className="nba-boundary"><ShieldCheck size={15} /><span>{lastNotice ?? "Ranking is advisory. The server re-checks role, scope and approval class before creating a durable command."}</span></div>
        </article>

        <article className="panel message-cockpit">
          <div className="panel-title-row"><div><Eyebrow>Event fabric · D1 ledger + Kafka bridge</Eyebrow><h2>Watch the enterprise think in events</h2></div><div className="message-controls"><button onClick={() => playing ? setPlaying(false) : void startReplay()} disabled={runtimeBusy} aria-label={playing ? "Pause replay" : "Play replay"} type="button">{playing ? <Pause size={14} /> : <Play size={14} />}</button><button onClick={() => { setPlaying(false); void stepReplay(); }} disabled={runtimeBusy || (runtime?.counts.events ?? 0) >= (runtime?.runtime.replayEventsAvailable ?? 0)} aria-label="Step one event" type="button"><StepForward size={14} /></button><button onClick={() => void resetReplay()} disabled={runtimeBusy} aria-label="Reset persisted replay" type="button"><RotateCcw size={14} /></button></div></div>
          <div className="message-status"><span className={playing ? "is-live" : ""}><i /> {runtimeBusy ? "runtime working" : playing ? "replay running" : "runtime ready"}</span><span>{runtime?.counts.events ?? 0} / {runtime?.runtime.replayEventsAvailable ?? "—"} persisted events</span><span>contract · canonical-event@1</span><span>outbox · {runtime?.health.pendingOutbox ?? 0} pending</span></div>
          <div className="message-table">
            <div className="message-head"><span>Time</span><span>Topic / message</span><span>Key</span><span>Source / trace</span><span>Type</span></div>
            {visibleMessages.map((message, index) => <button type="button" onClick={() => openMessageDetail(message)} className={index === 0 ? "message-row is-new drillable-surface" : "message-row drillable-surface"} key={`${message.topic}-${message.offset}`}><time>{message.time}</time><span><strong>{message.topic}</strong><small>{message.summary}</small></span><code>{message.key}</code><code>{message.partition}/{message.offset}</code><Tag tone={messageTone[message.type] ?? "neutral"}>{message.type}</Tag></button>)}
            {!visibleMessages.length ? <div className="message-row"><time>—</time><span><strong>No events persisted</strong><small>Use play or step to execute the server-side replay.</small></span><code>—</code><code>—</code><Tag tone="neutral">empty</Tag></div> : null}
          </div>
          {runtimeError ? <div className="nba-boundary"><ShieldCheck size={15} /><span>{runtimeError}</span></div> : null}
        </article>

        <article className="panel agent-cockpit">
          <div className="panel-title-row"><div><Eyebrow>Swarm configuration</Eyebrow><h2>{agentManifests.length} bounded cells</h2></div><Tag tone="violet"><ShieldCheck size={11} /> {runtime?.counts.executions ?? 0} traced runs</Tag></div>
          <div className="agent-selector" aria-label="Agent manifest registry">{agentManifests.map((agent) => <button className={agent.id === selectedAgent.id ? "is-active" : ""} title={agent.name} onClick={() => setSelectedAgentId(agent.id)} type="button" key={agent.id}><Bot size={13} /><span>{agent.name}</span></button>)}</div>
          <div className="agent-inspector">
            <div className="agent-inspector-top"><span className="agent-glyph"><Bot size={18} /></span><div><strong>{selectedAgent.name}</strong><small>{selectedAgent.id}@{selectedAgent.version} · {selectedDomain?.label ?? "Shared service"}</small></div><Tag tone="mint">Class {selectedAgent.approvalClass}</Tag></div>
            <div className="agent-config-grid"><span><small>Runtime executions</small><strong>{runtime?.executions.filter((item) => item.agentId === selectedAgent.id).length ?? 0}</strong></span><span><small>Eval gate</small><strong>{Math.round(selectedAgent.evalGate * 100)}%</strong></span><span><small>Kill switch</small><strong>{selectedAgent.killSwitch ? "Enabled" : "Disabled"}</strong></span></div>
            <div className="agent-topics"><div><small>Consumes</small><p>{selectedAgent.inputs.join(" · ")}</p></div><ArrowRight size={14} /><div><small>Produces</small><p>{selectedAgent.outputs.join(" · ")}</p></div></div>
            <div className="agent-allowlist"><small>Allowed actions only</small><div>{selectedAgent.allowedActions.map((action) => <span key={action}>{action}</span>)}</div></div>
            <div className="agent-gate"><span>Release evaluation</span><strong>{Math.round(selectedAgent.evalGate * 100)}%</strong></div><ProgressBar value={selectedAgent.evalGate * 100} tone="mint" />
          </div>
          <button className="button button-secondary agent-config-button" onClick={() => onNavigate("configuration")} type="button"><Settings2 size={14} /> Open versioned manifest</button>
        </article>
      </section>

      <section className="swarm-insight-strip panel">
        <div className="insight-strip-title"><span className="context-icon"><Network size={17} /></span><div><Eyebrow>Cross-facility swarm intelligence</Eyebrow><strong>{runtime?.counts.insights ?? 0} persisted insights · {runtime?.health.conflicts ?? 0} retained conflicts · no autonomous action</strong></div></div>
        {(runtime?.insights.length ? runtime.insights : ecosystemDemo.swarmInsights.slice(0, 3).map((insight) => ({ insightId: insight.id, title: insight.title, summary: insight.summary, confidenceBasisPoints: Math.round(insight.confidence * 10000), scopeId: insight.scope, state: insight.state, agentIds: insight.agentIds, conflicts: [] }))).map((insight) => <button className="swarm-insight-card drillable-surface" type="button" onClick={() => openInsightDetail(insight)} key={insight.insightId}><div><Tag tone={insight.conflicts.length ? "amber" : "mint"}>{Math.round(insight.confidenceBasisPoints / 100)}%</Tag><small>{insight.scopeId}</small></div><strong>{insight.title}</strong><p>{insight.summary}</p><span>{insight.agentIds.length} cells · {insight.conflicts.length ? `${insight.conflicts.length} conflict` : insight.state}</span></button>)}
      </section>
    </div>
  );
}

function messageType(eventType: string) {
  if (eventType.startsWith("adt.")) return "episode";
  if (eventType.startsWith("assessment.")) return "fact";
  if (eventType.startsWith("cms.") || eventType.startsWith("quality.")) return "measure";
  if (eventType.startsWith("service-coordination.")) return "action";
  return "signal";
}

function messageSummary(eventType: string, payload: Record<string, unknown>) {
  if (eventType === "assessment.response.v1") return `Exact answer retained; ${String(payload.extractedConcept ?? "fact candidate")} is human-confirmed.`;
  if (eventType === "adt.discharge.v2") return "Discharge accepted; next treatment confirmation is unresolved.";
  if (eventType === "facility.capacity.changed.v2") return `Station ${String(payload.station ?? "—")} capacity projected with machine and staffing constraints.`;
  if (eventType === "staffing.coverage.changed.v1") return `${String(payload.shiftGaps ?? "—")} gaps expose ${String(payload.exposedTreatments ?? "—")} treatments across the region.`;
  if (eventType === "cms.submission.gap.v1") return `${String(payload.incompleteRows ?? "—")} denominator rows require mapping reconciliation.`;
  if (eventType === "claim.status.changed.v2") return `Revenue variance traced to mapping ${String(payload.suspectedMappingVersion ?? "unknown")}.`;
  if (eventType === "machine.maintenance.signal.v1") return `${String(payload.machinesDue ?? "—")} machines need sequenced maintenance windows.`;
  return "Canonical event accepted, evidence recorded and eligible cells evaluated.";
}
