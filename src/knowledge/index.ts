// M20 Knowledge Layer — public API + bootstrap.

export * from './types.js';
export { SourceRegistry } from './source-registry.js';
export { CANONICAL_SOURCES, TIER1_SOURCES, TIER2_SOURCES } from './catalog.js';
export { CANONICAL_SUBSCRIPTIONS, withTimestamps } from './pack-subscriptions.js';
export { AdapterRegistry } from './adapter-registry.js';
export { buildAdapterRegistry } from './adapters/index.js';
export { SecretRegistry } from './secrets.js';
export { SyncEngine } from './sync-engine.js';
export type { RunSyncOptions } from './sync-engine.js';
export { SyncScheduler } from './scheduler.js';

import { SourceRegistry } from './source-registry.js';
import { CANONICAL_SOURCES } from './catalog.js';
import { CANONICAL_SUBSCRIPTIONS, withTimestamps } from './pack-subscriptions.js';
import { buildAdapterRegistry } from './adapters/index.js';
import { SecretRegistry } from './secrets.js';
import { SyncEngine } from './sync-engine.js';
import { SyncScheduler } from './scheduler.js';
import type { KnowledgeArtifact, KnowledgeEvent } from './types.js';
import { openSourceStore, loadManifest, type SourceManifest } from './adapters/base.js';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export interface BootstrapOpts {
  storeDir: string;
  onEvent?: (e: KnowledgeEvent) => void | Promise<void>;
  /** Skip subscription re-registration on cold boot if false. Defaults to true. */
  reseedSubscriptions?: boolean;
}

export interface KnowledgeLayer {
  sources: SourceRegistry;
  adapters: ReturnType<typeof buildAdapterRegistry>;
  secrets: SecretRegistry;
  engine: SyncEngine;
  scheduler: SyncScheduler;
  readManifest(sourceId: string): Promise<SourceManifest | null>;
  readArtifact(sourceId: string, artifactId: string): Promise<KnowledgeArtifact | null>;
  listArtifacts(sourceId: string, offset?: number, limit?: number): Promise<{ total: number; artifacts: KnowledgeArtifact[] }>;
}

/**
 * Boot the knowledge layer: register canonical sources, pack subscriptions,
 * adapters, secret registry, sync engine, and scheduler. Idempotent.
 */
export function bootstrapKnowledgeLayer(opts: BootstrapOpts): KnowledgeLayer {
  const forward = opts.onEvent ? (e: KnowledgeEvent) => { void opts.onEvent!(e); } : undefined;
  const sources = new SourceRegistry({ storeDir: opts.storeDir, ...(forward ? { onEvent: forward } : {}) });
  sources.registerMany(CANONICAL_SOURCES);
  if (opts.reseedSubscriptions !== false) {
    for (const s of CANONICAL_SUBSCRIPTIONS) sources.subscribe(withTimestamps(s));
  }
  const adapters = buildAdapterRegistry(CANONICAL_SOURCES);
  const secrets = new SecretRegistry(opts.storeDir);
  const engine = new SyncEngine({
    storeDir: opts.storeDir,
    sources,
    adapters,
    secrets,
    ...(forward ? { onEvent: forward } : {}),
  });
  const scheduler = new SyncScheduler({
    storeDir: opts.storeDir,
    sources,
    engine,
    ...(forward ? { onEvent: forward } : {}),
  });
  const readManifest = async (sourceId: string): Promise<SourceManifest | null> => {
    const store = openSourceStore(opts.storeDir, sourceId);
    if (!existsSync(store.manifestPath)) return null;
    return loadManifest(store, sourceId);
  };
  const readArtifact = async (sourceId: string, artifactId: string): Promise<KnowledgeArtifact | null> => {
    const store = openSourceStore(opts.storeDir, sourceId);
    const manifest = loadManifest(store, sourceId);
    const row = manifest.artifactIndex.find(r => r.id === artifactId);
    if (!row) return null;
    const path = join(store.root, row.path);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8')) as KnowledgeArtifact;
  };
  const listArtifacts = async (sourceId: string, offset = 0, limit = 20): Promise<{ total: number; artifacts: KnowledgeArtifact[] }> => {
    const manifest = await readManifest(sourceId);
    if (!manifest) return { total: 0, artifacts: [] };
    const rows = manifest.artifactIndex.slice(offset, offset + limit);
    const artifacts: KnowledgeArtifact[] = [];
    for (const r of rows) { const a = await readArtifact(sourceId, r.id); if (a) artifacts.push(a); }
    return { total: manifest.artifactIndex.length, artifacts };
  };
  return { sources, adapters, secrets, engine, scheduler, readManifest, readArtifact, listArtifacts };
}
