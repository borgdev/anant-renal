// M20 Knowledge Layer — public API + bootstrap.

export * from './types.js';
export { SourceRegistry } from './source-registry.js';
export { CANONICAL_SOURCES, TIER1_SOURCES, TIER2_SOURCES } from './catalog.js';
export { CANONICAL_SUBSCRIPTIONS, withTimestamps } from './pack-subscriptions.js';

import { SourceRegistry } from './source-registry.js';
import { CANONICAL_SOURCES } from './catalog.js';
import { CANONICAL_SUBSCRIPTIONS, withTimestamps } from './pack-subscriptions.js';
import type { KnowledgeEvent } from './types.js';

export interface BootstrapOpts {
  storeDir: string;
  onEvent?: (e: KnowledgeEvent) => void | Promise<void>;
  /** Skip subscription re-registration on cold boot if false. Defaults to true. */
  reseedSubscriptions?: boolean;
}

/**
 * Boot the knowledge layer: register canonical sources and pack subscriptions.
 * Idempotent — safe to call every process start.
 */
export function bootstrapKnowledgeLayer(opts: BootstrapOpts): SourceRegistry {
  const reg = new SourceRegistry({ storeDir: opts.storeDir, ...(opts.onEvent ? { onEvent: opts.onEvent } : {}) });
  reg.registerMany(CANONICAL_SOURCES);
  if (opts.reseedSubscriptions !== false) {
    for (const s of CANONICAL_SUBSCRIPTIONS) reg.subscribe(withTimestamps(s));
  }
  return reg;
}
