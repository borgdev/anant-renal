import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ExternalLink, Maximize2, Minimize2 } from "lucide-react";

export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="eyebrow">{children}</p>;
}

/** Maximize / restore a big card — toggles `.is-expanded` on the closest `.panel`. */
export function PanelExpand({ label = "Expand panel" }: { label?: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState(false);
  function toggle() {
    const panel = ref.current?.closest(".panel");
    if (!panel) return;
    panel.classList.toggle("is-expanded");
    setExpanded((prev) => !prev);
  }
  return (
    <button ref={ref} className="icon-button panel-expand" type="button" onClick={(event) => { event.stopPropagation(); toggle(); }} aria-label={expanded ? "Collapse panel" : label} title={expanded ? "Collapse" : "Expand"}>
      {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
    </button>
  );
}

export function Tag({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "mint" | "amber" | "red" | "blue" | "violet";
}) {
  return <span className={`tag tag-${tone}`}>{children}</span>;
}

/* U #7 — shared Dempster–Shafer evidence-posture language (one tone rule).
 * corroborated = mint (committed) · weak = amber (build, below gate) ·
 * contested = violet (verify, never auto-act). An *alert* state is a separate
 * red semantic layered on top (e.g. the early-warning watch auto-flag). */
export type EvidencePosture = "corroborated" | "weak" | "contested";
export const EVIDENCE_TONE: Record<EvidencePosture, "mint" | "amber" | "violet"> = {
  corroborated: "mint",
  weak: "amber",
  contested: "violet",
};
export const EVIDENCE_LABEL: Record<EvidencePosture, string> = {
  corroborated: "corroborated",
  weak: "weak",
  contested: "contested",
};
export function evidenceTone(posture?: string | null): "mint" | "amber" | "violet" {
  return EVIDENCE_TONE[(posture as EvidencePosture) ?? "weak"] ?? "amber";
}

/** A `evidence <posture>` pill that obeys the shared tone rule. */
export function EvidenceTag({ posture, children }: { posture?: string | null; children?: ReactNode }) {
  return (
    <Tag tone={evidenceTone(posture)}>
      {children ?? `evidence ${EVIDENCE_LABEL[(posture as EvidencePosture) ?? "weak"] ?? "—"}`}
    </Tag>
  );
}

export function Metric({
  label,
  value,
  detail,
  tone = "default",
  onClick,
}: {
  label: string;
  value: string;
  detail: string;
  tone?: "default" | "mint" | "amber" | "red";
  onClick?: () => void;
}) {
  const content = (
    <>
      <div className="metric-topline">
        <span>{label}</span>
        <span className="metric-pulse" aria-hidden="true" />
      </div>
      <strong>{value}</strong>
      <small>{detail}</small>
    </>
  );
  return onClick ? <button className={`metric metric-${tone} drillable-surface`} type="button" onClick={onClick} aria-label={`Inspect ${label}`}>{content}</button> : <article className={`metric metric-${tone}`}>{content}</article>;
}

export function SourceLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className="source-link" href={href} target="_blank" rel="noreferrer">
      <Check size={12} aria-hidden="true" />
      {children}
      <ExternalLink size={11} aria-hidden="true" />
    </a>
  );
}

export function ProgressBar({ value, tone = "mint" }: { value: number; tone?: "mint" | "amber" | "red" | "blue" }) {
  return (
    <div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}>
      <span className={`progress-fill progress-${tone}`} style={{ width: `${Math.max(0, Math.min(value, 100))}%` }} />
    </div>
  );
}

/**
 * A deliberately empty surface.
 *
 * `eyebrow` and `level` exist because an empty state is not always a "platform
 * module": on a clinical page the eyebrow has to say what is empty, and the heading
 * must not be a second `<h1>` competing with the page's own — a screen reader
 * announcing two level-1 headings is a defect, not a style choice.
 */
export function EmptyView({ title, description, eyebrow = "Platform module", level = 1 }: { title: string; description: string; eyebrow?: string; level?: 1 | 2 | 3 }) {
  const Heading = `h${level}` as "h1" | "h2" | "h3";
  return (
    <section className="empty-view">
      <span className="empty-orbit" aria-hidden="true" />
      <Eyebrow>{eyebrow}</Eyebrow>
      <Heading>{title}</Heading>
      <p>{description}</p>
    </section>
  );
}

/* ---------- pagination + scroll containment (page-by-page UI pass) ---------- */

/** Reveal a growing list a page at a time instead of rendering it all. When
 *  `resetKey` changes (e.g. a filter/patient selection), the page resets. */
export function usePaged<T>(items: readonly T[], pageSize: number, resetKey?: unknown) {
  const [limit, setLimit] = useState(pageSize);
  useEffect(() => { setLimit(pageSize); }, [resetKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const visible = items.slice(0, limit);
  const hasMore = items.length > limit;
  const remaining = Math.max(0, items.length - limit);
  const showMore = () => setLimit((previous) => Math.min(items.length, previous + pageSize));
  const reset = () => setLimit(pageSize);
  return { visible, hasMore, remaining, showMore, reset };
}

/** A centred "show more" control; renders nothing once everything is shown. */
export function LoadMore({ shown, total, onMore, label }: { shown: number; total: number; onMore: () => void; label?: string }) {
  if (shown >= total) return null;
  return (
    <div className="load-more">
      <button className="button button-ghost" type="button" onClick={onMore}>
        Show more ({total - shown} more{label ? ` · ${label}` : ""}) <ChevronDown size={14} />
      </button>
    </div>
  );
}
