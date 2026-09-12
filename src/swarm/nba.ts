/******************************************************************************
 * Next-best actions (NBA) — the optimization layer over swarm insights.
 *
 * Cells generate candidate interventions; this module ranks them deterministically
 * by f(outcome, urgency, value, evidence, consensus, policy, cost, risk). The
 * ranking is ADVISORY — the server re-checks role, scope and approval class
 * before any durable command is created (see outcome-episode.ts).
 ******************************************************************************/

import { createHash } from 'node:crypto';
import { DST_K_GATE } from './insight.js';
import type { SwarmInsight } from './insight.js';
import { formatActionValue, normaliseValue, actionLabel, type ActionValueUnit } from './actions.js';
import { SWARM_CELLS } from './cells.js';
import type { ApprovalClass, EvidenceRef, ScopeType, WorldEffectKind } from './types.js';

export type NbaStatus = 'proposed' | 'awaiting-approval' | 'approved' | 'executed' | 'dismissed';

/** The concrete action an NBA proposes — a governed `WorldEffectKind`, never a
 *  free-text headline. The cell that proposes it must allow the kind. */
export interface NbaAction {
  kind: WorldEffectKind;
  /** Subject the action would be dispatched against (defaults to `subject`). */
  target?: string;
  payload?: Record<string, unknown>;
}

/** cellId → allowed action kinds. Callers with their own cell manifests (the
 *  protocol packs) MUST pass theirs so the allowlist is verified there too. */
export type CellAllowlist = Record<string, WorldEffectKind[]>;

const DEFAULT_ALLOWLIST: CellAllowlist = Object.fromEntries(
  SWARM_CELLS.map((c) => [c.id, c.killSwitch ? [] : c.allowedActions]),
);

/**
 * The decision trajectory that travels WITH a recommendation.
 *
 * A single number ("increase to 10,000 units/week") asks a clinician to trust a
 * conclusion they cannot see. The candidate curve is the same analysis the engine
 * already performed, carried alongside it: what each dose does to Hb over the
 * horizon, which candidate the controller chose, and where the target band sits.
 * It is attached at ranking time so no console recomputes it — a re-derivation
 * could disagree with the number being approved, and then two "truths" exist.
 */
export interface NbaTrajectoryPoint {
  /** The weekly dose this point represents. `0` is a hold. */
  dose: number;
  label: string;
  endHgb: number;
  peakHgb: number;
  weeksInBand: number;
  pctInBand: number;
  projectedCostUsd: number;
}

export interface NbaTrajectory {
  horizonWeeks: number;
  currentHgb: number;
  currentDose: number;
  /** The clinical target band the curve is judged against. */
  targetBand: { min: number; max: number };
  /** Index into `points` of the candidate the engine recommends, when there is one. */
  chosenIndex: number | null;
  points: NbaTrajectoryPoint[];
  note: string;
  /**
   * Why there is no curve, when there is none (a guardrail blocked the analysis).
   * An absent trajectory must say why, or "no curve" is indistinguishable from a
   * rendering bug.
   */
  unavailableReason?: string;
}

export interface NbaCandidate {
  title: string;
  cells: string[];
  scopeType: ScopeType;
  subject: string;
  owner: string;
  due: string;
  evidence: EvidenceRef[];
  /** What to DO — the governed action (required; `action.kind` is checked
   *  against the proposing cell's `allowedActions` allowlist before ranking). */
  action: NbaAction;
  /** The decision curve behind the recommendation, when the pack computed one. */
  trajectory?: NbaTrajectory;
  /** The denomination of the value claim below. Without it a number has no
   *  meaning and downstream code invents one (the console once multiplied a
   *  signal count by 1000 and called it dollars). */
  valueUnit: ActionValueUnit;
  consensus: number;      // 0..1
  approvalClass: ApprovalClass;
  /** Positive value in `valueUnit`. */
  expectedOutcome: number;
  urgency: number;         // 0..1
  policyCost: number;      // 0..1 (higher = more policy/approval friction)
  risk: number;            // 0..1
  /** P2 — belief interval of the source insight (when known). */
  belief?: number;
  plausibility?: number;
  conflictMass?: number;
  /** P2 — which insight kind supplies the belief interval (for matching). */
  insightKind?: string;
}

