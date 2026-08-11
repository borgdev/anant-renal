// Versioned hyperedges.
//
// A `VersionedEdgeChain` tracks the ordered history of an edge that has been
// superseded through the ledger. Chains support:
//
//   • `head(asOf)` — the version live at a bitemporal position
//   • `history()` — the full chain in transaction-time order
//   • `retract(reason)` — mark the chain as retracted at the current wall time
//
// Callers should treat the chain identity — typically the id of the first
// asserted edge in the chain — as the durable identity of the modeled thing
// (e.g. `treatment-plan:patient-42:v*`). Versions inside the chain are
// referenceable by their per-version edge id, which never changes once frozen.

import type { EdgeId, HyperEdge } from './types.js';
import type { EdgeAssert, EdgeSupersede, LedgerEntry } from './ledger.js';

export interface EdgeVersion {
  readonly edge: HyperEdge;
  readonly validFrom: string;
  readonly validTo?: string;
  readonly transactionAt: string;
  readonly retractedAt?: string;
  readonly predecessorEdgeId?: EdgeId;
}

export function buildEdgeChain(ledgerEntries: readonly LedgerEntry[], chainRootId: EdgeId): readonly EdgeVersion[] {
  const versions: EdgeVersion[] = [];
  const seenIds = new Set<EdgeId>();
  seenIds.add(chainRootId);
  for (const e of ledgerEntries) {
    if (e.kind === 'edge.assert' && e.edge.id === chainRootId) {
      versions.push({
        edge: e.edge,
        validFrom: e.validFrom,
        ...(e.validTo !== undefined ? { validTo: e.validTo } : {}),
        transactionAt: e.transactionAt,
        ...(e.retractedAt !== undefined ? { retractedAt: e.retractedAt } : {}),
      });
    } else if (e.kind === 'edge.supersede' && seenIds.has(e.predecessorEdgeId)) {
      seenIds.add(e.successor.id);
      versions.push({
        edge: e.successor,
        validFrom: e.validFrom,
        ...(e.validTo !== undefined ? { validTo: e.validTo } : {}),
        transactionAt: e.transactionAt,
        ...(e.retractedAt !== undefined ? { retractedAt: e.retractedAt } : {}),
        predecessorEdgeId: e.predecessorEdgeId,
      });
    }
  }
  return versions;
}

/** Version live at the bitemporal position, or undefined if none. */
export function headOfChain(
  versions: readonly EdgeVersion[],
  asOf: { validAt: string; transactionAt: string },
): EdgeVersion | undefined {
  const candidates = versions.filter((v) => {
    if (v.transactionAt > asOf.transactionAt) return false;
    if (v.retractedAt && v.retractedAt <= asOf.transactionAt) return false;
    if (v.validFrom > asOf.validAt) return false;
    if (v.validTo !== undefined && v.validTo <= asOf.validAt) return false;
    return true;
  });
  // The latest transaction-time version among candidates wins.
  return candidates.reduce<EdgeVersion | undefined>((best, cur) => (best === undefined || cur.transactionAt > best.transactionAt ? cur : best), undefined);
}

/** True if the chain has a retracted entry no later than `asOf`. */
export function isChainRetracted(versions: readonly EdgeVersion[], asOfTx: string): boolean {
  return versions.some((v) => v.retractedAt !== undefined && v.retractedAt <= asOfTx);
}

/** Helper: given a ledger, return all chain root ids (edges that were the first version). */
export function chainRoots(entries: readonly LedgerEntry[]): readonly EdgeId[] {
  const superseded = new Set<EdgeId>();
  const asserted = new Set<EdgeId>();
  for (const e of entries) {
    if (e.kind === 'edge.assert') asserted.add(e.edge.id);
    else if (e.kind === 'edge.supersede') superseded.add(e.successor.id);
  }
  return Array.from(asserted).filter((id) => !superseded.has(id));
}

// Non-exported re-exports used only for type narrowing in tests / callers.
export type { EdgeAssert, EdgeSupersede };
