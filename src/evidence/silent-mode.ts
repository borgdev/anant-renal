// Silent mode — per-protocol surfacing control.
//
// A protocol has two modes:
//
//   active  — the pack computes AND surfaces: candidates reach the worklist,
//             the console, the NBA ledger.
//   silent  — the pack still computes, still evaluates its gates, still writes
//             its evidence: nothing is surfaced to a human. This is the mode a
//             newly activated pack runs in while it accumulates shadow-mode
//             agreement, and the mode any pack drops into under review.
//
// Silent is a SURFACING switch, never a COMPUTATION switch. A silent pack that
// stopped evaluating would be indistinguishable from a broken one, and the
// whole point of shadow mode is that the decision is recorded and comparable.
// `assertSilentStillComputes` below is the load-bearing invariant.

import type { ProtocolId } from './rule-packs.js';
import { RULE_PROTOCOLS } from './rule-packs.js';

/** Every protocol the assurance track governs. */
export const SILENT_MODE_PROTOCOLS: readonly ProtocolId[] = RULE_PROTOCOLS;

export type ProtocolMode = 'active' | 'silent';

export interface ProtocolModeRecord {
  protocol: ProtocolId;
  mode: ProtocolMode;
  /** ISO timestamp the mode took effect. */
  since: string;
  /** why it was set — shown verbatim in the console. */
  reason: string;
  /** who set it (operator id, or 'system' for the activation default). */
  by: string;
}

/** A surfaced-or-suppressed decision, with its provenance attached. */
export interface SurfacedDecision<T> {
  protocol: ProtocolId;
  mode: ProtocolMode;
  /** true when the recommendation is allowed to reach a human. */
  surfaced: boolean;
  /** planned surfacing is still recorded when suppressed — this is the shadow record. */
  shadow: boolean;
  /** one-line explanation for the console. */
  rationale: string;
  recommendation: T;
}

export const SILENT_MODE_REQUIRED_REASON_LENGTH = 12;

/**
 * The activation default: a protocol starts silent until shadow-mode agreement
 * is demonstrated, so no new pack can page a clinician on day one.
 */
export const SILENT_MODE_DEFAULT: ProtocolMode = 'silent';

/** Modes a clinician is allowed to flip at runtime, plus the reviewed default. */
export const PROTOCOL_MODE_RECORDS: readonly ProtocolModeRecord[] = SILENT_MODE_PROTOCOLS.map((protocol) => ({
  protocol,
  mode: SILENT_MODE_DEFAULT,
  since: '1970-01-01T00:00:00.000Z',
  reason: 'activation default — silent until shadow-mode agreement is demonstrated',
  by: 'system',
}));

const REGISTRY = new Map<ProtocolId, ProtocolModeRecord>(
  PROTOCOL_MODE_RECORDS.map((r) => [r.protocol, r]),
);

export function isProtocolId(value: string): value is ProtocolId {
  return (SILENT_MODE_PROTOCOLS as readonly string[]).includes(value);
}

/** Latest known mode record for a protocol; unknown protocols default silent. */
export function modeRecord(protocol: ProtocolId): ProtocolModeRecord {
  const found = REGISTRY.get(protocol);
  if (found) return found;
  return { protocol, mode: SILENT_MODE_DEFAULT, since: '1970-01-01T00:00:00.000Z', reason: 'unknown protocol — defaulted silent', by: 'system' };
}

export function modeFor(protocol: ProtocolId): ProtocolMode {
  return modeRecord(protocol).mode;
}

export function isSilent(protocol: ProtocolId): boolean {
  return modeFor(protocol) === 'silent';
}

/**
 * Apply a mode change. Rejects a silent->active move with no stated reason:
 * leaving silent mode is a governed act and must say why.
 */
export function applyMode(input: {
  protocol: ProtocolId;
  mode: ProtocolMode;
  reason: string;
  by: string;
  at?: string;
}): ProtocolModeRecord {
  const reason = input.reason.trim();
  if (input.mode === 'active' && reason.length < SILENT_MODE_REQUIRED_REASON_LENGTH) {
    throw new Error(
      `leaving silent mode for ${input.protocol} requires a reason of at least ${SILENT_MODE_REQUIRED_REASON_LENGTH} characters`,
    );
  }
  const record: ProtocolModeRecord = {
    protocol: input.protocol,
    mode: input.mode,
    since: input.at ?? new Date().toISOString(),
    reason: reason || (input.mode === 'silent' ? 'returned to silent mode' : 'activated'),
    by: input.by,
  };
  REGISTRY.set(input.protocol, record);
  return record;
}

