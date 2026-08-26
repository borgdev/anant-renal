"use client";

import { useEffect, useState } from "react";

import {
  Activity,
  CalendarClock,
  CheckCircle2,
  ClipboardList,
  HeartHandshake,
  MapPin,
  ShieldCheck,
  Sparkles,
  Stethoscope,
  Target,
} from "lucide-react";
import { assessmentResponses, outcomeEpisodes, patientTimeline } from "../../lib/demo-data";
import { ensureRuntime, type RuntimeSnapshot } from "../../lib/runtime/client";
import type { NavigationId } from "../../lib/types";
import type { OpenWorkflowDetail } from "../../lib/workflow-detail";
import { Eyebrow, ProgressBar, Tag } from "./ui";

const stateCards = [
  { label: "Next treatment", value: "Today · 14:30 proposed", detail: "Awaiting coordinator approval", tone: "amber" as const, icon: CalendarClock },
  { label: "Modality", value: "In-center HD", detail: "Mon · Wed · Fri", tone: "mint" as const, icon: Stethoscope },
  { label: "Access", value: "Left AV fistula", detail: "Last observation stable", tone: "mint" as const, icon: Activity },
  { label: "Open goals", value: "Preserve morning work", detail: "Patient-confirmed 18 Aug", tone: "blue" as const, icon: Target },
];

