/**
 * The ranked-action board every protocol pack publishes on its `/state` route.
 *
 * A protocol's findings are converted into governed actions server-side
 * (`src/swarm/clinical-nba.ts`), and this is that payload. The console renders
 * exactly what the pack produced — it must never re-derive a value, and it must
 * never guess an action's kind. The two governance lists travel with the data on
 * purpose:
 *
 *   - `unmapped` — the pack produced an action token its own map does not cover.
 *     A real coverage gap (as opposed to `null`, which means "deliberately no
 *     action": in band, or blocked by a guardrail).
 *   - `rejected` — a candidate whose proposing cell is not permitted to perform
 *     that action kind. The action was dropped rather than dispatched.
 *
 * Both are shown to the operator. A gap that only appears in a server log is a
 * gap nobody fixes.
 */

import { responseOrThrow } from "./session";

export type ActionApprovalClass = "A" | "B" | "C" | "D";

export interface RankedActionEvidenceRef {
  sourceId?: string;
  contentType?: string;
  span?: string;
}

export interface RankedActionTrajectoryPoint {
  dose: number;
  label: string;
  endHgb: number;
  peakHgb: number;
  weeksInBand: number;
  pctInBand: number;
  projectedCostUsd: number;
}

/**
 * The decision curve the engine computed, carried on the action itself. The console
 * RENDERS this; it never recomputes it, because a second derivation could disagree
 * with the number being approved.
 */
export interface RankedActionTrajectory {
  horizonWeeks: number;
  currentHgb: number;
  currentDose: number;
  targetBand: { min: number; max: number };
  chosenIndex: number | null;
  points: RankedActionTrajectoryPoint[];
  note: string;
  /** Present when there is no curve, and says why. */
  unavailableReason?: string;
}

export interface RankedAction {
  nbaId: string;
  rank: number;
  /** Human title — already carries the subject and the observed value. */
  title: string;
  subject: string;
  scopeType: string;
  /** Owning cell's manifest owner (e.g. "Nephrology · Renal dialysis"). */
  owner: string;
  due: string;
  cells: string[];
  /** The governed action this NBA performs; already checked against the cell's
   *  `allowedActions` allowlist before ranking. */
  actionKind: string;
  actionLabel: string;
  /** The value claim WITH its unit, formatted server-side ("20 treatments",
   *  "1 lab result"). Never re-format a number in the console. */
  valueLabel: string;
  valueUnit: string;
  expectedOutcome: number;
  evidenceCount: number;
  evidence?: RankedActionEvidenceRef[];
  consensus: number;
  approvalClass: ActionApprovalClass;
  urgency: number;
  policyCost: number;
  risk: number;
  status: "proposed" | "awaiting-approval";
  score: number;
  insightKind?: string;
  /** Dempster–Shafer interval fused from the finding's own evidence. */
  belief?: number;
  plausibility?: number;
  conflictMass?: number;
  /** The dose/effect curve this recommendation came from, when the pack computed one. */
  trajectory?: RankedActionTrajectory;
}

export interface RankedActionsPayload {
  nbas: RankedAction[];
  considered: number;
  actionable: number;
  suppressed: number;
  /** Proposal kinds actually emitted (one per contributing cell). */
  kinds: string[];
  unmapped: string[];
  rejected: Array<{ title: string; actionKind: string; cells: string[] }>;
}

/**
 * Treat anything that is not a board as "no board", not as "no work" — an older
 * server build, a failed evaluation and a genuinely empty fleet must not look
 * the same to the operator.
 */
export function asActionsPayload(raw: unknown): RankedActionsPayload | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const candidate = raw as Partial<RankedActionsPayload>;
  return Array.isArray(candidate.nbas) ? (candidate as RankedActionsPayload) : undefined;
}

export function approvalTone(cls: ActionApprovalClass): "mint" | "blue" | "amber" | "violet" {
  switch (cls) {
    case "A":
      return "mint";
    case "B":
      return "blue";
    case "D":
      return "violet";
    default:
      return "amber";
  }
}

/**
 * DST-Q: the belief interval is what the finding's evidence actually supports, so
 * it is always shown next to the point estimate rather than instead of it.
 */
export function dstReadout(row: Pick<RankedAction, "belief" | "plausibility" | "conflictMass">): string | null {
  if (typeof row.belief !== "number") return null;
  const bel = Math.round(row.belief * 100);
  const pl = Math.round((row.plausibility ?? 0) * 100);
  const k = (row.conflictMass ?? 0).toFixed(2);
  return `Bel ${bel}% · Pl ${pl}% · K ${k}`;
}

export function dstNarrative(row: Pick<RankedAction, "belief" | "plausibility" | "conflictMass">): string {
  const k = row.conflictMass ?? 0;
  if (k >= 0.3) return "contested — the sources disagree and the conflict was retained rather than averaged away";
  if (typeof row.belief !== "number" || row.belief < 0.55) return "weak — one source, or thin evidence";
  return "corroborated — the fused sources support this action";
}

/** The posture word alone, for a heading. The numbers go in the detail line. */
export function dstPosture(row: Pick<RankedAction, "belief" | "plausibility" | "conflictMass">): string {
  const k = row.conflictMass ?? 0;
  if (k >= 0.3) return "Evidence: contested";
  if (typeof row.belief !== "number" || row.belief < 0.55) return "Evidence: weak";
  return "Evidence: corroborated";
}

