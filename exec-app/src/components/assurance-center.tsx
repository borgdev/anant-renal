"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertOctagon,
  Ban,
  Bug,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Clock3,
  Crosshair,
  Eye,
  FileCheck2,
  Gauge,
  KeyRound,
  Play,
  RotateCcw,
  Shield,
  ShieldCheck,
  Siren,
  Target,
} from "lucide-react";
import { agentManifests, greenTeamChecks, redTeamScenarios, traceSpans } from "../lib/catalogs";
import { startLiveRuntime, runRedTeamReplay, type RuntimeSnapshot } from "../lib/harness";
import type { NavigationId } from "../lib/types";
import type { OpenWorkflowDetail } from "../lib/workflow-detail";
import { Eyebrow, ProgressBar, Tag } from "./ui";

export default function AssuranceCenter({ onOpenDetail }: { onOpenDetail: OpenWorkflowDetail }) {
  const [selectedScenario, setSelectedScenario] = useState(redTeamScenarios[0].id);
  const [replayState, setReplayState] = useState<"idle" | "running" | "passed" | "error">("idle");
  const [runtime, setRuntime] = useState<RuntimeSnapshot | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [redResult, setRedResult] = useState<{ evidenceHash: string; checks: Array<{ name: string; passed: boolean; observed: string }> } | null>(null);
  const replayed = replayState === "passed";
  const scenario = redTeamScenarios.find((item) => item.id === selectedScenario) ?? redTeamScenarios[0];
  const observedTraces = useMemo(() => runtime?.traces.length ? runtime.traces.slice(0, 8).map((span) => ({ id: span.spanId, label: span.name, system: span.system, duration: `${span.durationMs} ms`, status: span.status === "blocked" ? "blocked" as const : span.status === "review" ? "review" as const : "ok" as const, detail: String(span.attributes.eventType ?? span.attributes.proposalType ?? span.attributes.integrity ?? "persisted trace") })) : traceSpans, [runtime]);

  useEffect(() => {
    let active = true;
    const stop = startLiveRuntime((snapshot) => { if (active) setRuntime(snapshot); }, { roleId: "fa", onError: (error) => { if (active) setRuntimeError(error ? error.message : null); } });
    return () => { active = false; stop(); };
  }, []);

  function chooseScenario(id: string) {
    setSelectedScenario(id);
    setReplayState("idle");
    setRedResult(null);
  }

  async function runReplay() {
    if (replayed) {
      setReplayState("idle");
      return;
    }
    setReplayState("running");
    try {
      const payload = await runRedTeamReplay(scenario.id);
      setRedResult(payload.result);
      setReplayState("passed");
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : "Red-team replay failed");
      setReplayState("error");
    }
  }

  function openAssuranceDetail(title: string, summary: string, status: string, evidence: Array<{ label: string; value: string; source?: string }> = [], target: NavigationId = "platform") {
    onOpenDetail({ id: `ASSURANCE-${title.toUpperCase().replaceAll(" ", "-")}`, kind: "AI assurance control", title, summary, status, tone: status.toLowerCase().includes("fail") || status.toLowerCase().includes("open") ? "red" : status.toLowerCase().includes("watch") || status.toLowerCase().includes("review") ? "amber" : "mint", owner: "AI assurance", scope: "Renal outcome harness", metrics: [{ label: "Executions", value: String(runtime?.counts.executions ?? 0) }, { label: "Trace spans", value: String(runtime?.traces.length ?? 0) }, { label: "Incidents", value: String(runtime?.incidents.filter((item) => item.status === "open").length ?? 0) }, { label: "Audit events", value: String(runtime?.counts.auditEvents ?? 0) }], evidence, steps: [{ label: "Define", detail: "Threshold and expected containment versioned", state: "done" }, { label: "Execute", detail: "Green or red evaluation run", state: replayState === "running" ? "current" : "done" }, { label: "Decide", detail: status, state: status.toLowerCase().includes("fail") ? "blocked" : "done" }, { label: "Promote", detail: "Human approval and canary required", state: "pending" }], control: "A passing reference replay is necessary but not sufficient for clinical production authorization. Security, privacy, clinical validation and local workflow approval remain separate gates.", primary: { label: target === "ecosystem" ? "Open Swarm Control" : target === "command" ? "Open Outcome Command" : "Open Configuration Studio", target } });
  }

  return (
    <div className="view-stack assurance-view">
      <header className="view-heading">
        <div>
          <Eyebrow>Assurance center · evaluate, observe, govern</Eyebrow>
          <h1>Assurance Center</h1>
          <p>Green-team quality gates and red-team adversarial replays govern every model, policy, agent manifest and measure pack.</p>
        </div>
        <div className="heading-actions"><Tag tone={runtime && runtime.health.failedExecutions === 0 ? "mint" : runtimeError ? "red" : "violet"}><ShieldCheck size={11} /> {runtime ? "Runtime controls observed" : "Loading assurance ledger"}</Tag><button className="button button-secondary" type="button" onClick={() => openAssuranceDetail("Evidence dossier", "Consolidated evaluation, trace, model, drift, incident and human-action evidence for the active runtime release.", "Inspectable", [{ label: "Configuration", value: runtime?.runtime.configuration ?? "Loading", source: runtime?.runtime.policyVersion }, { label: "Models", value: String(runtime?.models.length ?? 0), source: "Persisted model registry" }, { label: "Authority snapshots", value: String(runtime?.authoritySnapshots.length ?? 0), source: "Public source registry" }])}><FileCheck2 size={15} /> Evidence dossier</button></div>
      </header>

      <section className="assurance-scoreboard">
        <article className="assurance-hero panel"><span className="assurance-orbit"><Shield size={27} /></span><div><Eyebrow>Assurance posture</Eyebrow><strong>Reference controls are executing</strong><p>{runtime ? `${runtime.counts.events} events produced ${runtime.counts.executions} bounded executions, ${runtime.health.conflicts} retained conflicts and ${runtime.health.failedExecutions} failures.` : "Loading persisted runtime telemetry."} Production clinical validation, security authorization and local workflow approval remain required.</p></div><Tag tone={runtime?.health.failedExecutions === 0 ? "mint" : "red"}>{runtime?.models.filter((model) => model.killSwitch).length ?? 0} model kill switches</Tag></article>
        <button className="assurance-stat panel drillable-surface" type="button" onClick={() => openAssuranceDetail("Completed runs", "Bounded agent executions retain status, latency, cost, confidence, input/output hashes and abstention reason.", runtime?.health.failedExecutions ? "Failures present" : "Healthy", runtime?.executions.slice(0, 8).map((item) => ({ label: item.agentId, value: item.status, source: `${item.executionId} · ${item.latencyMs} ms` })) ?? [], "ecosystem")}><Target size={18} /><div><small>Completed runs</small><strong>{runtime?.health.completedExecutions ?? "—"}</strong><span>{runtime?.health.failedExecutions ?? 0} failed · {runtime?.health.abstentions ?? 0} abstained</span></div></button>
        <button className="assurance-stat panel drillable-surface" type="button" onClick={() => openAssuranceDetail("Drift controls", "Persisted drift snapshots compare observed values to configured thresholds before promotion.", runtime?.drift.some((item) => item.status !== "healthy") ? "Watch" : "Healthy", runtime?.drift.map((item) => ({ label: item.targetId, value: `${item.valueBasisPoints / 100}% observed`, source: `${item.metric} · threshold ${item.thresholdBasisPoints / 100}%` })) ?? [])}><Crosshair size={18} /><div><small>Drift controls</small><strong>{runtime ? `${runtime.drift.filter((item) => item.status === "healthy").length} / ${runtime.drift.length}` : "—"}</strong><span>Persisted snapshots</span></div></button>
        <button className="assurance-stat panel drillable-surface" type="button" onClick={() => openAssuranceDetail("Trace spans", "Event, policy, cell, command and acknowledgement stages retain a shared trace identifier.", "Lineage retained", runtime?.traces.slice(0, 10).map((span) => ({ label: span.name, value: `${span.durationMs} ms · ${span.status}`, source: span.traceId })) ?? [], "command")}><Eye size={18} /><div><small>Trace spans</small><strong>{runtime?.traces.length ?? "—"}</strong><span>Event and cell lineage</span></div></button>
      </section>

      <section className="team-grid">
        <article className="panel green-panel">
          <div className="team-title"><span className="team-icon green"><CheckCircle2 size={18} /></span><div><Eyebrow>Green team</Eyebrow><h2>Release quality gates</h2></div><Tag tone="mint">All pass</Tag></div>
          <div className="quality-table">
            <div className="quality-head"><span>Gate</span><span>Threshold</span><span>Result</span><span>Decision</span></div>
            {greenTeamChecks.map((check) => <button className="quality-row drillable-surface" type="button" onClick={() => openAssuranceDetail(check.name, `Release quality gate passed its configured threshold of ${check.target}.`, `Pass · ${check.result}`, [{ label: "Threshold", value: check.target, source: "Green-team release gate" }, { label: "Observed", value: check.result, source: "Latest reference evaluation" }])} key={check.name}><strong>{check.name}</strong><span>{check.target}</span><span>{check.result}</span><Tag tone="mint">Pass</Tag></button>)}
          </div>
        </article>

        <article className="panel red-panel">
          <div className="team-title"><span className="team-icon red"><Siren size={18} /></span><div><Eyebrow>Red team</Eyebrow><h2>Adversarial replay lab</h2></div><Tag tone="red">Attack safely</Tag></div>
          <div className="red-lab">
            <div className="scenario-list">{redTeamScenarios.map((item) => <button className={item.id === scenario.id ? "is-selected" : ""} key={item.id} onClick={() => chooseScenario(item.id)} type="button"><span><small>{item.id}</small><strong>{item.name}</strong></span><ChevronRight size={14} /></button>)}</div>
            <div className="scenario-inspector">
              <div className="attack-block"><AlertOctagon size={17} /><div><Eyebrow>Attack</Eyebrow><p>{scenario.attack}</p></div></div>
              <div className="expected-block"><ShieldCheck size={17} /><div><Eyebrow>Expected containment</Eyebrow><p>{scenario.expected}</p></div></div>
              <div className="control-row"><KeyRound size={14} /><span>{scenario.control}</span></div>
              <button className={`button ${replayed ? "button-secondary" : "button-primary"} replay-button`} disabled={replayState === "running"} onClick={runReplay} type="button">{replayed ? <><RotateCcw size={15} /> Reset replay</> : replayState === "running" ? <><Activity size={15} /> Running replay…</> : <><Play size={15} /> Run adversarial replay</>}</button>
              {replayed && redResult ? <div className="containment-result"><Ban size={17} /><div><strong>{redResult.checks.length} executable controls passed</strong><p>{redResult.checks.map((check) => `${check.name}: ${check.observed}`).join(" · ")} · evidence {redResult.evidenceHash.slice(0, 12)}…</p></div></div> : null}
              {replayState === "error" ? <div className="containment-result is-error"><AlertOctagon size={17} /><div><strong>Replay result was not persisted</strong><p>The assurance ledger rejected the run. No release state changed.</p></div></div> : null}
            </div>
          </div>
        </article>
      </section>

      <section className="observability-grid">
        <article className="panel trace-panel">
          <div className="panel-title-row"><div><Eyebrow>End-to-end trace · OUT-1042</Eyebrow><h2>Observe → understand → coordinate → verify</h2></div><Tag tone="mint"><Activity size={11} /> sampled 100%</Tag></div>
          <div className="trace-waterfall">
            {observedTraces.map((span, index) => <button className="trace-row drillable-surface" type="button" onClick={() => openAssuranceDetail(span.label, span.detail, span.status, [{ label: "System", value: span.system, source: span.id }, { label: "Duration", value: span.duration, source: "Persisted trace span" }], "command")} key={span.id}><span className={`trace-status trace-${span.status}`}><CircleDot size={13} /></span><div className="trace-copy"><strong>{span.label}</strong><small>{span.system} · {span.detail}</small></div><span className="trace-duration">{span.duration}</span><div className="trace-bar" style={{ width: span.duration === "pending" ? "38%" : `${30 + index * 8}%` }} /></button>)}
          </div>
        </article>

        <aside className="assurance-side-stack">
          <article className="panel slo-card">
            <div className="panel-title-row"><div><Eyebrow>Runtime SLOs</Eyebrow><h2>Event health</h2></div><Gauge size={18} /></div>
            {[{label:"Mean cell completion",value:`${runtime?.health.averageLatencyMs ?? 0} ms`,pct:runtime?.health.failedExecutions ? 45 : 100},{label:"Pending Kafka outbox",value:String(runtime?.health.pendingOutbox ?? 0),pct:runtime?.health.pendingOutbox ? 78 : 100},{label:"Model-call cost",value:`${runtime?.health.totalCostMicrounits ?? 0} µ`,pct:100},{label:"Integrity + lineage",value:`${runtime?.counts.evidence ?? 0}/${runtime?.counts.events ?? 0}`,pct:runtime?.counts.events ? Math.min(100, Math.round((runtime.counts.evidence / runtime.counts.events) * 100)) : 0}].map((item) => <button className="slo-row drillable-surface" type="button" onClick={() => openAssuranceDetail(item.label, "Runtime service-level indicator with its observed value and configured control posture.", item.pct >= 90 ? "Healthy" : "Watch", [{ label: "Observed", value: item.value, source: "Runtime telemetry" }, { label: "Control score", value: `${item.pct}%`, source: "Reference SLO" }])} key={item.label}><div><span>{item.label}</span><strong>{item.value}</strong></div><ProgressBar value={item.pct} tone={item.pct >= 90 ? "mint" : "amber"} /></button>)}
          </article>
          <button className="panel incident-card drillable-surface" type="button" onClick={() => openAssuranceDetail("Open incidents", runtimeError ?? (runtime?.incidents[0]?.summary || "No runtime incident is open; proposed authority packs remain non-active configuration."), runtime?.incidents.some((item) => item.status === "open") ? "Open" : "Clear", runtime?.incidents.map((item) => ({ label: item.incidentId, value: item.summary, source: `Severity ${item.severity} · ${item.status}` })) ?? [])}><Bug size={19} /><div><Eyebrow>Open incidents</Eyebrow><strong>{runtime?.incidents.filter((item) => item.status === "open").length ?? 0} persisted</strong><p>{runtimeError ?? (runtime?.incidents[0]?.summary || "No runtime incident is open; proposed authority packs remain non-active configuration.")}</p></div><Tag tone={runtime?.incidents.some((item) => item.status === "open") ? "amber" : "mint"}>{runtime?.incidents.some((item) => item.status === "open") ? "Watch" : "Clear"}</Tag></button>
        </aside>
      </section>

      <section className="governance-panel panel">
        <div className="panel-title-row"><div><Eyebrow>Governance by construction</Eyebrow><h2>Bounded agent manifest registry</h2></div><Tag tone="violet">Kill switch · all cells</Tag></div>
        <div className="manifest-grid">{agentManifests.map((cell) => <button className="drillable-surface" type="button" onClick={() => openAssuranceDetail(cell.name, `${cell.mode} cell with a strict action allowlist and kill switch.`, `Class ${cell.approvalClass} · ${Math.round(cell.evalGate * 100)}% gate`, [{ label: "Allowed actions", value: cell.allowedActions.join(" · "), source: `${cell.id}@${cell.version}` }, { label: "Inputs", value: cell.inputs.join(" · "), source: "Typed event contract" }])} key={cell.id}><div className="manifest-top"><span className="manifest-icon"><ShieldCheck size={15} /></span><div><strong>{cell.name}</strong><small>{cell.version} · {cell.mode}</small></div><Tag tone="mint">Class {cell.approvalClass}</Tag></div><dl><div><dt>Allowed</dt><dd>{cell.allowedActions.join(" · ")}</dd></div><div><dt>Inputs</dt><dd>{cell.inputs.join(" · ")}</dd></div></dl><div className="manifest-gate"><span>Eval gate</span><strong>{Math.round(cell.evalGate * 100)}%</strong></div><ProgressBar value={cell.evalGate * 100} tone="mint" /></button>)}</div>
        <div className="governance-footer"><Clock3 size={15} /><span>Every promotion records actor, approver, test dossier, configuration diff, effective window, rollback target and purpose-of-use.</span></div>
      </section>
    </div>
  );
}
