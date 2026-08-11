export type Id<T extends string> = `${T}:${string}`;
export type OrganizationKind = 'provider' | 'payer' | 'health-system' | 'practice';
export type ScopeKind = 'organization' | 'region' | 'facility' | 'team' | 'room' | 'project' | 'person' | 'service';

export interface Organization { id: Id<'org'>; kind: OrganizationKind; name: string; parentId?: Id<'org'>; attributes: Record<string, unknown>; }
export interface Person { id: Id<'person'>; organizationId: Id<'org'>; displayName: string; roles: string[]; attributes: Record<string, unknown>; }
export interface Scope { id: Id<'scope'>; kind: ScopeKind; organizationId: Id<'org'>; parentScopeId?: Id<'scope'>; memberIds: Id<'person'>[]; attributes: Record<string, unknown>; }

export type HyperNodeId = `node:${string}`;
export type HyperedgeId = `edge:${string}`;
export interface Provenance { sourceId: string; observedAt: string; ingestedAt: string; confidence?: number; }
export interface HyperNode { id: HyperNodeId; type: string; properties: Record<string, unknown>; provenance: Provenance[]; validFrom: string; validTo?: string; }
export interface Hyperedge { id: HyperedgeId; type: string; participants: Array<{ nodeId: HyperNodeId; role: string }>; properties: Record<string, unknown>; provenance: Provenance[]; validFrom: string; validTo?: string; }
export interface HypergraphVersion { id: string; parentId?: string; createdAt: string; nodes: ReadonlyMap<HyperNodeId, HyperNode>; edges: ReadonlyMap<HyperedgeId, Hyperedge>; }

export class TemporalHypergraphStore {
  private current: HypergraphVersion;
  constructor(now = new Date().toISOString()) { this.current = { id: 'version:0', createdAt: now, nodes: new Map(), edges: new Map() }; }
  snapshot(): HypergraphVersion { return this.current; }
  upsertNode(node: HyperNode, now = new Date().toISOString()): HypergraphVersion {
    const nodes = new Map(this.current.nodes); nodes.set(node.id, structuredClone(node));
    this.current = { id: this.nextId(), parentId: this.current.id, createdAt: now, nodes, edges: this.current.edges }; return this.current;
  }
  upsertEdge(edge: Hyperedge, now = new Date().toISOString()): HypergraphVersion {
    for (const participant of edge.participants) if (!this.current.nodes.has(participant.nodeId)) throw new Error(`Unknown participant ${participant.nodeId}`);
    const edges = new Map(this.current.edges); edges.set(edge.id, structuredClone(edge));
    this.current = { id: this.nextId(), parentId: this.current.id, createdAt: now, nodes: this.current.nodes, edges }; return this.current;
  }
  projectGraph(): Array<{ from: HyperNodeId; to: HyperNodeId; source: HyperedgeId }> {
    return [...this.current.edges.values()].flatMap((edge) => edge.participants.flatMap((a, i) => edge.participants.slice(i + 1).map((b) => ({ from: a.nodeId, to: b.nodeId, source: edge.id }))));
  }
  private nextId(): string { return `version:${Number(this.current.id.split(':')[1]) + 1}`; }
}

export type CycleStatus = 'on-rhythm' | 'drifting' | 'broken' | 'recovering';
export interface CyclicTemporalState { cycleId: string; phase: string; expectedAt: string; observedAt?: string; status: CycleStatus; }
export function classifyRhythm(expectedAt: Date, observedAt: Date | undefined, toleranceMinutes: number, now = new Date()): CycleStatus {
  if (!observedAt) return now > expectedAt ? 'broken' : 'on-rhythm';
  return Math.abs(observedAt.getTime() - expectedAt.getTime()) / 60_000 <= toleranceMinutes ? 'on-rhythm' : 'drifting';
}
