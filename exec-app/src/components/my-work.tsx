"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertOctagon,
  ArrowRight,
  CheckCircle2,
  CircleDot,
  ClipboardList,
  Clock3,
  GitBranch,
  Inbox,
  RefreshCw,
  ShieldCheck,
  Users,
  XCircle,
} from "lucide-react";
import { fetchMyWork, fetchWorkDetail, performWorkAction, type PlatformWorkItem, type PlatformWorkDetail, type PlatformUrgency } from "../lib/work";
import type { NavigationId } from "../lib/types";
import type { OpenWorkflowDetail, WorkflowDetail } from "../lib/workflow-detail";
import { EvidenceTag, Eyebrow, EmptyView, LoadMore, Tag, usePaged } from "./ui";

const KIND_LABEL: Record<PlatformWorkItem["kind"], string> = {
  episode: "Outcome episode",
  review: "Evidence review",
  release: "Release",
  dlq: "DLQ incident",
  cohort: "Cohort suggestion",
};

const KIND_ICON: Record<PlatformWorkItem["kind"], typeof CircleDot> = {
  episode: CircleDot,
  review: ShieldCheck,
  release: GitBranch,
  dlq: AlertOctagon,
  cohort: Users,
};

const URGENCY_TONE: Record<PlatformUrgency, "red" | "amber" | "mint"> = { high: "red", medium: "amber", low: "mint" };

const STATE_TONE: Record<string, "mint" | "amber" | "red" | "blue" | "neutral"> = {
  AwaitingApproval: "amber",
  Proposed: "blue",
  Coordinating: "blue",
  Verifying: "blue",
  Escalated: "red",
  Resolved: "mint",
  pending: "amber",
  validated: "blue",
  approved: "blue",
  canary: "blue",
  active: "mint",
  draft: "neutral",
  failed: "red",
  incident: "red",
};

const ACTION_LABEL: Record<string, string> = {
  approve: "Approve", reject: "Reject", escalate: "Escalate", validate: "Validate",
  activate: "Activate", rollback: "Rollback", acknowledge: "Acknowledge", "request-approval": "Request approval",
  canary: "Canary", promote: "Promote", fail: "Fail",
  // NOT "Review": this action records a decision (the activity entry reads
  // suggested → reviewed); it does not open the item — the row title does. See
  // the same note in admin-ui. For md/safety, whose cohort items land here.
  review: "Mark reviewed", decline: "Decline",
};

function toneFor(item: PlatformWorkItem): "neutral" | "mint" | "amber" | "red" | "blue" | "violet" {
  return (STATE_TONE[item.state] ?? URGENCY_TONE[item.urgency]) as "neutral" | "mint" | "amber" | "red" | "blue" | "violet";
}

function detailToDrawer(item: PlatformWorkItem, detail?: PlatformWorkDetail): WorkflowDetail {
  const activity = (detail?.activity ?? []).map((a, i, all) => ({
    time: String(a.at ?? ""),
    title: `${String(a.from ?? "—")} → ${String(a.to ?? "—")}`,
    detail: String(a.note ?? a.by ?? ""),
    state: i === all.length - 1 ? ("current" as const) : ("done" as const),
  }));
  const steps: WorkflowDetail["steps"] = [
    { label: "Observe", detail: "Signal retained, scoped and understood", state: "done" },
    { label: "Decide", detail: item.actions.includes("approve") ? "Approval required by the authorized role" : "Decision recorded", state: item.actions.includes("approve") ? "current" : "done" },
    { label: "Coordinate", detail: "Command dispatched through the harness to the owning system", state: "pending" },
    { label: "Verify", detail: "Outcome evidence, not send status, closes the loop", state: "pending" },
  ];
  const primary: { label: string; target: NavigationId } =
    item.kind === "episode" || item.kind === "review"
      ? { label: "Open Outcome Command", target: "command" }
      : item.kind === "release"
        ? { label: "Open Platform & configuration", target: "platform" }
        : item.kind === "cohort"
          ? { label: "Open Renal Cohorts", target: "patient" }
          : { label: "Open Event Operations", target: "command" };
  const metrics: WorkflowDetail["metrics"] = [
    { label: "State", value: detail?.state ?? item.state },
    { label: "Scope", value: detail?.scope ?? item.scope },
    { label: "Owner", value: detail?.owner ?? item.owner },
    { label: "SLA", value: item.sla },
  ];
  if (item.kind === "episode" && item.belief !== undefined) {
    metrics.push({
      label: "D-S evidence",
      value: `${item.evidenceStatus ?? "—"} · Bel ${item.belief.toFixed(2)}`,
      detail: `Pl ${(item.plausibility ?? 0).toFixed(2)} · K ${(item.conflictMass ?? 0).toFixed(2)} · priority ${(item.dstPriority ?? 0).toFixed(2)}`,
    });
  }
  return {
    id: `MYWORK-${item.id}`,
    kind: KIND_LABEL[item.kind],
    title: detail?.title ?? item.title,
    summary: detail?.why ?? item.summary,
    status: detail?.state ?? item.state,
    tone: toneFor(item),
    owner: detail?.owner ?? item.owner,
    scope: detail?.scope ?? item.scope,
    due: item.sla,
    metrics,
    evidence: (detail?.evidence ?? []).map((ev) => ({ label: String(ev.contentType ?? "evidence"), value: String(ev.sourceId ?? ""), source: String(ev.hash ?? "") })),
    activity,
    steps,
    control: detail?.policy ? `Action class ${String(detail.policy.approvalClass ?? "B")} · ${detail.policy.approver ? `approved by ${String(detail.policy.approver)}` : "awaiting the authorized role"}` : undefined,
    primary,
  };
}

