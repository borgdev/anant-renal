import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  Clock3,
  FileSearch,
  History,
  ListChecks,
  ShieldCheck,
  UserRound,
  X,
} from "lucide-react";
import type { NavigationId } from "../lib/types";
import type { WorkflowDetail } from "../lib/workflow-detail";
import { Eyebrow, Tag } from "./ui";

type DetailTab = "overview" | "evidence" | "activity";

export default function WorkflowDetailDrawer({
  detail,
  onClose,
  onNavigate,
}: {
  detail: WorkflowDetail | null;
  onClose: () => void;
  onNavigate: (target: NavigationId) => void;
}) {
  const [tab, setTab] = useState<DetailTab>("overview");
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!detail) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const timer = window.setTimeout(() => closeRef.current?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("keydown", onKeyDown);
      previous?.focus();
    };
  }, [detail, onClose]);

  if (!detail) return null;

  return (
    <>
      <button className="workflow-drawer-scrim" type="button" aria-label="Close work item details" onClick={onClose} />
      <aside className="workflow-drawer" role="dialog" aria-modal="true" aria-labelledby="workflow-detail-title">
        <header className="workflow-drawer-header">
          <div>
            <Eyebrow>{detail.kind} · {detail.id}</Eyebrow>
            <h2 id="workflow-detail-title">{detail.title}</h2>
          </div>
          <button ref={closeRef} className="icon-button" type="button" aria-label="Close work item details" onClick={onClose}><X size={18} /></button>
        </header>

        <div className="workflow-state-strip">
          <Tag tone={detail.tone ?? "blue"}>{detail.status}</Tag>
          <span><UserRound size={13} /> {detail.owner}</span>
          <span>{detail.scope}</span>
          {detail.due ? <span><Clock3 size={13} /> {detail.due}</span> : null}
        </div>

        <nav className="workflow-tabs" aria-label="Work item detail sections">
          <button className={tab === "overview" ? "is-active" : ""} onClick={() => setTab("overview")} type="button"><ListChecks size={14} /> Overview</button>
          <button className={tab === "evidence" ? "is-active" : ""} onClick={() => setTab("evidence")} type="button"><FileSearch size={14} /> Evidence <span>{detail.evidence?.length ?? 0}</span></button>
          <button className={tab === "activity" ? "is-active" : ""} onClick={() => setTab("activity")} type="button"><History size={14} /> Activity <span>{detail.activity?.length ?? 0}</span></button>
        </nav>

        <div className="workflow-drawer-body">
          {tab === "overview" ? (
            <>
              <section className="workflow-summary">
                <Eyebrow>Why this matters</Eyebrow>
                <p>{detail.summary}</p>
              </section>
              {detail.metrics?.length ? <section className="workflow-metric-grid">{detail.metrics.map((metric) => <div key={metric.label}><small>{metric.label}</small><strong>{metric.value}</strong>{metric.detail ? <span>{metric.detail}</span> : null}</div>)}</section> : null}
              {detail.steps?.length ? (
                <section className="workflow-loop">
                  <Eyebrow>Closed-loop state</Eyebrow>
                  {detail.steps.map((step, index) => <div className={`workflow-loop-step is-${step.state}`} key={`${step.label}-${index}`}><span>{step.state === "done" ? <CheckCircle2 size={14} /> : index + 1}</span><div><strong>{step.label}</strong><small>{step.detail}</small></div></div>)}
                </section>
              ) : null}
              <section className="workflow-control-note"><ShieldCheck size={16} /><p>{detail.control ?? "The harness preserves evidence, authorization and acknowledgement boundaries. No external or clinical write occurs from this inspector."}</p></section>
              {detail.security ? (
                <section className="workflow-security-context">
                  <div className="workflow-security-title"><ShieldCheck size={15} /><div><Eyebrow>Server trust context</Eyebrow><strong>Backend assembled · browser authority none</strong></div><Tag tone="mint">verified</Tag></div>
                  <dl>
                    <div><dt>Role</dt><dd>{detail.security.role}</dd></div>
                    <div><dt>Scope</dt><dd>{detail.security.scope}</dd></div>
                    <div><dt>Purpose</dt><dd>{detail.security.purpose}</dd></div>
                    <div><dt>Policy</dt><dd>{detail.security.policyVersion}</dd></div>
                  </dl>
                  {detail.security.redactions.length ? <p className="workflow-redaction"><ShieldCheck size={13} /> {detail.security.redactions.join(" · ")}</p> : <p className="workflow-no-redaction"><CheckCircle2 size={13} /> No additional field redactions were required for this view.</p>}
                  <small>Trace {detail.security.traceId}</small>
                </section>
              ) : null}
            </>
          ) : null}

          {tab === "evidence" ? (
            <section className="workflow-evidence-list">
              {(detail.evidence?.length ? detail.evidence : [{ label: "Evidence status", value: "No linked evidence was supplied for this summary item.", source: "Harness boundary" }]).map((item, index) => <article key={`${item.label}-${index}`}><span>{index + 1}</span><div><small>{item.label}</small><strong>{item.value}</strong>{item.source ? <p>{item.source}</p> : null}</div></article>)}
            </section>
          ) : null}

          {tab === "activity" ? (
            <ol className="workflow-activity-list">
              {(detail.activity?.length ? detail.activity : [{ time: "Current", title: "Item surfaced", detail: "No additional activity is recorded yet.", state: "current" as const }]).map((item, index) => <li key={`${item.time}-${item.title}-${index}`}><time>{item.time}</time><span className={`is-${item.state ?? "done"}`} /><div><strong>{item.title}</strong><p>{item.detail}</p></div></li>)}
            </ol>
          ) : null}
        </div>

        <footer className="workflow-drawer-footer">
          <button className="button button-secondary" type="button" onClick={() => setTab("evidence")}><FileSearch size={15} /> Inspect evidence</button>
          {detail.primary ? <button className="button button-primary" type="button" onClick={() => onNavigate(detail.primary!.target)}>{detail.primary.label} <ArrowRight size={15} /></button> : null}
        </footer>
      </aside>
    </>
  );
}
