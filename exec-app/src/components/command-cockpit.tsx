"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowRight,
  CheckCircle2,
  Clock3,
  MapPin,
  MessageSquareText,
  Network,
  ShieldCheck,
  Sparkles,
  UserRoundCheck,
  XCircle,
} from "lucide-react";
import { outcomeEpisodes, patientTimeline, agentManifests } from "../lib/catalogs";
import { startLiveRuntime, fetchRuntimeSnapshot, mutateRuntime, type RuntimeActionRow, type RuntimeSnapshot } from "../lib/harness";
import type { NavigationId } from "../lib/types";
import type { OpenWorkflowDetail } from "../lib/workflow-detail";
import { Eyebrow, Metric, PanelExpand, ProgressBar, Tag } from "./ui";

/** A live outcome episode as projected by the durable coordinator. */
type LiveEpisode = {
  episodeId: string;
  kind: string;
  subject: string;
  scopeType: string;
  state: string;
  openedAt: string;
  evidence?: unknown[];
  proposal?: { cellId?: string };
  transitions?: Array<{ from: string; to: string; at: string; by: string; note?: string }>;
  dossierHash?: string;
  evidenceFusion?: { belief?: number; plausibility?: number; uncertainty?: number; conflictMass?: number; sources?: Array<{ sourceId: string; alpha: number }> };
  evidenceStatus?: string;
};

type QueueItem = {
  id: string;
  kind: "episode" | "action";
  title: string;
  subtitle: string;
  scope: string;
  due: string;
  tone: "red" | "amber" | "blue" | "mint";
  status: string;
  confidence: number;
  evidenceCount: number;
  actionClass: string;
  cells: string[];
  valueLabel?: string;
};

/** Convergence perspectives — derived from the live agent-manifest catalog when the
 *  runtime has no insights yet (no hardcoded findings). */

function QueueRow({ item, selected, onSelect }: { item: QueueItem; selected: boolean; onSelect: () => void }) {
  return (
    <button className={`episode-row ${selected ? "is-selected" : ""}`} onClick={onSelect} type="button">
      <span className={`priority-dot priority-${item.tone === "red" ? "red" : item.tone === "amber" ? "amber" : "blue"}`} aria-hidden="true" />
      <span className="episode-main">
        <strong>{item.title}</strong>
        <small>{item.subtitle}</small>
      </span>
      <span className="episode-meta">
        <small>{item.due}</small>
        <Tag tone={item.tone}>{item.status}</Tag>
      </span>
      <ArrowRight size={16} aria-hidden="true" />
    </button>
  );
}