export interface NextBestAction extends NbaCandidate {
  nbaId: string;
  rank: number;
  evidenceCount: number;
  /** Denormalised for clients: `action.kind`, its label and the formatted value
   *  (`"20 treatments"` / `"$3.4M"`) so no consumer re-interprets the number. */
  actionKind: WorldEffectKind;
  actionLabel: string;
  valueLabel: string;
  score: number;
  status: NbaStatus;
  rankedAt: string;
}

export interface NbaRankingDiagnostics {
  /** Candidates dropped because their action is outside the proposing cell's allowlist. */
  rejected: { title: string; actionKind: string; cells: string[] }[];
  /** Candidates whose cells are not in the supplied allowlist (boundary unverified). */
  unverified: { title: string; cells: string[] }[];
}

export interface NbaRankingResult {
  nbas: NextBestAction[];
  diagnostics: NbaRankingDiagnostics;
}

export interface NbaRankingOptions {
  /** Weight vector; defaults to outcome/urgency/consensus/evidence minus risk/policyCost. */
  weights?: { outcome?: number; urgency?: number; consensus?: number; evidence?: number; belief?: number; risk?: number; policyCost?: number };
  /** Policy filter — NBAs above this policyCost are held for review (never auto-approved). */
  maxPolicyCost?: number;
  /** Cap the number of ranked NBAs returned. */
  limit?: number;
  /** cellId → allowed action kinds. Defaults to the renal `SWARM_CELLS`; packs
   *  with their own manifests must pass theirs or the boundary is unverified. */
  allowlist?: CellAllowlist;
  /** P2 — rank by decision-theoretic expected value over the belief interval (Bel + λ·(Pl−Bel) − γ·Pl(harm)). */
  beliefAware?: boolean;
  /** P2 — optimism weight λ applied to ignorance (Pl − Bel). Default 0.3. */
  optimismLambda?: number;
  /** P2 — harm-avoidance weight γ applied to Pl(adverse). Default 0.5. */
  harmGamma?: number;
  /** P2 — harm-plausibility gate ε: above it the NBA requires approval. Default 0.6. */
  harmGate?: number;
}

export function scoreCandidate(c: NbaCandidate, w: NonNullable<NbaRankingOptions['weights']>): number {
  const evidence = Math.min(c.evidence.length / 20, 1); // saturate at 20 evidence objects
  const outcome = normaliseValue(c.valueUnit, c.expectedOutcome);
  return (
    (w.outcome ?? 0.4) * outcome +
    (w.urgency ?? 0.2) * c.urgency +
    (w.consensus ?? 0.2) * c.consensus +
    (w.evidence ?? 0.1) * evidence -
    (w.risk ?? 0.15) * c.risk -
    (w.policyCost ?? 0.15) * c.policyCost
  );
}

/** Best-known belief interval for a candidate (falls back to a point consensus mass). */
export function beliefInterval(c: NbaCandidate): { belief: number; plausibility: number; uncertainty: number } {
  const beliefVal = typeof c.belief === 'number' ? c.belief : c.consensus;
  const plausibilityVal = typeof c.plausibility === 'number' ? c.plausibility : beliefVal;
  return { belief: beliefVal, plausibility: plausibilityVal, uncertainty: Math.max(0, plausibilityVal - beliefVal) };
}

/** P2 — plausibility that the option harms: realized risk + half the uncommitted ignorance. */
export function plausibilityOfHarm(c: NbaCandidate): number {
  const { uncertainty } = beliefInterval(c);
  return Math.min(1, (c.risk ?? 0) + uncertainty * 0.5);
}

/** P2 — decision-theoretic score over the belief interval:
 *  Bel(good) + λ·(Pl − Bel) − γ·Pl(harm), combined with the value/urgency features. */
export function scoreCandidateBeliefAware(
  c: NbaCandidate,
  w: NonNullable<NbaRankingOptions['weights']>,
  lambda: number,
  gamma: number,
): number {
  const { belief: bel, plausibility: pl } = beliefInterval(c);
  const uncertainty = pl - bel;
  const plHarm = plausibilityOfHarm(c);
  const outcome = normaliseValue(c.valueUnit, c.expectedOutcome);
  return (
    (w.outcome ?? 0.4) * outcome +
    (w.urgency ?? 0.2) * c.urgency +
    (w.belief ?? 0.4) * (bel + lambda * uncertainty - gamma * plHarm)
  );
}

