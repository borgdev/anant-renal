import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, RefreshCw, ShieldAlert } from "lucide-react";

import { Eyebrow, LoadMore, PanelExpand, Tag, usePaged } from "./ui";
import { approvalTone, fetchFleetActions, type FleetActionBoard, type ProtocolActionSource } from "../lib/ranked-actions";

export interface FleetActionsBoardProps {
  /**
   * Open the pack's own page. The hub indexes and ranks; the pack's page owns the
   * detail (its windows, twin, assurance). Duplicating that here would create a
   * second rendering of the same finding — the thing this board exists to avoid.
   */
  onOpenProtocol?: (protocol: string) => void;
  shellClass?: string;
}

/** A pack's contribution, at a glance. */
function sourceTone(source: ProtocolActionSource): string {
  if (!source.ok) return "is-down";
  if (source.rejected.length > 0) return "is-blocked";
  if (source.unmapped.length > 0) return "is-gap";
  if (source.ranked === 0) return "is-empty";
  return "is-ok";
}

function sourceNote(source: ProtocolActionSource): string {
  if (!source.ok) return source.error ?? "unavailable";
  if (source.ranked === 0 && source.suppressed > 0) return `no action · ${source.suppressed} evaluated`;
  if (source.ranked === 0) return "no findings";
  // "shown" — the pack publishes a capped top-N, so this is not a total.
  return `${source.ranked} shown · ${source.considered} considered · ${source.suppressed} no-action`;
}

/**
 * Every protocol pack's ranked actions in ONE list.
 *
 * The packs already rank their own findings with the same belief-aware scorer, so
 * their scores are comparable and can be merged. Their VALUE claims are not: one
 * pack's unit is treatments, another's is lab results. The merged list is therefore
 * ordered by score and every row keeps its own unit — the board never adds two
 * quantities that are not the same kind of thing.
 *
 * It is also deliberately not a second detail view: a row opens the pack that owns it.
 */