/** One-line, honest explanation of an empty board. */
export function emptyBoardReason(payload: RankedActionsPayload | undefined): string {
  if (!payload) return "This response carries no action board.";
  if (payload.suppressed > 0 && payload.actionable === 0) {
    return `All ${payload.suppressed} finding(s) were in band, guardrail-blocked or deliberately no-action. Nothing to rank — and nothing was suppressed silently.`;
  }
  if (payload.actionable > 0) {
    return `${payload.actionable} finding(s) named an action, but none survived ranking (see the diagnostics below).`;
  }
  return "No findings were produced for this fleet.";
}

/* ======================================================================
 * The fleet board — every pack's actions in ONE ranked list
 * ====================================================================== */

/** Where each pack publishes its board. The exec view ids differ (`vascular-access`),
 *  so the route is named explicitly rather than derived from the nav id. */
export const PROTOCOL_ACTION_SOURCES: ReadonlyArray<{ protocol: string; label: string; path: string }> = [
  { protocol: "adequacy", label: "Adequacy & Kt/V", path: "/admin/swarm/adequacy/state" },
  { protocol: "fluid", label: "Fluid & IDH", path: "/admin/swarm/fluid/state" },
  { protocol: "access", label: "Vascular access", path: "/admin/swarm/access/state" },
  { protocol: "anemia", label: "Anemia & ESA", path: "/admin/swarm/anemia/state" },
  { protocol: "mbd", label: "CKD-MBD", path: "/admin/swarm/mbd/state" },
  { protocol: "nutrition", label: "Nutrition & electrolytes", path: "/admin/swarm/nutrition/state" },
  { protocol: "infection", label: "Infection & vaccination", path: "/admin/swarm/infection/state" },
];

/** What one pack contributed. A pack that failed reports `ok: false` — the board
 *  says so rather than showing a confident zero. */
export interface ProtocolActionSource {
  protocol: string;
  label: string;
  ok: boolean;
  error?: string;
  ranked: number;
  /** Findings that named a real action, before the allowlist ran. */
  actionable: number;
  considered: number;
  suppressed: number;
  kinds: string[];
  unmapped: string[];
  rejected: Array<{ title: string; actionKind: string; cells: string[] }>;
}

export type FleetRankedAction = RankedAction & { protocol: string; protocolLabel: string };

export interface FleetActionBoard {
  actions: FleetRankedAction[];
  totals: { ranked: number; considered: number; actionable: number; suppressed: number; packs: number; reporting: number };
  kinds: string[];
  sources: ProtocolActionSource[];
}

export function assembleFleetBoard(actions: readonly FleetRankedAction[], sources: readonly ProtocolActionSource[]): FleetActionBoard {
  const sorted = [...actions].sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return {
    actions: sorted,
    totals: {
      ranked: sorted.length,
      considered: sources.reduce((sum, source) => sum + source.considered, 0),
      actionable: sources.reduce((sum, source) => sum + source.actionable, 0),
      suppressed: sources.reduce((sum, source) => sum + source.suppressed, 0),
      packs: PROTOCOL_ACTION_SOURCES.length,
      reporting: sources.filter((source) => source.ok).length,
    },
    kinds: [...new Set(sources.flatMap((source) => source.kinds))].sort(),
    sources: [...sources],
  };
}

/**
 * Read every pack's action board into one ranked list.
 *
 * SEQUENTIAL on purpose. Each `/state` route runs that pack's engine over the whole
 * cohort, and the server is single-threaded — firing all seven at once starves every
 * other request in the console. `onProgress` receives the merged board after EACH
 * pack, so the list fills in as answers land and a slow pack is visible instead of
 * hidden behind one spinner.
 *
 * The scores are comparable across packs (every pack uses the same belief-aware
 * ranker with the same weights), but the VALUE claims are not: one pack's unit is
 * treatments, another's is lab results. Compare score, then read each row's unit.
 */
export async function fetchFleetActions(
  onProgress?: (board: FleetActionBoard) => void,
  signal?: AbortSignal,
): Promise<FleetActionBoard> {
  const actions: FleetRankedAction[] = [];
  const sources: ProtocolActionSource[] = [];
  for (const entry of PROTOCOL_ACTION_SOURCES) {
    try {
      const response = await fetch(entry.path, { signal, headers: { accept: "application/json" } });
      const body = await responseOrThrow<{ actions?: unknown }>(entry.path, response);
      const payload = asActionsPayload(body.actions);
      if (!payload) throw new Error("the pack returned no action board");
      sources.push({
        protocol: entry.protocol,
        label: entry.label,
        ok: true,
        ranked: payload.nbas.length,
        actionable: payload.actionable,
        considered: payload.considered,
        suppressed: payload.suppressed,
        kinds: payload.kinds,
        unmapped: payload.unmapped,
        rejected: payload.rejected,
      });
      for (const row of payload.nbas) {
        actions.push({ ...row, protocol: entry.protocol, protocolLabel: entry.label });
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      sources.push({
        protocol: entry.protocol,
        label: entry.label,
        ok: false,
        error: error instanceof Error ? error.message : "request failed",
        ranked: 0,
        actionable: 0,
        considered: 0,
        suppressed: 0,
        kinds: [],
        unmapped: [],
        rejected: [],
      });
    }
    onProgress?.(assembleFleetBoard(actions, sources));
  }
  return assembleFleetBoard(actions, sources);
}
