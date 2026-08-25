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

// EntityGraph — the world's state.
//
// Every meaningful thing in healthcare is a node here. Nodes have typed
// state, relations to other nodes, and a per-attribute history. Mutations
// go through the Effect reducer; this class is the storage + query API.

import type { EntityKind, EntityRecord, EntityUrn } from './types.js';

function makeUrn(realmId: string, kind: EntityKind, id: string): EntityUrn {
  return `urn:realm:${realmId}:${kind}:${id}` as EntityUrn;
}

export class EntityGraph {
  private entities = new Map<EntityUrn, EntityRecord>();
  private byKind = new Map<EntityKind, Set<EntityUrn>>();
  private byRelation = new Map<string, Set<EntityUrn>>();
  private subscribers: Array<(mut: { urn: EntityUrn; patch: Record<string, unknown>; cause: string; at: string }) => void> = [];

  constructor(private readonly realmId: string) {}

  onMutation(cb: (mut: { urn: EntityUrn; patch: Record<string, unknown>; cause: string; at: string }) => void): () => void {
    this.subscribers.push(cb);
    return () => { this.subscribers = this.subscribers.filter((x) => x !== cb); };
  }

  create<S extends Record<string, unknown>>(kind: EntityKind, id: string, state: S, relations: Record<string, EntityUrn[]> = {}): EntityRecord<S> {
    const urn = makeUrn(this.realmId, kind, id);
    if (this.entities.has(urn)) throw new Error(`entity-exists: ${urn}`);
    const now = new Date().toISOString();
    const rec: EntityRecord<S> = { urn, kind, id, state, relations, createdAt: now, updatedAt: now, history: [] };
    this.entities.set(urn, rec as EntityRecord);
    const kindSet = this.byKind.get(kind) ?? new Set();
    kindSet.add(urn);
    this.byKind.set(kind, kindSet);
    for (const [rel, targets] of Object.entries(relations)) {
      for (const target of targets) this.indexRelation(rel, urn, target);
    }
    return rec;
  }

  private indexRelation(rel: string, from: EntityUrn, to: EntityUrn) {
    const fwd = `${rel}:from:${from}`;
    const back = `${rel}:to:${to}`;
    (this.byRelation.get(fwd) ?? this.byRelation.set(fwd, new Set()).get(fwd)!).add(to);
    (this.byRelation.get(back) ?? this.byRelation.set(back, new Set()).get(back)!).add(from);
  }

  get<S = Record<string, unknown>>(urn: EntityUrn): EntityRecord<S> | undefined {
    return this.entities.get(urn) as EntityRecord<S> | undefined;
  }

  patch(urn: EntityUrn, patch: Record<string, unknown>, cause: string): EntityRecord {
    const rec = this.entities.get(urn);
    if (!rec) throw new Error(`entity-not-found: ${urn}`);
    const now = new Date().toISOString();
    rec.state = { ...rec.state, ...patch };
    rec.updatedAt = now;
    rec.history.push({ at: now, patch, cause });
    for (const cb of this.subscribers) cb({ urn, patch, cause, at: now });
    return rec;
  }

  addRelation(urn: EntityUrn, rel: string, target: EntityUrn): void {
    const rec = this.entities.get(urn);
    if (!rec) throw new Error(`entity-not-found: ${urn}`);
    (rec.relations[rel] ??= []).push(target);
    this.indexRelation(rel, urn, target);
  }

  /** Forward relation lookup: entities that this urn points to via rel.
   *  Also supports '<rel>-inv' as an inverse-relation lookup. */
  related(urn: EntityUrn, rel: string): EntityUrn[] {
    if (rel.endsWith('-inv')) {
      const base = rel.slice(0, -4);
      return [...(this.byRelation.get(`${base}:to:${urn}`) ?? [])];
    }
    return [...(this.byRelation.get(`${rel}:from:${urn}`) ?? [])];
  }

  listKind(kind: EntityKind): EntityRecord[] {
    const set = this.byKind.get(kind);
    if (!set) return [];
    return [...set].map((u) => this.entities.get(u)!).filter(Boolean);
  }

  count(kind: EntityKind): number {
    return this.byKind.get(kind)?.size ?? 0;
  }

  urnFor(kind: EntityKind, id: string): EntityUrn { return makeUrn(this.realmId, kind, id); }

  /** Remove an entity entirely (used by FHIR transaction DELETE). Returns false if absent. */
  remove(urn: EntityUrn): boolean {
    const rec = this.entities.get(urn);
    if (!rec) return false;
    this.entities.delete(urn);
    this.byKind.get(rec.kind)?.delete(urn);
    for (const set of this.byRelation.values()) set.delete(urn);
    for (const cb of this.subscribers) cb({ urn, patch: { __deleted: true }, cause: 'fhir-delete', at: new Date().toISOString() });
    return true;
  }

  snapshot(): { entities: EntityRecord[]; countsByKind: Record<string, number> } {
    const counts: Record<string, number> = {};
    for (const [k, s] of this.byKind) counts[k] = s.size;
    return { entities: [...this.entities.values()], countsByKind: counts };
  }
}
