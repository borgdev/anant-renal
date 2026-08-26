"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowRight,
  Bot,
  Braces,
  BrainCircuit,
  Cable,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Coins,
  GitBranch,
  LockKeyhole,
  MessagesSquare,
  Play,
  RefreshCw,
  Route,
  Settings2,
  ShieldCheck,
  Sparkles,
  Waypoints,
} from "lucide-react";
import {
  fetchAgentOperations,
  mutateAgentOperations,
} from "../../lib/control-plane/client";
import type {
  AgentCategory,
  AgentOperationsSnapshot,
  AgentView,
} from "../../lib/control-plane/contracts";
import type { NavigationId } from "../../lib/types";
import type { OpenWorkflowDetail } from "../../lib/workflow-detail";
import { Eyebrow, ProgressBar, Tag } from "./ui";

type CategoryFilter = "all" | AgentCategory;

const categoryLabels: Record<CategoryFilter, string> = {
  all: "All specialists",
  "ai-agent": "AI agents",
  deterministic: "Deterministic",
  optimization: "Optimization",
  hybrid: "Hybrid",
};

function categoryTone(category: AgentCategory) {
  if (category === "ai-agent") return "violet" as const;
  if (category === "deterministic") return "mint" as const;
  if (category === "optimization") return "blue" as const;
  return "amber" as const;
}

function statusTone(status: AgentView["runtime"]["status"]) {
  return status === "healthy" ? "mint" as const : status === "watch" ? "amber" as const : "neutral" as const;
}

