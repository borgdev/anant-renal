import { useState } from "react";
import { AlertTriangle, LineChart, ShieldAlert } from "lucide-react";

import { Eyebrow, LoadMore, Metric, PanelExpand, ProgressBar, Tag, usePaged } from "./ui";
import {
  approvalTone,
  dstNarrative,
  dstPosture,
  dstReadout,
  emptyBoardReason,
  type RankedAction,
  type RankedActionTrajectory,
  type RankedActionsPayload,
} from "../lib/ranked-actions";

/**
 * The decision curve, rendered from the payload.
 *
 * This shows what the engine computed — it does NOT recompute a curve here. A
 * second derivation in the browser could disagree with the value in `valueLabel`,
 * and then two "truths" would exist for the thing being approved. When there is no
 * curve the block says so and repeats the engine's reason, because a missing chart
 * that renders as nothing is indistinguishable from a broken page.
 */
function TrajectoryBlock({ trajectory }: { trajectory: RankedActionTrajectory }) {
  const { points, targetBand: band } = trajectory;
  if (points.length === 0) {
    return (
      <div className="ra-traj is-absent">
        <span className="ra-traj-head">
          <LineChart size={12} /> No projected trajectory
        </span>
        <p>{trajectory.unavailableReason ?? "The pack produced no candidate curve for this patient."}</p>
      </div>
    );
  }
  // One shared scale across every candidate, so the rows are comparable — a
  // per-row scale would make a 0.2 g/dL difference look like a crash.
  const values = [...points.flatMap((p) => [p.endHgb, p.peakHgb]), band.min, band.max, trajectory.currentHgb];
  const lo = Math.min(...values) - 0.3;
  const hi = Math.max(...values) + 0.3;
  const span = Math.max(0.001, hi - lo);
  const x = (v: number) => `${Math.round(((v - lo) / span) * 100)}%`;
  const chosen = trajectory.chosenIndex !== null ? points[trajectory.chosenIndex] : undefined;
  return (
    <div className="ra-traj">
      <span className="ra-traj-head">
        <LineChart size={12} /> Projected {trajectory.horizonWeeks}-week trajectory
        <em>
          from {trajectory.currentHgb.toFixed(1)} g/dL on {trajectory.currentDose} u/wk · target {band.min}–{band.max}
        </em>
      </span>
      <div className="ra-traj-rows">
        {points.map((p, i) => (
          <div className={`ra-traj-row ${i === trajectory.chosenIndex ? "is-chosen" : ""}`} key={`${p.dose}-${i}`}>
            <span className="ra-traj-dose">{p.label}</span>
            <div className="ra-traj-track">
              <span className="ra-traj-band" style={{ left: x(band.min), width: `${Math.max(1, ((band.max - band.min) / span) * 100)}%` }} />
              <span
                className={`ra-traj-mark ${p.endHgb < band.min ? "is-low" : p.endHgb > band.max ? "is-high" : "is-in"}`}
                style={{ left: x(p.endHgb) }}
                title={`ends ${p.endHgb} g/dL · peak ${p.peakHgb} g/dL`}
              />
            </div>
            <span className="ra-traj-num">{p.endHgb.toFixed(1)}</span>
            <span className="ra-traj-inband">{p.weeksInBand}/{trajectory.horizonWeeks} wk</span>
            <span className="ra-traj-cost">${Math.round(p.projectedCostUsd)}</span>
            {i === trajectory.chosenIndex ? <Tag tone="mint">chosen</Tag> : null}
          </div>
        ))}
      </div>
      <p className="ra-traj-note">
        {trajectory.note} Each row is a candidate dose over the horizon; the marked row is the controller's
        preference. The dose this action places is one of these rows — compare them before approving.
      </p>
    </div>
  );
}

export interface RankedActionsPanelProps {
  /** The board this protocol's pack published on its `/state` route. */
  payload: RankedActionsPayload | undefined;
  /** Protocol id, for the header. */
  protocol: string;
  /**
   * Why an empty board is legitimate on THIS fleet. A gate is a real reason for
   * no action, and the operator must not read "nothing ranked" as "nothing to
   * do" — so the pack's own explanation is shown instead of a generic blank.
   */
  emptyHint?: string;
  /** How the actions are ranked, in the pack's own terms. */
  note?: string;
  /** Marks (never filters) the row for a patient the page has selected. */
  highlightSubject?: string;
  /** Outer shell class, so the board inherits the hosting page's panel look
   *  (`pc-panel` on the P1–P6 pages, `panel` on the anemia page). */
  shellClass?: string;
}

