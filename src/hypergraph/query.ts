// Cyclic temporal query operators.
//
// Bitemporal ledgers make three additional questions natural, all of which are
// awkward in row-oriented stores:
//
//   • as-of        — snapshot at (validAt, transactionAt)
//   • between      — all events / edges whose valid interval overlaps a range
//   • cycle-through — walk repeated states (e.g. dialysis treatment cycles,
//     missed-treatment recovery cycles) by grouping ledger entries that share
//     a `cycleAnchor` attribute and ordering them by validFrom.
//
// This module returns raw ledger slices rather than assembled snapshots; the
// caller composes those with the store or projections.

import type { LedgerEntry, MutationLedger } from './ledger.js';

export interface Range {
  readonly from: string;
  readonly to: string;
}

export interface CycleAnchorSelector {
  /** JSON path into the attributes; e.g. ['cycle','patientId']. */
  readonly path: readonly string[];
}

function pluck(obj: unknown, path: readonly string[]): unknown {
  let cur: unknown = obj;
  for (const p of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** Ledger entries whose valid interval overlaps `range` and which are live at `transactionAt`. */
export function between(ledger: MutationLedger, range: Range, transactionAt: string): readonly LedgerEntry[] {
  return ledger.asOfTransaction(transactionAt).filter((e) => {
    if (e.validFrom > range.to) return false;
    if (e.validTo !== undefined && e.validTo <= range.from) return false;
    return true;
  });
}

/**
 * Group ledger entries by a shared cycle anchor value drawn from the entry's
 * asserted node/edge attributes. Entries missing the anchor path are ignored.
 * Groups are ordered by `validFrom`.
 */
export function cycleThrough(
  ledger: MutationLedger,
  anchor: CycleAnchorSelector,
  transactionAt: string,
): ReadonlyMap<string, readonly LedgerEntry[]> {
  const groups = new Map<string, LedgerEntry[]>();
  for (const e of ledger.asOfTransaction(transactionAt)) {
    let attrs: Record<string, unknown> | undefined;
    if (e.kind === 'node.assert') attrs = e.node.attributes as Record<string, unknown>;
    else if (e.kind === 'edge.assert') attrs = e.edge.attributes as Record<string, unknown>;
    else if (e.kind === 'edge.supersede') attrs = e.successor.attributes as Record<string, unknown>;
    if (!attrs) continue;
    const v = pluck(attrs, anchor.path);
    if (typeof v !== 'string' && typeof v !== 'number') continue;
    const key = String(v);
    const bucket = groups.get(key) ?? [];
    bucket.push(e);
    groups.set(key, bucket);
  }
  for (const bucket of groups.values()) {
    bucket.sort((a, b) => a.validFrom.localeCompare(b.validFrom));
  }
  return groups;
}

/** All valid intervals that touched a node id, sorted by transactionAt. */
export function nodeHistory(ledger: MutationLedger, nodeId: string): readonly LedgerEntry[] {
  return ledger.all().filter((e) => {
    if (e.kind === 'node.assert') return e.node.id === nodeId;
    if (e.kind === 'node.retract') return e.nodeId === nodeId;
    return false;
  });
}
