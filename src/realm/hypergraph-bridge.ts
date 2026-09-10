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

// RealmHypergraph — live, idempotent bridge between a Realm and the typed
// hypergraph engine (Phase 1b).
//
// EffectReducer emits mutations; this bridge projects them into HyperNodes and
// HyperEdges against the healthcare schema: realm root, realm-membership edges,
// derived-reference edges for entity relations, and an effect node + presence +
// agent-run + effect-attribution edge per emitted effect. Assert-once per id
// keeps the ledger clean and every upsert schema-validated.

import type { HyperNode, HyperEdge, HypergraphSchema } from '../hypergraph/types.js';
import { HypergraphStore } from '../hypergraph/store.js';
import { MutationLedger } from '../hypergraph/ledger.js';
import type { AgentPresence, EmittedEffect, EntityRecord } from './types.js';
import { effectAttributionEdge, effectToHyperNode, entityRecordToHyperNode } from './entity-record.js';

export interface BridgeWriteOpts {
  at?: string;
  actorRef?: string;
  scopeId?: string;
}

export class RealmHypergraph {
  readonly schema: HypergraphSchema;
  readonly store: HypergraphStore;
  readonly realmId: string;
  private readonly nodes = new Set<string>();
  private readonly edges = new Set<string>();
  private readonly defaultActor: string;
  private readonly defaultScope: string;

  constructor(schema: HypergraphSchema, realmId: string, opts: { actorRef?: string; scopeId?: string } = {}) {
    this.schema = schema;
    this.store = new HypergraphStore(schema, new MutationLedger());
    this.realmId = realmId;
    this.defaultActor = opts.actorRef ?? 'system:hypergraph';
    this.defaultScope = opts.scopeId ?? realmId;
    const at = new Date().toISOString();
    this.store.assertNode({ id: realmId, type: 'realm', attributes: { realmId } }, { validFrom: at, actorRef: this.defaultActor, scopeId: this.defaultScope, reason: 'realm-root' });
    this.nodes.add(realmId);
  }

  now() { return this.store.now(); }

  private w(opts: BridgeWriteOpts): { at: string; actorRef: string; scopeId: string } {
    return { at: opts.at ?? new Date().toISOString(), actorRef: opts.actorRef ?? this.defaultActor, scopeId: opts.scopeId ?? this.defaultScope };
  }

  /** Assert a node once (schema-validated). Returns true when newly asserted. */
  upsertNode(node: HyperNode, opts: BridgeWriteOpts = {}): boolean {
    if (this.nodes.has(node.id)) return false;
    const { at, actorRef, scopeId } = this.w(opts);
    try {
      this.store.assertNode(node, { validFrom: at, actorRef, scopeId, reason: 'realm-hypergraph' });
    } catch {
      return false; // unknown type / missing required attr — skip silently
    }
    this.nodes.add(node.id);
    return true;
  }

  /** Realm-membership edge for a node (assert-once). */
  ensureMembership(nodeId: string, role: string, opts: BridgeWriteOpts = {}): boolean {
    const id = `membership:${this.realmId}:${nodeId}`;
    if (this.edges.has(id)) return false;
    const { at, actorRef, scopeId } = this.w(opts);
    try {
      this.store.assertEdge({ id, type: 'realm-membership', roles: { realm: [this.realmId], member: [nodeId] }, attributes: { joinedAt: at, role } }, { validFrom: at, actorRef, scopeId, reason: 'realm-hypergraph' });
    } catch {
      return false;
    }
    this.edges.add(id);
    return true;
  }

  /** Assert an edge once; returns false when already present or role nodes aren't live yet. */
  upsertEdge(edge: HyperEdge, opts: BridgeWriteOpts = {}): boolean {
    if (this.edges.has(edge.id)) return false;
    const { at, actorRef, scopeId } = this.w(opts);
    try {
      this.store.assertEdge(edge, { validFrom: at, actorRef, scopeId, reason: 'realm-hypergraph' });
    } catch {
      return false;
    }
    this.edges.add(edge.id);
    return true;
  }

  /** Project an EntityRecord: node + membership + relation-derived edges. */
  upsertEntity(rec: EntityRecord, opts: BridgeWriteOpts = {}): void {
    const node = entityRecordToHyperNode(rec);
    if (this.upsertNode(node, opts)) {
      this.ensureMembership(node.id, rec.kind, opts);
    }
    for (const [rel, targets] of Object.entries(rec.relations)) {
      for (const target of targets) {
        this.upsertEdge({ id: `${rec.urn}#${rel}#${target}`, type: 'derived-reference', roles: { from: [rec.urn], to: [target] }, attributes: { relation: rel, realmId: this.realmId } }, opts);
      }
    }
  }

  /**
   * Bring an already-populated entity graph into this projection.
   *
   * The bridge is a MATERIALISED VIEW of realm state, so a realm that was
   * populated (and given a history) before the projection existed can be synced
   * once instead of paying a per-effect write during bulk load. Used by realm
   * creation, where replaying a longitudinal history through a live projection
   * costs ~140x more than syncing the final graph.
   */
  syncEntityGraph(graph: { snapshot(): { entities: EntityRecord[] } }): { nodes: number; edges: number } {
    let nodes = 0;
    let edges = 0;
    for (const rec of graph.snapshot().entities) {
      const before = this.nodes.size;
      this.upsertEntity(rec);
      if (this.nodes.size > before) nodes += 1;
      edges += 1 + Object.values(rec.relations).reduce((n, targets) => n + targets.length, 0);
    }
    return { nodes, edges };
  }

  /** Project an emitted effect: effect + presence + agent-run nodes and the attribution edge. */
  upsertEffect(emitted: EmittedEffect, presence: AgentPresence, opts: BridgeWriteOpts = {}): void {
    const { at } = this.w(opts);
    const effNode = effectToHyperNode({
      effectId: emitted.effectId, presenceId: emitted.presenceId, agentSpecId: emitted.agentSpecId,
      realmAt: emitted.realmAt, effectKind: emitted.effect.kind, status: emitted.status, realmId: this.realmId,
    });
    this.upsertNode(effNode, opts);
    this.ensureMembership(effNode.id, 'effect', opts);

    const pNode: HyperNode = {
      id: `urn:realm:${this.realmId}:presence:${emitted.presenceId}`,
      type: 'presence',
      attributes: { realmId: this.realmId, presenceId: emitted.presenceId, agentSpecId: emitted.agentSpecId, role: presence.role, clearance: presence.clearance, attention: presence.attention, spawnedAt: presence.spawnedAt },
    };
    this.upsertNode(pNode, opts);
    this.ensureMembership(pNode.id, 'presence', opts);

    const runId = presence.runId || emitted.agentSpecId;
    const arNode: HyperNode = {
      id: `urn:realm:${this.realmId}:agent-run:${runId}`,
      type: 'agent-run',
      attributes: { realmId: this.realmId, runId, agentSpecId: emitted.agentSpecId, startedAt: emitted.realmAt, status: 'running' },
    };
    this.upsertNode(arNode, opts);
    this.ensureMembership(arNode.id, 'agent-run', opts);

    this.upsertEdge(effectAttributionEdge({ effectId: emitted.effectId, presenceId: emitted.presenceId, agentSpecId: emitted.agentSpecId, agentRunId: runId, realmId: this.realmId }), opts);
  }
}
