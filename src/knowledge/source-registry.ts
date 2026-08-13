// M20 Knowledge Layer — SourceRegistry + PackSubscriptionRegistry.
//
// The registry is the *only* mutable global surface for the knowledge layer.
// Everything else (adapters, sync jobs, evaluator, UI) reads from it.
//
// Persistence: mirrored to disk as JSON so the harness can boot cold and
// know which sources + subscriptions exist without re-scanning packs.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  KnowledgeSourceSpec, PackSourceSubscription, SourceCategory, AccessTier,
  Cadence, SourceConsumerFanout, PackKnowledgeBill, KnowledgeEvent,
} from './types.js';

const CADENCE_STRICTNESS: Record<Cadence, number> = {
  realtime: 100, event: 90, daily: 80, weekly: 70, monthly: 60,
  quarterly: 50, annual: 40, manual: 10,
};

export interface RegistryOpts {
  storeDir: string;                                    // e.g. /home/user/workspace/.harness/knowledge
  onEvent?: (e: KnowledgeEvent) => void | Promise<void>;
}

export class SourceRegistry {
  private readonly sources = new Map<string, KnowledgeSourceSpec>();
  private readonly subs = new Map<string, PackSourceSubscription[]>(); // sourceId -> subs
  private readonly storeDir: string;
  private readonly onEvent: (e: KnowledgeEvent) => void | Promise<void>;

  constructor(opts: RegistryOpts) {
    this.storeDir = opts.storeDir;
    this.onEvent = opts.onEvent ?? (() => {});
    mkdirSync(this.storeDir, { recursive: true });
    this.load();
  }

  // -------------------- Source management --------------------

  register(spec: KnowledgeSourceSpec): void {
    const existing = this.sources.get(spec.id);
    this.sources.set(spec.id, spec);
    this.persistSources();
    if (!existing) void this.onEvent({ type: 'source-registered', sourceId: spec.id, at: new Date().toISOString() });
  }

  registerMany(specs: KnowledgeSourceSpec[]): void {
    for (const s of specs) this.register(s);
  }

  get(sourceId: string): KnowledgeSourceSpec | undefined {
    return this.sources.get(sourceId);
  }

  list(filter?: { category?: SourceCategory; tier?: AccessTier; publisher?: string; clinicalDomain?: string }): KnowledgeSourceSpec[] {
    const all = [...this.sources.values()];
    if (!filter) return all;
    return all.filter((s) =>
      (!filter.category || s.category === filter.category)
      && (!filter.tier || s.tier === filter.tier)
      && (!filter.publisher || s.publisher === filter.publisher)
      && (!filter.clinicalDomain || s.clinicalDomains.includes(filter.clinicalDomain) || s.clinicalDomains.includes('all'))
    );
  }

  count(): number { return this.sources.size; }

  // -------------------- Pack subscription management --------------------

  subscribe(sub: PackSourceSubscription): void {
    const src = this.sources.get(sub.sourceId);
    if (!src) throw new Error(`unknown source: ${sub.sourceId}`);
    const list = this.subs.get(sub.sourceId) ?? [];
    const idx = list.findIndex((s) => s.packId === sub.packId);
    const stamp = new Date().toISOString();
    const persisted: PackSourceSubscription = { ...sub, updatedAt: stamp, createdAt: idx >= 0 ? list[idx]!.createdAt : stamp };
    if (idx >= 0) list[idx] = persisted; else list.push(persisted);
    this.subs.set(sub.sourceId, list);
    this.persistSubs();
    void this.onEvent({ type: idx >= 0 ? 'subscription-updated' : 'subscription-added', packId: sub.packId, sourceId: sub.sourceId, at: stamp });
  }

  unsubscribe(packId: string, sourceId: string): void {
    const list = this.subs.get(sourceId) ?? [];
    const next = list.filter((s) => s.packId !== packId);
    if (next.length !== list.length) {
      this.subs.set(sourceId, next);
      this.persistSubs();
    }
  }

  subscriptionsForSource(sourceId: string): PackSourceSubscription[] {
    return [...(this.subs.get(sourceId) ?? [])];
  }

  allSubscriptions(): PackSourceSubscription[] {
    const out: PackSourceSubscription[] = [];
    for (const list of this.subs.values()) for (const s of list) out.push(s);
    return out;
  }

