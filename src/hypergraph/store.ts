/******************************************************************************
 *
 * Copyright (c) 2026 AnantHQ Inc.
 * All Rights Reserved.
 *
 * This software is licensed, not sold.
 *
 * The contents of this file constitute confidential and proprietary
 * information belonging exclusively to Unison Software Technologies Pvt. Ltd.
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

  /** Apply an entry with schema validation. Throws SchemaError on bad input. */
  validate(entry: LedgerEntry): void {
    if (entry.kind === 'node.assert') {
      this.schema.validateNode(entry.node);
    } else if (entry.kind === 'edge.assert') {
      // We need a way to look up node types; use current-valid snapshot as
      // reference. Callers that assert edges before all nodes exist should
      // do it in a single transaction.
      const now = new Date().toISOString();
      const snap = this.snapshot({ validAt: now, transactionAt: now });
      this.schema.validateEdge(entry.edge, (id) => snap.nodes.get(id)?.type);
    } else if (entry.kind === 'edge.supersede') {
      const now = new Date().toISOString();
      const snap = this.snapshot({ validAt: now, transactionAt: now });
      this.schema.validateEdge(entry.successor, (id) => snap.nodes.get(id)?.type);
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

  /** Latest snapshot given the wall clock. */
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
    const snap = this.now();
    this.schema.validateEdge(edge, (id) => snap.nodes.get(id)?.type);
    // Reject duplicate live edge ids so callers must use supersede for updates.
    if (snap.edges.has(edge.id)) throw new SchemaError(`edge ${edge.id} already live; use supersede`);
    return this.ledger.append({
      kind: 'edge.assert', edge,
      validFrom: opts.validFrom,
      ...(opts.validTo !== undefined ? { validTo: opts.validTo } : {}),
      actorRef: opts.actorRef, scopeId: opts.scopeId,
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
    });
  }
}
