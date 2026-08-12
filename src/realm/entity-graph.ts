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

  listKind(kind: EntityKind): EntityRecord[] {
    const set = this.byKind.get(kind);
    if (!set) return [];
    return [...set].map((u) => this.entities.get(u)!).filter(Boolean);
  }

  count(kind: EntityKind): number {
    return this.byKind.get(kind)?.size ?? 0;
  }

  urnFor(kind: EntityKind, id: string): EntityUrn { return makeUrn(this.realmId, kind, id); }

  snapshot(): { entities: EntityRecord[]; countsByKind: Record<string, number> } {
    const counts: Record<string, number> = {};
    for (const [k, s] of this.byKind) counts[k] = s.size;
    return { entities: [...this.entities.values()], countsByKind: counts };
  }
}
