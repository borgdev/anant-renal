import type { HyperNodeId, HyperedgeId } from './ids.js';

// The temporal hypergraph is the heart of the harness. Everything the harness
// reasons about — patients, treatments, cases, workflows, policies — lives as
// nodes and hyperedges, and every mutation produces a new immutable version so
// replay and audit can be exact.

export interface Provenance {
  sourceId: string;
  observedAt: string; // when the source recorded the fact
  ingestedAt: string; // when we accepted it
  confidence?: number;
  lineage?: readonly string[];
}

export interface HyperNode {
  id: HyperNodeId;
  type: string;
  properties: Readonly<Record<string, unknown>>;
  provenance: readonly Provenance[];
  validFrom: string;
  validTo?: string;
  classification?: 'public' | 'internal' | 'confidential' | 'phi' | 'restricted-phi';
}

export interface Hyperedge {
  id: HyperedgeId;
  type: string;
  participants: ReadonlyArray<{ nodeId: HyperNodeId; role: string }>;
  properties: Readonly<Record<string, unknown>>;
  provenance: readonly Provenance[];
  validFrom: string;
  validTo?: string;
}

export interface HypergraphVersion {
  id: string;
  parentId?: string;
  createdAt: string;
  nodes: ReadonlyMap<HyperNodeId, HyperNode>;
  edges: ReadonlyMap<HyperedgeId, Hyperedge>;
}

const freezeNode = (n: HyperNode): HyperNode => Object.freeze({
  ...n,
  properties: Object.freeze({ ...n.properties }),
  provenance: Object.freeze(n.provenance.map((p) => Object.freeze({ ...p, lineage: p.lineage ? Object.freeze([...p.lineage]) : undefined }))) as readonly Provenance[],
});

const freezeEdge = (e: Hyperedge): Hyperedge => Object.freeze({
  ...e,
  participants: Object.freeze(e.participants.map((p) => Object.freeze({ ...p }))),
  properties: Object.freeze({ ...e.properties }),
  provenance: Object.freeze(e.provenance.map((p) => Object.freeze({ ...p, lineage: p.lineage ? Object.freeze([...p.lineage]) : undefined }))) as readonly Provenance[],
});

/**
 * Copy-on-write temporal hypergraph store. Each mutation returns a fresh
 * version linked to its parent; the previous versions remain reachable through
 * `history()` so replay is a plain fold.
 */
export class TemporalHypergraphStore {
  private current: HypergraphVersion;
  private readonly log: HypergraphVersion[] = [];

  constructor(now = new Date().toISOString()) {
    this.current = { id: 'version:0', createdAt: now, nodes: new Map(), edges: new Map() };
    this.log.push(this.current);
  }

  snapshot(): HypergraphVersion {
    return this.current;
  }

  history(): readonly HypergraphVersion[] {
    return this.log;
  }

  upsertNode(node: HyperNode, now = new Date().toISOString()): HypergraphVersion {
    const nodes = new Map(this.current.nodes);
    nodes.set(node.id, freezeNode(node));
    return this.advance({ nodes, edges: this.current.edges }, now);
  }

  upsertEdge(edge: Hyperedge, now = new Date().toISOString()): HypergraphVersion {
    for (const p of edge.participants) {
      if (!this.current.nodes.has(p.nodeId)) throw new Error(`Unknown participant: ${p.nodeId}`);
    }
    const edges = new Map(this.current.edges);
    edges.set(edge.id, freezeEdge(edge));
    return this.advance({ nodes: this.current.nodes, edges }, now);
  }

  /** Close a node's validity window without removing it — history stays exact. */
  retireNode(id: HyperNodeId, now = new Date().toISOString()): HypergraphVersion {
    const existing = this.current.nodes.get(id);
    if (!existing) throw new Error(`Unknown node: ${id}`);
    const nodes = new Map(this.current.nodes);
    nodes.set(id, freezeNode({ ...existing, validTo: now }));
    return this.advance({ nodes, edges: this.current.edges }, now);
  }

  /**
   * Project the hypergraph as a plain node-to-node graph, exploding every
   * hyperedge into its pairwise incidences. Useful for graph algorithms that
   * do not natively understand hyperedges.
   */
  projectPairwise(): Array<{ from: HyperNodeId; to: HyperNodeId; source: HyperedgeId; roles: [string, string] }> {
    const out: Array<{ from: HyperNodeId; to: HyperNodeId; source: HyperedgeId; roles: [string, string] }> = [];
    for (const edge of this.current.edges.values()) {
      const parts = edge.participants;
      for (let i = 0; i < parts.length; i += 1) {
        const a = parts[i];
        if (!a) continue;
        for (let j = i + 1; j < parts.length; j += 1) {
          const b = parts[j];
          if (!b) continue;
          out.push({ from: a.nodeId, to: b.nodeId, source: edge.id, roles: [a.role, b.role] });
        }
      }
    }
    return out;
  }

  /** All edges that reference a node. */
  edgesTouching(nodeId: HyperNodeId): Hyperedge[] {
    return [...this.current.edges.values()].filter((e) => e.participants.some((p) => p.nodeId === nodeId));
  }

  private advance(next: { nodes: ReadonlyMap<HyperNodeId, HyperNode>; edges: ReadonlyMap<HyperedgeId, Hyperedge> }, now: string): HypergraphVersion {
    const nextId = `version:${this.log.length}`;
    const version: HypergraphVersion = { id: nextId, parentId: this.current.id, createdAt: now, ...next };
    this.current = version;
    this.log.push(version);
    return version;
  }
}