/** P2 — attach the belief interval from the best-matching swarm insight (same subject + kind). */
export function attachInsightBelief(candidates: NbaCandidate[], insights: SwarmInsight[]): NbaCandidate[] {
  return candidates.map((c) => {
    const match = insights.find(
      (i) => i.subject === c.subject && (c.insightKind === undefined || i.kind === c.insightKind),
    );
    if (!match || typeof match.belief !== 'number') return c;
    return {
      ...c,
      ...(typeof match.belief === 'number' ? { belief: match.belief } : {}),
      ...(typeof match.plausibility === 'number' ? { plausibility: match.plausibility } : {}),
      ...(typeof match.conflictMass === 'number' ? { conflictMass: match.conflictMass } : {}),
    };
  });
}

/** Rank candidates, returning the list plus the allowlist diagnostics. Prefer
 *  this over `rankNextBestActions` wherever the boundary should be observable. */
export function rankNextBestActionsDetailed(
  candidates: NbaCandidate[],
  opts: NbaRankingOptions = {},
): NbaRankingResult {
  const w = opts.weights ?? {};
  const maxPolicyCost = opts.maxPolicyCost ?? 0.75;
  const limit = opts.limit ?? 10;
  const beliefAware = opts.beliefAware ?? false;
  const lambda = opts.optimismLambda ?? 0.3;
  const gamma = opts.harmGamma ?? 0.5;
  const harmGate = opts.harmGate ?? 0.6;
  const allowlist = opts.allowlist ?? DEFAULT_ALLOWLIST;

  // Bounded intelligence: an NBA may only propose an action one of its own cells
  // is allowed to perform. A candidate whose cells are unknown to the allowlist
  // is reported rather than silently accepted.
  const diagnostics: NbaRankingDiagnostics = { rejected: [], unverified: [] };
  const permitted = candidates.filter((c) => {
    if (c.cells.some((id) => (allowlist[id] ?? []).includes(c.action.kind))) return true;
    if (c.cells.every((id) => !(id in allowlist))) {
      diagnostics.unverified.push({ title: c.title, cells: c.cells });
      return true;
    }
    diagnostics.rejected.push({ title: c.title, actionKind: c.action.kind, cells: c.cells });
    return false;
  });

  const ranked = permitted
    .map((c) => ({
      ...c,
      // Id is derived from the identity of the action, NOT its index, so a
      // durable decision on it survives the candidate list being reordered.
      nbaId: `nba-${createHash('sha256').update(`${c.subject}|${c.scopeType}|${c.action.kind}|${c.title}`).digest('hex').slice(0, 8)}`,
      rank: 0,
      evidenceCount: c.evidence.length,
      actionKind: c.action.kind,
      actionLabel: actionLabel(c.action.kind),
      valueLabel: formatActionValue(c.valueUnit, c.expectedOutcome),
      score: beliefAware ? scoreCandidateBeliefAware(c, w, lambda, gamma) : scoreCandidate(c, w),
      status: ('proposed' as NbaStatus),
      rankedAt: new Date().toISOString(),
    }))
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, limit)
    .map((n, i) => {
      // P2 — approval is required for policy friction OR worst-case harm OR fused conflict.
      const approvalRequired = beliefAware
        ? n.policyCost > maxPolicyCost || plausibilityOfHarm(n) > harmGate || (n.conflictMass ?? 0) >= DST_K_GATE
        : n.policyCost > maxPolicyCost;
      return { ...n, rank: i + 1, status: (approvalRequired ? 'awaiting-approval' : 'proposed') as NbaStatus };
    });
  return { nbas: ranked, diagnostics };
}

export function rankNextBestActions(candidates: NbaCandidate[], opts: NbaRankingOptions = {}): NextBestAction[] {
  return rankNextBestActionsDetailed(candidates, opts).nbas;
}

/** A stable placeholder for building candidates. */
export function candidateId(c: NbaCandidate): string {
  return createHash('sha256').update(JSON.stringify(c)).digest('hex').slice(0, 8);
}
