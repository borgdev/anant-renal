// M13.G — Self-model → policy
//
// The self-model already stores preferences that shift with attributions
// (positive → weight up, negative → weight down). The Choice resolver already
// consults them. This module exposes an explicit *policy surface*:
//
//   - PolicyRuntime.rank(presence, candidateEffects) → ranked list with rationales
//   - PolicyRuntime.recommend(presence, candidates) → single top pick
//   - PolicyRuntime.trace(presence, effectKinds) → per-kind weight breakdown
//
// This is the entry point the LLM planner (M13.D) and any turn-by-turn
// decision harness will use so the agent behaves in accordance with its
// learned preferences without every caller re-implementing the math.

import type { AgentPresence, WorldEffect } from './types.js';
import type { SelfModelRegistry } from './self-model.js';

export interface Candidate<T = unknown> {
  optionId: string;
  effectKind: WorldEffect['kind'];
  utility: number; // baseline utility 0..1+
  action: T;
  reason?: string;
}

export interface RankedOption<T> {
  optionId: string;
  effectKind: WorldEffect['kind'];
  baselineUtility: number;
  preferenceWeight: number;
  finalScore: number;
  action: T;
  reason?: string;
  rationale: string;
}

export class PolicyRuntime {
  constructor(private readonly selfModel: SelfModelRegistry) {}

  /** Weight the presence assigns to an effect kind (default 1.0). */
  weightFor(presenceId: string, effectKind: WorldEffect['kind']): number {
    return this.selfModel.preferenceFor(presenceId, effectKind);
  }

  /** Rank candidate options for a presence using weighted utility.
   * Returns a stable, descending-by-finalScore list. */
  rank<T>(presence: AgentPresence, candidates: Array<Candidate<T>>): Array<RankedOption<T>> {
    const scored = candidates.map((c) => {
      const preferenceWeight = this.weightFor(presence.presenceId, c.effectKind);
      const finalScore = c.utility * preferenceWeight;
      const rationale = preferenceWeight === 1
        ? `baseline utility ${c.utility.toFixed(2)}, no learned preference`
        : preferenceWeight > 1
          ? `favored (weight ${preferenceWeight.toFixed(2)}× on ${c.effectKind}); score = ${finalScore.toFixed(2)}`
          : `disfavored (weight ${preferenceWeight.toFixed(2)}× on ${c.effectKind}); score = ${finalScore.toFixed(2)}`;
      const opt: RankedOption<T> = {
        optionId: c.optionId,
        effectKind: c.effectKind,
        baselineUtility: c.utility,
        preferenceWeight,
        finalScore,
        action: c.action,
        rationale,
      };
      if (c.reason !== undefined) opt.reason = c.reason;
      return opt;
    });
    // Stable descending sort by finalScore, break ties by original index
    return scored
      .map((s, i) => ({ ...s, _i: i }))
      .sort((a, b) => (b.finalScore - a.finalScore) || (a._i - b._i))
      .map(({ _i, ...rest }) => { void _i; return rest; });
  }

  /** Highest-scoring candidate. Returns undefined if the list is empty. */
  recommend<T>(presence: AgentPresence, candidates: Array<Candidate<T>>): RankedOption<T> | undefined {
    return this.rank(presence, candidates)[0];
  }

  /** Human-readable per-kind weight snapshot for a presence. Useful for the UI. */
  trace(presenceId: string, effectKinds: Array<WorldEffect['kind']>): Array<{ effectKind: WorldEffect['kind']; weight: number; lean: 'toward' | 'away' | 'neutral' }> {
    return effectKinds.map((k) => {
      const weight = this.weightFor(presenceId, k);
      return {
        effectKind: k,
        weight,
        lean: weight > 1.05 ? 'toward' : weight < 0.95 ? 'away' : 'neutral',
      };
    });
  }
}
