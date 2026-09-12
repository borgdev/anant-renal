"use client";

import { useCallback, useEffect, useState } from "react";
import { Activity, AlertTriangle, RefreshCw, Stethoscope, Timer, Waves } from "lucide-react";
import { fetchNextSession, type NextSessionRisk, type NextSessionView } from "../lib/round";
import { EmptyView, Eyebrow, LoadMore, Metric, PanelExpand, Tag, usePaged } from "./ui";

/**
 * The next-session lens — chair-side.
 *
 * The pack pages answer "what does this patient's window say?" one patient at a time.
 * This answers the question a clinician actually walks the floor with: who is going
 * to crash NEXT session, and what exactly do I change before they sit down.
 *
 * The counterfactual is shown ONLY when the server modelled one. When the pack's
 * proposal does not change the UF rate (a hold, a sodium profile, an adherence
 * block), the server sends `counterfactual: null` plus the reason, and this renders
 * the reason. Filling that gap with the current risk would present an absence of
 * change as evidence of benefit.
 */

const BAND_TONE: Record<NextSessionRisk["band"], "red" | "amber" | "mint"> = {
  high: "red",
  watch: "amber",
  low: "mint",
};

function RiskTrack({ row }: { row: NextSessionRisk }) {
  // Both series on ONE scale, so the length of the bar is comparable between rows —
  // a per-row scale would make a 4-point risk look as tall as a 40-point one.
  const max = Math.max(100, ...row.clocks.flatMap((c) => [c.beforePct, c.afterPct ?? 0]));
  return (
    <div className="nsl-track-wrap">
      <div className="nsl-track-legend">
        <span><i className="nsl-swatch is-before" /> now</span>
        {row.counterfactual ? <span><i className="nsl-swatch is-after" /> after the change</span> : null}
      </div>
      <div className="nsl-tracks">
        {row.clocks.map((clock) => (
          <div className="nsl-track" key={clock.minute}>
            <span className="nsl-track-min">{clock.minute}′</span>
            <div className="nsl-track-bars">
              <span className="nsl-bar is-before" style={{ width: `${(clock.beforePct / max) * 100}%` }} title={`${clock.beforePct}% now`} />
              {clock.afterPct !== undefined ? (
                <span className="nsl-bar is-after" style={{ width: `${(clock.afterPct / max) * 100}%` }} title={`${clock.afterPct}% after`} />
              ) : null}
            </div>
            <span className="nsl-track-val">
              {clock.beforePct}%{clock.afterPct !== undefined ? ` → ${clock.afterPct}%` : ""}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PatientRow({ row }: { row: NextSessionRisk }) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <div className="episode-row nsl-row">
        <button className="nsl-main" onClick={() => setOpen((v) => !v)} type="button">
          <span className="nsl-id">
            <strong>{row.patientId}</strong>
            <small>{row.facilityId ?? "facility unknown"}</small>
          </span>
          <span className="nsl-risk">
            <span className="nsl-peak">{row.unassessable ? "—" : `${row.peakPct}%`}</span>
            <small>{row.unassessable ? "not assessable" : `peak @ ${row.peakMinute} min`}</small>
          </span>
          <span className="nsl-change">
            {row.change ? (
              <>
                <strong>{row.change.label}</strong>
                <small>
                  {row.current.ufRateMlH ?? "—"} → {row.change.ufRateMlH} mL/h
                  {row.change.extraMinutes ? ` · +${row.change.extraMinutes} min` : ""}
                </small>
              </>
            ) : (
              <>
                <strong>{row.unassessable ? "Window blocked" : "No rate change proposed"}</strong>
                <small>{row.unassessable ? "see the guardrail" : "the current plan stands"}</small>
              </>
            )}
          </span>
          <span className="nsl-drop">
            {row.counterfactual ? (
              <>
                <strong className={row.counterfactual.meaningful ? "is-good" : ""}>−{row.counterfactual.peakDropPp} pts</strong>
                <small>{Math.round(row.counterfactual.riskReducedBy * 100)}% of the peak risk removed</small>
              </>
            ) : (
              <strong className="is-muted">no modelled change</strong>
            )}
          </span>
          <Tag tone={row.unassessable ? "neutral" : BAND_TONE[row.band]}>{row.unassessable ? "unknown" : row.band}</Tag>
        </button>
      </div>
      {open ? (
        <div className="ra-detail nsl-detail">
          <div className="ra-detail-grid">
            <Metric label="UF rate" value={row.current.ufRateMlH !== undefined ? `${row.current.ufRateMlH} mL/h` : "—"} detail={row.current.ufRatePerKg !== undefined ? `${row.current.ufRatePerKg} mL/kg/h` : "per-kg rate unavailable"} />
            <Metric label="Volume / time" value={row.current.ufVolumeL !== undefined ? `${row.current.ufVolumeL} L` : "—"} detail={row.current.deliveredMinutes !== undefined ? `${row.current.deliveredMinutes} min delivered` : "duration unknown"} />
            <Metric label="IDWG" value={row.current.idwgKg !== undefined ? `${row.current.idwgKg} kg` : "—"} detail={row.current.nadirSbp !== undefined ? `nadir SBP ${row.current.nadirSbp} mmHg` : "no nadir recorded"} />
            <Metric label="Target weight" value={row.current.dryWeightSource === "last-session-close" ? "current" : "unknown"} detail={row.current.dryWeightSource === "last-session-close" ? "refreshed at the last session close" : "the risk is computed against a target nobody has re-checked"} />
          </div>

          <RiskTrack row={row} />

          {row.counterfactual ? (
            <div className="ra-dst">
              <strong>Counterfactual · {row.counterfactual.peakPct}% at {row.counterfactual.peakMinute} min</strong>
              <span>
                {row.change!.label} · {row.current.ufRateMlH} → {row.change!.ufRateMlH} mL/h
                {row.change!.extraMinutes ? ` with +${row.change!.extraMinutes} min to keep the same fluid removal` : ""} — the modelled peak risk
                falls {row.counterfactual.peakDropPp} points{row.counterfactual.meaningful ? "" : " (below the floor that would justify a prescription change)"}.
              </span>
            </div>
          ) : (
            <div className="ra-dst is-absent">
              <span>{row.noCounterfactualReason ?? "No modelled change for this patient."}</span>
            </div>
          )}

          <p className="ra-traj-note">{row.note}</p>

          {row.flags.length > 0 ? (
            <div className="nsl-flags">
              {row.flags.map((f) => <Tag key={f} tone="amber">{f}</Tag>)}
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export default function NextSessionView() {
  const [view, setView] = useState<NextSessionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const paged = usePaged(view?.rows ?? [], 8);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setView(await fetchNextSession());
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load the next-session lens");
    } finally {
      setBusy(false);
    }
  }, []);

  // The lens is chair-side: it is read while the unit moves, so it polls itself.
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load]);

  const flagged = view?.rows.filter((r) => !r.unassessable && r.band !== "low") ?? [];

  return (
    <div className="pc-root">
      <header className="pc-header">
        <div className="pc-header-main">
          <Eyebrow>Chair-side · next session</Eyebrow>
          <h1>Who needs me before they sit down?</h1>
          <p>
            Every patient ranked by the risk of intradialytic hypotension at their <em>next</em> treatment, with the
            specific change the fluid pack proposes and what that change does to the risk. The comparison is the
            point: a rate change is advice, a modelled fall from one number to another is a decision. Where the pack
            does not change the rate, no counterfactual is shown and the reason is stated instead.
          </p>
        </div>
        <div className="pc-header-actions">
          <button className="pc-btn" onClick={() => void load()} disabled={busy} type="button">
            <RefreshCw size={14} /> {busy ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      {error ? <div className="pc-error">{error}</div> : null}

      <section className="pc-kpis">
        <Metric label="High risk next session" value={view ? String(view.totals.high) : "—"} detail={view ? `≥35% peak IDH · ${view.totals.actionable} with a modelled rate change` : "—"} />
        <Metric label="On watch" value={view ? String(view.totals.watch) : "—"} detail="worth a look before the session" />
        <Metric label="Screened" value={view ? String(view.totals.screened) : "—"} detail="patients with a session window" />
        <Metric label="Not assessable" value={view ? String(view.totals.unassessable) : "—"} detail="no telemetry or a stale target weight — an unknown risk, not a low one" />
      </section>

      <section className="pc-panel">
        <div className="pc-panel-head">
          <Eyebrow>Next session · ranked</Eyebrow>
          <PanelExpand label="Peak IDH probability next session, the proposed UF change and its counterfactual" />
        </div>

        {view && view.reading.length > 0 ? (
          <ul className="ra-reading">
            {view.reading.map((line) => (
              <li key={line}><Activity size={12} /> {line}</li>
            ))}
          </ul>
        ) : null}

        {view === null ? (
          <div className="ra-loading"><RefreshCw size={13} className="ra-spin" /> Reading the unit…</div>
        ) : view.rows.length === 0 ? (
          <EmptyView
            eyebrow="Next session"
            level={2}
            title="No patient windows yet"
            description="The lens reads real session telemetry. Start the simulator or ingest session data and the unit will rank here."
          />
        ) : (
          <>
            <ol className="episode-list ra-list list-scroll list-scroll-tall">
              {paged.visible.map((row) => <PatientRow key={row.patientId} row={row} />)}
            </ol>
            <LoadMore shown={paged.visible.length} total={view.rows.length} onMore={paged.showMore} />
            <p className="ra-foot">
              {flagged.length} of {view.totals.screened} patient(s) are flagged. Risk is the fluid pack's own
              mechanistic prior at the protocol clocks (15/30/60 min) — a Class B/C proposal for review, never an
              autonomous prescription change.
            </p>
          </>
        )}
      </section>

      <section className="pc-panel">
        <div className="pc-panel-head">
          <Eyebrow>How to read this</Eyebrow>
          <PanelExpand label="What the numbers are and what they are not" />
        </div>
        <ul className="nsl-notes">
          <li><Waves size={12} /> <strong>Now</strong> is the peak IDH probability under the prescription on record; <strong>after</strong> is the same model with the pack&apos;s recommended UF rate.</li>
          <li><Timer size={12} /> The drop is only shown when the rate actually changes. A hold, a temperature/sodium profile or an adherence-first block leaves the rate alone, so there is no rate counterfactual and the row says so rather than showing a zero as a plan.</li>
          <li><Stethoscope size={12} /> A flagged patient is a conversation at a chair, not a prescription. Approval and ordering stay in the governed loop.</li>
          <li><AlertTriangle size={12} /> &ldquo;Not assessable&rdquo; means the window could not be scored at all — it is never counted as low risk.</li>
        </ul>
      </section>
    </div>
  );
}
