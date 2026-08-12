// Choice Points — the substrate of free will. When a behavior faces
// multiple valid actions, it constructs an Option set with utility
// scores. The ChoiceResolver applies the agent's self-model preferences
// to compute final scores, chooses stochastically within a utility band,
// records the roll, and returns the choice with full rationale.
//
// Replay: given the same options + same rng seed + same preferences, the
// resolver returns the same choice.

import type { ChoicePoint } from './episode.js';
import type { SelfModelRegistry } from './self-model.js';

export interface Option<T> {
  optionId: string;
  description: string;
  utility: number; // behavior's baseline utility, 0..1 or greater
  effectKind: string; // used to look up preference weight
  action: T; // opaque payload the caller executes
}

// Deterministic PRNG so replay is reproducible. Mulberry32.
function mulberry32(a: number): () => number {
  return function () {
    let t = (a += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ResolveOptions {
  presenceId: string;
  selfModel: SelfModelRegistry;
  bandThreshold?: number; // options within (topScore - band) are candidates
  rngSeed?: number; // if omitted, a random seed is generated
}

export interface Resolved<T> {
  choice: ChoicePoint;
  action: T;
}

export function resolveChoice<T>(options: Array<Option<T>>, opts: ResolveOptions): Resolved<T> {
  if (options.length === 0) throw new Error('resolveChoice: no options');
  const band = opts.bandThreshold ?? 0.15;
  const seed = opts.rngSeed ?? Math.floor(Math.random() * 2 ** 31);
  const rng = mulberry32(seed);

  // Compute final scores = utility * preferenceWeight
  const scored = options.map((o) => {
    const w = opts.selfModel.preferenceFor(opts.presenceId, o.effectKind);
    return { ...o, preferenceWeight: w, finalScore: o.utility * w };
  });
  const top = Math.max(...scored.map((s) => s.finalScore));
  const candidates = scored.filter((s) => s.finalScore >= top - band);

  // Roll among candidates weighted by finalScore
  const totalWeight = candidates.reduce((a, c) => a + c.finalScore, 0);
  const roll = rng();
  let acc = 0;
  let chosen = candidates[0]!;
  for (const c of candidates) {
    acc += c.finalScore / totalWeight;
    if (roll <= acc) { chosen = c; break; }
  }

  const selfModelInfluence = candidates.length > 1
    ? Math.min(1, Math.abs(chosen.preferenceWeight - 1) / 1)
    : 0;

  const choice: ChoicePoint = {
    presented: scored.map((s) => ({
      optionId: s.optionId,
      description: s.description,
      utility: s.utility,
      preferenceWeight: s.preferenceWeight,
      finalScore: s.finalScore,
    })),
    chosenOptionId: chosen.optionId,
    rationale: candidates.length === 1
      ? `Single dominant option (utility ${chosen.utility.toFixed(2)}, preference ${chosen.preferenceWeight.toFixed(2)}).`
      : `Selected from ${candidates.length} candidates within band ${band}. Self-model influence ${selfModelInfluence.toFixed(2)}. RNG roll ${roll.toFixed(4)}.`,
    rngRoll: roll,
    selfModelInfluence,
  };
  return { choice, action: chosen.action };
}