/** Restore a record persisted elsewhere (workspace reload, test reset). */
export function seedModeRecord(record: ProtocolModeRecord): ProtocolModeRecord {
  REGISTRY.set(record.protocol, record);
  return record;
}

export function resetModes(): void {
  REGISTRY.clear();
  for (const r of PROTOCOL_MODE_RECORDS) REGISTRY.set(r.protocol, r);
}

export function allModeRecords(): ProtocolModeRecord[] {
  return SILENT_MODE_PROTOCOLS.map((p) => modeRecord(p));
}

export function silentProtocols(): ProtocolId[] {
  return SILENT_MODE_PROTOCOLS.filter((p) => modeFor(p) === 'silent');
}

export function activeProtocols(): ProtocolId[] {
  return SILENT_MODE_PROTOCOLS.filter((p) => modeFor(p) === 'active');
}

/**
 * Decide whether a computed recommendation may be surfaced.
 *
 * In silent mode the caller still gets its recommendation back with
 * `surfaced: false` and `shadow: true`, so the decision can be written to the
 * ledger and compared later. Silently dropping it would destroy the evidence.
 */
export function surfaceDecision<T>(
  protocol: ProtocolId,
  recommendation: T,
  opts: { shadow?: boolean; note?: string } = {},
): SurfacedDecision<T> {
  const record = modeRecord(protocol);
  const surfaced = record.mode === 'active';
  return {
    protocol,
    mode: record.mode,
    surfaced,
    shadow: !surfaced,
    rationale: surfaced
      ? `${protocol} is active — recommendation surfaced`
      : `${protocol} is silent (since ${record.since}) — computed and recorded, not surfaced${opts.note ? `: ${opts.note}` : ''}`,
    recommendation,
  };
}

/** Convenience: filter a candidate list down to what may actually be shown. */
export function surfaceable<T>(protocol: ProtocolId, items: readonly T[]): T[] {
  return isSilent(protocol) ? [] : [...items];
}

/**
 * The invariant: silent is a surfacing switch, never a computation switch.
 * Given the same inputs, a pack must return the same recommendation in both
 * modes — only `surfaced` may differ.
 *
 * The probe flips the mode, computes, flips back, computes, and compares
 * signatures. If a pack ever branched on the mode to skip work (or to skip a
 * gate), the two signatures would diverge and the assurance gate fails.
 */
export function assertSilentStillComputes<T>(args: {
  protocol: ProtocolId;
  compute: () => T;
  signature: (value: T) => string;
}): { active: string; silent: string; identical: boolean; surfacedWhenSilent: boolean } {
  const restore = modeRecord(args.protocol);
  const probe = (mode: ProtocolMode): string => {
    seedModeRecord({ ...restore, mode, reason: 'computation invariant probe', by: 'system' });
    return args.signature(args.compute());
  };
  const active = probe('active');
  const silent = probe('silent');
  const decision = surfaceDecision(args.protocol, args.compute());
  seedModeRecord(restore);
  return {
    active,
    silent,
    identical: active === silent && decision.surfaced === false && decision.shadow === true,
    surfacedWhenSilent: decision.surfaced,
  };
}

export const SILENT_MODE_REFERENCE = {
  defaultMode: SILENT_MODE_DEFAULT,
  minReasonLength: SILENT_MODE_REQUIRED_REASON_LENGTH,
  protocols: SILENT_MODE_PROTOCOLS,
  rule: 'silent suppresses surfacing only — computation, gates, evidence and the shadow record all continue',
} as const;

export function silentModeSummary(): {
  total: number;
  active: ProtocolId[];
  silent: ProtocolId[];
  records: ProtocolModeRecord[];
} {
  const records = allModeRecords();
  return { total: records.length, active: activeProtocols(), silent: silentProtocols(), records };
}
