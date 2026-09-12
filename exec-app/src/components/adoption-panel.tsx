"use client";

import { useCallback, useEffect, useState } from "react";
import { Activity, Gauge, RefreshCw, ShieldCheck, TrendingUp } from "lucide-react";
import { fetchRankedAdoption, type AdoptionView } from "../lib/adoption";
import { Eyebrow, Metric, PanelExpand, ProgressBar, Tag } from "./ui";

/**
 * Adoption — is the ranked-action loop actually being used?
 *
 * This block deliberately reports what the data supports and says so when it does
 * not: the verdict mix and the coverage of today's ranking are measured, dismissal
 * reasons are clustered by meaning, and time-to-decision is shown as *not measured*
 * with the reason. A fabricated latency would look like the most authoritative
 * number on the panel, which is exactly why it must not be invented.
 */

function VerdictBar({ label, pct, tone }: { label: string; pct: number | null; tone: "mint" | "amber" | "blue" | "red" }) {
  return (
    <div className="ra-bar">
      <span className="ra-bar-label">{label}</span>
      <ProgressBar value={Math.round(pct ?? 0)} tone={tone} />
      <span className="ra-bar-value">{pct === null ? "—" : `${pct}%`}</span>
    </div>
  );
}

export default function AdoptionPanel() {
  const [view, setView] = useState<AdoptionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setView(await fetchRankedAdoption());
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load adoption metrics");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <section className="pc-panel ra-panel">
        <div className="pc-panel-head">
          <Eyebrow>Adoption</Eyebrow>
          <PanelExpand label="Is the ranking being answered?" />
        </div>
        <div className="pc-error">{error}</div>
      </section>
    );
  }

  const v = view?.verdicts;

  return (
    <section className="pc-panel ra-panel">
      <div className="pc-panel-head">
        <Eyebrow>Adoption · is the ranking being used</Eyebrow>
        <div className="ra-panel-actions">
          <button className="pc-btn ghost" onClick={() => void load()} disabled={busy} type="button">
            <RefreshCw size={13} /> {busy ? "Refreshing…" : "Refresh"}
          </button>
          <PanelExpand label="Verdict coverage, dismissal reasons and how work moves between people" />
        </div>
      </div>

      <div className="ra-metrics">
        <Metric
          label="Verdict coverage"
          value={view?.coveragePct === null || view === null ? "—" : `${view.coveragePct}%`}
          detail={view ? `${view.decidedOfRanked} of ${view.ranked} ranked action(s)` : "—"}
        />
        <Metric
          label="Verdicts recorded"
          value={view ? String(view.decided) : "—"}
          detail={v ? `${v.approved} approved · ${v.dismissed} dismissed` : "—"}
        />
        <Metric
          label="Work moved, not refused"
          value={v ? String(v.deferred + v["handed-off"]) : "—"}
          detail={v ? `${v.deferred} deferred · ${v["handed-off"]} handed off` : "—"}
        />
        <Metric
          label="Time to decision"
          value="not measured"
          detail="the first-appearance time is not recorded"
        />
      </div>

      {view && view.decided > 0 ? (
        <div className="ra-bars">
          <VerdictBar label="Approved" pct={view.approvalPct} tone="mint" />
          <VerdictBar label="Dismissed" pct={view.dismissalPct} tone="amber" />
          <VerdictBar label="Deferred" pct={view.deferralPct} tone="blue" />
          <VerdictBar label="Handed off" pct={view.handoffPct} tone="blue" />
        </div>
      ) : null}

      {view && view.reading.length > 0 ? (
        <ul className="ra-reading">
          {view.reading.map((line) => (
            <li key={line}>
              {line.startsWith("Dismissals concentrate") ? <TrendingUp size={12} /> : <Activity size={12} />} {line}
            </li>
          ))}
        </ul>
      ) : null}

      {view && view.dismissalClusters.length > 0 ? (
        <div className="ra-clusters">
          <span className="ra-section-head">
            <ShieldCheck size={12} /> Why suggestions were dismissed
            {view.clustered ? (
              <Tag tone="amber">clustered</Tag>
            ) : view.concentrated ? (
              <Tag tone="blue">one reason, small sample</Tag>
            ) : (
              <Tag tone="neutral">observations</Tag>
            )}
          </span>
          {view.dismissalClusters.slice(0, 5).map((c) => (
            <div className="ra-cluster" key={c.reason}>
              <span className="ra-cluster-count">{c.count}×</span>
              <span className="ra-cluster-reason">{c.reason}</span>
              {c.variants.length > 1 ? (
                <details className="ra-technical">
                  <summary>{c.variants.length} wordings</summary>
                  <ul>{c.variants.map((w) => <li key={w}>{w}</li>)}</ul>
                </details>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      <p className="ra-note">
        <Gauge size={12} /> {view ? view.timeToDecision.reason : "…"}
      </p>
    </section>
  );
}