export default function PatientIntelligence({ onOpenDetail }: { onOpenDetail: OpenWorkflowDetail }) {
  const mayaEpisodes = outcomeEpisodes.filter((episode) => episode.patient === "Maya Ortiz");
  const [runtime, setRuntime] = useState<RuntimeSnapshot | null>(null);
  const runtimeAssessment = runtime?.evidence.find((item) => item.evidenceType === "assessment.response.v1");
  const runtimeEpisode = runtime?.episodes.find((episode) => episode.episodeId === "OUT-RUNTIME-1042");

  useEffect(() => {
    let active = true;
    void ensureRuntime("fa").then((snapshot) => { if (active) setRuntime(snapshot); }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  function openPatientState(label: string, value: string, detail: string, target: NavigationId) {
    onOpenDetail({ id: `PATIENT-STATE-${label.toUpperCase().replaceAll(" ", "-")}`, kind: "Temporal patient state", title: label, summary: detail, status: value, tone: label === "Next treatment" ? "amber" : "mint", owner: "Facility coordinator", scope: "Maya Ortiz · SYN-10042", metrics: [{ label, value }, { label: "Evidence objects", value: String(runtime?.counts.evidence ?? 0) }, { label: "State confidence", value: runtimeEpisode ? `${Math.round(Number(runtimeEpisode.confidenceBasisPoints ?? 0) / 100)}%` : "—" }], evidence: [{ label: "Current projection", value, source: runtime?.runtime.configuration ?? "reference projection" }, ...(runtimeAssessment ? [{ label: "Assessment evidence", value: runtimeAssessment.exactText ?? runtimeAssessment.evidenceId, source: `${runtimeAssessment.sourceEventId} · ${runtimeAssessment.contentHash.slice(0, 12)}…` }] : [])], steps: [{ label: "Observe", detail: "Source events accepted", state: "done" }, { label: "Reconcile", detail: "Bitemporal state assembled", state: "done" }, { label: "Review", detail, state: label === "Next treatment" ? "current" : "done" }, { label: "Verify", detail: "Await future event", state: label === "Next treatment" ? "pending" : "current" }], primary: { label: target === "facility" ? "Open Facility Operations" : target === "assessments" ? "Open Assessment Intelligence" : "Open Outcome Command", target } });
  }

  function openOutcomeLoop(title: string, id: string, recommendation: string, state: string) {
    onOpenDetail({ id, kind: "Patient outcome loop", title, summary: recommendation, status: state, tone: state.toLowerCase().includes("verified") ? "mint" : state.toLowerCase().includes("watch") ? "blue" : "red", owner: "Facility coordinator", scope: "Maya Ortiz · Riverbend Franklin", metrics: [{ label: "Loop state", value: state }, { label: "Commands", value: String(runtime?.counts.commands ?? 0) }, { label: "Acknowledgements", value: String(runtime?.counts.acknowledgements ?? 0) }], evidence: (runtime?.events.filter((event) => event.subjectId === "SYN-10042").slice(0, 5).map((event) => ({ label: event.eventType, value: new Date(event.recordedTime).toLocaleString(), source: `${event.sourceSystem} · ${event.traceId.slice(0, 10)}` })) ?? []), steps: [{ label: "Observe", detail: "Patient-scoped evidence joined", state: "done" }, { label: "Understand", detail: "Outcome need established", state: "done" }, { label: "Coordinate", detail: state.toLowerCase().includes("verified") ? "Action completed" : "Human workflow active", state: state.toLowerCase().includes("verified") ? "done" : "current" }, { label: "Verify", detail: state.toLowerCase().includes("verified") ? "Acknowledgement retained" : "Await outcome event", state: state.toLowerCase().includes("verified") ? "done" : "pending" }], primary: { label: "Open Outcome Command", target: "command" } });
  }

  return (
    <div className="view-stack patient-view">
      <header className="view-heading">
        <div>
          <Eyebrow>Patient intelligence · synthetic longitudinal record</Eyebrow>
          <h1>Maya Ortiz</h1>
          <p>One reviewable patient state assembled from events, assessments and human-verified facts.</p>
        </div>
        <div className="heading-actions">
          <Tag tone="violet"><ShieldCheck size={12} /> SYN-10042 · non-production</Tag>
          <button className="button button-secondary" type="button" onClick={() => openPatientState("Evidence brief", `${runtime?.counts.evidence ?? 0} objects`, "Review the exact sources and provenance before exporting through an approved enterprise document connector.", "assessments")}><ClipboardList size={15} /> Inspect evidence brief</button>
        </div>
      </header>

      <section className="patient-identity panel">
        <div className="patient-hero-avatar">MO</div>
        <div className="patient-identity-copy">
          <div className="inline-cluster"><h2>Maya Ortiz</h2><Tag tone="red">Continuity review</Tag></div>
          <p>Age 54 · English / Spanish · Riverbend Franklin · primary nephrology team: Synthetic Team A</p>
          <div className="identity-facts"><span><MapPin size={13} /> 22 miles from facility</span><span><HeartHandshake size={13} /> Daughter is primary support</span><span><CheckCircle2 size={13} /> Consent status current</span></div>
        </div>
        <div className="trust-score"><small>State confidence</small><strong>{runtimeEpisode ? `${Math.round(Number(runtimeEpisode.confidenceBasisPoints ?? 0) / 100)}%` : "—"}</strong><span>{runtime?.counts.evidence ?? 0} evidence objects reconciled</span></div>
      </section>

      <section className="state-grid" aria-label="Current patient state">
        {stateCards.map((card) => {
          const Icon = card.icon;
          return (
            <button className="state-card drillable-surface" type="button" onClick={() => openPatientState(card.label, card.value, card.detail, card.label === "Next treatment" ? "facility" : card.label === "Open goals" ? "assessments" : "command")} key={card.label}>
              <div className={`state-icon state-${card.tone}`}><Icon size={17} /></div>
              <div><small>{card.label}</small><strong>{card.value}</strong><span>{card.detail}</span></div>
            </button>
          );
        })}
      </section>

      <section className="patient-main-grid">
        <article className="panel patient-narrative">
          <div className="panel-title-row">
            <div><Eyebrow>Evidence-grounded brief</Eyebrow><h2>What matters now</h2></div>
            <Sparkles size={18} />
          </div>
          <div className="narrative-block">
            <p>Maya was discharged and the next treatment was not confirmed. Her exact assessment answer says: “{runtimeAssessment?.exactText ?? assessmentResponses[0].answer}” A compatible chair signal exists, so the harness created a bounded, human-reviewed continuity proposal.</p>
            <div className="citation-row"><span>FHIR Encounter event</span><span>{runtimeAssessment?.evidenceId ?? "Assessment AR-1401"}</span><span>{runtime?.runtime.configuration ?? "reference configuration"}</span></div>
          </div>
          <div className="narrative-boundary">
            <ShieldCheck size={17} />
            <div><strong>Grounding boundary active</strong><p>The brief may summarize cited evidence. It cannot diagnose, prescribe, alter orders or infer unsupported facts.</p></div>
          </div>
          <div className="goal-list">
            <div className="list-section-title"><span>Patient goals &amp; constraints</span><small>Human confirmed</small></div>
            <button type="button" onClick={() => openPatientState("Open goal", "Preserve morning work", "Patient-confirmed preference: schedule after 13:00.", "assessments")}><Target size={15} /><span><strong>Keep morning work shift</strong><small>Preferred schedule: after 13:00</small></span><Tag tone="mint">Current</Tag></button>
            <button type="button" onClick={() => openPatientState("Transportation barrier", "Tuesday ride unavailable", "The patient’s exact answer remains cited and human-reviewable.", "assessments")}><MapPin size={15} /><span><strong>Transportation changed</strong><small>Daughter unavailable Tuesdays</small></span><Tag tone="amber">Barrier</Tag></button>
          </div>
        </article>

        <aside className="panel outcome-loops-panel">
          <div className="panel-title-row"><div><Eyebrow>Outcome loops</Eyebrow><h2>Open &amp; recently verified</h2></div><span className="mini-count">03</span></div>
          <div className="outcome-loop-list">
            {mayaEpisodes.map((episode) => (
              <button className="outcome-loop-card is-open drillable-surface" type="button" onClick={() => openOutcomeLoop(episode.title, String(runtimeEpisode?.episodeId ?? episode.id), episode.recommendation, runtimeEpisode?.status === "resolved" ? "Verified" : "Open · critical")} key={episode.id}>
                <div className="loop-card-top"><Tag tone={runtimeEpisode?.status === "resolved" ? "mint" : "red"}>{runtimeEpisode?.status === "resolved" ? "Verified" : "Open · critical"}</Tag><span>{String(runtimeEpisode?.episodeId ?? episode.id)}</span></div>
                <strong>{episode.title}</strong>
                <p>{episode.recommendation}</p>
                <ProgressBar value={runtimeEpisode?.status === "resolved" ? 100 : runtime?.counts.commands ? 82 : 68} tone={runtimeEpisode?.status === "resolved" ? "mint" : "amber"} />
                <small>{runtimeEpisode?.status === "resolved" ? "Outcome acknowledgement and measure retained" : runtime?.counts.commands ? "Command emitted · verify pending" : "Coordinate 3/4 · verify pending"}</small>
              </button>
            ))}
            <button className="outcome-loop-card drillable-surface" type="button" onClick={() => openOutcomeLoop("Medication reconciliation complete", "OUT-0981", "Clinician confirmed the post-discharge medication list.", "Verified")}>
              <div className="loop-card-top"><Tag tone="mint">Verified</Tag><span>OUT-0981</span></div>
              <strong>Medication reconciliation complete</strong>
              <p>Clinician confirmed the post-discharge medication list.</p>
              <small>Verified 07 Aug · evidence retained</small>
            </button>
            <button className="outcome-loop-card drillable-surface" type="button" onClick={() => openOutcomeLoop("Transplant education follow-up", "OUT-0912", "Patient requested a Spanish-language session next month.", "Watching")}>
              <div className="loop-card-top"><Tag tone="blue">Watching</Tag><span>OUT-0912</span></div>
              <strong>Transplant education follow-up</strong>
              <p>Patient requested a Spanish-language session next month.</p>
              <small>Next review 04 Sep</small>
            </button>
          </div>
        </aside>
      </section>

      <section className="patient-lower-grid">
        <article className="panel evidence-ledger">
          <div className="panel-title-row"><div><Eyebrow>Bitemporal event ledger</Eyebrow><h2>What changed, and when we knew</h2></div><Tag tone="mint">Replayable</Tag></div>
          <div className="ledger-table">
            <div className="ledger-head"><span>Valid time</span><span>Evidence</span><span>Source</span><span>State</span></div>
            {(runtime?.events.filter((event) => event.subjectId === "SYN-10042").map((event) => ({ time: new Date(event.recordedTime).toLocaleString(), label: event.eventType, source: event.sourceSystem, state: event.status === "accepted" ? "complete" : "review" })) ?? patientTimeline).map((event) => (
              <button className="ledger-row drillable-surface" type="button" onClick={() => onOpenDetail({ id: `LEDGER-${event.time}-${event.label}`, kind: "Bitemporal ledger entry", title: event.label, summary: `The event was retained from ${event.source} with its valid and recorded time.`, status: event.state, tone: event.state === "review" ? "amber" : "mint", owner: event.source, scope: "SYN-10042", metrics: [{ label: "Valid / recorded time", value: event.time }, { label: "State", value: event.state }], evidence: [{ label: "Source", value: event.source, source: "Canonical event envelope" }], steps: [{ label: "Ingest", detail: "Schema and integrity checked", state: "done" }, { label: "Persist", detail: "Immutable envelope retained", state: "done" }, { label: "Project", detail: "Patient state updated", state: "done" }, { label: "Review", detail: event.state, state: event.state === "review" ? "current" : "done" }], primary: { label: "Open Shared Intelligence", target: "intelligence" } })} key={`${event.time}-${event.label}`}>
                <time>{event.time}</time><strong>{event.label}</strong><span>{event.source}</span><Tag tone={event.state === "review" ? "amber" : event.state === "derived" ? "blue" : "mint"}>{event.state}</Tag>
              </button>
            ))}
          </div>
        </article>

        <article className="panel patient-assessment-preview">
          <div className="panel-title-row"><div><Eyebrow>Assessment evidence</Eyebrow><h2>Answers in context</h2></div><Tag tone="violet">{runtimeAssessment ? "1 persisted + reference" : "3 reference"}</Tag></div>
          {assessmentResponses.slice(0, 2).map((response, index) => (
            <button className="answer-preview drillable-surface" type="button" onClick={() => openPatientState("Assessment answer", response.question, index === 0 && runtimeAssessment?.exactText ? runtimeAssessment.exactText : response.answer, "assessments")} key={response.id}>
              <small>{response.question}</small>
              <p>“{index === 0 && runtimeAssessment?.exactText ? runtimeAssessment.exactText : response.answer}”</p>
              <span>{index === 0 && runtimeAssessment ? `${runtimeAssessment.sourceEventId} · hash ${runtimeAssessment.contentHash.slice(0, 10)}…` : `${response.source} · ${response.effective}`}</span>
            </button>
          ))}
        </article>
      </section>
    </div>
  );
}
