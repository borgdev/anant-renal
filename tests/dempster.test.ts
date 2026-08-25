import { describe, expect, it } from 'vitest';
import { belief, discount, frameOf, fuse, plausibility, singleton, uncertainty, vacuous, FULL } from '../src/evidence/dempster.js';

describe('Dempster–Shafer core', () => {
  it('fuses agreeing sources into a near-certain belief with negligible conflict', () => {
    const a = singleton('protect', 0.7);
    const b = singleton('protect', 0.6);
    const c = singleton('restore', 0.05); // minority hypothesis keeps the frame honest
    const { mass, k, degenerate } = fuse([a, b, c]);
    const frame = frameOf([a, b, c]);
    expect(degenerate).toBe(false);
    expect(k).toBeCloseTo(0.044, 3); // every p·o combination conflicts
    const bel = belief(mass, frame, new Set(['protect']));
    const pl = plausibility(mass, frame, new Set(['protect']));
    expect(bel).toBeGreaterThan(0.8); // ≈ 0.83
    expect(pl).toBeGreaterThanOrEqual(bel);
    expect(pl).toBeLessThanOrEqual(1);
  });

  it('is neutral to vacuous (abstention) sources', () => {
    const a = singleton('protect', 0.7);
    const b = singleton('rebalance', 0.5);
    const vac = vacuous();
    const r1 = fuse([a, b]);
    const r2 = fuse([vac, b, a]);
    expect([...r1.mass.entries()].sort()).toEqual([...r2.mass.entries()].sort());
    expect(r1.k).toBeCloseTo(r2.k, 10);
  });

  it('measures conflict mass and keeps belief ≤ plausibility (3-vs-1 reference shape)', () => {
    const plan = [0.64, 0.64, 0.64].map((w) => singleton('plan', w));
    const limit = singleton('limit', 0.64);
    const { mass, k } = fuse([...plan, limit]);
    const frame = frameOf([...plan, limit]);
    expect(k).toBeGreaterThanOrEqual(0.5); // ≈ 0.61
    const bel = belief(mass, frame, new Set(['plan']));
    const pl = plausibility(mass, frame, new Set(['plan']));
    expect(bel).toBeGreaterThan(0.7); // ≈ 0.88
    expect(pl).toBeGreaterThanOrEqual(bel);
    expect(bel).toBeLessThanOrEqual(1);
    expect(pl).toBeLessThanOrEqual(1);
  });

  it('discounts unreliable sources toward ignorance', () => {
    const m = singleton('protect', 0.8);
    const d = discount(m, 0.5);
    expect(d.get('protect')).toBeCloseTo(0.4, 5); // committed mass halved
    expect(d.get(FULL) ?? 0).toBeCloseTo(0.6, 5); // ignorance absorbs the rest
    const frame = new Set(['protect', 'other']); // two-hypothesis frame keeps FULL honest
    const bel = belief(d, frame, new Set(['protect']));
    const pl = plausibility(d, frame, new Set(['protect']));
    expect(bel).toBeCloseTo(0.4, 5); // Θ ⊄ {protect}, so FULL is excluded from belief
    expect(pl).toBeCloseTo(1, 5); // Θ overlaps {protect} → everything remains plausible
  });

  it('flags total conflict as degenerate (Zadeh) instead of over-committing', () => {
    // Fully-committed (no ignorance) opposing masses → K = 1, fusion degenerates.
    const a = singleton('a', 1);
    const b = singleton('b', 1);
    const { degenerate, k } = fuse([a, b]);
    expect(degenerate).toBe(true);
    expect(k).toBe(1);
  });

  it('keeps 0 ≤ belief ≤ plausibility ≤ 1 with uncertainty = pl − bel for every option', () => {
    const src = [singleton('a', 0.7), singleton('b', 0.5), singleton('a', 0.6), vacuous()];
    const { mass } = fuse(src);
    const frame = frameOf(src);
    for (const o of ['a', 'b']) {
      const bel = belief(mass, frame, new Set([o]));
      const pl = plausibility(mass, frame, new Set([o]));
      const un = uncertainty(mass, frame, new Set([o]));
      expect(bel).toBeGreaterThanOrEqual(0);
      expect(pl).toBeGreaterThanOrEqual(bel);
      expect(pl).toBeLessThanOrEqual(1);
      expect(un).toBeCloseTo(pl - bel, 5);
    }
  });
});
