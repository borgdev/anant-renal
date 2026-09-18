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

// Hypergraph store — folds the mutation ledger into a queryable state.
//
// The store never mutates in place. All state is derived by replaying the
// ledger against the schema. Queries take an `AsOf` selector so callers can
// ask "what was believed at transaction time T' about valid time T?" — the
// full bitemporal question.

import type { EdgeId, HyperEdge, HyperNode, HypergraphSchema, NodeId } from './types.js';
import { SchemaError } from './types.js';
import type { LedgerEntry, MutationLedger } from './ledger.js';

export interface BitemporalAsOf {
  /** World time — the fact must be valid at this instant. */
  readonly validAt: string;
  /** Belief time — only consider knowledge acquired by this transaction time. */
  readonly transactionAt: string;
}

export interface HypergraphSnapshot {
  readonly nodes: ReadonlyMap<NodeId, HyperNode>;
  readonly edges: ReadonlyMap<EdgeId, HyperEdge>;
}

export class HypergraphStore {
  constructor(private readonly schema: HypergraphSchema, private readonly ledger: MutationLedger) {}

  // ---------------------------------------------------------------------------
  // The write-path index.
  //
  // `snapshot()` replays the whole ledger — that is what a bitemporal QUERY needs,
  // and this file keeps doing it. But `assertEdge` used to call `snapshot()` twice
  // per edge, once for the role-type lookup and once for the duplicate-id check, so
  // every write cost O(ledger). The bridge asserts one membership edge plus one edge
  // per relation for EVERY effect in a realm, so writing N entries cost O(N^2) — and
  // the ledger only ever grows. Measured on the dev server at 9 realms: 33% of all
  // CPU in `snapshot`, 14% in `assertEdge`, 47% in this file, with the event loop
  // starved badly enough that new connections were never accepted.
  //
  // These two maps answer the only questions the write path asks — "what type is
  // this node id" and "is this edge id already live" — in O(1) amortised, by folding
  // each ledger entry exactly once.
  //
  // They deliberately DO NOT consult valid-time windows: they mean "latest asserted,
  // not retracted", which is the reference `validate()`'s own comment already
  // specified ("use current-valid snapshot as reference"). The only input that can
  // see the difference is a node asserted with a `validFrom` in the future, which the
  // bridge never produces — it stamps every write with the current instant. Queries
  // are unaffected: `snapshot()`/`now()` still replay and stay time-correct.
  // ---------------------------------------------------------------------------
  private readonly nodeTypeIndex = new Map<NodeId, string>();
  /**
   * Mirrors `snapshot()`'s permanent `retracted` shadow set.
   *
   * The replay ignores a `node.assert` whose id has EVER been retracted, so re-asserting
   * one is a silent no-op there. The index reproduces that rather than letting the id
   * come back to life, which would let the write path bind an edge to a node the store
   * does not believe in. (`edge.retract` has NO such shadow set in the replay — a
   * retracted edge may be re-asserted — so this asymmetry is the replay's, not mine.)
   */
  private readonly retractedNodeIds = new Set<NodeId>();
  private readonly liveEdgeIds = new Set<EdgeId>();
  /**
   * Mirrors `snapshot()`'s permanent `supersededEdges` shadow set.
   *
   * The replay ignores an `edge.assert` whose id has EVER been superseded — not only
   * while the supersede is the latest event — so re-asserting a superseded id is a
   * silent no-op there. The index reproduces that exactly rather than inventing a
   * stricter "already used" rule of its own: the two must agree, or the write path
   * would accept an edge the store then never shows. (The silent no-op is arguably
   * worth rejecting outright, but that is a behaviour change and belongs in its own
   * commit, not smuggled in behind a performance fix.)
   */
  private readonly supersededEdgeIds = new Set<EdgeId>();
  private indexedCount = 0;
  private indexedVersion = 0;

  /**
   * Fold any ledger entries not yet in the index.
   *
   * A `retract()` rewrites an entry in place, so the ledger version can move without
   * the length moving. When the version delta cannot be explained by appends we Rebuild
   * rather than guess — a retraction is rare, and an index that kept serving a
   * retracted node as live would be the kind of wrong that looks right.
   */
  private syncIndex(): void {
    const entries = this.ledger.all();
    const version = this.ledger.version();
    if (version - this.indexedVersion !== entries.length - this.indexedCount) {
      this.nodeTypeIndex.clear();
      this.retractedNodeIds.clear();
      this.liveEdgeIds.clear();
      this.supersededEdgeIds.clear();
      this.indexedCount = 0;
    }
    for (let i = this.indexedCount; i < entries.length; i++) this.foldEntry(entries[i]!);
    this.indexedCount = entries.length;
    this.indexedVersion = version;
  }