export default function AgentOperations({
  onNavigate,
  onOpenDetail,
}: {
  onNavigate: (id: NavigationId) => void;
  onOpenDetail: OpenWorkflowDetail;
}) {
  const [snapshot, setSnapshot] = useState<AgentOperationsSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState("assessment-cell");
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [busy, setBusy] = useState<"replay" | "step" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void fetchAgentOperations()
      .then((result) => {
        if (active) setSnapshot(result);
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : "Agent control plane unavailable");
      });
    return () => {
      active = false;
    };
  }, []);

  const visibleAgents = useMemo(
    () => snapshot?.agents.filter((agent) => category === "all" || agent.category === category) ?? [],
    [category, snapshot],
  );
  const selected = snapshot?.agents.find((agent) => agent.id === selectedId) ?? visibleAgents[0] ?? snapshot?.agents[0];

  async function run(action: "replay" | "step") {
    setBusy(action);
    setError(null);
    try {
      setSnapshot(await mutateAgentOperations(action));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Agent operation failed");
    } finally {
      setBusy(null);
    }
  }

  function inspectAgent(agent: AgentView) {
    onOpenDetail({
      id: agent.id,
      kind: "AI agent",
      title: agent.name,
      summary: agent.description,
      status: agent.runtime.status,
      owner: agent.ownerRoles.join(" · "),
      scope: "Server-side agent runtime",
      primary: { label: "Open AI Assurance", target: "assurance" },
    });
  }

  return (
    <div className="view-stack agent-operations-view">
      <header className="view-heading agent-operations-heading">
        <div>
          <Eyebrow>Agent Operations · governed specialist workforce</Eyebrow>
          <h1>The agents reason. The harness remains in control.</h1>
          <p>Inspect manifests, runtime performance, proposal boundaries and the server-side message flow connecting every specialist to an outcome.</p>
        </div>
        <div className="heading-actions">
          <Tag tone={snapshot?.runtimeStatus === "active" ? "mint" : "amber"}><Activity size={11} /> {snapshot?.runtimeStatus === "active" ? "Runtime active" : "Runtime idle"}</Tag>
          <button className="button button-secondary" type="button" onClick={() => onNavigate("admin")}><Settings2 size={15} /> Configure agents</button>
          <button className="button button-primary" type="button" disabled={Boolean(busy)} onClick={() => run(snapshot?.runtimeStatus === "empty" ? "replay" : "step")}>
            {busy ? <RefreshCw size={15} className="is-spinning" /> : <Play size={15} />}
            {snapshot?.runtimeStatus === "empty" ? "Load governed replay" : "Run next event"}
          </button>
        </div>
      </header>

      <section className="agent-boundary-strip panel" aria-label="Agent trust boundary">
        <div><LockKeyhole size={17} /><span><small>Browser authority</small><strong>{snapshot?.boundary.browserAuthority ?? "none"}</strong></span></div>
        <ArrowRight size={14} />
        <div><BrainCircuit size={17} /><span><small>Agent authority</small><strong>{snapshot?.boundary.agentAuthority ?? "proposal-only"}</strong></span></div>
        <ArrowRight size={14} />
        <div><ShieldCheck size={17} /><span><small>Policy default</small><strong>{snapshot?.boundary.policyDefault ?? "block"}</strong></span></div>
        <ArrowRight size={14} />
        <div><Cable size={17} /><span><small>External writes</small><strong>{snapshot?.boundary.externalWritesEnabled ? "enabled" : "disabled"}</strong></span></div>
      </section>

      <section className="agent-metrics-grid">
        <button className="agent-metric panel drillable-surface" type="button" onClick={() => selected && inspectAgent(selected)}><Bot size={18} /><div><small>Configured specialists</small><strong>{snapshot?.totals.agents ?? "—"}</strong><span>{snapshot?.totals.aiAgents ?? 0} language agents</span></div></button>
        <button className="agent-metric panel drillable-surface" type="button" onClick={() => onNavigate("assurance")}><Activity size={18} /><div><small>Traced executions</small><strong>{snapshot?.totals.executions ?? "—"}</strong><span>{snapshot?.totals.proposals ?? 0} proposals retained</span></div></button>
        <button className="agent-metric panel drillable-surface" type="button" onClick={() => onNavigate("ecosystem")}><GitBranch size={18} /><div><small>Retained conflicts</small><strong>{snapshot?.totals.conflicts ?? "—"}</strong><span>No silent consensus</span></div></button>
        <button className="agent-metric panel drillable-surface" type="button" onClick={() => onNavigate("assurance")}><Coins size={18} /><div><small>Runtime cost</small><strong>{snapshot?.totals.costMicrounits ?? "—"}</strong><span>Tracked microunits</span></div></button>
      </section>

      {error ? <div className="agent-error" role="alert"><CircleAlert size={15} /> {error}</div> : null}

      <section className="agent-control-grid">
        <article className="panel agent-registry-panel">
          <div className="panel-title-row">
            <div><Eyebrow>Agent registry</Eyebrow><h2>Bounded specialists</h2></div>
            <Tag tone="violet"><Sparkles size={11} /> Server manifests</Tag>
          </div>
          <div className="agent-filter-row" aria-label="Filter agent categories">
            {(Object.keys(categoryLabels) as CategoryFilter[]).map((item) => (
              <button className={category === item ? "is-active" : ""} type="button" onClick={() => setCategory(item)} key={item}>{categoryLabels[item]}</button>
            ))}
          </div>
          <div className="agent-registry-list">
            {visibleAgents.map((agent) => (
              <button className={selected?.id === agent.id ? "is-selected" : ""} type="button" onClick={() => setSelectedId(agent.id)} key={agent.id}>
                <span className={"agent-category-icon is-" + agent.category}><Bot size={15} /></span>
                <span className="agent-registry-copy">
                  <span><strong>{agent.name}</strong><Tag tone={categoryTone(agent.category)}>{categoryLabels[agent.category]}</Tag></span>
                  <small>{agent.enabled ? agent.mode : "Paused by active configuration"} · v{agent.version}</small>
                </span>
                <span className={"agent-health is-" + agent.runtime.status} />
              </button>
            ))}
          </div>
        </article>

        <article className="panel agent-inspector-panel">
          {selected ? (
            <>
              <div className="agent-inspector-head">
                <span className={"agent-hero-icon is-" + selected.category}><BrainCircuit size={22} /></span>
                <div><Eyebrow>{selected.id} · v{selected.version}</Eyebrow><h2>{selected.name}</h2><p>{selected.description}</p></div>
                <Tag tone={selected.enabled ? statusTone(selected.runtime.status) : "red"}>{selected.enabled ? selected.runtime.status : "paused"}</Tag>
              </div>

              <div className="agent-contract-grid">
                <div><small>Mode</small><strong>{selected.mode}</strong></div>
                <div><small>Approval ceiling</small><strong>Class {selected.approvalClass}</strong></div>
                <div><small>Evaluation gate</small><strong>{Math.round(selected.evaluationGateBasisPoints / 100)}%</strong></div>
                <div><small>Kill switch</small><strong>{selected.killSwitchAvailable ? "Available" : "Unavailable"}</strong></div>
              </div>

              <div className="agent-runtime-row">
                <span><Activity size={14} /><small>Executions</small><strong>{selected.runtime.executions}</strong></span>
                <span><CheckCircle2 size={14} /><small>Completed</small><strong>{selected.runtime.completed}</strong></span>
                <span><Clock3 size={14} /><small>Mean latency</small><strong>{selected.runtime.averageLatencyMs} ms</strong></span>
                <span><Coins size={14} /><small>Cost</small><strong>{selected.runtime.costMicrounits} µ</strong></span>
              </div>

              <section className="agent-eval-gate">
                <div><span>Promotion threshold</span><strong>{Math.round(selected.evaluationGateBasisPoints / 100)}%</strong></div>
                <ProgressBar value={selected.evaluationGateBasisPoints / 100} tone={selected.runtime.status === "watch" ? "amber" : "mint"} />
              </section>

              <div className="agent-io-grid">
                <section><Eyebrow><Route size={12} /> Trigger contracts</Eyebrow>{selected.inputs.map((item) => <code key={item}>{item}</code>)}</section>
                <section><Eyebrow><Waypoints size={12} /> Typed outputs</Eyebrow>{selected.outputs.map((item) => <code key={item}>{item}</code>)}</section>
              </div>

              <section className="agent-allowed-actions">
                <Eyebrow><Braces size={12} /> Allowed proposals—not direct writes</Eyebrow>
                <div>{selected.allowedActions.map((item) => <span key={item}>{item}</span>)}</div>
              </section>

              <section className="agent-memory-boundary"><ShieldCheck size={16} /><div><strong>{selected.dataBoundary}</strong><p>{selected.memoryBoundary}</p></div></section>

              <div className="agent-inspector-actions">
                <button className="button button-secondary" type="button" onClick={() => inspectAgent(selected)}>Inspect evidence and traces</button>
                <button className="button button-primary" type="button" onClick={() => onNavigate("assurance")}>Open assurance <ArrowRight size={14} /></button>
              </div>
            </>
          ) : <div className="agent-empty">Select an agent to inspect its governed contract.</div>}
        </article>
      </section>

      <section className="panel agent-message-panel">
        <div className="panel-title-row">
          <div><Eyebrow>Dedicated swarm message fabric</Eyebrow><h2>See every handoff in one screen</h2></div>
          <Tag tone="blue"><MessagesSquare size={11} /> {snapshot?.messages.length ?? 0} server messages</Tag>
        </div>
        <div className="agent-message-head"><span>Time</span><span>From</span><span>To</span><span>Message</span><span>State</span></div>
        <div className="agent-message-list">
          {(snapshot?.messages ?? []).map((message) => (
            <button type="button" className="drillable-surface" onClick={() => onOpenDetail({ id: message.id, kind: "Agent message", title: message.summary, summary: "", status: message.status, owner: message.from, scope: message.to, primary: { label: "Open Swarm Control", target: "ecosystem" } })} key={message.id}>
              <time>{new Date(message.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
              <strong>{message.from}</strong>
              <span><ArrowRight size={11} /> {message.to}</span>
              <span><Tag tone={message.kind === "policy" ? "amber" : message.kind === "insight" ? "violet" : message.kind === "proposal" ? "blue" : "neutral"}>{message.kind}</Tag>{message.summary}</span>
              <Tag tone={message.status === "blocked" ? "red" : message.status === "review" ? "amber" : "mint"}>{message.status}</Tag>
            </button>
          ))}
          {!snapshot?.messages.length ? <div className="agent-message-empty"><MessagesSquare size={18} /><span>Load the governed replay to observe agent messages.</span></div> : null}
        </div>
      </section>
    </div>
  );
}
