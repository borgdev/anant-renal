"use client";

import { useEffect, useState } from "react";
import {
  ArrowRight,
  BookOpenCheck,
  Braces,
  Check,
  CircleAlert,
  FileText,
  Filter,
  Fingerprint,
  MessageSquareQuote,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { assessmentResponses } from "../../lib/demo-data";
import { ensureRuntime, fetchRuntimeSnapshot, mutateRuntime, type RuntimeSnapshot } from "../../lib/runtime/client";
import type { NavigationId } from "../../lib/types";
import type { OpenWorkflowDetail } from "../../lib/workflow-detail";
import { Eyebrow, ProgressBar, Tag } from "./ui";

type ReviewState = "pending" | "confirmed";

export default function AssessmentIntelligence({ onNavigate, onOpenDetail }: { onNavigate: (id: NavigationId) => void; onOpenDetail: OpenWorkflowDetail }) {
  const [selected, setSelected] = useState(assessmentResponses[0].id);
  const [reviews, setReviews] = useState<Record<string, ReviewState>>({ "AR-1401-Transportation barrier": "confirmed", "AR-1401-Tuesday-specific constraint": "confirmed", "AR-1402-Employment goal": "confirmed", "AR-1402-Afternoon preference": "confirmed" });
  const [runtime, setRuntime] = useState<RuntimeSnapshot | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const response = assessmentResponses.find((item) => item.id === selected) ?? assessmentResponses[0];
  const selectedQuestionId = response.id === "AR-1401" ? "transport-next-week" : response.id === "AR-1402" ? "schedule-goal" : null;
  const runtimeEvidence = runtime?.evidence.find((item) => item.evidenceType === "assessment.response.v1" && item.structured.questionId === selectedQuestionId);
  const runtimeReview = runtime?.evidenceReviews.find((item) => item.evidenceId === runtimeEvidence?.evidenceId);
  const usesRuntimeEvidence = Boolean(runtimeEvidence);

  useEffect(() => {
    let active = true;
    void ensureRuntime("fa").then((snapshot) => { if (active) setRuntime(snapshot); }).catch((error) => { if (active) setReviewError(error instanceof Error ? error.message : "Runtime evidence unavailable"); });
    return () => { active = false; };
  }, []);

  async function toggleReview(concept: string) {
    if (usesRuntimeEvidence && runtimeEvidence) {
      setReviewBusy(true);
      try {
        const decision = runtimeReview?.decision === "confirmed" ? "rejected" : "confirmed";
        await mutateRuntime("review-evidence", "fa", { evidenceId: runtimeEvidence.evidenceId, decision });
        setRuntime(await fetchRuntimeSnapshot());
        setReviewError(null);
      } catch (error) {
        setReviewError(error instanceof Error ? error.message : "Evidence review failed");
      } finally {
        setReviewBusy(false);
      }
      return;
    }
    const key = `${response.id}-${concept}`;
    setReviews((current) => ({ ...current, [key]: current[key] === "confirmed" ? "pending" : "confirmed" }));
  }

  function openAssessmentDetail(title: string, summary: string, target: NavigationId = "patient") {
    const confirmed = usesRuntimeEvidence ? runtimeReview?.decision === "confirmed" || runtimeEvidence?.structured.humanConfirmed === true : true;
    onOpenDetail({ id: runtimeEvidence?.evidenceId ?? response.id, kind: "Assessment evidence", title, summary, status: confirmed ? "Human confirmed" : "Review required", tone: confirmed ? "mint" : "amber", owner: "Facility assessment reviewer", scope: "Maya Ortiz · SYN-10042", metrics: [{ label: "Format", value: response.format }, { label: "Extracted facts", value: String(response.extracted.length) }, { label: "Reviews", value: String(runtime?.counts.evidenceReviews ?? 0) }], evidence: [{ label: "Exact answer", value: runtimeEvidence?.exactText ?? response.answer, source: runtimeEvidence ? `${runtimeEvidence.sourceEventId} · ${runtimeEvidence.contentHash.slice(0, 12)}…` : response.source }, ...response.extracted.map((fact) => ({ label: fact.concept, value: `${Math.round(fact.confidence * 100)}% confidence`, source: "Cited span attached" }))], activity: [{ time: response.effective, title: "Answer became valid", detail: response.question, state: "done" }, { time: runtimeEvidence?.recordedAt ? new Date(runtimeEvidence.recordedAt).toLocaleString() : "Recorded", title: "Immutable evidence created", detail: runtimeEvidence?.evidenceId ?? response.id, state: "done" }, { time: runtimeReview?.createdAt ? new Date(runtimeReview.createdAt).toLocaleString() : "Current", title: confirmed ? "Human confirmation retained" : "Awaiting reviewer", detail: runtimeReview?.reviewerRole ?? "No semantic fact advances without review", state: confirmed ? "done" : "current" }], steps: [{ label: "Capture", detail: "Exact answer retained", state: "done" }, { label: "Extract", detail: "Bounded fact candidates produced", state: "done" }, { label: "Review", detail: confirmed ? "Human decision recorded" : "Reviewer decision required", state: confirmed ? "done" : "current" }, { label: "Use", detail: "Policy-compatible downstream context", state: confirmed ? "current" : "pending" }], primary: { label: target === "patient" ? "Open Patient Intelligence" : target === "command" ? "Open Outcome Command" : "Open AI Assurance", target } });
  }

  return (
    <div className="view-stack assessment-view">
      <header className="view-heading">
        <div>
          <Eyebrow>Assessment intelligence · provenance before prediction</Eyebrow>
          <h1>Turn answers into governed evidence.</h1>
          <p>Exact structured and unstructured responses remain visible beside every extracted fact and downstream use.</p>
        </div>
        <button className="button button-secondary" type="button" onClick={() => onNavigate("patient")}><Filter size={15} /> Patient · Maya Ortiz</button>
      </header>

      <section className="assessment-metrics metrics-grid">
        <button className="metric metric-mint drillable-surface" type="button" onClick={() => openAssessmentDetail("Runtime responses", "Every response preserves exact answer text, source identity, effective time, recorded time and content hash.")}><div className="metric-topline"><span>Runtime responses</span><MessageSquareQuote size={14} /></div><strong>{runtime?.evidence.filter((item) => item.evidenceType === "assessment.response.v1").length ?? "—"}</strong><small>Immutable exact-answer evidence</small></button>
        <button className="metric drillable-surface" type="button" onClick={() => openAssessmentDetail("Assessment proposals", "The assessment cell produces bounded candidates with cited spans; it does not write patient facts autonomously.", "assurance")}><div className="metric-topline"><span>Assessment proposals</span><Sparkles size={14} /></div><strong>{runtime?.executions.filter((item) => item.agentId === "assessment-cell").length ?? "—"}</strong><small>Bounded fact candidates</small></button>
        <button className="metric metric-amber drillable-surface" type="button" onClick={() => openAssessmentDetail("Human reviews", "Confirmed or rejected decisions are persisted beside the cited evidence and reviewer role.")}><div className="metric-topline"><span>Human reviews</span><CircleAlert size={14} /></div><strong>{runtime?.counts.evidenceReviews ?? "—"}</strong><small>No downstream action without policy</small></button>
        <button className="metric metric-mint drillable-surface" type="button" onClick={() => openAssessmentDetail("Groundedness gate", "The registered extractor is evaluated for cited-span groundedness and can be disabled with its kill switch.", "assurance")}><div className="metric-topline"><span>Groundedness gate</span><ShieldCheck size={14} /></div><strong>{runtime?.models.find((model) => model.modelId === "grounded-assessment-extractor") ? `${Math.round((runtime.models.find((model) => model.modelId === "grounded-assessment-extractor")?.evaluationScoreBasisPoints ?? 0) / 100)}%` : "—"}</strong><small>Persisted model registry</small></button>
      </section>

      <section className="assessment-layout">
        <aside className="panel response-list-panel">
          <div className="panel-title-row"><div><Eyebrow>Source responses</Eyebrow><h2>Latest patient answers</h2></div><span className="mini-count">03</span></div>
          <div className="response-list">
            {assessmentResponses.map((item) => (
              <button className={`response-select ${item.id === response.id ? "is-selected" : ""}`} onClick={() => setSelected(item.id)} type="button" key={item.id}>
                <span className="response-type-icon">{item.format === "Free text" ? <FileText size={15} /> : <Braces size={15} />}</span>
                <span><small>{item.id} · {item.format}</small><strong>{item.question}</strong><em>{item.source}</em></span>
                <ArrowRight size={15} />
              </button>
            ))}
          </div>
          <div className="ingestion-contract"><Fingerprint size={16} /><div><strong>Immutable source envelope</strong><p>Instrument, version, respondent, valid time, recorded time and content hash travel together.</p></div></div>
        </aside>

        <article className="panel answer-inspector">
          <div className="answer-inspector-head">
            <div><Eyebrow>Exact response · {response.id}</Eyebrow><h2>{response.question}</h2></div>
            <Tag tone="violet">{response.format}</Tag>
          </div>
          <blockquote>{usesRuntimeEvidence ? runtimeEvidence?.exactText : response.answer}</blockquote>
          <div className="answer-provenance">
            <span><small>Instrument</small><strong>{usesRuntimeEvidence ? runtimeEvidence?.sourceEventId : response.source}</strong></span>
            <span><small>Effective</small><strong>{usesRuntimeEvidence ? new Date(runtimeEvidence?.validFrom ?? "").toLocaleString() : response.effective}</strong></span>
            <span><small>Recorded</small><strong>{usesRuntimeEvidence ? new Date(runtimeEvidence?.recordedAt ?? "").toLocaleString() : "2026-08-18 · 16:22 CT"}</strong></span>
            <span><small>Integrity</small><strong>{usesRuntimeEvidence ? `${runtimeEvidence?.contentHash.slice(0, 12)}…` : "SHA-256 verified"}</strong></span>
          </div>

          <div className="extraction-head"><div><Eyebrow>Bounded extraction</Eyebrow><h3>Candidate patient facts</h3></div><Tag tone="mint"><BookOpenCheck size={11} /> {usesRuntimeEvidence ? "D1 evidence + cited span" : "cited span attached"}</Tag></div>
          <div className="extraction-list">
            {response.extracted.map((fact) => {
              const key = `${response.id}-${fact.concept}`;
              const isConfirmed = usesRuntimeEvidence ? runtimeReview ? runtimeReview.decision === "confirmed" : runtimeEvidence?.structured.humanConfirmed === true : fact.status === "deterministic" || reviews[key] === "confirmed";
              return (
                <div className="extraction-card" key={fact.concept}>
                  <button className="extraction-card-main drillable-surface" type="button" onClick={() => openAssessmentDetail(fact.concept, `Supported by the exact response above at ${Math.round(fact.confidence * 100)}% bounded confidence.`, "command")}>
                    <span className={`fact-status ${isConfirmed ? "is-confirmed" : ""}`}>{isConfirmed ? <Check size={13} /> : <CircleAlert size={13} />}</span>
                    <div><strong>{fact.concept}</strong><small>Supported by the exact response above · patient scoped</small></div>
                  </button>
                  <div className="confidence-cell"><strong>{Math.round(fact.confidence * 100)}%</strong><ProgressBar value={fact.confidence * 100} tone={fact.confidence > .95 ? "mint" : "blue"} /></div>
                  {fact.status === "deterministic" ? <Tag tone="blue">Deterministic</Tag> : <button className={`review-toggle ${isConfirmed ? "is-confirmed" : ""}`} disabled={reviewBusy} type="button" onClick={() => void toggleReview(fact.concept)}>{reviewBusy ? "Recording…" : isConfirmed ? "Confirmed" : "Confirm"}</button>}
                </div>
              );
            })}
          </div>
          {reviewError ? <div className="ingestion-contract"><ShieldAlert size={16} /><div><strong>Review not recorded</strong><p>{reviewError}</p></div></div> : null}

          <div className="downstream-use">
            <div className="downstream-title"><Eyebrow>Authorized downstream use</Eyebrow><span>Policy ASMT-4.2</span></div>
            <div className="use-flow">
              <span>Confirmed fact</span><ArrowRight size={14} /><span>Continuity cell</span><ArrowRight size={14} /><span>Human-reviewed plan</span>
            </div>
            <p>The assessment cell can request confirmation. It cannot write diagnoses, change treatment, message the patient or submit regulatory data.</p>
          </div>
        </article>
      </section>

      <section className="assessment-safety-grid">
        <button className="panel safety-card safe drillable-surface" type="button" onClick={() => openAssessmentDetail("Green boundary", "Patient-scoped, span-cited, temporally valid, schema-conformant and human-confirmed evidence can advance.", "assurance")}>
          <ShieldCheck size={19} />
          <div><Eyebrow>Green boundary</Eyebrow><h3>Evidence that can advance</h3><p>Patient-scoped, span-cited, temporally valid, schema-conformant and human-confirmed when semantic.</p></div>
        </button>
        <button className="panel safety-card danger drillable-surface" type="button" onClick={() => openAssessmentDetail("Red boundary", "Embedded instructions, unsupported diagnoses, cross-patient context, stale facts and ambiguous negation remain untrusted.", "assurance")}>
          <ShieldAlert size={19} />
          <div><Eyebrow>Red boundary</Eyebrow><h3>Content that stays untrusted</h3><p>Embedded instructions, unsupported diagnosis, another patient’s context, stale facts and ambiguous negation.</p></div>
        </button>
      </section>
    </div>
  );
}
