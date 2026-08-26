/******************************************************************************
 * Swarm insights — cross-domain evidence convergence.
 *
 * Cells publish typed CellProposal objects. The harness aggregates them into a
 * SwarmInsight that PRESERVES each cell's contribution, records conflicts
 * (cells proposing incompatible options for the same subject) and abstentions
 * (cells that consumed the signal but produced nothing), and reports the
 * consensus as a fraction of the cells that observed the signal. Conflicts are
 * retained, never dropped — "no autonomous action".
 ******************************************************************************/

import { createHash, randomUUID } from 'node:crypto';
import { cellById } from './cells.js';
import { belief, discount, frameOf, fuse, plausibility, singleton, uncertainty, vacuous, type Mass } from '../evidence/dempster.js';
import { reliabilityBySource, type ReviewStatus } from '../evidence/reliability.js';
import type { ApprovalClass, EvidenceRef, ReviewKind, ScopeType } from './types.js';

export interface CellProposal {
  proposalId: string;
  cellId: string;
  /** Proposal kind, e.g. 'continuity.proposal', 'coverage.proposal'. */
  kind: string;
  subject: string;
  scopeType: ScopeType;
  /** The concrete option this cell supports (for consensus/conflict grouping). */
  option: string;
  recommendation: string;
  /** Whether the proposal's implied action is within the cell's allowlist. */
  allowed: boolean;
  evidence: EvidenceRef[];
  producedAt: string;
  payload: Record<string, unknown>;
  /** Required action class for the proposal's implied action (spec §14.3). */
  approvalClass?: ApprovalClass;
}

export interface SwarmInsight {
  insightId: string;
  kind: string;
  headline: string;
  summary: string;
  subject: string;
  scopeType: ScopeType;
  /** Cells that contributed a proposal to the winning option. */
  cells: string[];
  /** 0..1 — winning-option support over all cells that consumed the signal. */
  consensus: number;
  /** Cells that proposed a different option for the same subject. */
  conflicts: string[];
  /** Cells that consumed the signal but produced nothing. */
  abstentions: string[];
  /** Total evidence objects across contributing proposals. */
  evidenceCount: number;
  review: ReviewKind;
  /** Maximum approval class among contributing cells. */
  approvalClass: ApprovalClass;
  retained: boolean;
  /** DST belief in the winning option (0..1) — evidence committed to it (P0 overlay). */
  belief?: number;
  /** DST plausibility of the winning option (0..1) — best case allowed by evidence. */
  plausibility?: number;
  /** DST uncertainty = plausibility − belief (0..1). */
  uncertainty?: number;
  /** DST conflict mass K from fusing the cells' evidence (0..1). */
  conflictMass?: number;
  /** P3 — mean reliability discount applied to the cells' evidence (0..1). */
  avgReliability?: number;
  /** P4 — provenance: per-source masses + the fused mass vector (decomposable). */
  evidenceFusion?: {
    sources: { cellId: string; option: string; weight: number; alpha: number }[];
    massVector: Record<string, number>;
    conflictMass: number;
    belief: number;
    plausibility: number;
  };
  producedAt: string;
  /** Payload of the winning proposal (e.g. { treatments, chairHours }). */
  payload: Record<string, unknown>;
}

export type SwarmAggregationMode = 'simple' | 'dst';

/** DST retain gate — retain (no autonomous action) when conflict mass ≥ this. */
export const DST_K_GATE = 0.3;
/** DST retain gate — retain when a non-winning option's plausibility exceeds this. */
export const DST_DISSENT_PL_GATE = 0.6;

export interface InsightAggregationInput {
  proposals: CellProposal[];
  /** signalKey (`kind`) → cell ids that consumed/observed it (for abstention). */
  consumedBy: Record<string, string[]>;
  /** 'simple' = legacy consensus; 'dst' = Dempster–Shafer belief + K-gated retain. */
  mode?: SwarmAggregationMode;
  /** P3 — evidence-review status per source id (confirmed/rejected) → reliability. */
  reviews?: Record<string, ReviewStatus>;
  /** P3 — injectable reliability resolver (defaults to reliabilityBySource). */
  getReliability?: (sourceId: string, reviewStatus?: ReviewStatus) => number;
}

