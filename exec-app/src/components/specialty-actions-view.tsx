import { useEffect, useState } from "react";
import RankedActionsPanel from "./ranked-actions-panel";
import { asActionsPayload, type RankedActionsPayload } from "../lib/ranked-actions";

/**
 * The `ranked-actions` view KIND.
 *
 * A specialty declares `{ id, label, kind: "ranked-actions", source }` and gets
 * this screen without the shell knowing the specialty exists — which is the whole
 * point of G5, and the difference between the declared id vocabulary (where an id
 * only means something because a `case` arm exists for it) and a kind vocabulary
 * (where the platform supplies the renderer).
 *
 * The panel below computes nothing: it renders whatever board the pack published
 * at its own route. So this component is a fetch, an honest failure state and a
 * hand-off, and it is deliberately the only thing a new kind needs — adding a
 * second kind means adding a second renderer, not editing the shell's dispatch.
 */
export default function SpecialtyActionsView({ label, source }: { label: string; source: string }) {
  const [payload, setPayload] = useState<RankedActionsPayload | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [emptyHint, setEmptyHint] = useState<string | undefined>(undefined);
  const [cohort, setCohort] = useState<{ id: string; patients: number; onPlan?: number } | undefined>(undefined);

  useEffect(() => {
    let active = true;
    setPayload(undefined);
    setError(undefined);
    setEmptyHint(undefined);
    setCohort(undefined);
    (async () => {
      try {
        const response = await fetch(source, { headers: { accept: "application/json" } });
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const body = (await response.json()) as { actions?: unknown; emptyHint?: unknown; cohort?: unknown };
        const board = asActionsPayload(body.actions);
        // Not a board is reported as not a board. An absent payload rendered as
        // "nothing ranked" would read as "nothing to do" — the same conflation
        // `asActionsPayload` exists to prevent, and one the operator cannot
        // distinguish from the outside.
        if (!board) throw new Error("the pack published no action board on this route");
        // The pack's own reason for an empty board, when it gives one. A blank
        // panel and "no cohort is enrolled here" look identical to an operator
        // and mean opposite things.
        if (active && typeof body.emptyHint === "string") setEmptyHint(body.emptyHint);
        // The population the pack says it is responsible for. Optional: a pack
        // that declares no cohort publishes none, and then nothing renders here
        // rather than a misleading zero.
        const declared = body.cohort as { id?: unknown; patients?: unknown; onPlan?: unknown } | undefined;
        if (active && declared && typeof declared.id === "string" && typeof declared.patients === "number") {
          setCohort({
            id: declared.id,
            patients: declared.patients,
            ...(typeof declared.onPlan === "number" ? { onPlan: declared.onPlan } : {}),
          });
        }
        if (active) setPayload(board);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "failed to load the board");
      }
    })();
    return () => { active = false; };
  }, [source]);

  return (
    <section className="panel view-kind-ranked-actions">
      <header className="panel-head">
        <div>
          <h1>{label}</h1>
          <p className="muted">
            Ranked actions published by this specialty at <code>{source}</code>. The board is the pack&apos;s;
            this screen renders it and computes nothing.
          </p>
        </div>
      </header>
      {error ? <div className="error">{error}</div> : null}
      {cohort ? (
        <p className="cohort-strip muted" data-cohort={cohort.id}>
          Cohort <code>{cohort.id}</code> · {cohort.patients} patient{cohort.patients === 1 ? "" : "s"}
          {typeof cohort.onPlan === "number" ? ` · ${cohort.onPlan} on a plan` : null}
        </p>
      ) : null}
      {!error && !payload ? <p className="muted">Loading the board…</p> : null}
      {payload ? <RankedActionsPanel payload={payload} protocol={label} {...(emptyHint ? { emptyHint } : {})} /> : null}
    </section>
  );
}