export default function CommandCockpit({
  selectedId,
  onSelect,
  onOpenDemo,
  onNavigate,
  onOpenDetail,
}: {
  selectedId: string;
  onSelect: (id: string) => void;
  onOpenDemo: () => void;
  onNavigate: (id: NavigationId) => void;
  onOpenDetail: OpenWorkflowDetail;
}) {
  const [runtime, setRuntime] = useState<RuntimeSnapshot | null>(null);
  const [runtimeNotice, setRuntimeNotice] = useState<string | null>(null);
  const [reviewStates, setReviewStates] = useState<Record<string, "idle" | "saving" | "recorded" | "error">>({});
  const [coordinatorBusy, setCoordinatorBusy] = useState(false);

  useEffect(() => {
    let active = true;
    const stop = startLiveRuntime((snapshot) => { if (active) setRuntime(snapshot); }, { roleId: "fa", onError: (error) => { if (active) setRuntimeNotice(error ? error.message : null); } });
    return () => { active = false; stop(); };
  }, []);

  // Unified resolution queue: live outcome episodes + live ranked NBAs, with a
  // reference fallback when the runtime has produced nothing yet.
  const queue = useMemo<QueueItem[]>(() => {
    const items: QueueItem[] = [];
    const episodes = (runtime?.episodes ?? []) as unknown as LiveEpisode[];
    for (const ep of episodes.slice(0, 10)) {
      items.push({
        id: ep.episodeId,
        kind: "episode",
        title: ep.kind.replaceAll(".", " "),
        subtitle: `${ep.subject} · ${ep.scopeType} · ${ep.state}`,
        scope: ep.subject,
        due: new Date(ep.openedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
        tone: ep.state === "Resolved" || ep.state === "Verifying" ? "mint" : ep.state === "AwaitingApproval" || ep.state === "Proposed" ? "amber" : ep.state === "Rejected" || ep.state === "Escalated" ? "red" : "blue",
        status: ep.state,
        confidence: 0,
        evidenceCount: ep.evidence?.length ?? 0,
        actionClass: "—",
        cells: ep.proposal?.cellId ? [ep.proposal.cellId] : [],
      });
    }
    for (const a of (runtime?.actions ?? []).slice(0, 10)) {
      items.push({
        id: a.actionId,
        kind: "action",
        title: a.title,
        subtitle: a.outcome,
        scope: a.outcome,
        due: new Date(a.dueAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
        tone: a.status === "completed" ? "mint" : a.status === "dismissed" ? "red" : a.status === "review" ? "amber" : "blue",
        status: a.status,
        confidence: a.confidenceBasisPoints / 10000,
        evidenceCount: a.evidenceCount,
        actionClass: `Class ${a.actionClass}`,
        cells: a.agentIds,
        valueLabel: a.valueLabel,
      });
    }
    if (!items.length) {
      for (const e of outcomeEpisodes) {
        items.push({
          id: e.id, kind: "episode", title: e.title, subtitle: `${e.patient} · ${e.facility}`, scope: e.facility,
          due: e.due, tone: e.urgency === "critical" ? "red" : e.urgency === "high" ? "amber" : "blue",
          status: "reference", confidence: e.confidence, evidenceCount: e.evidenceCount, actionClass: `Class ${e.actionClass}`, cells: [],
        });
      }
    }
    return items;
  }, [runtime]);

  const selected = useMemo(() => queue.find((item) => item.id === selectedId) ?? queue[0], [queue, selectedId]);
  const selectedAction = useMemo<RuntimeActionRow | undefined>(() => {
    if (selected?.kind !== "action") return undefined;
    return runtime?.actions.find((a) => a.actionId === selected.id);
  }, [runtime, selected]);
  const selectedEpisode = useMemo<LiveEpisode | undefined>(() => {
    if (selected?.kind !== "episode") return undefined;
    return (runtime?.episodes ?? []).find((e) => e.episodeId === selected.id) as unknown as LiveEpisode | undefined;
  }, [runtime, selected]);

  // Episode linked to the selected action (via the durable decision ledger).
  const linkedEpisode = useMemo<LiveEpisode | undefined>(() => {
    if (selected?.kind !== "action") return undefined;
    const decision = runtime?.nbaDecisions.find((d) => d.nbaId === selected.id);
    const episodes = (runtime?.episodes ?? []) as unknown as LiveEpisode[];
    if (decision?.episodeId) return episodes.find((e) => e.episodeId === decision.episodeId);
    return episodes.find((e) => e.subject === selectedAction?.outcome);
  }, [runtime, selected, selectedAction]);

  const reviewState = selected ? (reviewStates[selected.id] ?? "idle") : "idle";
  const swarmPerspectives = useMemo(() => {
    const insights = runtime?.insights ?? [];
    if (insights.length) {
      return insights.slice(0, 5).map((i) => ({
        name: i.title.split("—")[0]?.trim() ?? i.title,
        finding: i.summary,
        confidence: Math.round(i.confidenceBasisPoints / 100),
        tone: (i.conflicts?.length ? "red" : i.confidenceBasisPoints > 8500 ? "mint" : "amber") as "red" | "mint" | "amber" | "blue",
        belief: i.belief,
        plausibility: i.plausibility,
        uncertainty: i.uncertainty,
        conflictMass: i.conflictMass,
      }));
    }
    return agentManifests.slice(0, 5).map((cell) => ({
      name: cell.displayName ?? cell.name ?? cell.id ?? "Cell",
      finding: "Awaiting live swarm signals",
      confidence: 0,
      tone: "blue" as const,
      belief: undefined,
      plausibility: undefined,
      uncertainty: undefined,
      conflictMass: undefined,
    }));
  }, [runtime]);

  const timelineEvents = useMemo(() => {
    const rows = (runtime?.events ?? []).slice(-6).reverse();
    if (rows.length) {
      return rows.map((e) => ({
        time: new Date(e.recordedTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        label: e.eventType,
        type: e.subjectType,
        source: e.sourceSystem,
        state: "complete" as const,
      }));
    }
    return patientTimeline.slice(0, 5).map((event: Record<string, string>) => ({ time: String(event.time), label: String(event.label), type: String(event.type), source: String(event.source), state: "complete" as const }));
  }, [runtime]);

  async function decideAction(item: QueueItem, decision: "approved" | "dismissed") {
    if (!item) return;
    setReviewStates((current) => ({ ...current, [item.id]: "saving" }));
    setRuntimeNotice(null);
    try {
      if (item.kind === "action") {
        const result = await mutateRuntime<{ approved: boolean; commandId?: string; episodeId?: string; reasons: string[] }>(decision === "approved" ? "approve" : "dismiss", "fa", { actionId: item.id });
        if (!result.approved) throw new Error(result.reasons.join(" · "));
        setRuntimeNotice(result.episodeId ? `${result.commandId ?? "Command"} entered the durable outbox; episode ${result.episodeId} awaits downstream acknowledgement.` : `Human decision recorded in the durable ledger (${decision}).`);
      } else {
        await mutateRuntime("episode-decide", "fa", { episodeId: item.id, decision, approvalClass: "B" });
        setRuntimeNotice(decision === "approved" ? "Episode approved; coordinating downstream acknowledgement." : "Episode rejected; the loop closed with no command emitted.");
      }
      setRuntime(await fetchRuntimeSnapshot());
      setReviewStates((current) => ({ ...current, [item.id]: "recorded" }));
    } catch (error) {
      setRuntimeNotice(error instanceof Error ? error.message : "Runtime rejected the decision");
      setReviewStates((current) => ({ ...current, [item.id]: "error" }));
    }
  }

  async function recordAck(item: QueueItem, episodeId?: string) {
    if (!item) return;
    setReviewStates((current) => ({ ...current, [item.id]: "saving" }));
    setRuntimeNotice(null);
    try {
      const target = episodeId ?? (item.kind === "episode" ? item.id : linkedEpisode?.episodeId);
      if (!target) throw new Error("No open outcome episode to acknowledge");
      await mutateRuntime("acknowledge-episode", "fa", { episodeId: target });
      setRuntimeNotice("Downstream acknowledgement verified; the outcome loop resolved and the measure was calculated.");
      setRuntime(await fetchRuntimeSnapshot());
      setReviewStates((current) => ({ ...current, [item.id]: "recorded" }));
    } catch (error) {
      setRuntimeNotice(error instanceof Error ? error.message : "Acknowledgement failed");
      setReviewStates((current) => ({ ...current, [item.id]: "error" }));
    }
  }

  async function requestCoordinatorReview() {
    setCoordinatorBusy(true);
    try {
      const result = await mutateRuntime<{ requestId: string; status: string }>("request-review", "fa", { entityType: "outcome-episode", entityId: selected?.id ?? "outcome", targetRole: "fa", message: `Review outcome plan: ${selected?.title ?? ""}` });
      setRuntimeNotice(`${result.requestId} was recorded in the audit ledger for the facility coordinator.`);
      setRuntime(await fetchRuntimeSnapshot());
    } catch (error) {
      setRuntimeNotice(error instanceof Error ? error.message : "Coordinator request failed");
    } finally {
      setCoordinatorBusy(false);
    }
  }

  function openEpisodeDetail() {
    if (!selected) return;
    const ep = selected.kind === "episode" ? selectedEpisode : linkedEpisode;
    const state = selected.kind === "action"
      ? (selected.status === "completed" ? "Resolved" : selected.status === "dismissed" ? "Dismissed" : ep?.state ?? "Awaiting approval")
      : (selectedEpisode?.state ?? selected.status);
    const tones: Record<string, "mint" | "red" | "amber" | "blue"> = { Resolved: "mint", Verifying: "mint", AwaitingApproval: "amber", Proposed: "amber", Coordinating: "mint", Rejected: "red", Escalated: "red", Dismissed: "red", completed: "mint", dismissed: "red", review: "amber", queued: "blue" };
    onOpenDetail({
      id: selected.id,
      kind: selected.kind === "action" ? "Next-best action" : "Outcome episode",
      title: selected.title,
      summary: selected.subtitle,
      status: state,
      tone: tones[state] ?? "blue",
      owner: selectedAction?.ownerRole ?? "Facility coordinator",
      scope: selected.scope,
      due: selected.due,
      metrics: [
        { label: "Confidence", value: selected.confidence ? `${Math.round(selected.confidence * 100)}%` : "—" },
        { label: "Evidence", value: String(selected.evidenceCount) },
        { label: "Action class", value: selected.actionClass },
        { label: "Open episodes", value: String(runtime?.episodes.length ?? 0) },
      ],
      evidence: (ep?.evidence ?? []).slice(0, 6).map((item, index) => ({ label: `Evidence ${index + 1}`, value: typeof item === "object" && item !== null ? String((item as { sourceId?: string }).sourceId ?? "evidence") : String(item), source: "Outcome evidence ledger" })),
      steps: [
        { label: "Observe", detail: "Events joined", state: "done" },
        { label: "Understand", detail: "Cells converged", state: "done" },
        { label: "Coordinate", detail: ep?.state === "Coordinating" || ep?.state === "Verifying" || selected.status === "completed" ? "Command emitted" : "Human decision", state: ep?.state === "Coordinating" || selected.status === "completed" ? "done" : "current" },
        { label: "Verify", detail: ep?.state === "Resolved" || selected.status === "completed" ? "Outcome acknowledged" : "Await outcome", state: ep?.state === "Resolved" || selected.status === "completed" ? "done" : "pending" },
      ],
      primary: { label: "Open Swarm Control", target: "ecosystem" },
    });
  }

  if (!selected) {
    return (
      <div className="view-stack command-view">
        <header className="view-heading command-heading">
          <div>
            <Eyebrow>Outcome command</Eyebrow>
            <h1>No outcome episodes or actions yet.</h1>
            <p>Start the simulator or open the guided demo to surface a care-journey decision.</p>
          </div>
          <button className="button button-primary demo-launch" onClick={onOpenDemo} type="button"><Sparkles size={16} aria-hidden="true" /> Run the guided demo</button>
        </header>
      </div>
    );
  }

  const canAck = selected?.kind === "episode"
    ? selectedEpisode?.state === "Coordinating" || selectedEpisode?.state === "Verifying"
    : selected?.status === "completed" || linkedEpisode?.state === "Coordinating" || linkedEpisode?.state === "Verifying";
  const settled = selected.status === "completed" || selected.status === "dismissed" || (selectedEpisode && ["Resolved", "Rejected", "Escalated"].includes(selectedEpisode.state));

  return (
    <div className="view-stack command-view">
      <header className="view-heading command-heading">
        <div>
          <Eyebrow>Outcome command · live decision surface</Eyebrow>
          <h1>Outcome Command</h1>
          <p>The durable outcome ledger joins evidence → proposal → approval → command → acknowledgement. The coordinator stays in control.</p>
        </div>
        <button className="button button-primary demo-launch" onClick={onOpenDemo} type="button">
          <Sparkles size={16} aria-hidden="true" />
          Run the guided demo
        </button>
      </header>

      <section className="metrics-grid" aria-label="Current operating metrics">
        <Metric label="Outcome episodes" value={String(runtime?.episodes.length ?? "—").padStart(2, "0")} detail={`${runtime?.counts.actions ?? 0} governed actions`} tone="red" onClick={() => openEpisodeDetail()} />
        <Metric label="Mean cell completion" value={runtime ? `${runtime.health.averageLatencyMs} ms` : "—"} detail={`${runtime?.counts.executions ?? 0} traced executions`} tone="mint" onClick={() => onNavigate("assurance")} />
        <Metric label="CMS readiness" value={runtime?.rollups ? `${runtime.rollups.regulatory.value}%` : "—"} detail="Live submission readiness" onClick={() => onNavigate("cms")} />
        <Metric label="Trace completeness" value={runtime?.counts.events ? `${Math.round((runtime.counts.evidence / runtime.counts.events) * 100)}%` : "—"} detail="Event to evidence object" tone="mint" onClick={() => onNavigate("assurance")} />
      </section>

      <section className="command-grid">
        <article className="panel mission-panel">
          <div className="panel-header">
            <div>
              <div className="inline-cluster">
                <Tag tone={selected.tone}>{selected.kind === "action" ? "Next-best action" : selected.status}</Tag>
                <span className="mono-id">{selected.id}</span>
              </div>
              <h2>{selected.title}</h2>
            </div>
            {selected.confidence > 0 ? (
              <div className="confidence-ring" aria-label={`${Math.round(selected.confidence * 100)} percent confidence`}>
                <strong>{Math.round(selected.confidence * 100)}</strong><small>%</small>
              </div>
            ) : null}
          </div>

          <button className="patient-strip drillable-surface" type="button" onClick={() => openEpisodeDetail()} aria-label="Open outcome detail">
            <div className="avatar">{selected.kind === "action" ? "NBA" : "EP"}</div>
            <div><strong>{selected.scope}</strong><small>{selected.subtitle}</small></div>
            <span className="patient-spacer" />
            <div className="patient-context"><MapPin size={14} /> {selected.kind === "episode" ? (selectedEpisode?.scopeType ?? "facility") : selected.scope}</div>
            <div className="patient-context"><Clock3 size={14} /> {selected.due}</div>
          </button>

          <div className="loop-rail" aria-label="Outcome loop progress">
            {[
              ["Observe", "Events joined", "done"],
              ["Understand", `${swarmPerspectives.length} cells converged`, "done"],
              ["Coordinate", canAck || selected.status === "completed" || selectedEpisode?.state === "Coordinating" ? "Command emitted" : "Human decision", canAck || selected.status === "completed" || selectedEpisode?.state === "Coordinating" ? "done" : "active"],
              ["Verify", canAck && (selected.status === "completed" || selectedEpisode?.state === "Resolved") ? "Outcome acknowledged" : "Await outcome", canAck && (selected.status === "completed" || selectedEpisode?.state === "Resolved") ? "done" : "next"],
            ].map(([label, detail, state], index) => (
              <div className={`loop-step loop-${state}`} key={label}>
                <span>{state === "done" ? <CheckCircle2 size={14} /> : index + 1}</span>
                <div><strong>{label}</strong><small>{detail}</small></div>
              </div>
            ))}
          </div>

          <div className="decision-summary">
            <div className="decision-icon"><UserRoundCheck size={20} /></div>
            <div>
              <Eyebrow>Coordinated plan · {selected.actionClass}</Eyebrow>
              <h3>{selected.title}</h3>
              <p>Backed by {selected.evidenceCount} evidence objects across {selected.cells.length || 1} cell(s). No autonomous clinical action is included.</p>
              {typeof selectedEpisode?.evidenceFusion?.belief === "number" ? <p className="evidence-status">Evidence fusion · Bel {Math.round(selectedEpisode.evidenceFusion.belief * 100)}% · Pl {Math.round((selectedEpisode.evidenceFusion.plausibility ?? 0) * 100)}% · K {(selectedEpisode.evidenceFusion.conflictMass ?? 0).toFixed(2)} · {selectedEpisode.evidenceStatus ?? "fused"}{selectedEpisode.evidenceFusion.sources?.length ? ` · ${selectedEpisode.evidenceFusion.sources.length} source(s)` : ""}</p> : null}
            </div>
          </div>

          <div className="evidence-chips">
            {selected.cells.length ? selected.cells.slice(0, 6).map((cell) => <button type="button" onClick={() => onNavigate("agents")} key={cell}>{cell}</button>) : <button type="button" onClick={() => onNavigate("intelligence")} key="graph">Shared intelligence</button>}
          </div>

          <div className="action-row">
            {settled ? (
              <button className="button button-primary" disabled type="button"><CheckCircle2 size={16} /> {selected.status === "dismissed" || selectedEpisode?.state === "Rejected" ? "Decision dismissed" : "Outcome resolved"}</button>
            ) : canAck ? (
              <button className="button button-primary" disabled={reviewState === "saving"} onClick={() => void recordAck(selected, linkedEpisode?.episodeId)} type="button">{reviewState === "saving" ? <><Activity size={16} /> Recording…</> : <><CheckCircle2 size={16} /> Record downstream acknowledgement</>}</button>
            ) : (
              <button className="button button-primary" disabled={!runtime || reviewState === "saving"} onClick={() => void decideAction(selected, "approved")} type="button">{reviewState === "saving" ? <><Activity size={16} /> Recording…</> : <><ShieldCheck size={16} /> Review &amp; authorize</>}</button>
            )}
            {!settled && !canAck ? (
              <button className="button button-secondary" disabled={reviewState === "saving"} onClick={() => void decideAction(selected, "dismissed")} type="button"><XCircle size={16} /> Dismiss</button>
            ) : null}
            <button className="button button-secondary" disabled={coordinatorBusy} onClick={() => void requestCoordinatorReview()} type="button"><MessageSquareText size={16} /> {coordinatorBusy ? "Recording request…" : "Request coordinator review"}</button>
            <button className="button button-ghost" onClick={() => openEpisodeDetail()} type="button">Inspect evidence</button>
          </div>
          {reviewState === "recorded" || canAck ? <p className="action-feedback is-success"><CheckCircle2 size={13} /> {runtimeNotice ?? "Governed runtime transition persisted."}</p> : null}
          {reviewState === "error" ? <p className="action-feedback is-error">{runtimeNotice ?? "The policy boundary rejected the action. No downstream action occurred."}</p> : null}
        </article>

        <aside className="panel swarm-panel">
          <div className="panel-title-row">
            <div><Eyebrow>Swarm convergence</Eyebrow><h2>Bounded perspectives</h2></div>
            <Network size={19} /><PanelExpand />
          </div>
          <div className="cell-list">
            {swarmPerspectives.map((cell) => (
              <button className="cell-item drillable-surface" type="button" onClick={() => onOpenDetail({ id: `CELL-${cell.name.toUpperCase().replaceAll(" ", "-")}`, kind: "Swarm contribution", title: `${cell.name} perspective`, summary: cell.finding, status: `${cell.confidence}% confidence`, tone: cell.tone, owner: "Contributing cell", scope: selected.scope, metrics: [{ label: "Confidence", value: `${cell.confidence}%` }, ...(typeof cell.belief === "number" ? [{ label: "Belief", value: `${Math.round(cell.belief * 100)}%` }, { label: "Plausibility", value: `${Math.round((cell.plausibility ?? 0) * 100)}%` }, { label: "Uncertainty", value: `${Math.round((cell.uncertainty ?? 0) * 100)}%` }, { label: "Conflict K", value: (cell.conflictMass ?? 0).toFixed(2) }] : []), { label: "Episode", value: selected.id }], evidence: [], steps: [{ label: "Observe", detail: "Eligible events selected", state: "done" }, { label: "Evaluate", detail: cell.finding, state: "done" }, { label: "Propose", detail: "Bounded contribution retained", state: "done" }, { label: "Decide", detail: "Human-authorized plan", state: "current" }], primary: { label: "Open AI Assurance", target: "assurance" } })} key={cell.name}>
                <div className="cell-heading"><strong>{cell.name}</strong><span>{cell.confidence}%{typeof cell.belief === "number" ? ` · Bel ${Math.round(cell.belief * 100)}% · Pl ${Math.round((cell.plausibility ?? 0) * 100)}% · K ${(cell.conflictMass ?? 0).toFixed(2)}` : ""}</span></div>
                <p>{cell.finding}</p>
                <ProgressBar value={cell.confidence} tone={cell.tone} />
              </button>
            ))}
          </div>
          <div className="policy-note">
            <ShieldCheck size={16} />
            <p><strong>Harness decision:</strong> policy-compatible. Human approval required before any command is emitted; external writes remain disabled.</p>
          </div>
        </aside>
      </section>

      <section className="lower-grid">
        <article className="panel queue-panel">
          <div className="panel-title-row">
            <div><Eyebrow>Resolution queue</Eyebrow><h2>Outcome episodes &amp; next-best actions</h2></div>
            <span className="live-label"><span /> {runtime ? `D1 runtime · ${queue.length} items` : "Loading runtime"}</span>
          </div>
          <div className="episode-list">
            {queue.map((item) => <QueueRow key={item.id} item={item} selected={item.id === selected.id} onSelect={() => onSelect(item.id)} />)}
          </div>
        </article>

        <article className="panel event-panel">
          <div className="panel-title-row">
            <div><Eyebrow>Evidence timeline</Eyebrow><h2>Why the harness acted</h2></div>
            <Activity size={18} />
          </div>
          <ol className="timeline-list">
            {timelineEvents.map((event) => (
              <li key={`${event.time}-${event.label}`}>
                <time>{event.time}</time><span className={`timeline-node timeline-${event.state}`} />
                <div><strong>{event.label}</strong><small>{event.type} · {event.source}</small></div>
              </li>
            ))}
          </ol>
        </article>
      </section>
    </div>
  );
}
