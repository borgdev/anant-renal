/******************************************************************************
 * Swarm Intelligence — bounded-cell outcome layer.
 *
 * cells.ts          — the 12 renal cell manifests (consumes/produces/allowed actions)
 * insight.ts        — CellProposal + SwarmInsight aggregation (consensus/conflict/abstention)
 * nba.ts            — deterministic next-best-action ranking (advisory)
 * outcome-episode.ts— Observed→…→Resolved state machine over the existing loop
 * release.ts        — green/red-team release gate (M-S3)
 * live.ts           — derive swarm state from REAL realm data (holistic integration)
 * demo.ts           — the spec's "current executable reference boundary" as a demo
 ******************************************************************************/

export * from './types.js';
export * from './cells.js';
export * from './insight.js';
export * from './nba.js';
export * from './outcome-episode.js';
export * from './release.js';
export * from './live.js';
export * from './demo.js';
