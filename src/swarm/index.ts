/******************************************************************************
 *
 * Copyright (c) 2026 AnantHQ Inc.
 * All Rights Reserved.
 *
 * This software is licensed, not sold.
 *
 * The contents of this file constitute confidential and proprietary
 * information belonging exclusively to AnantHQ Inc.
 *
 * This source code incorporates proprietary algorithms, software architecture,
 * business logic, computational methods, optimization techniques,
 * workflows, data structures, APIs, and implementation details that are
 * protected by copyright law, patent law, trade secret law, and
 * international intellectual property treaties.
 *
 * Except as expressly permitted by a written license agreement,
 * no person or organization may:
 *
 *   • Copy or reproduce this software.
 *   • Modify or create derivative works.
 *   • Reverse engineer, decompile, or disassemble.
 *   • Benchmark or publicly disclose performance.
 *   • Redistribute, sublicense, lease, rent, or sell.
 *   • Use this software for competitive analysis.
 *   • Disclose any implementation details.
 *
 * Any unauthorized use is strictly prohibited and may result in
 * civil damages, injunctive relief, criminal prosecution,
 * and all other remedies available under applicable law.
 *
 ******************************************************************************/

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