export default function MyWork({ onNavigate, onOpenDetail }: { onNavigate: (id: NavigationId) => void; onOpenDetail: OpenWorkflowDetail }) {
  const [items, setItems] = useState<PlatformWorkItem[]>([]);
  /** Items the server returned that belong to the OPERATOR console instead. */
  const [elsewhere, setElsewhere] = useState(0);
  const [filter, setFilter] = useState<"all" | PlatformUrgency>("all");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  // A decline is feedback, so it must carry a reason. Collected inline rather
  // than sent bare and rejected.
  const [declining, setDeclining] = useState<{ id: string; reason: string } | null>(null);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const list = await fetchMyWork();
      if (!mounted.current) return;
      // An item's `console` is the console that OWNS its capability, and the queue
      // spans every console the role can open. This console renders only its own:
      // cohort review is nursing work owned by the operator console, so rendering
      // it here claimed ownership on behalf of the wrong surface — and left the
      // console that actually owns it with no queue at all. The remainder is
      // reported rather than dropped, so an empty queue is never ambiguous.
      setItems(list.filter((i) => i.console === "exec"));
      setElsewhere(list.filter((i) => i.console !== "exec").length);
      setError(null);
      setLoaded(true);
    } catch (e) {
      if (!mounted.current) return;
      setError(e instanceof Error ? e.message : String(e));
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    const timer = setInterval(() => void load(), 6000);
    return () => { mounted.current = false; window.clearInterval(timer); };
  }, [load]);

  const counts = useMemo(() => ({
    high: items.filter((i) => i.urgency === "high").length,
    medium: items.filter((i) => i.urgency === "medium").length,
    low: items.filter((i) => i.urgency === "low").length,
  }), [items]);

  const visible = filter === "all" ? items : items.filter((i) => i.urgency === filter);
  // Page the queue (10/page) so long role-scoped lists never stretch the page.
  const paged = usePaged(visible, 10, filter);

  const act = async (item: PlatformWorkItem, action: string, reason?: string) => {
    const key = `${item.id}:${action}`;
    setBusy(key);
    setNotice(null);
    try {
      const res = await performWorkAction(item.id, action, {
        approver: "operator", idempotencyKey: `${key}:${Date.now()}`,
        ...(reason ? { reason } : {}),
      });
      setNotice(`${item.title} → ${res.state ?? action}${res.duplicate ? " (duplicate idempotent replay)" : ""}`);
      await load();
    } catch (e) {
      setNotice(`Action failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  /** Cohorts ask a human to judge the suggestion itself, so a decline needs the
   *  reason that will be read back when the criterion is tuned. */
  const beginAction = (item: PlatformWorkItem, action: string) => {
    if (action === "decline") {
      setDeclining({ id: item.id, reason: "" });
      return;
    }
    void act(item, action);
  };

  const openItem = (item: PlatformWorkItem) => {
    void fetchWorkDetail(item.id).then((detail) => {
      if (mounted.current) onOpenDetail(detailToDrawer(item, detail));
    }).catch(() => {
      if (mounted.current) onOpenDetail(detailToDrawer(item));
    });
  };

  const filters: Array<{ id: "all" | PlatformUrgency; label: string; count: number }> = [
    { id: "all", label: "All", count: items.length },
    { id: "high", label: "High", count: counts.high },
    { id: "medium", label: "Medium", count: counts.medium },
    { id: "low", label: "Low", count: counts.low },
  ];

  return (
    <div className="panel">
      <div className="panel-title-row">
        <div>
          <Eyebrow>My Work · server-assembled</Eyebrow>
          <h2>Prioritized, role-scoped decision queue</h2>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <Tag tone={counts.high > 0 ? "red" : "mint"}><Inbox size={11} /> {items.length} item(s) · {counts.high} high</Tag>
          <button className="button button-ghost" onClick={() => void load()} type="button"><RefreshCw size={13} /> Refresh</button>
        </div>
      </div>

      <div className="mywork-filters" role="tablist" aria-label="Filter by urgency">
        {filters.map((f) => (
          <button
            key={f.id}
            className={`mywork-filter ${filter === f.id ? "is-active" : ""}`}
            onClick={() => setFilter(f.id)}
            type="button"
            role="tab"
            aria-selected={filter === f.id}
          >
            {f.label} <span>{f.count}</span>
          </button>
        ))}
      </div>

      {notice ? <div className="mywork-notice">{notice}</div> : null}

      {elsewhere > 0 ? (
        <div className="mywork-elsewhere">
          <Inbox size={13} />
          <span>
            {elsewhere} item(s) in this queue belong to the <b>Operator console</b> and are worked there.
          </span>
          <a className="button button-ghost" href="/admin/ui/">Open operator console <ArrowRight size={13} /></a>
        </div>
      ) : null}

      {!loaded ? (
        <div className="module-loading"><div className="module-loading-orbit" /><p>Resolving your work queue…</p></div>
      ) : error ? (
        <EmptyView title="Work queue unavailable" description={`${error} — the server assembles My Work; reconnect to refresh.`} />
      ) : visible.length === 0 ? (
        <div className="mywork-empty">
          <Inbox size={26} style={{ color: "var(--faint)" }} />
          <strong>{filter === "all" ? "Nothing currently requires you" : `No ${filter}-priority work`}</strong>
          <p>The server derives this queue from real episodes, reviews, releases and DLQ incidents at your role&apos;s scope. New signals appear here the moment the harness retains them.</p>
          {elsewhere > 0
            ? <a className="button button-primary" href="/admin/ui/">Open operator console <ArrowRight size={14} /></a>
            : <button className="button button-primary" onClick={() => onNavigate("command")} type="button">Open Outcome Command <ArrowRight size={14} /></button>}
        </div>
      ) : (
        <>
        <div className="episode-list mywork-list list-scroll list-scroll-tall">
          {paged.visible.map((item) => {
            const Icon = KIND_ICON[item.kind];
            const actionKey = `${item.id}:${item.actions[0] ?? ""}`;
            return (
              <div className="episode-row mywork-row" key={item.id}>
                <span className={`mywork-kind tag tag-${URGENCY_TONE[item.urgency]}`} aria-hidden="true"><Icon size={12} /></span>
                <button className="mywork-main" onClick={() => openItem(item)} type="button">
                  <strong>{item.title}</strong>
                  <small>{item.summary}</small>
                  <span className="mywork-meta">{KIND_LABEL[item.kind]} · {item.scope} · {item.owner} · due {item.sla}</span>
                  {item.kind === "episode" && item.belief !== undefined ? (
                    <span className="mywork-dst" title="Dempster–Shafer fusion over this episode's evidence — Bel(commitment) · Pl(plausibility) · K(conflict). Items order by Bel + 0.3·ignorance − 0.5·Pl(harm).">
                      <EvidenceTag posture={item.evidenceStatus} />
                      Bel <b>{item.belief.toFixed(2)}</b> · Pl {item.plausibility?.toFixed(2)} · K {item.conflictMass?.toFixed(2)}
                    </span>
                  ) : null}
                </button>
                <span className="mywork-side">
                  <Tag tone={toneFor(item) as "mint" | "amber" | "red" | "blue"}>{item.state}</Tag>
                  <Tag tone={URGENCY_TONE[item.urgency]}>{item.urgency}</Tag>
                  <span className="mywork-time" title={item.at}><Clock3 size={11} /> {item.sla}</span>
                </span>
                <span className="mywork-actions">
                  {declining?.id === item.id ? (
                    <span className="mywork-decline">
                      <input
                        autoFocus
                        className="input"
                        onChange={(e) => setDeclining({ id: item.id, reason: e.target.value })}
                        placeholder="Why is this suggestion wrong? (kept for criterion tuning)"
                        value={declining.reason}
                      />
                      <button
                        className="button button-primary"
                        disabled={declining.reason.trim().length < 4 || busy === `${item.id}:decline`}
                        onClick={() => { const r = declining.reason.trim(); setDeclining(null); void act(item, "decline", r); }}
                        type="button"
                      >
                        Confirm decline
                      </button>
                      <button className="button button-ghost" onClick={() => setDeclining(null)} type="button">Cancel</button>
                    </span>
                  ) : (
                    item.actions.map((a) => (
                      <button
                        key={a}
                        className={`button ${a === "approve" || a === "activate" ? "button-primary" : "button-ghost"}`}
                        disabled={busy === `${item.id}:${a}`}
                        onClick={() => beginAction(item, a)}
                        type="button"
                      >
                        {busy === `${item.id}:${a}` ? "…" : <CheckCircle2 size={12} />} {ACTION_LABEL[a] ?? a}
                      </button>
                    ))
                  )}
                  {busy === actionKey ? <XCircle size={13} style={{ color: "var(--faint)" }} /> : null}
                </span>
              </div>
            );
          })}
        </div>
        <LoadMore shown={paged.visible.length} total={visible.length} onMore={paged.showMore} label="work item(s)" />
        </>
      )}
    </div>
  );
}
