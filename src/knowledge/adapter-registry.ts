/******************************************************************************
 *
 * Copyright (c) 2026 AnantHQ Inc.
 * All Rights Reserved.
 *
 * This software is licensed, not sold.
 *
 * The contents of this file constitute confidential and proprietary
 * information belonging exclusively to Unison Software Technologies Pvt. Ltd.
 *
 * This source code incorporates proprietary algorithms, software architecture,
 * business logic, computational methods, optimization techniques,
 * workflows, data structures, APIs, and implementation details that are
 * protected by copyright law, patent law, trade secret law, and
 * international intellectual property treaties.
 *
 * Except as expressly permitted by a written license agreement,
 * no person or organization may:
 *
 *   • Copy or reproduce this software.
 *   • Modify or create derivative works.
 *   • Reverse engineer, decompile, or disassemble.
 *   • Benchmark or publicly disclose performance.
 *   • Redistribute, sublicense, lease, rent, or sell.
 *   • Use this software for competitive analysis.
 *   • Disclose any implementation details.
 *
 * Any unauthorized use is strictly prohibited and may result in
 * civil damages, injunctive relief, criminal prosecution,
 * and all other remedies available under applicable law.
 *
 ******************************************************************************/

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