function sig(subject: string, kind: string): string {
  return createHash('sha256').update(`${subject}|${kind}`).digest('hex').slice(0, 12);
}

function reviewFor(approvalClass: ApprovalClass): ReviewKind {
  if (approvalClass === 'D') return 'dual';
  if (approvalClass === 'C') return 'clinical';
  if (approvalClass === 'B') return 'operator';
  return 'none';
}

/**
 * Aggregate proposals into swarm insights.
 * - Proposals for the same (subject, kind) are grouped.
 * - The winning option is the one with the most supporting cells.
 * - consensus = supporting cells / observed cells (observed = union of consumed
 *   and contributing cells for that kind, scoped to this subject).
 * - conflicts = cells proposing a different option; abstentions = observed but silent.
 */
export function aggregateSwarmInsights(input: InsightAggregationInput): SwarmInsight[] {
  const { proposals, consumedBy, mode = 'simple' } = input;
  const bySig = new Map<string, CellProposal[]>();
  for (const p of proposals) {
    const k = sig(p.subject, p.kind);
    const arr = bySig.get(k) ?? [];
    arr.push(p);
    bySig.set(k, arr);
  }
  const insights: SwarmInsight[] = [];
  for (const [k, group] of bySig) {
    // Winning option = most supporting cells (deterministic tie-break by option).
    const byOption = new Map<string, CellProposal[]>();
    for (const p of group) {
      const arr = byOption.get(p.option) ?? [];
      arr.push(p);
      byOption.set(p.option, arr);
    }
    const options = [...byOption.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
    const [winningOption, supporters] = options[0] ?? ['', []];
    const contributing = new Set(group.map((p) => p.cellId));
    const observed = new Set<string>((consumedBy[group[0]!.kind] ?? []).filter((c) => !contributing.has(c)));
    for (const c of contributing) observed.add(c);
    const conflictCells = options
      .filter(([opt]) => opt !== winningOption)
      .flatMap(([, arr]) => arr.map((p) => p.cellId))
      .filter((c, i, a) => a.indexOf(c) === i);
    const abstentions = [...observed].filter((c) => !contributing.has(c)).sort();
    const consensus = observed.size > 0 ? supporters.length / observed.size : supporters.length > 0 ? 1 : 0;
    // ---- Dempster–Shafer overlay: fuse each cell's evidence (P0 always computed;
    // P1: abstention → vacuous mass (neutral, never opposing) + K-gated retain;
    // P3: evidence discounted by source reliability; P4: provenance kept per source).
    const dst = fuseInsightEvidence(group, abstentions, winningOption, input.reviews, input.getReliability);
    const retained = mode === 'dst'
      ? dst.conflictMass >= DST_K_GATE || dst.dissentPlausibility > DST_DISSENT_PL_GATE
      : conflictCells.length > 0;
    const evidenceCount = group.reduce((n, p) => n + p.evidence.length, 0);
    const approvalClass: ApprovalClass = group.reduce<ApprovalClass>(
      (hi, p) => {
        const cls = cellById(p.cellId)?.approvalClass ?? 'B'; // unknown cell → default B, never crash
        return cls > hi ? cls : hi;
      },
      'A',
    );
    const first = group[0]!;
    const headline = supporters.length > 1
      ? `${winningOption} — ${supporters.length} cells converge`
      : `${winningOption} — single-cell proposal`;
    insights.push({
      insightId: `ins-${k}`,
      kind: first.kind,
      headline,
      summary: first.recommendation,
      subject: first.subject,
      scopeType: first.scopeType,
      cells: supporters.map((p) => p.cellId),
      consensus: Math.round(consensus * 100) / 100,
      conflicts: conflictCells,
      abstentions,
      evidenceCount,
      review: reviewFor(approvalClass),
      approvalClass,
      retained,
      belief: dst.belief,
      plausibility: dst.plausibility,
      uncertainty: dst.uncertainty,
      conflictMass: dst.conflictMass,
      avgReliability: dst.avgReliability,
      evidenceFusion: {
        sources: dst.sources,
        massVector: dst.massVector,
        conflictMass: dst.conflictMass,
        belief: dst.belief,
        plausibility: dst.plausibility,
      },
      producedAt: group.map((p) => p.producedAt).sort().at(-1) ?? new Date().toISOString(),      payload: supporters[0]?.payload ?? {},    });
  }
  return insights.sort((a, b) => b.consensus - a.consensus || a.subject.localeCompare(b.subject));
}

interface InsightFusion {
  belief: number;
  plausibility: number;
  uncertainty: number;
  conflictMass: number;
  dissentPlausibility: number;
  avgReliability: number;
  sources: { cellId: string; option: string; weight: number; alpha: number }[];
  massVector: Record<string, number>;
}

/** A cell's evidence → DST mass: weight on its option, remainder to ignorance,
 *  discounted by the source reliability α (P3). Heuristic (interpretable):
 *  0.30 + 0.17 per evidence object, saturating at three → 0.80. Low-evidence
 *  or low-reliability cells carry mostly ignorance, never hard votes. */
function proposalMass(p: CellProposal, alpha: number): Mass {
  const weight = Math.min(0.8, 0.3 + 0.17 * Math.min(p.evidence.length, 3));
  return discount(singleton(p.option, weight), alpha);
}

function reliabilityOf(p: CellProposal, reviews?: Record<string, ReviewStatus>, getReliability?: (sourceId: string, reviewStatus?: ReviewStatus) => number): number {
  const alphas = p.evidence.map((e) =>
    getReliability ? getReliability(e.sourceId, reviews?.[e.sourceId]) : reliabilityBySource(e.sourceId, reviews?.[e.sourceId]));
  if (alphas.length > 0) return alphas.reduce((a, b) => a + b, 0) / alphas.length;
  return getReliability ? getReliability('', undefined) : reliabilityBySource('', undefined);
}

/** Fuse a group's cell proposals (+ vacuous abstentions) via Dempster–Shafer. */
function fuseInsightEvidence(
  group: CellProposal[],
  abstentions: string[],
  winningOption: string,
  reviews?: Record<string, ReviewStatus>,
  getReliability?: (sourceId: string, reviewStatus?: ReviewStatus) => number,
): InsightFusion {
  const srcMasses: Mass[] = [];
  const sources: InsightFusion['sources'] = [];
  let alphaSum = 0;
  for (const p of group) {
    const alpha = reliabilityOf(p, reviews, getReliability);
    const weight = Math.min(0.8, 0.3 + 0.17 * Math.min(p.evidence.length, 3));
    srcMasses.push(proposalMass(p, alpha));
    sources.push({ cellId: p.cellId, option: p.option, weight, alpha: Math.round(alpha * 1000) / 1000 });
    alphaSum += alpha;
  }
  for (const _c of abstentions) srcMasses.push(vacuous()); // abstention = ignorance (neutral)
  const avgReliability = group.length > 0 ? Math.round((alphaSum / group.length) * 1000) / 1000 : 0;
  const frame = frameOf(srcMasses);
  // A latent complement hypothesis ("some option we haven't enumerated") keeps
  // ignorance honest: unanimous cells show Bel < 1 instead of Θ collapsing into
  // the sole proposed option's belief.
  frame.add('__other__');
  const { mass, k, degenerate } = fuse(srcMasses);
  const win = new Set([winningOption]);
  const b = belief(mass, frame, win);
  const pl = plausibility(mass, frame, win);
  const un = uncertainty(mass, frame, win);
  let dissentPl = 0;
  for (const p of group) {
    if (p.option === winningOption) continue;
    dissentPl = Math.max(dissentPl, plausibility(mass, frame, new Set([p.option])));
  }
  return {
    belief: Math.round(b * 1000) / 1000,
    plausibility: Math.round(pl * 1000) / 1000,
    uncertainty: Math.round(un * 1000) / 1000,
    conflictMass: degenerate ? 1 : Math.round(k * 1000) / 1000,
    dissentPlausibility: Math.round(dissentPl * 1000) / 1000,
    avgReliability,
    sources,
    massVector: Object.fromEntries([...mass.entries()].map(([key, v]) => [key, Math.round(v * 1000) / 1000])),
  };
}

/** Build a CellProposal with a stable id. */
export function makeProposal(input: Omit<CellProposal, 'proposalId'>): CellProposal {
  return { ...input, proposalId: `prop-${randomUUID().slice(0, 8)}` };
}
