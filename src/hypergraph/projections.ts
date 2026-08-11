// Four canonical projections over a bitemporal hypergraph snapshot.
//
//   • graphProjection    — node/edge adjacency map suitable for graph UIs
//   • tableProjection    — flat rows for an edge type with per-role columns
//   • worklistProjection — actionable items derived from open edges (edges
//                          whose validTo is in the future and whose attributes
//                          match a worklist filter)
//   • timelineProjection — events pinned to validFrom, ordered chronologically
//
// Projections are pure functions over `HypergraphSnapshot` + ledger; they take
// no I/O and are safe to run inside a request handler.

import type { HyperEdge, HyperNode, NodeId } from './types.js';
import type { HypergraphSnapshot } from './store.js';
import type { LedgerEntry } from './ledger.js';

// ---------- graph ----------
export interface GraphProjection {
  readonly nodes: readonly HyperNode[];
  readonly edges: readonly {
    readonly id: string;
    readonly type: string;
    readonly participants: readonly { readonly role: string; readonly nodeId: NodeId }[];
  }[];
}

export function graphProjection(snap: HypergraphSnapshot): GraphProjection {
  const edges = Array.from(snap.edges.values()).map((e) => ({
    id: e.id,
    type: e.type,
    participants: Object.entries(e.roles).flatMap(([role, nodeIds]) => nodeIds.map((nodeId) => ({ role, nodeId }))),
  }));
  return { nodes: Array.from(snap.nodes.values()), edges };
}

// ---------- table ----------
export interface TableProjection {
  readonly columns: readonly string[];
  readonly rows: readonly Record<string, unknown>[];
}

export function tableProjection(snap: HypergraphSnapshot, edgeType: string): TableProjection {
  const edges = Array.from(snap.edges.values()).filter((e) => e.type === edgeType);
  if (edges.length === 0) return { columns: ['id'], rows: [] };
  const roleNames = new Set<string>();
  const attrNames = new Set<string>();
  for (const e of edges) {
    for (const r of Object.keys(e.roles)) roleNames.add(r);
    for (const a of Object.keys(e.attributes)) attrNames.add(a);
  }
  const columns = ['id', ...Array.from(roleNames).map((r) => `role:${r}`), ...Array.from(attrNames)];
  const rows = edges.map((e) => {
    const row: Record<string, unknown> = { id: e.id };
    for (const r of roleNames) row[`role:${r}`] = e.roles[r] ?? [];
    for (const a of attrNames) row[a] = e.attributes[a];
    return row;
  });
  return { columns, rows };
}

// ---------- worklist ----------
export interface WorklistItem {
  readonly edgeId: string;
  readonly edgeType: string;
  readonly assignedTo?: string;
  readonly dueAt?: string;
  readonly summary: string;
}

export interface WorklistFilter {
  readonly edgeTypes: readonly string[];
  readonly assignedAttr?: string;
  readonly dueAttr?: string;
  readonly summaryAttr?: string;
}

export function worklistProjection(snap: HypergraphSnapshot, filter: WorklistFilter): readonly WorklistItem[] {
  const items: WorklistItem[] = [];
  for (const e of snap.edges.values()) {
    if (!filter.edgeTypes.includes(e.type)) continue;
    const item: {
      edgeId: string; edgeType: string; assignedTo?: string; dueAt?: string; summary: string;
    } = {
      edgeId: e.id,
      edgeType: e.type,
      summary: pickString(e, filter.summaryAttr) ?? e.id,
    };
    const at = pickString(e, filter.assignedAttr);
    if (at !== undefined) item.assignedTo = at;
    const du = pickString(e, filter.dueAttr);
    if (du !== undefined) item.dueAt = du;
    items.push(item);
  }
  items.sort((a, b) => (a.dueAt ?? '').localeCompare(b.dueAt ?? ''));
  return items;
}

function pickString(edge: HyperEdge, attrName?: string): string | undefined {
  if (!attrName) return undefined;
  const v = edge.attributes[attrName];
  return typeof v === 'string' ? v : undefined;
}

// ---------- timeline ----------
export interface TimelineEvent {
  readonly at: string;
  readonly kind: LedgerEntry['kind'];
  readonly subjectId: string;
  readonly actorRef: string;
  readonly summary: string;
}

export function timelineProjection(entries: readonly LedgerEntry[]): readonly TimelineEvent[] {
  return entries
    .map((e) => {
      const subjectId =
        e.kind === 'node.assert' ? e.node.id
        : e.kind === 'node.retract' ? e.nodeId
        : e.kind === 'edge.assert' ? e.edge.id
        : e.kind === 'edge.retract' ? e.edgeId
        : e.successor.id;
      const summary =
        e.kind === 'node.assert' ? `assert node ${e.node.type}:${e.node.id}`
        : e.kind === 'node.retract' ? `retract node ${e.nodeId}`
        : e.kind === 'edge.assert' ? `assert edge ${e.edge.type}:${e.edge.id}`
        : e.kind === 'edge.retract' ? `retract edge ${e.edgeId}`
        : `supersede ${e.predecessorEdgeId} -> ${e.successor.id}`;
      return { at: e.validFrom, kind: e.kind, subjectId, actorRef: e.actorRef, summary };
    })
    .sort((a, b) => a.at.localeCompare(b.at));
}
