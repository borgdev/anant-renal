/******************************************************************************
 * Simulator — deterministic seeded PRNG (mulberry32).
 *
 * Every scenario carries a `seed`; the script generator draws all "random"
 * decisions (which lab code, how many starts, which patient) from this stream
 * so a scenario replays identically run-to-run (given the same realm clock).
 ******************************************************************************/

/** 32-bit mulberry32 — small, fast, deterministic. Returns 0..1. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pick one element deterministically. */
export function pick<T>(items: readonly T[], rng: () => number): T {
  return items[Math.min(items.length - 1, Math.floor(rng() * items.length))] as T;
}
