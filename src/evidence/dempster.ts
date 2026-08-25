/******************************************************************************
 * Dempster–Shafer theory (DST) evidence-fusion core.
 *
 * A pure, dependency-free implementation of mass functions, Dempster's rule of
 * combination, reliability discounting, and belief/plausibility. Used to fuse
 * bounded-cell swarm evidence into belief intervals instead of a single
 * confidence number — so an operator sees "Bel 88% · Pl 92% · conflict 0.61"
 * rather than one fake-precise percentage.
 *
 * Focal elements are subsets of a frame of discernment Θ (the candidate
 * hypotheses). They are represented by canonical string keys: sorted
 * hypothesis ids joined by UNIT_SEP; the FULL frame (total ignorance) is "*";
 * the empty set is "\u0000".
 *
 * Two caveats the consumers must honor:
 *   • Under total conflict Dempster's rule degenerates (Zadeh) — fuse() reports
 *     `degenerate: true` and falls back to vacuous, and callers should
 *     retain/escalate (never auto-approve) rather than trust the normalized
 *     result.
 *   • Masses must be calibrated so they stay interpretable (see the swarm
 *     adapters: evidence-count-weighted singletons + reliability discounting).
 ******************************************************************************/

export const FULL = '*';
export const EMPTY = '\u0000';
const UNIT = '\u0001';

export type Mass = Map<string, number>;

function keyOf(ids: Iterable<string>): string {
  return [...ids].sort().join(UNIT);
}

function keySet(key: string): Set<string> {
  if (key === FULL || key === EMPTY) return new Set();
  return new Set(key.split(UNIT));
}

function intersectKey(a: string, b: string): string {
  if (a === EMPTY || b === EMPTY) return EMPTY;
  if (a === FULL) return b;
  if (b === FULL) return a;
  const sa = keySet(a);
  const out: string[] = [];
  for (const id of b.split(UNIT)) if (sa.has(id)) out.push(id);
  return out.length ? keyOf(out) : EMPTY;
}

/** A mass with `weight` committed to a single hypothesis; the rest is ignorance. */
export function singleton(id: string, weight: number): Mass {
  const w = Math.max(0, Math.min(1, weight));
  const m = new Map<string, number>();
  if (w > 0) m.set(keyOf([id]), w);
  if (1 - w > 0) m.set(FULL, 1 - w);
  return m;
}

/** Full ignorance — "I observed the signal but know nothing." (abstention / missing telemetry) */
export function vacuous(): Mass {
  return new Map<string, number>([[FULL, 1]]);
}

/** Reliability discounting: α·m on focal elements, (1−α) pushed to ignorance. */
export function discount(m: Mass, alpha: number): Mass {
  const a = Math.max(0, Math.min(1, alpha));
  const out = new Map<string, number>();
  for (const [key, w] of m) {
    if (key === FULL) continue;
    const w2 = w * a;
    if (w2 > 0) out.set(key, w2);
  }
  const full = (m.get(FULL) ?? 0) * a + (1 - a);
  if (full > 0) out.set(FULL, full);
  return out;
}

/** Combine two masses by Dempster's rule WITHOUT normalization (keeps empty-set mass). */
function combineRaw(a: Mass, b: Mass): Mass {
  const out = new Map<string, number>();
  for (const [ka, wa] of a) {
    for (const [kb, wb] of b) {
      const key = intersectKey(ka, kb);
      const w = wa * wb;
      out.set(key, (out.get(key) ?? 0) + w);
    }
  }
  return out;
}

export interface FusionResult {
  mass: Mass;
  /** Conflict mass K ∈ [0,1] — total mass committed to the empty set. */
  k: number;
  /** True when K → 1 (total conflict); the mass falls back to vacuous. */
  degenerate: boolean;
}

/** Fuse any number of masses; returns the normalized result + global conflict K. */
export function fuse(sources: Mass[]): FusionResult {
  if (sources.length === 0) return { mass: vacuous(), k: 0, degenerate: false };
  let acc = new Map(sources[0]!);
  for (let i = 1; i < sources.length; i += 1) acc = combineRaw(acc, sources[i]!);
  const k = acc.get(EMPTY) ?? 0;
  if (k >= 1 || !Number.isFinite(k)) return { mass: vacuous(), k: 1, degenerate: true };
  const scale = 1 / (1 - k);
  const mass = new Map<string, number>();
  for (const [key, w] of acc) if (key !== EMPTY && w > 0) mass.set(key, w * scale);
  return { mass, k, degenerate: false };
}

/** The frame of discernment = union of all hypothesis ids across the masses. */
export function frameOf(masses: Mass[]): Set<string> {
  const frame = new Set<string>();
  for (const m of masses) for (const key of m.keys()) for (const id of keySet(key)) frame.add(id);
  return frame;
}

function isSubsetOf(b: Set<string>, a: Set<string>): boolean {
  for (const id of b) if (!a.has(id)) return false;
  return true;
}

function intersects(b: Set<string>, a: Set<string>): boolean {
  for (const id of b) if (a.has(id)) return true;
  return false;
}

/** Belief in A — the mass fully committed to A (every focal element ⊆ A). */
export function belief(mass: Mass, frame: Set<string>, a: Set<string>): number {
  let s = 0;
  for (const [key, w] of mass) {
    if (key === FULL) {
      // Θ ⊆ A only when A spans the whole frame.
      if (a.size >= frame.size && isSubsetOf(frame, a)) s += w;
    } else if (isSubsetOf(keySet(key), a)) {
      s += w;
    }
  }
  return s;
}

/** Plausibility of A — the most the evidence would allow (focal elements ∩ A ≠ ∅). */
export function plausibility(mass: Mass, frame: Set<string>, a: Set<string>): number {
  let s = 0;
  for (const [key, w] of mass) {
    if (key === FULL) {
      if (a.size > 0) s += w;
    } else if (intersects(keySet(key), a)) {
      s += w;
    }
  }
  return s;
}

/** Uncertainty = Plausibility − Belief (the honest ignorance band). */
export function uncertainty(mass: Mass, frame: Set<string>, a: Set<string>): number {
  return Math.max(0, plausibility(mass, frame, a) - belief(mass, frame, a));
}
