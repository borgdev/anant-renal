// Wires source id → adapter implementation.

import type { KnowledgeAdapter } from './types.js';

export class AdapterRegistry {
  private readonly byKind = new Map<string, KnowledgeAdapter>();
  private readonly bySource = new Map<string, string>(); // sourceId → adapter kind

  registerAdapter(adapter: KnowledgeAdapter): void {
    this.byKind.set(adapter.kind, adapter);
  }
  bind(sourceId: string, adapterKind: string): void {
    this.bySource.set(sourceId, adapterKind);
  }
  adapterFor(sourceId: string): KnowledgeAdapter | undefined {
    const kind = this.bySource.get(sourceId);
    if (!kind) return undefined;
    return this.byKind.get(kind);
  }
  list(): { sourceId: string; adapterKind: string }[] {
    return [...this.bySource.entries()].map(([sourceId, adapterKind]) => ({ sourceId, adapterKind }));
  }
}
