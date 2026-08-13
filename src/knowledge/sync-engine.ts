// Sync engine — runs an adapter for a source, streams events, returns summary.

import type { AdapterRegistry } from './adapter-registry.js';
import type { SecretRegistry } from './secrets.js';
import type { SourceRegistry } from './source-registry.js';
import type { AdapterEvent, KnowledgeSourceSpec, SyncInput, SyncSummary, KnowledgeEvent } from './types.js';

export interface SyncEngineOptions {
  storeDir: string;
  sources: SourceRegistry;
  adapters: AdapterRegistry;
  secrets: SecretRegistry;
  onEvent?: (event: KnowledgeEvent) => void;
}

export interface RunSyncOptions {
  sourceId: string;
  packHint?: string;               // pack id that triggered this sync
  overridesConfig?: Record<string, unknown>;
  filterIds?: string[];            // artifact-id whitelist
  concurrency?: number;
  actor?: string;                  // who triggered
}

export class SyncEngine {
  constructor(private readonly opts: SyncEngineOptions) {}

  async run(request: RunSyncOptions): Promise<{
    ok: boolean;
    summary?: SyncSummary;
    events: AdapterEvent[];
    error?: string;
  }> {
    const spec = this.opts.sources.get(request.sourceId);
    if (!spec) return { ok: false, events: [], error: `unknown source ${request.sourceId}` };
    const adapter = this.opts.adapters.adapterFor(request.sourceId);
    if (!adapter) return { ok: false, events: [], error: `no adapter bound for ${request.sourceId}` };

    const secretsBundle = this.opts.secrets.bundleFor(request.sourceId);
    const missing = missingSecrets(spec, secretsBundle);
    if (missing.length > 0) {
      return { ok: false, events: [], error: `missing credentials: ${missing.join(', ')}` };
    }

    const input: SyncInput<Record<string, unknown>> = {
      spec,
      storeDir: this.opts.storeDir,
      secrets: secretsBundle,
      config: { ...(spec.fetchConfig as Record<string, unknown>), ...(request.overridesConfig ?? {}) },
      ...(request.filterIds ? { filter: (id: string) => request.filterIds!.includes(id) } : {}),
      ...(request.concurrency ? { concurrency: request.concurrency } : {}),
    };

    const startedAt = new Date().toISOString();
    this.emit({ type: 'sync-started', at: startedAt, sourceId: spec.id });
    const events: AdapterEvent[] = [];
    let summary: SyncSummary | undefined;
    let bytesIn = 0;
    const errors: { at: string; message: string }[] = [];
    try {
      const iter = adapter.sync(input as never);
      let step = await iter.next();
      while (!step.done) {
        const ev = step.value;
        events.push(ev);
        if (ev.type === 'fetch') bytesIn += ev.bytes;
        if (ev.type === 'error') errors.push({ at: new Date().toISOString(), message: ev.message });
        step = await iter.next();
      }
      summary = step.value as SyncSummary;
      const finishedAt = new Date().toISOString();
      this.emit({
        type: 'sync-completed', sourceId: spec.id,
        outcome: {
          sourceId: spec.id, startedAt, finishedAt,
          status: errors.length > 0 ? 'partial' : (summary.totalExtracted === 0 ? 'skipped-unchanged' : 'ok'),
          fetched: summary.totalFetched, extracted: summary.totalExtracted, changes: summary.changes,
          errors, bytesIn,
          ...(summary.upstreamVersion !== undefined ? { upstreamVersion: summary.upstreamVersion } : {}),
          message: `synced ${summary.totalExtracted} artifacts (${summary.changes.length} changes)`,
        },
      });
      return { ok: true, summary, events };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const finishedAt = new Date().toISOString();
      this.emit({
        type: 'sync-completed', sourceId: spec.id,
        outcome: {
          sourceId: spec.id, startedAt, finishedAt, status: 'failed',
          fetched: 0, extracted: 0, changes: [],
          errors: [{ at: finishedAt, message }], bytesIn, message,
        },
      });
      return { ok: false, events, error: message };
    }
  }

  private emit(e: KnowledgeEvent): void { this.opts.onEvent?.(e); }
}

function missingSecrets(spec: KnowledgeSourceSpec, provided: Record<string, string>): string[] {
  const need = spec.requires?.credentialSetup?.fields ?? [];
  return need.filter((f) => f.required !== false && !provided[f.name]).map((f) => f.name);
}
