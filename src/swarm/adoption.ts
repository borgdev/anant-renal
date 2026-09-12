// Adoption metrics for the ranked-action loop — the numbers that say whether a
// clinician is actually living in this thing.
//
// The point of these metrics is NOT to produce a scoreboard. It is to answer three
// questions an owner asks after week one:
//
//   1. Are the rankings being answered at all, or ignored?      → verdict coverage
//   2. When they are refused, is it one systemic reason?        → dismissal clusters
//   3. Is work moving between people, or piling up on one?      → deferral / handoff share
//
// One metric the plan asks for is deliberately NOT computed. "Time to decision"
// needs the moment a ranked action first appeared in front of a human, and that
// moment is not recorded anywhere: the ranking is recomputed on every read, and an
// NBA carries no first-seen timestamp. A latency computed from the decision row's
// own `createdAt` would measure nothing but the clock — so it is reported as
// unavailable, with the reason, rather than as a number nobody should trust.
import type { NbaDecision } from './workspace.js';

/** Below this many decisions, a cluster is an observation, not a finding. */
export const ADOPTION_SAMPLE_FLOOR = 5;
/** Share of dismissals that must share a reason before it is called a pattern. */
export const ADOPTION_CLUSTER_SHARE = 0.6;

export interface RankedAdoptionVerdicts {
  approved: number;
  dismissed: number;
  deferred: number;
  'handed-off': number;
}

export interface ReasonCluster {
  /** The wording the clinician used most often for this signature. */
  reason: string;
  count: number;
  /** Every distinct wording folded into this cluster, so nothing is hidden by the fold. */
  variants: string[];
}

export interface RankedAdoption {
  /** Ranked actions published by the fleet right now. */
  ranked: number;
  /** Distinct actions that have ever received a human verdict. */
  decided: number;
  /** Of the actions published RIGHT NOW, how many already carry a verdict. */
  decidedOfRanked: number;
  /** `decidedOfRanked / ranked` as a percentage, or null when nothing is ranked. */
  coveragePct: number | null;
  verdicts: RankedAdoptionVerdicts;
  /** Dismissal reasons that appear more than once, most frequent first. */
  dismissalClusters: ReasonCluster[];
  /** Share of all verdicts, as percentages. Null when nothing has been decided. */
  approvalPct: number | null;
  dismissalPct: number | null;
  deferralPct: number | null;
  handoffPct: number | null;
  /** True when one reason dominates the dismissals (≥2 dismissals, ≥60% share). */
  concentrated: boolean;
  /** True when it dominates AND there is enough of a sample to act on. */
  clustered: boolean;
  timeToDecision: { available: false; reason: string };
  /** What a human should take from this, in words — never a bare number. */
  reading: string[];
}

const STOPWORDS = new Set(['the', 'a', 'an', 'is', 'was', 'are', 'for', 'of', 'to', 'in', 'on', 'at', 'it', 'this', 'that', 'and', 'or', 'not', 'no', 'too', 'already']);

/**
 * A wording-independent signature for a dismissal reason, so "iron panel missing"
 * and "missing iron panel" are one cluster rather than two. Returns '' for a
 * reason with no content words, which callers treat as "no usable reason".
 */
export function reasonSignature(reason: string): string {
  return reason
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .sort()
    .join(' ');
}

const pct = (n: number, of: number): number | null => (of === 0 ? null : Math.round((n / of) * 1000) / 10);

