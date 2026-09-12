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
