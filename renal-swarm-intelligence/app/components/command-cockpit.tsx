"use client";

import { useEffect, useState } from "react";
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
} from "lucide-react";
import { outcomeEpisodes, patientTimeline } from "../../lib/demo-data";
import { ensureRuntime, fetchRuntimeSnapshot, mutateRuntime, type RuntimeSnapshot } from "../../lib/runtime/client";
import type { NavigationId, OutcomeEpisode } from "../../lib/types";
import type { OpenWorkflowDetail } from "../../lib/workflow-detail";
import { Eyebrow, Metric, ProgressBar, Tag } from "./ui";

const cells = [
  { name: "Transition", finding: "Discharged; next treatment unresolved", confidence: 99, tone: "mint" as const },
  { name: "Continuity", finding: "High probability of a treatment break", confidence: 96, tone: "red" as const },
  { name: "Transport", finding: "Usual Tuesday ride unavailable", confidence: 96, tone: "amber" as const },
  { name: "Capacity", finding: "14:30 chair is policy-compatible", confidence: 98, tone: "blue" as const },
  { name: "Life goals", finding: "Afternoon preserves work schedule", confidence: 93, tone: "mint" as const },
];

function EpisodeRow({ episode, selected, onSelect }: { episode: OutcomeEpisode; selected: boolean; onSelect: () => void }) {
  const tone = episode.urgency === "critical" ? "red" : episode.urgency === "high" ? "amber" : "blue";
  return (
    <button className={`episode-row ${selected ? "is-selected" : ""}`} onClick={onSelect} type="button">
      <span className={`priority-dot priority-${tone}`} aria-hidden="true" />
      <span className="episode-main">
        <strong>{episode.title}</strong>
        <small>{episode.patient} · {episode.facility}</small>
      </span>
      <span className="episode-meta">
        <small>{episode.due}</small>
        <Tag tone={tone}>{episode.urgency}</Tag>
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
  const selected = outcomeEpisodes.find((episode) => episode.id === selectedId) ?? outcomeEpisodes[0];
  const [reviewStates, setReviewStates] = useState<Record<string, "idle" | "saving" | "recorded" | "error">>({});
  const [runtime, setRuntime] = useState<RuntimeSnapshot | null>(null);
  const [runtimeNotice, setRuntimeNotice] = useState<string | null>(null);
  const [coordinatorBusy, setCoordinatorBusy] = useState(false);
  const reviewState = reviewStates[selected.id] ?? "idle";
  const runtimeAction = runtime?.actions.find((action) => action.episodeId === "OUT-RUNTIME-1042");
  const runtimeCommand = runtime?.commands.find((command) => command.actionId === runtimeAction?.actionId);
  const outcomeVerified = runtimeAction?.status === "completed";

  useEffect(() => {
    let active = true;
    void ensureRuntime("fa").then((snapshot) => { if (active) setRuntime(snapshot); }).catch((error) => { if (active) setRuntimeNotice(error instanceof Error ? error.message : "Runtime unavailable"); });
    return () => { active = false; };
  }, []);

  async function recordAuthorization() {
    setReviewStates((current) => ({ ...current, [selected.id]: "saving" }));
    try {
      if (!runtimeAction) throw new Error("The persisted continuity action is not ready");
      if (runtimeCommand && runtimeCommand.status !== "acknowledged") {
        await mutateRuntime("acknowledge", "fa", { commandId: runtimeCommand.commandId });
        setRuntimeNotice("Synthetic downstream acknowledgement verified the outcome and calculated the continuity measure.");
      } else {
        const result = await mutateRuntime<{ approved: boolean; commandId?: string; reasons: string[] }>("approve", "fa", { actionId: runtimeAction.actionId });
        if (!result.approved) throw new Error(result.reasons.join(" · "));
        setRuntimeNotice(`${result.commandId} entered the durable Kafka outbox; no scheduling or EMR write occurred.`);
      }
      setRuntime(await fetchRuntimeSnapshot());
      setReviewStates((current) => ({ ...current, [selected.id]: "recorded" }));
    } catch (error) {
      setRuntimeNotice(error instanceof Error ? error.message : "Runtime rejected the action");
      setReviewStates((current) => ({ ...current, [selected.id]: "error" }));
    }
  }

  async function requestCoordinatorReview() {
    setCoordinatorBusy(true);
    try {
      const result = await mutateRuntime<{ requestId: string; status: string }>("request-review", "fa", { entityType: "outcome-episode", entityId: runtimeAction?.episodeId ?? selected.id, targetRole: "fa", message: `Review continuity plan: ${selected.recommendation}` });
      setRuntimeNotice(`${result.requestId} was recorded in the audit ledger for the facility coordinator.`);
      setRuntime(await fetchRuntimeSnapshot());
    } catch (error) {
      setRuntimeNotice(error instanceof Error ? error.message : "Coordinator request failed");
    } finally {
      setCoordinatorBusy(false);
    }
  }

  function openEpisodeDetail(target: NavigationId = "patient") {
    const eventRows = runtime?.events.filter((event) => event.correlationId === "OUT-RUNTIME-1042") ?? [];
    onOpenDetail({
      id: String(runtimeAction?.episodeId ?? selected.id),
      kind: "Outcome episode",
      title: selected.title,
      summary: selected.recommendation,
      status: outcomeVerified ? "Resolved" : runtimeCommand ? "Verifying" : "Awaiting approval",
      tone: outcomeVerified ? "mint" : "red",
      owner: selected.owner,
      scope: selected.facility,
      due: selected.due,
      metrics: [{ label: "Confidence", value: `${Math.round(selected.confidence * 100)}%` }, { label: "Evidence", value: String(runtimeAction?.evidenceCount ?? selected.evidenceCount) }, { label: "Action class", value: selected.actionClass }, { label: "Events", value: String(eventRows.length) }],
      evidence: selected.signals.map((signal, index) => ({ label: `Signal ${index + 1}`, value: signal, source: eventRows[index]?.eventType ?? "Outcome evidence ledger" })).concat(runtime?.evidence.slice(0, 3).map((item) => ({ label: item.evidenceType, value: item.exactText ?? item.evidenceId, source: `${item.sourceEventId} · ${item.contentHash.slice(0, 12)}…` })) ?? []),
      activity: [{ time: "07:14", title: "Discharge observed", detail: "Next treatment confirmation unresolved", state: "done" }, { time: "07:16", title: "Five cells converged", detail: "Transition, continuity, transport, capacity and life-goal perspectives retained", state: "done" }, { time: runtimeCommand ? "Authorized" : "Current", title: runtimeCommand ? "Command emitted" : "Human review required", detail: runtimeCommand?.commandId ?? "No external scheduling write", state: runtimeCommand ? "done" : "current" }, { time: outcomeVerified ? "Verified" : "Pending", title: outcomeVerified ? "Outcome acknowledged" : "Await downstream acknowledgement", detail: outcomeVerified ? "Continuity measure calculated" : "Loop remains open", state: outcomeVerified ? "done" : "pending" }],
      steps: [{ label: "Observe", detail: "Events joined", state: "done" }, { label: "Understand", detail: "Five cells converged", state: "done" }, { label: "Coordinate", detail: runtimeCommand ? "Command emitted" : "Human review", state: runtimeCommand ? "done" : "current" }, { label: "Verify", detail: outcomeVerified ? "Outcome acknowledged" : "Await outcome", state: outcomeVerified ? "done" : "pending" }],
      primary: { label: target === "assessments" ? "Open Assessment Intelligence" : target === "patient" ? "Open Patient Intelligence" : "Open Shared Intelligence", target },
    });
  }

  return (
    <div className="view-stack command-view">
      <header className="view-heading command-heading">
        <div>
          <Eyebrow>Outcome command · Friday, August 21</Eyebrow>
          <h1>One care journey needs a decision.</h1>
          <p>The harness assembled a safe, evidence-backed plan. The coordinator remains in control.</p>
        </div>
        <button className="button button-primary demo-launch" onClick={onOpenDemo} type="button">
          <Sparkles size={16} aria-hidden="true" />
          Run the guided demo
        </button>
      </header>

      <section className="metrics-grid" aria-label="Current operating metrics">
        <Metric label="Runtime outcome episodes" value={String(runtime?.episodes.length ?? "—").padStart(2, "0")} detail={`${runtime?.counts.actions ?? 0} governed actions`} tone="red" onClick={() => openEpisodeDetail("patient")} />
        <Metric label="Mean cell completion" value={runtime ? `${runtime.health.averageLatencyMs} ms` : "—"} detail={`${runtime?.counts.executions ?? 0} traced executions`} tone="mint" onClick={() => onNavigate("assurance")} />
        <Metric label="CMS readiness" value="94.2%" detail="Across active measure packs" onClick={() => onNavigate("cms")} />
        <Metric label="Trace completeness" value={runtime?.counts.events ? `${Math.round((runtime.counts.evidence / runtime.counts.events) * 100)}%` : "—"} detail="Event to evidence object" tone="mint" onClick={() => onNavigate("assurance")} />
      </section>

      <section className="command-grid">
        <article className="panel mission-panel">
          <div className="panel-header">
            <div>
              <div className="inline-cluster">
                <Tag tone="red">Critical continuity episode</Tag>
                <span className="mono-id">{selected.id}</span>
              </div>
              <h2>{selected.title}</h2>
            </div>
            <div className="confidence-ring" aria-label={`${Math.round(selected.confidence * 100)} percent confidence`}>
              <strong>{Math.round(selected.confidence * 100)}</strong><small>%</small>
            </div>
          </div>

          <button className="patient-strip drillable-surface" type="button" onClick={() => openEpisodeDetail("patient")} aria-label={`Open patient details for ${selected.patient}`}>
            <div className="avatar">MO</div>
            <div><strong>{selected.patient}</strong><small>{selected.patientId} · synthetic patient</small></div>
            <span className="patient-spacer" />
            <div className="patient-context"><MapPin size={14} /> {selected.facility}</div>
            <div className="patient-context"><Clock3 size={14} /> Next treatment today</div>
          </button>

          <div className="loop-rail" aria-label="Outcome loop progress">
            {[
              ["Observe", "Events joined", "done"],
              ["Understand", "5 cells converged", "done"],
              ["Coordinate", runtimeCommand ? "Command emitted" : "Human review", runtimeCommand ? "done" : "active"],
              ["Verify", outcomeVerified ? "Outcome acknowledged" : "Await outcome", outcomeVerified ? "done" : "next"],
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
              <Eyebrow>Recommended coordinated plan · Class {selected.actionClass}</Eyebrow>
              <h3>{selected.recommendation}</h3>
              <p>Generated from nine evidence objects. No clinical prescription or autonomous clinical action is included.</p>
            </div>
          </div>

          <div className="evidence-chips">{selected.signals.map((signal) => <button type="button" onClick={() => openEpisodeDetail("assessments")} key={signal}>{signal}</button>)}</div>

          <div className="action-row">
            <button className="button button-primary" disabled={!runtimeAction || reviewState === "saving" || outcomeVerified} onClick={recordAuthorization} type="button"><ShieldCheck size={16} /> {reviewState === "saving" ? "Recording…" : outcomeVerified ? "Outcome verified" : runtimeCommand ? "Record downstream acknowledgement" : reviewState === "error" ? "Retry authorization" : "Review & authorize"}</button>
            <button className="button button-secondary" disabled={coordinatorBusy} onClick={() => void requestCoordinatorReview()} type="button"><MessageSquareText size={16} /> {coordinatorBusy ? "Recording request…" : "Request coordinator review"}</button>
            <button className="button button-ghost" onClick={() => openEpisodeDetail("assessments")} type="button">Inspect evidence</button>
          </div>
          {reviewState === "recorded" || outcomeVerified ? <p className="action-feedback is-success"><CheckCircle2 size={13} /> {runtimeNotice ?? "Governed runtime transition persisted."}</p> : null}
          {reviewState === "error" ? <p className="action-feedback is-error">{runtimeNotice ?? "The policy boundary rejected the action. No downstream action occurred."}</p> : null}
        </article>

        <aside className="panel swarm-panel">
          <div className="panel-title-row">
            <div><Eyebrow>Swarm convergence</Eyebrow><h2>Five bounded perspectives</h2></div>
            <Network size={19} />
          </div>
          <div className="cell-list">
            {cells.map((cell) => (
              <button className="cell-item drillable-surface" type="button" onClick={() => onOpenDetail({ id: `CELL-${cell.name.toUpperCase().replaceAll(" ", "-")}`, kind: "Swarm contribution", title: `${cell.name} perspective`, summary: cell.finding, status: `${cell.confidence}% confidence`, tone: cell.tone, owner: `${cell.name} cell`, scope: selected.facility, metrics: [{ label: "Confidence", value: `${cell.confidence}%` }, { label: "Episode", value: selected.id }], evidence: selected.signals.map((signal, index) => ({ label: `Evidence ${index + 1}`, value: signal, source: "Episode evidence set" })), steps: [{ label: "Observe", detail: "Eligible events selected", state: "done" }, { label: "Evaluate", detail: cell.finding, state: "done" }, { label: "Propose", detail: "Bounded contribution retained", state: "done" }, { label: "Decide", detail: "Human-authorized plan", state: "current" }], primary: { label: "Open AI Assurance", target: "assurance" } })} key={cell.name}>
                <div className="cell-heading"><strong>{cell.name}</strong><span>{cell.confidence}%</span></div>
                <p>{cell.finding}</p>
                <ProgressBar value={cell.confidence} tone={cell.tone} />
              </button>
            ))}
          </div>
          <div className="policy-note">
            <ShieldCheck size={16} />
            <p><strong>Harness decision:</strong> policy-compatible. Human approval required because the action changes scheduled services.</p>
          </div>
        </aside>
      </section>

      <section className="lower-grid">
        <article className="panel queue-panel">
          <div className="panel-title-row">
            <div><Eyebrow>Resolution queue</Eyebrow><h2>Active outcome episodes</h2></div>
            <span className="live-label"><span /> {runtime ? "D1 runtime + reference queue" : "Loading runtime"}</span>
          </div>
          <div className="episode-list">
            {outcomeEpisodes.map((episode) => <EpisodeRow key={episode.id} episode={episode} selected={episode.id === selected.id} onSelect={() => onSelect(episode.id)} />)}
          </div>
        </article>

        <article className="panel event-panel">
          <div className="panel-title-row">
            <div><Eyebrow>Evidence timeline</Eyebrow><h2>Why the harness acted</h2></div>
            <Activity size={18} />
          </div>
          <ol className="timeline-list">
            {(runtime?.events.filter((event) => event.correlationId === "OUT-RUNTIME-1042").slice().reverse().map((event) => ({ time: new Date(event.recordedTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), label: event.eventType, type: event.subjectType, source: event.sourceSystem, state: "complete" })) ?? patientTimeline.slice(0, 5)).map((event) => (
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