/** Cluster dismissals by signature, keeping every wording that fed each cluster. */
export function clusterDismissalReasons(decisions: readonly NbaDecision[]): ReasonCluster[] {
  const clusters = new Map<string, Map<string, number>>();
  for (const d of decisions) {
    if (d.decision !== 'dismissed') continue;
    const wording = d.reason?.trim() ?? '';
    const signature = reasonSignature(wording);
    if (signature === '') continue;
    const counts = clusters.get(signature) ?? new Map<string, number>();
    counts.set(wording, (counts.get(wording) ?? 0) + 1);
    clusters.set(signature, counts);
  }
  return [...clusters.values()]
    .map((counts) => {
      const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      const total = ranked.reduce((n, [, c]) => n + c, 0);
      // `count` is the whole cluster, not just the leading wording — the threshold
      // test is about how many dismissals share a MEANING, not a spelling.
      return { reason: ranked[0]![0], count: total, variants: ranked.map(([w]) => w) };
    })
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

/**
 * Fold the ranking and the decision ledger into the adoption reading.
 *
 * `ranked` is the CURRENT published set; `decisions` is the durable ledger. They
 * are reported separately on purpose: a high number of verdicts against actions
 * that are no longer being suggested is history, and reporting it as coverage
 * would flatter the coverage number.
 */
export function analyseRankedAdoption(
  ranked: readonly { nbaId: string }[],
  decisions: readonly NbaDecision[],
): RankedAdoption {
  const verdicts: RankedAdoptionVerdicts = { approved: 0, dismissed: 0, deferred: 0, 'handed-off': 0 };
  for (const d of decisions) verdicts[d.decision] += 1;

  const decidedIds = new Set(decisions.map((d) => d.nbaId));
  const decidedOfRanked = ranked.filter((n) => decidedIds.has(n.nbaId)).length;
  const decided = decidedIds.size;
  const coveragePct = pct(decidedOfRanked, ranked.length);

  const clusters = clusterDismissalReasons(decisions);
  const top = clusters[0];
  // Two different gates, because they answer two different questions:
  //   concentrated — do the dismissals we have all say the same thing? That is a
  //     property of the dismissals themselves and needs only TWO of them; one
  //     refusal is one person's opinion, not a pattern.
  //   clustered — is that concentration worth acting on? That also needs enough
  //     decisions to be a trend rather than a coincidence.
  const concentrated =
    top !== undefined && verdicts.dismissed >= 2 && top.count / verdicts.dismissed >= ADOPTION_CLUSTER_SHARE;
  const clustered = concentrated && decided >= ADOPTION_SAMPLE_FLOOR;

  const reading: string[] = [];
  if (ranked.length === 0) {
    reading.push('No ranked actions are published right now, so coverage says nothing either way.');
  } else if (decidedOfRanked === 0) {
    reading.push(`${ranked.length} action(s) ranked and none answered yet — the ranking is not being used, which is a finding about the surfacing, not about the ranking.`);
  } else {
    reading.push(`${decidedOfRanked} of ${ranked.length} ranked action(s) carry a verdict (${coveragePct}%).`);
  }
  if (decided < ADOPTION_SAMPLE_FLOOR && decided > 0) {
    reading.push(`${decided} verdict(s) recorded — below the ${ADOPTION_SAMPLE_FLOOR}-decision floor, so these are observations, not a trend.`);
  }
  if (clustered && top) {
    reading.push(`Dismissals concentrate on "${top.reason}" (${top.count} of ${verdicts.dismissed}) — that is a signal about the criterion, not about the clinician.`);
  } else if (concentrated && top) {
    // The signal is real but the sample is too small to call it a pattern, so it is
    // reported as an observation WITH its size instead of being withheld.
    reading.push(`Dismissals concentrate on "${top.reason}" (${top.count} of ${verdicts.dismissed}), but ${decided} decision(s) is below the ${ADOPTION_SAMPLE_FLOOR}-decision floor — an observation, not yet a finding.`);
  } else if (top && top.count >= 2) {
    reading.push(`"${top.reason}" recurs (${top.count} of ${verdicts.dismissed} dismissal(s)) but does not yet dominate — reported as an observation.`);
  }
  if (verdicts['handed-off'] > 0 || verdicts.deferred > 0) {
    reading.push(
      `${verdicts.deferred} deferred and ${verdicts['handed-off']} handed off — work is moving between people and sessions rather than being refused, which is what a correct-but-early suggestion should produce.`,
    );
  }

  return {
    ranked: ranked.length,
    decided,
    decidedOfRanked,
    coveragePct,
    verdicts,
    dismissalClusters: clusters,
    approvalPct: pct(verdicts.approved, decided),
    dismissalPct: pct(verdicts.dismissed, decided),
    deferralPct: pct(verdicts.deferred, decided),
    handoffPct: pct(verdicts['handed-off'], decided),
    clustered,
    concentrated,
    timeToDecision: {
      available: false,
      reason:
        'Time to decision is not computable from stored data: the moment a ranked action first appeared to a human is not recorded, and a value derived from the decision row itself would measure only the clock.',
    },
    reading,
  };
}