  /** One ledger entry → its effect on the index. A retracted entry contributes nothing. */
  private foldEntry(e: LedgerEntry): void {
    if (e.retractedAt) return;
    switch (e.kind) {
      case 'node.assert':
        if (!this.retractedNodeIds.has(e.node.id)) this.nodeTypeIndex.set(e.node.id, e.node.type);
        break;
      case 'node.retract':
        this.retractedNodeIds.add(e.nodeId);
        this.nodeTypeIndex.delete(e.nodeId);
        break;
      case 'edge.assert':
        if (!this.supersededEdgeIds.has(e.edge.id)) this.liveEdgeIds.add(e.edge.id);
        break;
      case 'edge.retract': this.liveEdgeIds.delete(e.edgeId); break;
      case 'edge.supersede':
        this.supersededEdgeIds.add(e.predecessorEdgeId);
        this.liveEdgeIds.delete(e.predecessorEdgeId);
        this.liveEdgeIds.add(e.successor.id);
        break;
    }
  }

  /** Apply an entry with schema validation. Throws SchemaError on bad input. */
  validate(entry: LedgerEntry): void {
    if (entry.kind === 'node.assert') {
      this.schema.validateNode(entry.node);
    } else if (entry.kind === 'edge.assert') {
      this.syncIndex();
      this.schema.validateEdge(entry.edge, (id) => this.nodeTypeIndex.get(id));
    } else if (entry.kind === 'edge.supersede') {
      this.syncIndex();
      this.schema.validateEdge(entry.successor, (id) => this.nodeTypeIndex.get(id));
    }
  }

  /** Compute the snapshot of nodes and edges believed live at the given bitemporal position. */
  snapshot(asOf: BitemporalAsOf): HypergraphSnapshot {
    const nodes = new Map<NodeId, HyperNode>();
    const edges = new Map<EdgeId, HyperEdge>();
    const retracted = new Set<string>();
    const supersededEdges = new Set<EdgeId>();

    for (const e of this.ledger.liveAt(asOf.validAt, asOf.transactionAt)) {
      switch (e.kind) {
        case 'node.assert':
          if (!retracted.has(e.node.id)) nodes.set(e.node.id, e.node);
          break;
        case 'node.retract':
          retracted.add(e.nodeId);
          nodes.delete(e.nodeId);
          break;
        case 'edge.assert':
          if (!supersededEdges.has(e.edge.id)) edges.set(e.edge.id, e.edge);
          break;
        case 'edge.retract':
          edges.delete(e.edgeId);
          break;
        case 'edge.supersede':
          supersededEdges.add(e.predecessorEdgeId);
          edges.delete(e.predecessorEdgeId);
          edges.set(e.successor.id, e.successor);
          break;
      }
    }
    return { nodes, edges };
  }

  /** Latest snapshot given the wall clock. O(ledger) — a READ path, never call it per write. */
  now(): HypergraphSnapshot {
    const t = new Date().toISOString();
    return this.snapshot({ validAt: t, transactionAt: t });
  }

  /** Assert a node through the ledger with schema check. */
  assertNode(node: HyperNode, opts: { validFrom: string; validTo?: string; actorRef: string; scopeId: string; reason?: string }): LedgerEntry {
    this.schema.validateNode(node);
    return this.ledger.append({
      kind: 'node.assert', node,
      validFrom: opts.validFrom,
      ...(opts.validTo !== undefined ? { validTo: opts.validTo } : {}),
      actorRef: opts.actorRef, scopeId: opts.scopeId,
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
    });
  }

  /** Assert an edge, validating its role bindings against currently-live nodes. */
  assertEdge(edge: HyperEdge, opts: { validFrom: string; validTo?: string; actorRef: string; scopeId: string; reason?: string }): LedgerEntry {
    this.syncIndex();
    this.schema.validateEdge(edge, (id) => this.nodeTypeIndex.get(id));
    // Reject duplicate live edge ids so callers must use supersede for updates.
    if (this.liveEdgeIds.has(edge.id)) throw new SchemaError(`edge ${edge.id} already live; use supersede`);
    return this.ledger.append({
      kind: 'edge.assert', edge,
      validFrom: opts.validFrom,
      ...(opts.validTo !== undefined ? { validTo: opts.validTo } : {}),
      actorRef: opts.actorRef, scopeId: opts.scopeId,
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
    });
  }
}
