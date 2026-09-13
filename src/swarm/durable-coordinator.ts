/******************************************************************************
 *
 * Copyright (c) 2026 AnantHQ Inc.
 * All Rights Reserved.
 *
 * This software is licensed, not sold.
 *
 * The contents of this file constitute confidential and proprietary
 * information belonging exclusively to AnantHQ Inc.
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

/******************************************************************************
 * Persistent outcome coordinator — makes the outcome-episode state machine
 * durable across polls and restarts.
 *
 * The base `OutcomeEpisodeCoordinator` is in-memory. Every mutation this
 * subclass performs is also persisted (fire-and-forget) to the workspace store's
 * `outcome-episode` kind, and on boot the store is re-hydrated so episode
 * identity and dossiers survive a process restart. Reads stay synchronous and
 * in-memory (the map is the source of truth); the store is a durability log.
 ******************************************************************************/

import type { SwarmWorkspaceStore } from './workspace.js';
import { OutcomeEpisodeCoordinator, type OutcomeEpisode } from './outcome-episode.js';

/** OutcomeEpisode as persisted by the workspace store (id/createdAt/updatedAt injected). */
type StoredOutcomeEpisode = OutcomeEpisode & { id: string; createdAt: string; updatedAt: string };

export class PersistentOutcomeCoordinator extends OutcomeEpisodeCoordinator {
  private loaded: Promise<void> | null = null;

  constructor(private readonly store?: SwarmWorkspaceStore) {
    super();
  }

  /** Hydrate from the durable store once; safe to call many times. */
  ensureLoaded(): Promise<void> {
    if (!this.loaded) this.loaded = this.hydrate();
    return this.loaded;
  }

  private async hydrate(): Promise<void> {
    if (!this.store) return;
    const rows = await this.store.list<StoredOutcomeEpisode>('outcome-episode');
    for (const row of rows) this.import(row);
  }

  protected override commit(e: OutcomeEpisode): void {
    if (!this.store) return;
    // Fire-and-forget durability: the in-memory map is authoritative for reads;
    // the row is rewritten on every mutation so it survives a restart.
    void this.store
      .create<StoredOutcomeEpisode>('outcome-episode', e.episodeId, e as StoredOutcomeEpisode)
      .catch(() => undefined);
  }

  protected override commitRemove(id: string): void {
    if (!this.store) return;
    void this.store.remove('outcome-episode', id).catch(() => undefined);
  }

  /** Drop all in-memory episodes (durable rows are removed separately by the
   *  demo cleanup path) and force a fresh hydrate on the next read. */
  reset(): void {
    this.clear();
    this.loaded = null;
  }
}
