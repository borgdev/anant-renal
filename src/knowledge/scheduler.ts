// Cadence-driven scheduler — runs syncs when they come due based on
// KnowledgeSourceSpec.cadence + manifest.lastSyncedAt.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SyncEngine } from './sync-engine.js';
import type { SourceRegistry } from './source-registry.js';
import type { KnowledgeEvent } from './types.js';

export type Cadence = 'realtime' | 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'annual' | 'on-demand';

const CADENCE_MS: Record<Cadence, number> = {
  realtime: 60 * 60 * 1000,        // treat as hourly ceiling
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
  quarterly: 90 * 24 * 60 * 60 * 1000,
  annual: 365 * 24 * 60 * 60 * 1000,
  'on-demand': Number.POSITIVE_INFINITY,
};

export interface SchedulerOptions {
  storeDir: string;
  sources: SourceRegistry;
  engine: SyncEngine;
  onEvent?: (e: KnowledgeEvent) => void;
  clock?: () => number;
}

export class SyncScheduler {
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly opts: SchedulerOptions) {}

  /** Compute the next due sources without triggering them. */
  dueSources(): { sourceId: string; cadence: Cadence; lastSyncedAt: string | null; overdueBy: number }[] {
    const now = (this.opts.clock ?? Date.now)();
    const out: { sourceId: string; cadence: Cadence; lastSyncedAt: string | null; overdueBy: number }[] = [];
    for (const spec of this.opts.sources.list()) {
      const cadence = spec.cadence as Cadence;
      if (cadence === 'on-demand') continue;
      const manifest = readManifest(this.opts.storeDir, spec.id);
      const last = manifest?.lastSyncedAt ?? null;
      const lastMs = last ? Date.parse(last) : 0;
      const dueAt = lastMs + CADENCE_MS[cadence];
      if (now >= dueAt) out.push({ sourceId: spec.id, cadence, lastSyncedAt: last, overdueBy: now - dueAt });
    }
    return out.sort((a, b) => b.overdueBy - a.overdueBy);
  }

  /** Run all due syncs sequentially. */
  async runDueOnce(actor = 'scheduler'): Promise<{ sourceId: string; ok: boolean; error?: string }[]> {
    const due = this.dueSources();
    const results: { sourceId: string; ok: boolean; error?: string }[] = [];
    for (const { sourceId } of due) {
      const r = await this.opts.engine.run({ sourceId, actor });
      const out: { sourceId: string; ok: boolean; error?: string } = { sourceId, ok: r.ok };
      if (r.error !== undefined) out.error = r.error;
      results.push(out);
    }
    return results;
  }

  /** Start a low-resolution poll loop (default: every 10 minutes). */
  start(intervalMs = 10 * 60 * 1000): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.runDueOnce(); }, intervalMs);
  }
  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
}

function readManifest(storeDir: string, sourceId: string): { lastSyncedAt?: string } | null {
  const f = join(storeDir, sourceId, 'manifest.json');
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, 'utf8')) as { lastSyncedAt?: string }; } catch { return null; }
}
