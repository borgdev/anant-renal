/**
 * The two round-level lenses — client types and fetchers.
 *
 * Wire shapes mirror `src/swarm/next-session.ts` and `src/swarm/round-digest.ts`.
 * The server decides every number; this module only carries them, so the console can
 * never disagree with the server about a patient's risk.
 */

import { responseOrThrow } from "./session";

/* ---------------- 3.2 · the next session ---------------- */

export type NextSessionBand = "high" | "watch" | "low";

export interface NextSessionClock {
  minute: number;
  beforePct: number;
  afterPct?: number;
}

export interface NextSessionChange {
  action: string;
  label: string;
  ufRateMlH?: number;
  extraMinutes?: number;
  ufVolumeCapL?: number;
}

export interface NextSessionRisk {
  patientId: string;
  facilityId?: string;
  band: NextSessionBand;
  peakPct: number;
  peakMinute: number;
  clocks: NextSessionClock[];
  current: {
    ufRateMlH?: number;
    ufRatePerKg?: number;
    ufVolumeL?: number;
    deliveredMinutes?: number;
    idwgKg?: number;
    nadirSbp?: number;
    dryWeightSource: "last-session-close" | "unavailable" | "unknown";
  };
  change: NextSessionChange | null;
  counterfactual: {
    peakPct: number;
    peakMinute: number;
    peakDropPp: number;
    riskReducedBy: number;
    meaningful: boolean;
  } | null;
  noCounterfactualReason?: string;
  note: string;
  flags: string[];
  unassessable: boolean;
}

export interface NextSessionView {
  generatedAt: string;
  horizon: string;
  rows: NextSessionRisk[];
  totals: {
    screened: number;
    high: number;
    watch: number;
    low: number;
    actionable: number;
    unassessable: number;
  };
  reading: string[];
}

export async function fetchNextSession(): Promise<NextSessionView> {
  const res = await fetch("/admin/swarm/next-session", { cache: "no-store", credentials: "same-origin" });
  return responseOrThrow<NextSessionView>("/admin/swarm/next-session", res);
}

/* ---------------- 3.3 · since your last round ---------------- */

export type ProtocolStatusWord = "green" | "amber" | "red" | "unknown";

export interface RoundProtocolState {
  status: ProtocolStatusWord;
  severity: number;
}

export interface RoundMovement {
  patientId: string;
  realmId: string;
  facilityId?: string;
  protocol: string;
  protocolLabel: string;
  substate: string;
  before: RoundProtocolState;
  after: RoundProtocolState;
  deltaSeverity: number;
  direction: "worsened" | "improved";
  newlyAtRisk: boolean;
  drivers: string[];
}

export interface RoundSnapshotPatient {
  patientId: string;
  realmId: string;
  facilityId?: string;
  worstStatus: ProtocolStatusWord;
  worstSeverity: number;
  worstProtocol: string;
}

export interface RoundDigestView {
  generatedAt: string;
  baseline: { id: string; takenAt: string; takenBy: string } | null;
  scopedTo: string | null;
  since: { takenAt: string; takenBy: string; patients: number } | null;
  now: { takenAt: string; takenBy: string; patients: number };
  movements: RoundMovement[];
  newlyAtRisk: RoundMovement[];
  improved: RoundMovement[];
  departed: Array<{ patientId: string; realmId: string; worstStatus: ProtocolStatusWord; worstSeverity: number }>;
  appeared: RoundSnapshotPatient[];
  summary: {
    worsened: number;
    improved: number;
    unchanged: number;
    newlyAtRisk: number;
    netSeverityChange: number;
    fleetSeverityNow: number;
    fleetSeverityBefore: number;
  };
  reading: string[];
}

export interface RoundListView {
  count: number;
  rounds: Array<{ id: string; takenAt: string; takenBy: string; patients: number; worstStatus: number }>;
}

export async function fetchRoundDigest(by?: string): Promise<RoundDigestView> {
  const path = by && by.length > 0
    ? `/admin/swarm/rounds/digest?by=${encodeURIComponent(by)}`
    : "/admin/swarm/rounds/digest";
  const res = await fetch(path, { cache: "no-store", credentials: "same-origin" });
  return responseOrThrow<RoundDigestView>(path, res);
}

export async function fetchRounds(): Promise<RoundListView> {
  const res = await fetch("/admin/swarm/rounds", { cache: "no-store", credentials: "same-origin" });
  return responseOrThrow<RoundListView>("/admin/swarm/rounds", res);
}

export async function closeRound(takenBy: string): Promise<{ round: { id: string; takenAt: string; takenBy: string; patients: number } }> {
  const res = await fetch("/admin/swarm/rounds/close", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ takenBy }),
  });
  return responseOrThrow("/admin/swarm/rounds/close", res);
}
