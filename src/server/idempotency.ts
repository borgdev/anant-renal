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

// Idempotency-Key support (Phase 4). A client-supplied key makes a write
// safe to retry: the first request computes + caches the response; repeat
// requests (same key) return the cached response without re-applying side
// effects. A same-key/different-body conflict is rejected.

import { createHash, randomUUID } from 'node:crypto';
import type { SqlStore } from './sql/sql-store.js';

export class IdempotencyConflict extends Error {
  constructor(key: string) { super(`idempotency key ${key} was already used for a different request`); this.name = 'IdempotencyConflict'; }
}

export interface IdempotencyResult {
  readonly key: string;
  readonly response: unknown;
  readonly replayed: boolean;
}

function hash(v: unknown): string {
  return createHash('sha256').update(JSON.stringify(v ?? null)).digest('hex');
}

export class IdempotencyRegistry {
  constructor(private readonly store: SqlStore, private readonly scopeId = 'scope:*') {}

  async resolve(
    key: string,
    method: string,
    path: string,
    body: unknown,
    compute: () => Promise<unknown>,
  ): Promise<IdempotencyResult> {
    const requestHash = hash(body);
    const existing = await this.store.getIdempotencyKeyById(key);
    if (existing) {
      if (existing.requestHash !== requestHash) throw new IdempotencyConflict(key);
      return { key, response: JSON.parse(existing.responseJson ?? 'null'), replayed: true };
    }
    const response = await compute();
    await this.store.saveIdempotencyKey({
      id: key, scopeId: this.scopeId, method, path, requestHash,
      responseJson: JSON.stringify(response), createdAt: new Date().toISOString(),
    });
    return { key, response, replayed: false };
  }

  /** Generate a fresh key for callers that don't supply one. */
  fresh(): string { return randomUUID(); }
}
