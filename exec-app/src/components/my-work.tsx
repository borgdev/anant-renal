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
  XCircle,
} from "lucide-react";
import { fetchMyWork, fetchWorkDetail, performWorkAction, type PlatformWorkItem, type PlatformWorkDetail, type PlatformUrgency } from "../lib/work";
import type { NavigationId } from "../lib/types";
import type { OpenWorkflowDetail, WorkflowDetail } from "../lib/workflow-detail";
import { Eyebrow, EmptyView, Tag } from "./ui";

const KIND_LABEL: Record<PlatformWorkItem["kind"], string> = {
  episode: "Outcome episode",
  review: "Evidence review",
  release: "Release",
  dlq: "DLQ incident",
};

const KIND_ICON: Record<PlatformWorkItem["kind"], typeof CircleDot> = {
  episode: CircleDot,
  review: ShieldCheck,
  release: GitBranch,
  dlq: AlertOctagon,
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
        ? { label: "Open Configuration Studio", target: "configuration" }
        : { label: "Open Event Operations", target: "command" };
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
    metrics: [
      { label: "State", value: detail?.state ?? item.state },
      { label: "Scope", value: detail?.scope ?? item.scope },
      { label: "Owner", value: detail?.owner ?? item.owner },
      { label: "SLA", value: item.sla },
    ],
    evidence: (detail?.evidence ?? []).map((ev) => ({ label: String(ev.contentType ?? "evidence"), value: String(ev.sourceId ?? ""), source: String(ev.hash ?? "") })),
    activity,
    steps,
    control: detail?.policy ? `Action class ${String(detail.policy.approvalClass ?? "B")} · ${detail.policy.approver ? `approved by ${String(detail.policy.approver)}` : "awaiting the authorized role"}` : undefined,
    primary,
  };
}

export default function MyWork({ onNavigate, onOpenDetail }: { onNavigate: (id: NavigationId) => void; onOpenDetail: OpenWorkflowDetail }) {
  const [items, setItems] = useState<PlatformWorkItem[]>([]);
  const [filter, setFilter] = useState<"all" | PlatformUrgency>("all");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const list = await fetchMyWork();
      if (!mounted.current) return;
      setItems(list);
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

  const act = async (item: PlatformWorkItem, action: string) => {
    const key = `${item.id}:${action}`;
    setBusy(key);
    setNotice(null);
    try {
      const res = await performWorkAction(item.id, action, { approver: "operator", idempotencyKey: `${key}:${Date.now()}` });
      setNotice(`${item.title} → ${res.state ?? action}${res.duplicate ? " (duplicate idempotent replay)" : ""}`);
      await load();
    } catch (e) {
      setNotice(`Action failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
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

      {!loaded ? (
        <div className="module-loading"><div className="module-loading-orbit" /><p>Resolving your work queue…</p></div>
      ) : error ? (
        <EmptyView title="Work queue unavailable" description={`${error} — the server assembles My Work; reconnect to refresh.`} />
      ) : visible.length === 0 ? (
        <div className="mywork-empty">
          <Inbox size={26} style={{ color: "var(--faint)" }} />
          <strong>{filter === "all" ? "Nothing currently requires you" : `No ${filter}-priority work`}</strong>
          <p>The server derives this queue from real episodes, reviews, releases and DLQ incidents at your role&apos;s scope. New signals appear here the moment the harness retains them.</p>
          <button className="button button-primary" onClick={() => onNavigate("command")} type="button">Open Outcome Command <ArrowRight size={14} /></button>
        </div>
      ) : (
        <div className="episode-list mywork-list">
          {visible.map((item) => {
            const Icon = KIND_ICON[item.kind];
            const actionKey = `${item.id}:${item.actions[0] ?? ""}`;
            return (
              <div className="episode-row mywork-row" key={item.id}>
                <span className={`mywork-kind tag tag-${URGENCY_TONE[item.urgency]}`} aria-hidden="true"><Icon size={12} /></span>
                <button className="mywork-main" onClick={() => openItem(item)} type="button">
                  <strong>{item.title}</strong>
                  <small>{item.summary}</small>
                  <span className="mywork-meta">{KIND_LABEL[item.kind]} · {item.scope} · {item.owner} · due {item.sla}</span>
                </button>
                <span className="mywork-side">
                  <Tag tone={toneFor(item) as "mint" | "amber" | "red" | "blue"}>{item.state}</Tag>
                  <Tag tone={URGENCY_TONE[item.urgency]}>{item.urgency}</Tag>
                  <span className="mywork-time" title={item.at}><Clock3 size={11} /> {item.sla}</span>
                </span>
                <span className="mywork-actions">
                  {item.actions.map((a) => (
                    <button
                      key={a}
                      className={`button ${a === "approve" || a === "activate" ? "button-primary" : "button-ghost"}`}
                      disabled={busy === `${item.id}:${a}`}
                      onClick={() => void act(item, a)}
                      type="button"
                    >
                      {busy === `${item.id}:${a}` ? "…" : <CheckCircle2 size={12} />} {ACTION_LABEL[a] ?? a}
                    </button>
                  ))}
                  {busy === actionKey ? <XCircle size={13} style={{ color: "var(--faint)" }} /> : null}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