  subscriptionsForPack(packId: string): PackSourceSubscription[] {
    const out: PackSourceSubscription[] = [];
    for (const list of this.subs.values()) for (const s of list) if (s.packId === packId) out.push(s);
    return out;
  }

  // -------------------- Cross-cutting views --------------------

  /** Consumer fanout for a source: who uses it, how many workflows/agents/measures, effective cadence. */
  fanout(sourceId: string): SourceConsumerFanout {
    const subs = this.subscriptionsForSource(sourceId);
    const packIds = new Set(subs.map((s) => s.packId));
    let workflows = 0, agents = 0, measures = 0;
    for (const s of subs) for (const u of s.usedBy) {
      if (u.workflowId) workflows++;
      if (u.agentId) agents++;
      if (u.measureId) measures++;
    }
    const effectiveCadence = subs.reduce<Cadence>((strict, s) =>
      CADENCE_STRICTNESS[s.freshnessRequirement] > CADENCE_STRICTNESS[strict] ? s.freshnessRequirement : strict,
      this.sources.get(sourceId)?.cadence ?? 'manual');
    return {
      sourceId,
      totalPacks: packIds.size,
      totalWorkflows: workflows,
      totalAgents: agents,
      totalMeasures: measures,
      subscriptions: subs,
      effectiveCadence,
      anyBlocking: subs.some((s) => s.criticality === 'blocking'),
    };
  }

  /** Knowledge bill of materials for a pack. */
  bill(packId: string, opts?: { hasCredential?: (sourceId: string) => boolean; isStale?: (sourceId: string) => boolean }): PackKnowledgeBill {
    const subs = this.subscriptionsForPack(packId);
    const byCategory = Object.create(null) as Record<SourceCategory, number>;
    const byTier = Object.create(null) as Record<AccessTier, number>;
    const blocking: string[] = [];
    const missingCreds: string[] = [];
    const stale: string[] = [];
    for (const s of subs) {
      const src = this.sources.get(s.sourceId);
      if (!src) continue;
      byCategory[src.category] = (byCategory[src.category] ?? 0) + 1;
      byTier[src.tier] = (byTier[src.tier] ?? 0) + 1;
      if (s.criticality === 'blocking') blocking.push(s.sourceId);
      if (src.requires?.credentialName && opts?.hasCredential && !opts.hasCredential(s.sourceId)) missingCreds.push(s.sourceId);
      if (opts?.isStale?.(s.sourceId)) stale.push(s.sourceId);
    }
    return {
      packId,
      totalSources: subs.length,
      bySources: subs,
      byCategory,
      byTier,
      blockingSources: blocking,
      missingCredentials: missingCreds,
      staleSources: stale,
    };
  }

  /** Aggregate: how many packs each source serves. Useful for UI ordering. */
  reachTable(): { sourceId: string; packs: string[]; usages: number }[] {
    const out: { sourceId: string; packs: string[]; usages: number }[] = [];
    for (const [sourceId, subs] of this.subs.entries()) {
      const packs = [...new Set(subs.map((s) => s.packId))];
      const usages = subs.reduce((n, s) => n + s.usedBy.length, 0);
      out.push({ sourceId, packs, usages });
    }
    out.sort((a, b) => b.packs.length - a.packs.length || b.usages - a.usages);
    return out;
  }

  // -------------------- Persistence --------------------

  private sourcesFile(): string { return join(this.storeDir, 'sources.json'); }
  private subsFile(): string { return join(this.storeDir, 'subscriptions.json'); }

  private persistSources(): void {
    writeFileSync(this.sourcesFile(), JSON.stringify([...this.sources.values()], null, 2));
  }
  private persistSubs(): void {
    const flat: PackSourceSubscription[] = [];
    for (const list of this.subs.values()) flat.push(...list);
    writeFileSync(this.subsFile(), JSON.stringify(flat, null, 2));
  }

  private load(): void {
    if (existsSync(this.sourcesFile())) {
      const arr = JSON.parse(readFileSync(this.sourcesFile(), 'utf8')) as KnowledgeSourceSpec[];
      for (const s of arr) this.sources.set(s.id, s);
    }
    if (existsSync(this.subsFile())) {
      const arr = JSON.parse(readFileSync(this.subsFile(), 'utf8')) as PackSourceSubscription[];
      for (const s of arr) {
        const list = this.subs.get(s.sourceId) ?? [];
        list.push(s);
        this.subs.set(s.sourceId, list);
      }
    }
  }
}