const NEGLIGIBLE = 0.005;

/**
 * ONE action board for every clinical protocol page.
 *
 * Each pack ranks its own findings into governed actions and publishes the board
 * with the findings, so this panel is a renderer — it computes no score, picks no
 * action and formats no value. That is the whole point: the same component over
 * seven packs means the ranking rules can only differ where the packs differ.
 */
export default function RankedActionsPanel({
  payload,
  protocol,
  emptyHint,
  note,
  highlightSubject,
  shellClass = "pc-panel",
}: RankedActionsPanelProps) {
  const [open, setOpen] = useState<string | null>(null);
  const nbas = payload?.nbas ?? [];
  const { visible, remaining, showMore } = usePaged(nbas, 6, protocol);
  const unmapped = payload?.unmapped ?? [];
  const rejected = payload?.rejected ?? [];

  return (
    <section className={`${shellClass} ra-panel`}>
      <div className="pc-panel-head">
        <Eyebrow>Ranked next-best actions · {protocol}</Eyebrow>
        <PanelExpand
          label={
            note ??
            "Every finding converted into a governed action, checked against its cell's allowlist, then ranked by the pack"
          }
        />
      </div>

      {payload ? (
        <div className="ra-summary">
          <span className="ra-chip">
            <strong>{nbas.length}</strong> ranked
          </span>
          <span className="ra-chip">
            <strong>{payload.considered}</strong> findings considered
          </span>
          <span className="ra-chip">
            <strong>{payload.suppressed}</strong> no-action
          </span>
          <span className="ra-chip" title="Proposal kinds emitted — one per contributing cell">
            <strong>{payload.kinds.length}</strong> cell kind{payload.kinds.length === 1 ? "" : "s"}
            {payload.kinds.length ? ` · ${payload.kinds.join(" · ")}` : ""}
          </span>
        </div>
      ) : null}

      {unmapped.length > 0 ? (
        <div className="ra-warn">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>
            <strong>Action-map coverage gap.</strong> The pack produced{" "}
            {unmapped.length === 1 ? "an action token" : "action tokens"} its map does not cover:{" "}
            <code>{unmapped.join(", ")}</code>. A delivered verdict with no action is a gap to close in the map — not a
            no-op, and not a silent drop.
          </span>
        </div>
      ) : null}

      {rejected.length > 0 ? (
        <div className="ra-blocked">
          <ShieldAlert size={14} aria-hidden="true" />
          <span>
            <strong>Rejected by the cell allowlist.</strong> {rejected.length} candidate
            {rejected.length === 1 ? "" : "s"} named an action its proposing cell is not permitted to perform, so{" "}
            {rejected.length === 1 ? "it was" : "they were"} dropped rather than dispatched.
            <ul className="ra-blocked-list">
              {rejected.map((row) => (
                <li key={`${row.actionKind}-${row.cells.join("-")}-${row.title}`}>
                  <code>{row.actionKind}</code> from <code>{row.cells.join(", ")}</code> — {row.title}
                </li>
              ))}
            </ul>
          </span>
        </div>
      ) : null}

      {nbas.length === 0 ? (
        <div className="ra-empty">
          <strong>No ranked actions</strong>
          <p>{emptyHint ?? emptyBoardReason(payload)}</p>
          {payload && payload.suppressed > 0 ? (
            <p className="ra-empty-foot">
              {payload.considered} finding(s) were evaluated and {payload.suppressed} reported no action. The board is
              empty because the pack found nothing to do — not because it failed to run.
            </p>
          ) : null}
        </div>
      ) : (
        <>
          <ol className="ra-list">
            {visible.map((row) => {
              const readout = dstReadout(row);
              const isOpen = open === row.nbaId;
              const highlighted = Boolean(highlightSubject && row.subject === highlightSubject);
              return (
                <li
                  key={row.nbaId}
                  className={`ra-row${row.status === "awaiting-approval" ? " is-approval" : ""}${
                    highlighted ? " is-highlight" : ""
                  }`}
                >
                  <button
                    type="button"
                    className="ra-row-main"
                    aria-expanded={isOpen}
                    onClick={() => setOpen(isOpen ? null : row.nbaId)}
                  >
                    <span className="ra-rank">{row.rank}</span>
                    <span className="ra-title">
                      <strong>{row.title}</strong>
                      <small>
                        {row.owner} · {row.scopeType} · {row.cells.join(", ")}
                      </small>
                    </span>
                    <span className="ra-value" title={`Denominated in ${row.valueUnit}`}>
                      {row.valueLabel}
                    </span>
                    <Tag tone={row.status === "awaiting-approval" ? "amber" : "mint"}>{row.status}</Tag>
                    <Tag tone={approvalTone(row.approvalClass)}>Class {row.approvalClass}</Tag>
                    <span className="ra-due">{row.due}</span>
                  </button>

                  {isOpen ? (
                    <div className="ra-detail">
                      <div className="ra-detail-grid">
                        <Metric label="Action" value={row.actionLabel} detail="the governed action this performs" />
                        <Metric
                          label="Expected value"
                          value={row.valueLabel}
                          detail={`over the pack's horizon · ${row.valueUnit}`}
                        />
                        <Metric label="Evidence" value={String(row.evidenceCount)} detail={dstNarrative(row)} />
                        <Metric label="Priority" value={row.score.toFixed(3)} detail={`urgency ${Math.round(row.urgency * 100)}% · approval effort ${Math.round(row.policyCost * 100)}%`} />
                      </div>

                      {/* The curve the number came from — shown BEFORE the approval, not after. */}
                      {row.trajectory ? <TrajectoryBlock trajectory={row.trajectory} /> : null}

                      {readout ? (
                        <div className="ra-dst" title="Dempster–Shafer interval fused from this finding's own evidence">
                          <strong>{dstPosture(row)}</strong>
                          <span>{readout} · {dstNarrative(row)}</span>
                        </div>
                      ) : (
                        <div className="ra-dst is-absent">
                          <span>No fused interval on this action — the point estimate stands alone.</span>
                        </div>
                      )}

                      <div className="ra-bars">
                        <div>
                          <small>Urgency</small>
                          <ProgressBar value={Math.round(row.urgency * 100)} tone="mint" />
                        </div>
                        <div>
                          <small>Approval effort</small>
                          <ProgressBar value={Math.round(row.policyCost * 100)} tone="amber" />
                        </div>
                        <div>
                          <small>Risk if wrong</small>
                          <ProgressBar value={Math.round(row.risk * 100)} tone={row.risk > 0.6 ? "red" : "blue"} />
                        </div>
                        <div>
                          <small>Priority</small>
                          <span className="ra-score">{row.score.toFixed(3)}</span>
                        </div>
                      </div>

                      {/* Internal identifiers live here, out of the way of a decision. */}
                      <details className="ra-technical">
                        <summary>Technical detail</summary>
                        <div className="ra-kv">
                          <span>Proposal kind</span><code>{row.insightKind ?? '—'}</code>
                          <span>Scope</span><code>{row.scopeType}</code>
                          <span>Subject</span><code>{row.subject}</code>
                          <span>Action id</span><code>{row.nbaId}</code>
                        </div>
                      </details>

                      {row.evidence && row.evidence.length > 0 ? (
                        <div className="ra-evidence">
                          <Eyebrow>Cited by the pack</Eyebrow>
                          <ul>
                            {row.evidence.map((ref, index) => (
                              <li key={`${row.nbaId}-ev-${index}`}>
                                <code>{ref.sourceId ?? "unnamed"}</code>
                                {ref.contentType ? <em>{ref.contentType}</em> : null}
                                {ref.span ? <span>{ref.span}</span> : null}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
          <LoadMore
            shown={visible.length}
            total={nbas.length}
            onMore={showMore}
            label={`${remaining} more action${remaining === 1 ? "" : "s"}`}
          />
        </>
      )}

      {payload && payload.kinds.length > 0 && nbas.length > 0 ? (
        <p className="ra-foot">
          Ranked from {payload.considered} finding(s) across {payload.kinds.length} contributing cell kind
          {payload.kinds.length === 1 ? "" : "s"}. {payload.suppressed > 0 ? `${payload.suppressed} reported no action. ` : ""}
          Every listed action passed its cell's allowlist before it was ranked.
        </p>
      ) : null}
    </section>
  );
}