export default function FleetActionsBoard({ onOpenProtocol, shellClass = "pc-panel" }: FleetActionsBoardProps) {
  const [board, setBoard] = useState<FleetActionBoard | null>(null);
  const [loading, setLoading] = useState(false);
  const [reading, setReading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setReading(null);
    try {
      await fetchFleetActions((partial) => {
        setBoard(partial);
        const last = partial.sources[partial.sources.length - 1];
        setReading(last ? last.label : null);
      });
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : "could not read the protocol boards");
    } finally {
      setLoading(false);
      setReading(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = board?.actions ?? [];
  const sources = board?.sources ?? [];
  const { visible, remaining, showMore } = usePaged(rows, 10);
  const down = sources.filter((source) => !source.ok);
  const unmapped = sources.filter((source) => source.unmapped.length > 0);
  const rejected = sources.filter((source) => source.rejected.length > 0);

  return (
    <section className={`${shellClass} ra-panel`}>
      <div className="pc-panel-head">
        <Eyebrow>Fleet ranked actions · every protocol pack</Eyebrow>
        <PanelExpand
          label="One rank across seven packs — the same belief-aware scorer, ranked on the server, merged here without recomputation"
        />
      </div>

      {board ? (
        <div className="ra-summary">
          <span className="ra-chip">
            <strong>{board.totals.ranked}</strong> ranked across {board.totals.reporting}/{board.totals.packs} packs
          </span>
          <span className="ra-chip">
            <strong>{board.totals.considered}</strong> findings considered
          </span>
          <span className="ra-chip">
            <strong>{board.totals.suppressed}</strong> no-action
          </span>
          <span className="ra-chip" title="Proposal kinds emitted across every contributing cell">
            <strong>{board.kinds.length}</strong> cell kind{board.kinds.length === 1 ? "" : "s"}
          </span>
          {board ? (
            <button className="ra-refresh" type="button" onClick={() => void load()} disabled={loading}>
              <RefreshCw size={12} /> {loading ? "Reading…" : "Refresh"}
            </button>
          ) : null}
        </div>
      ) : null}

      {error ? <div className="ra-blocked">{error}</div> : null}

      {!board && loading ? (
        <div className="ra-loading">
          <RefreshCw size={14} className="ra-spin" />
          <span>Reading the packs in sequence{reading ? ` — ${reading}` : ""}…</span>
        </div>
      ) : null}

      {sources.length > 0 ? (
        <div className="ra-src-strip">
          {sources.map((source) => (
            <button
              key={source.protocol}
              type="button"
              className={`ra-src ${sourceTone(source)}`}
              title={sourceNote(source)}
              disabled={!onOpenProtocol}
              onClick={() => onOpenProtocol?.(source.protocol)}
            >
              <strong>{source.label}</strong>
              <span>{sourceNote(source)}</span>
              {source.unmapped.length > 0 ? <em className="is-gap">{source.unmapped.length} gap</em> : null}
              {source.rejected.length > 0 ? <em className="is-blocked">{source.rejected.length} rejected</em> : null}
            </button>
          ))}
        </div>
      ) : null}

      {down.length > 0 ? (
        <div className="ra-blocked">
          <ShieldAlert size={14} aria-hidden="true" />
          <span>
            <strong>{down.length} pack{down.length === 1 ? "" : "s"} could not be read.</strong> Not the same as
            zero — the board has no actions from {down.map((source) => source.label).join(", ")} because the request
            failed, not because the pack found nothing:
            <ul className="ra-blocked-list">
              {down.map((source) => (
                <li key={source.protocol}>
                  <code>{source.label}</code> — {source.error ?? "unavailable"}
                </li>
              ))}
            </ul>
          </span>
        </div>
      ) : null}

      {unmapped.length > 0 ? (
        <div className="ra-warn">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>
            <strong>Action-map coverage gaps.</strong> These packs delivered verdicts their own maps cannot turn into an
            action — a gap to close in the map, not a no-op:
            <ul className="ra-blocked-list">
              {unmapped.map((source) => (
                <li key={source.protocol}>
                  <code>{source.label}</code> — <code>{source.unmapped.join(", ")}</code>
                </li>
              ))}
            </ul>
          </span>
        </div>
      ) : null}

      {rejected.length > 0 ? (
        <div className="ra-blocked">
          <ShieldAlert size={14} aria-hidden="true" />
          <span>
            <strong>Rejected by a cell allowlist.</strong> These candidates named an action their proposing cell is not
            permitted to perform, so they were dropped rather than dispatched:
            <ul className="ra-blocked-list">
              {rejected.map((source) => (
                <li key={source.protocol}>
                  <code>{source.label}</code> —{" "}
                  {source.rejected.map((row) => `${row.actionKind} from ${row.cells.join(", ")}`).join("; ")}
                </li>
              ))}
            </ul>
          </span>
        </div>
      ) : null}

      {board && rows.length === 0 && !loading ? (
        <div className="ra-empty">
          <strong>No ranked actions across the fleet</strong>
          <p>
            {board.totals.considered} finding(s) were evaluated and {board.totals.suppressed} reported no action. Every
            pack's board is empty because the packs found nothing to do — each pack's own page states the gate that
            applies.
          </p>
        </div>
      ) : null}

      {rows.length > 0 ? (
        <>
          <ol className="ra-list">
            {visible.map((row, index) => (
              <li key={`${row.protocol}-${row.nbaId}`} className={`ra-row${row.status === "awaiting-approval" ? " is-approval" : ""}`}>
                <button
                  type="button"
                  className="ra-row-main"
                  title={onOpenProtocol ? `Open ${row.protocolLabel}` : undefined}
                  onClick={() => onOpenProtocol?.(row.protocol)}
                >
                  {/* The position in THIS merged list, not the pack's own rank —
                      three packs each have a rank 1. */}
                  <span className="ra-rank" title={`#${row.rank} within ${row.protocolLabel}`}>
                    {index + 1}
                  </span>
                  <span className="ra-title">
                    <strong>{row.title}</strong>
                    <small>
                      <em className="ra-prov">{row.protocolLabel}</em> · {row.owner} · {row.actionLabel}
                    </small>
                  </span>
                  <span className="ra-value" title={`Denominated in ${row.valueUnit}`}>
                    {row.valueLabel}
                  </span>
                  <Tag tone={row.status === "awaiting-approval" ? "amber" : "mint"}>{row.status}</Tag>
                  <Tag tone={approvalTone(row.approvalClass)}>Class {row.approvalClass}</Tag>
                  <span className="ra-due">{row.due}</span>
                </button>
              </li>
            ))}
          </ol>
          <LoadMore
            shown={visible.length}
            total={rows.length}
            onMore={showMore}
            label={`${remaining} more action${remaining === 1 ? "" : "s"}`}
          />
        </>
      ) : null}

      {board && loading ? <p className="ra-foot">Reading the remaining packs…</p> : null}

      {board && rows.length > 0 ? (
        <p className="ra-foot">
          Ranked by the same belief-aware score, so the order is comparable across packs — the <strong>values are
          not</strong>: each row keeps its own unit (treatments, lab results, doses), so compare score, then read the
          unit. Each pack publishes its own top-N, so this is the union of the packs' ranked heads — a pack with more
          work than its page limit shows the rest on its own page. Packs are read one at a time to keep the server
          responsive; the board is a snapshot, refreshed on demand. Open a row to work it in the pack that owns it.
        </p>
      ) : null}
    </section>
  );
}
