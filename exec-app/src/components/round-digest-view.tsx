"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowDownRight, ArrowUpRight, BookmarkCheck, RefreshCw, UserMinus, UserPlus } from "lucide-react";
import { closeRound, fetchRoundDigest, type ProtocolStatusWord, type RoundDigestView, type RoundMovement } from "../lib/round";
import { Eyebrow, EmptyView, LoadMore, Metric, PanelExpand, Tag, usePaged } from "./ui";

/**
 * "Since your last round" — the worklist a clinician picks up when they sit down.
 *
 * The digest is only as good as its baseline, so this view is built around being
 * honest about the record: it names WHEN the previous round was taken and by whom,
 * it lets the current state be recorded as the next baseline, and when nothing has
 * ever been recorded it says there is nothing to compare against — rather than
 * showing an empty list that reads as a calm fleet.
 */

const STATUS_TONE: Record<ProtocolStatusWord, "red" | "amber" | "mint" | "neutral"> = {
  red: "red",
  amber: "amber",
  green: "mint",
  unknown: "neutral",
};

function MovementRow({ m }: { m: RoundMovement }) {
  const delta = Math.round(m.deltaSeverity * 100);
  return (
    <li>
      <div className={`episode-row rd-row ${m.direction} ${m.newlyAtRisk ? "is-new" : ""}`}>
        <span className="rd-arrow">
          {m.direction === "worsened" ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
        </span>
        <span className="rd-who">
          <strong>{m.patientId}</strong>
          <small>{m.facilityId ?? m.realmId}</small>
        </span>
        <span className="rd-what">
          <strong>{m.protocolLabel}</strong>
          <small>{m.drivers.length > 0 ? `drivers: ${m.drivers.slice(0, 3).join(", ")}` : m.substate}</small>
        </span>
        <span className="rd-move">
          <span className="rd-scores">
            <Tag tone={STATUS_TONE[m.before.status]}>{m.before.status} {Math.round(m.before.severity * 100)}%</Tag>
            <span className="rd-to">→</span>
            <Tag tone={STATUS_TONE[m.after.status]}>{m.after.status} {Math.round(m.after.severity * 100)}%</Tag>
          </span>
          <small className={m.direction === "worsened" ? "is-bad" : "is-good"}>
            {m.direction === "worsened" ? "+" : ""}{delta} pts severity
          </small>
        </span>
        {m.newlyAtRisk ? <Tag tone="red">newly at risk</Tag> : <span className="rd-spacer" />}
      </div>
    </li>
  );
}

export default function RoundDigestView() {
  const [digest, setDigest] = useState<RoundDigestView | null>(null);
  const [clinician, setClinician] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const movements = usePaged(digest?.movements ?? [], 12);

  const load = useCallback(async (by = "") => {
    setBusy(true);
    setError(null);
    try {
      setDigest(await fetchRoundDigest(by));
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load the round digest");
    } finally {
      setBusy(false);
    }
  }, []);

  // The poll reads the LATEST clinician name through a ref: putting `clinician` in
  // the dependency list would fetch once per keystroke and let the baseline change
  // under the reader while they are still typing their name.
  const clinicianRef = useRef(clinician);
  clinicianRef.current = clinician;

  useEffect(() => {
    void load(clinicianRef.current);
    const timer = setInterval(() => void load(clinicianRef.current), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const close = async () => {
    const by = clinician.trim() || "operator";
    setBusy(true);
    try {
      const saved = await closeRound(by);
      setNotice(`Round recorded at ${saved.round.takenAt} by ${saved.round.takenBy} across ${saved.round.patients} patient(s) — it is now the baseline for your next round.`);
      await load(clinician);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to close the round");
    } finally {
      setBusy(false);
    }
  };

  const summary = digest?.summary;

  return (
    <div className="pc-root">
      <header className="pc-header">
        <div className="pc-header-main">
          <Eyebrow>Round · since your last round</Eyebrow>
          <h1>What moved while I was not looking?</h1>
          <p>
            Every protocol&apos;s severity for every patient, diffed against your last recorded round and ordered so the
            worsenings come first. &ldquo;Newly at risk&rdquo; means a patient crossed from green into red or amber —
            a patient who was already red and got worse is shown as a worsening, not as a discovery.
          </p>
        </div>
        <div className="pc-header-actions">
          <input
            className="input rd-input"
            onChange={(e) => setClinician(e.target.value)}
            placeholder="Your name (scopes the baseline)"
            value={clinician}
          />
          <button className="pc-btn" onClick={() => void load(clinician)} disabled={busy} type="button">
            <RefreshCw size={14} /> {busy ? "Working…" : "Refresh"}
          </button>
          <button className="pc-btn" onClick={() => void close()} disabled={busy} type="button">
            <BookmarkCheck size={14} /> Close this round
          </button>
        </div>
      </header>

      {error ? <div className="pc-error">{error}</div> : null}
      {notice ? <div className="rd-notice">{notice}</div> : null}

      <section className="pc-kpis">
        <Metric
          label="Worsened"
          value={summary ? String(summary.worsened) : "—"}
          detail={summary ? `${summary.newlyAtRisk} newly at risk` : "—"}
        />
        <Metric label="Improved" value={summary ? String(summary.improved) : "—"} detail={summary ? `${summary.unchanged} unchanged (moved less than 5%)` : "—"} />
        <Metric
          label="Fleet worst severity"
          value={summary ? `${(summary.fleetSeverityNow * 100).toFixed(1)}%` : "—"}
          detail={summary ? summary.netSeverityChange === 0 ? "unchanged since your last round" : `${summary.netSeverityChange > 0 ? "+" : ""}${(summary.netSeverityChange * 100).toFixed(1)} pts since your last round` : "—"}
        />
        <Metric
          label="Measured against"
          value={digest?.baseline ? new Date(digest.baseline.takenAt).toLocaleString() : "no baseline"}
          detail={digest?.baseline ? `recorded by ${digest.baseline.takenBy} · ${digest.since?.patients ?? 0} patient(s)` : "close a round to start comparing"}
        />
      </section>

      <section className="pc-panel">
        <div className="pc-panel-head">
          <Eyebrow>Movements</Eyebrow>
          <PanelExpand label="Worsenings first, then improvements, each with the protocol and the size of the move" />
        </div>

        {digest && digest.reading.length > 0 ? (
          <ul className="ra-reading">
            {digest.reading.map((line) => (
              <li key={line}><AlertTriangle size={12} /> {line}</li>
            ))}
          </ul>
        ) : null}

        {digest === null ? (
          <div className="ra-loading"><RefreshCw size={13} className="ra-spin" /> Diffing the round…</div>
        ) : !digest.baseline ? (
          // No baseline is a fact about the record, not a quiet fleet. This is the
          // one state that must never be rendered as an empty list.
          <EmptyView
            eyebrow="Since your last round"
            level={2}
            title="No previous round recorded"
            description="Severity is a function of each patient's whole window at one moment, so it cannot be reconstructed for a past moment — the baseline has to be recorded. Close this round to make the next one comparable."
          />
        ) : digest.movements.length === 0 ? (
          <EmptyView
            eyebrow="Since your last round"
            level={2}
            title="Nothing moved"
            description={`Across ${digest.now.patients} patient(s) and every protocol, no severity moved by more than the 5-point floor since ${digest.since?.takenAt}. That is a result, not a missing render.`}
          />
        ) : (
          <>
            <ol className="episode-list ra-list list-scroll list-scroll-tall">
              {movements.visible.map((m) => <MovementRow key={`${m.patientId}-${m.protocol}-${m.direction}`} m={m} />)}
            </ol>
            <LoadMore shown={movements.visible.length} total={digest.movements.length} onMore={movements.showMore} />
            <p className="ra-foot">
              {digest.movements.length} movement(s) above the 5-point floor. Severity comes from the same per-patient
              protocol evaluation the cockpit shows, so this can never disagree with the board.
            </p>
          </>
        )}
      </section>

      {digest && (digest.departed.length > 0 || digest.appeared.length > 0) ? (
        <section className="rd-side-grid">
          {digest.departed.length > 0 ? (
            <div className="pc-panel">
              <div className="pc-panel-head"><Eyebrow>Left the cohort</Eyebrow></div>
              <ul className="rd-side-list">
                {digest.departed.slice(0, 12).map((d) => (
                  <li key={d.patientId}>
                    <UserMinus size={12} />
                    <strong>{d.patientId}</strong>
                    <span>{d.realmId}</span>
                    <Tag tone={STATUS_TONE[d.worstStatus]}>{d.worstStatus} {Math.round(d.worstSeverity * 100)}%</Tag>
                  </li>
                ))}
              </ul>
              <p className="ra-foot">
                Discharged, transferred or removed since your last round. Deliberately NOT counted as improvements —
                leaving is not recovering.
              </p>
            </div>
          ) : null}
          {digest.appeared.length > 0 ? (
            <div className="pc-panel">
              <div className="pc-panel-head"><Eyebrow>New since your last round</Eyebrow></div>
              <ul className="rd-side-list">
                {digest.appeared.slice(0, 12).map((a) => (
                  <li key={a.patientId}>
                    <UserPlus size={12} />
                    <strong>{a.patientId}</strong>
                    <span>{a.facilityId ?? a.realmId}</span>
                    <Tag tone={STATUS_TONE[a.worstStatus]}>{a.worstStatus} {Math.round(a.worstSeverity * 100)}%</Tag>
                  </li>
                ))}
              </ul>
              <p className="ra-foot">No previous record, so they are listed here rather than as a movement.</p>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
