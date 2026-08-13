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
import type { KnowledgeEvent } from './types.js';

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
  return { sources, adapters, secrets, engine, scheduler };
}
