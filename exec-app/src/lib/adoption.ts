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

/**
 * Adoption metrics client — the ranked-action loop's own vital signs.
 *
 * Mirrors src/swarm/adoption.ts. The server decides what is measurable; this
 * module only carries it. `timeToDecision` is present in the payload with
 * `available: false` and a reason, so the console can state plainly that the
 * number is not measured instead of showing a placeholder that reads like a value.
 */

import { responseOrThrow } from "./session";

export interface AdoptionVerdicts {
  approved: number;
  dismissed: number;
  deferred: number;
  "handed-off": number;
}

export interface AdoptionReasonCluster {
  reason: string;
  count: number;
  variants: string[];
}

export interface AdoptionView {
  ranked: number;
  decided: number;
  decidedOfRanked: number;
  coveragePct: number | null;
  verdicts: AdoptionVerdicts;
  dismissalClusters: AdoptionReasonCluster[];
  approvalPct: number | null;
  dismissalPct: number | null;
  deferralPct: number | null;
  handoffPct: number | null;
  /** One reason dominates the dismissals — true even below the sample floor. */
  concentrated: boolean;
  /** Dominant AND backed by enough decisions to act on. */
  clustered: boolean;
  timeToDecision: { available: boolean; reason: string };
  reading: string[];
}

export async function fetchRankedAdoption(): Promise<AdoptionView> {
  const response = await fetch("/admin/swarm/adoption", { cache: "no-store", credentials: "same-origin" });
  return responseOrThrow<AdoptionView>("/admin/swarm/adoption", response);
}
