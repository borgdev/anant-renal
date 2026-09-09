/******************************************************************************
 * DST-Q #1 — belief-aware My Work.
 *
 * The work queue is role-scoped and server-assembled; this module gives that
 * queue a Dempster–Shafer conscience:
 *
 *  1. For every evidence-driven item (outcome episodes) we read out the fused
 *     belief interval — Bel / Pl / K — computed over the episode's real
 *     evidence (via the same `fuseEpisodeEvidence` used by the coordinator,
 *     so the readout is always grounded, never cosmetic).
 *  2. Each episode is given a belief-aware decision priority in [0,1]:
 *        score = Bel + λ·(Pl − Bel) − γ·Pl(harm)
 *     where the harm plausibility is driven by how much the evidence is
 *     contested/weak plus half of the uncommitted ignorance. This mirrors the
 *     decision-theoretic score used for NBAs (see `scoreCandidateBeliefAware`)
 *     so a clinician sees one consistent "how sure are we, and how risky"
 *     signal everywhere.
 *  3. Within an urgency tier, scored items sort by descending priority before
 *     unscored items (reviews/releases/DLQ fall back to recency). The queue
 *     therefore surfaces the highest-commitment, lowest-conflict decisions
 *     first instead of pure FIFO.
 ******************************************************************************/

import {
  fuseEpisodeEvidence,
  DST_EPISODE_K_GATE,
  DST_RESOLVE_BELIEF_GATE,
  type OutcomeEpisode,
  type EpisodeEvidenceFusion,
} from './outcome-episode.js';

/** Optimism weight λ applied to ignorance (Pl − Bel). Default 0.3. */
export const DST_WORK_OPTIMISM = 0.3;
/** Harm-avoidance weight γ applied to Pl(harm). Default 0.5. */
export const DST_WORK_HARM_GAMMA = 0.5;

export type QueueUrgency = 'high' | 'medium' | 'low';
export type QueueEvidenceStatus = 'corroborated' | 'weak' | 'contested' | undefined;

export interface EpisodeDstReadout {
  belief: number;
  plausibility: number;
  uncertainty: number;
  conflictMass: number;
  evidenceStatus: QueueEvidenceStatus;
  /** Belief-aware decision priority in [0,1] (Bel + λ·unc − γ·Pl(harm)). */
  score: number;
}

/** Structural slice of a work item needed by the D-S comparator. */
export interface DstQueueItem {
  urgency: QueueUrgency;
  at: string;
  dstPriority?: number;
}

const round = (n: number): number => Math.round(n * 1000) / 1000;

/** Evidence posture straight from the fused conflict/belief gates. */
export function evidenceStatusFromFusion(fusion: EpisodeEvidenceFusion): QueueEvidenceStatus {
  if (fusion.conflictMass >= DST_EPISODE_K_GATE) return 'contested';
  if (fusion.belief >= DST_RESOLVE_BELIEF_GATE) return 'corroborated';
  return 'weak';
}

/** A bounded plausibility-of-harm estimate from evidence posture + ignorance. */
function evidencePlHarm(status: QueueEvidenceStatus, uncertainty: number): number {
  const contestedOffset = status === 'contested' ? 0.4 : status === 'weak' ? 0.2 : status === 'corroborated' ? 0.1 : 0;
  return Math.min(1, contestedOffset + uncertainty * 0.5);
}

/**
 * The shared belief-aware decision priority rule (used by episodes and by the
 * anemia suggestion readout): Bel + λ·(Pl − Bel) − γ·Pl(harm), clamped to [0,1].
 */
export function dstPriorityFromFusion(fusion: EpisodeEvidenceFusion, status: QueueEvidenceStatus): number {
  const uncertainty = Math.max(0, fusion.plausibility - fusion.belief);
  const plHarm = evidencePlHarm(status, uncertainty);
  return round(Math.max(0, Math.min(1, fusion.belief + DST_WORK_OPTIMISM * uncertainty - DST_WORK_HARM_GAMMA * plHarm)));
}

/**
 * Dempster–Shafer readout for an outcome episode.
 *
 * Prefers the fusion the coordinator already computed (`evidenceFusion`); when
 * an episode somehow lacks one but carries evidence, recomputes it on the fly
 * so the queue is never empty of belief. Returns undefined only when there is
 * no evidence at all (episodes with no evidence have no belief to show).
 */
export function episodeDstReadout(e: OutcomeEpisode): EpisodeDstReadout | undefined {
  const evidence = e.evidence ?? [];
  const fusion = e.evidenceFusion ?? (evidence.length > 0 ? fuseEpisodeEvidence(evidence) : undefined);
  if (!fusion) return undefined;
  const belief = round(fusion.belief);
  const plausibility = round(fusion.plausibility);
  const conflictMass = round(fusion.conflictMass);
  const uncertainty = round(Math.max(0, plausibility - belief));
  const status: QueueEvidenceStatus = e.evidenceStatus ?? evidenceStatusFromFusion(fusion);
  const score = dstPriorityFromFusion(fusion, status);
  return { belief, plausibility, uncertainty, conflictMass, evidenceStatus: status, score };
}

const URGENCY_RANK: Record<QueueUrgency, number> = { high: 0, medium: 1, low: 2 };

/**
 * Comparator for the My Work queue.
 *
 * Urgency is the primary tier. Within a tier, belief-aware (scored) items come
 * first ordered by descending D-S priority; unscored items fall back to recency.
 */
export function compareDstQueue(a: DstQueueItem, b: DstQueueItem): number {
  const byUrgency = URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency];
  if (byUrgency !== 0) return byUrgency;
  const aScored = a.dstPriority !== undefined;
  const bScored = b.dstPriority !== undefined;
  if (aScored !== bScored) return aScored ? -1 : 1;
  if (aScored && bScored && a.dstPriority !== b.dstPriority) {
    return (b.dstPriority ?? 0) - (a.dstPriority ?? 0);
  }
  return String(b.at).localeCompare(String(a.at));
}
