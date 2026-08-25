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

// AgentRegistry — resolves AgentSpecs by id/version/scope.
//
// Backed by an in-memory map at runtime; sources are two-fold:
//   1. YAML files in packs (git source of truth), loaded at boot
//   2. Postgres mirror table (for hot-edits via Studio between deploys)
//
// The registry does not fetch or sync — it accepts fully-validated specs and
// serves lookups. The sync loop lives in `spec-sync.ts`.

import type { AgentSpec } from './spec.js';

export interface AgentRegistrySnapshot {
  readonly count: number;
  readonly agents: readonly { id: string; version: string; packId: string; scope: string }[];
}

export class AgentRegistry {
  private readonly byIdVersion = new Map<string, AgentSpec>();
  private readonly latestVersionById = new Map<string, string>();

  register(spec: AgentSpec): void {
    const key = `${spec.id}@${spec.version}`;
    this.byIdVersion.set(key, spec);
    const currentLatest = this.latestVersionById.get(spec.id);
    if (!currentLatest || semverGt(spec.version, currentLatest)) this.latestVersionById.set(spec.id, spec.version);
  }
  unregister(id: string, version: string): boolean {
    const key = `${id}@${version}`;
    const removed = this.byIdVersion.delete(key);
    if (this.latestVersionById.get(id) === version) {
      // Recompute latest.
      let latest: string | undefined;
      for (const k of this.byIdVersion.keys()) {
        const [kid, kver] = k.split('@');
        if (kid === id && kver && (!latest || semverGt(kver, latest))) latest = kver;
      }
      if (latest) this.latestVersionById.set(id, latest);
      else this.latestVersionById.delete(id);
    }
    return removed;
  }
  get(id: string, version?: string): AgentSpec | undefined {
    const v = version ?? this.latestVersionById.get(id);
    if (!v) return undefined;
    return this.byIdVersion.get(`${id}@${v}`);
  }
  list(scope?: AgentSpec['scope']): readonly AgentSpec[] {
    const out: AgentSpec[] = [];
    for (const s of this.byIdVersion.values()) if (!scope || s.scope === scope) out.push(s);
    return out;
  }
  snapshot(): AgentRegistrySnapshot {
    const agents = Array.from(this.byIdVersion.values()).map((s) => ({ id: s.id, version: s.version, packId: s.packId, scope: s.scope }));
    return { count: agents.length, agents };
  }
}

function semverGt(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const av = pa[i] ?? 0; const bv = pb[i] ?? 0;
    if (av > bv) return true;
    if (av < bv) return false;
  }
  return false;
}
