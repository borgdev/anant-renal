// Bitemporal, copy-on-write mutation ledger.
//
// Every change to the hypergraph is recorded here as an append-only entry that
// carries two timestamps:
//
//   • `validFrom` / `validTo` — the interval in the *modeled world* during
//     which the fact holds. Corrections may open a new entry that overlaps a
//     prior one; the older entry is retracted (see `retractedAt`) but never
//     removed. This lets the store answer "what did the world look like at
//     time T according to today's best knowledge?"
//   • `transactionAt` — when the entry was recorded. Combined with retraction,
//     this lets the store answer "what did we *believe* the world looked like
//     as of transaction time T'?"
//
// COW semantics: entries are frozen at append time. Later corrections do not
// mutate earlier entries; they append a new entry and mark the predecessor as
// retracted.

import type { EdgeId, HyperEdge, HyperNode, NodeId } from './types.js';

export type LedgerOpKind =
  | 'node.assert'
  | 'node.retract'
  | 'edge.assert'
  | 'edge.retract'
  | 'edge.supersede';

export interface LedgerEntryBase {
  readonly id: string;
  readonly kind: LedgerOpKind;
  readonly validFrom: string;
  readonly validTo?: string;
  readonly transactionAt: string;
  readonly retractedAt?: string;
  readonly predecessorId?: string;
  readonly actorRef: string;
  readonly reason?: string;
  readonly scopeId: string;
}

export interface NodeAssert extends LedgerEntryBase {
  readonly kind: 'node.assert';
  readonly node: HyperNode;
}
export interface NodeRetract extends LedgerEntryBase {
  readonly kind: 'node.retract';
  readonly nodeId: NodeId;
}
export interface EdgeAssert extends LedgerEntryBase {
  readonly kind: 'edge.assert';
  readonly edge: HyperEdge;
}
export interface EdgeRetract extends LedgerEntryBase {
  readonly kind: 'edge.retract';
  readonly edgeId: EdgeId;
}
export interface EdgeSupersede extends LedgerEntryBase {
  readonly kind: 'edge.supersede';
  readonly predecessorEdgeId: EdgeId;
  readonly successor: HyperEdge;
}

export type LedgerEntry = NodeAssert | NodeRetract | EdgeAssert | EdgeRetract | EdgeSupersede;

export interface LedgerAppendInput {
  readonly kind: LedgerOpKind;
  readonly validFrom: string;
  readonly validTo?: string;
  readonly actorRef: string;
  readonly reason?: string;
  readonly scopeId: string;
  readonly predecessorId?: string;
  readonly node?: HyperNode;
  readonly edge?: HyperEdge;
  readonly nodeId?: NodeId;
  readonly edgeId?: EdgeId;
  readonly predecessorEdgeId?: EdgeId;
  readonly successor?: HyperEdge;
}

export class LedgerError extends Error {
  constructor(message: string) { super(message); this.name = 'LedgerError'; }
}

export class MutationLedger {
  private readonly entries: LedgerEntry[] = [];
  constructor(private readonly clock: () => Date = () => new Date()) {}

  size(): number { return this.entries.length; }
  all(): readonly LedgerEntry[] { return this.entries; }

  append(input: LedgerAppendInput): LedgerEntry {
    const transactionAt = this.clock().toISOString();
    const id = `le:${this.entries.length}:${transactionAt}`;
    const base = {
      id,
      transactionAt,
      validFrom: input.validFrom,
      ...(input.validTo !== undefined ? { validTo: input.validTo } : {}),
      actorRef: input.actorRef,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      scopeId: input.scopeId,
      ...(input.predecessorId !== undefined ? { predecessorId: input.predecessorId } : {}),
    };
    let entry: LedgerEntry;
    switch (input.kind) {
      case 'node.assert':
        if (!input.node) throw new LedgerError('node.assert requires node');
        entry = { ...base, kind: 'node.assert', node: input.node };
        break;
      case 'node.retract':
        if (!input.nodeId) throw new LedgerError('node.retract requires nodeId');
        entry = { ...base, kind: 'node.retract', nodeId: input.nodeId };
        break;
      case 'edge.assert':
        if (!input.edge) throw new LedgerError('edge.assert requires edge');
        entry = { ...base, kind: 'edge.assert', edge: input.edge };
        break;
      case 'edge.retract':
        if (!input.edgeId) throw new LedgerError('edge.retract requires edgeId');
        entry = { ...base, kind: 'edge.retract', edgeId: input.edgeId };
        break;
      case 'edge.supersede':
        if (!input.predecessorEdgeId || !input.successor) throw new LedgerError('edge.supersede requires predecessorEdgeId and successor');
        entry = { ...base, kind: 'edge.supersede', predecessorEdgeId: input.predecessorEdgeId, successor: input.successor };
        break;
      default:
        throw new LedgerError(`unsupported op: ${(input as { kind: string }).kind}`);
    }
    const frozen = Object.freeze(entry) as LedgerEntry;
    this.entries.push(frozen);
    return frozen;
  }

  /** Mark a prior entry as retracted at the current transaction time.
   *  Returns a new frozen entry that reflects the retraction; the original
   *  entry is preserved via copy-on-write.
   */
  retract(entryId: string, actorRef: string, reason?: string): LedgerEntry {
    const idx = this.entries.findIndex((e) => e.id === entryId);
    if (idx === -1) throw new LedgerError(`no such entry ${entryId}`);
    const original = this.entries[idx]!;
    if (original.retractedAt) throw new LedgerError(`entry ${entryId} already retracted`);
    const retractedAt = this.clock().toISOString();
    const replaced = Object.freeze({ ...original, retractedAt, retractedBy: actorRef, retractionReason: reason }) as LedgerEntry;
    this.entries[idx] = replaced;
    return replaced;
  }

  /** Every entry whose transactionAt ≤ asOf and which has NOT been retracted by asOf. */
  asOfTransaction(asOf: string): readonly LedgerEntry[] {
    return this.entries.filter((e) => e.transactionAt <= asOf && (!e.retractedAt || e.retractedAt > asOf));
  }

  /** Entries whose valid interval covers `validAt` and which are believed live as of `asOf`. */
  liveAt(validAt: string, asOf: string): readonly LedgerEntry[] {
    return this.asOfTransaction(asOf).filter((e) => {
      if (e.validFrom > validAt) return false;
      if (e.validTo !== undefined && e.validTo <= validAt) return false;
      return true;
    });
  }
}
