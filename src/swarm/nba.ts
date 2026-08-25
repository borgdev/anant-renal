/******************************************************************************
 * Next-best actions (NBA) — the optimization layer over swarm insights.
 *
 * Cells generate candidate interventions; this module ranks them deterministically
 * by f(outcome, urgency, value, evidence, consensus, policy, cost, risk). The
 * ranking is ADVISORY — the server re-checks role, scope and approval class
 * before any durable command is created (see outcome-episode.ts).
 ******************************************************************************/

import { createHash, randomUUID } from 'node:crypto';
import { DST_K_GATE } from './insight.js';
import type { SwarmInsight } from './insight.js';
import type { ApprovalClass, EvidenceRef, ScopeType } from './types.js';

export type NbaStatus = 'proposed' | 'awaiting-approval' | 'approved' | 'executed' | 'dismissed';

export interface NbaCandidate {
  title: string;
  cells: string[];
  scopeType: ScopeType;
  subject: string;
  owner: string;
  due: string;
  evidence: EvidenceRef[];
  consensus: number;      // 0..1
  approvalClass: ApprovalClass;
  expectedOutcome: number; // positive value metric (e.g. treatments protected)
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
  score: number;
  status: NbaStatus;
  rankedAt: string;
}

export interface NbaRankingOptions {
  /** Weight vector; defaults to outcome/urgency/consensus/evidence minus risk/policyCost. */
  weights?: { outcome?: number; urgency?: number; consensus?: number; evidence?: number; belief?: number; risk?: number; policyCost?: number };
  /** Policy filter — NBAs above this policyCost are held for review (never auto-approved). */
  maxPolicyCost?: number;
  /** Cap the number of ranked NBAs returned. */
  limit?: number;
  /** P2 — rank by decision-theoretic expected value over the belief interval (Bel + λ·(Pl−Bel) − γ·Pl(harm)). */
  beliefAware?: boolean;
  /** P2 — optimism weight λ applied to ignorance (Pl − Bel). Default 0.3. */
  optimismLambda?: number;
  /** P2 — harm-avoidance weight γ applied to Pl(adverse). Default 0.5. */
  harmGamma?: number;
  /** P2 — divides expectedOutcome to normalize it to 0..1. Default 50. */
  outcomeCap?: number;
  /** P2 — harm-plausibility gate ε: above it the NBA requires approval. Default 0.6. */
  harmGate?: number;
}

export function scoreCandidate(c: NbaCandidate, w: NonNullable<NbaRankingOptions['weights']>): number {
  const evidence = Math.min(c.evidence.length / 20, 1); // saturate at 20 evidence objects
  return (
    (w.outcome ?? 0.4) * c.expectedOutcome +
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
  outcomeCap: number,
): number {
  const { belief: bel, plausibility: pl } = beliefInterval(c);
  const uncertainty = pl - bel;
  const plHarm = plausibilityOfHarm(c);
  const outcome = Math.min(1, c.expectedOutcome / outcomeCap);
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

export function rankNextBestActions(candidates: NbaCandidate[], opts: NbaRankingOptions = {}): NextBestAction[] {
  const w = opts.weights ?? {};
  const maxPolicyCost = opts.maxPolicyCost ?? 0.75;
  const limit = opts.limit ?? 10;
  const beliefAware = opts.beliefAware ?? false;
  const lambda = opts.optimismLambda ?? 0.3;
  const gamma = opts.harmGamma ?? 0.5;
  const outcomeCap = opts.outcomeCap ?? 50;
  const harmGate = opts.harmGate ?? 0.6;
  const ranked = candidates
    .map((c, i) => ({
      ...c,
      nbaId: `nba-${createHash('sha256').update(`${c.subject}|${c.title}|${i}`).digest('hex').slice(0, 8)}`,
      rank: 0,
      evidenceCount: c.evidence.length,
      score: beliefAware ? scoreCandidateBeliefAware(c, w, lambda, gamma, outcomeCap) : scoreCandidate(c, w),
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
  return ranked;
}

/** A stable placeholder for building candidates. */
export function candidateId(c: NbaCandidate): string {
  return createHash('sha256').update(JSON.stringify(c)).digest('hex').slice(0, 8);
}
