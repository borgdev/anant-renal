/******************************************************************************
 * Demo cleanup — POST /admin/demo/cleanup.
 *
 * One-shot "clean up the demo":
 *   1. stops the simulator + drops its sim:* realms (and persisted fleet /
 *      sim:* realm specs + snapshots)
 *   2. removes the demo decision fabric (durable outcome episodes + NBA decisions)
 *   3. prunes delivered event_outbox rows (keeps the latest `keepOutbox`,
 *      default 1000) — this is the disk-reclamation step
 *   4. runs any enabled age-based retention policies
 *
 * Read-only catalogs / substrate / admin config are left intact, so the exec
 * console keeps working after cleanup.
 ******************************************************************************/

import type { FastifyInstance } from 'fastify';
import type { SqlStore } from './sql/sql-store.js';
import type { RetentionService } from './retention.js';
import type { SimulatorController } from '../simulator/controller.js';
import type { SwarmWorkspaceStore } from '../swarm/workspace.js';

export interface DemoCleanupOptions {
  store?: SqlStore;
  retention?: RetentionService;
  /** Lazily-resolved simulator controller (null before simulator routes register). */
  simulator?: () => SimulatorController | null;
  /** Lazily-resolved durable swarm workspace (null before swarm routes register). */
  workspace?: () => SwarmWorkspaceStore | null;
  /** Reset the in-memory swarm runtime caches after durable rows are removed. */
  resetRuntime?: () => void;
}

export async function registerDemoCleanupRoutes(app: FastifyInstance, opts: DemoCleanupOptions = {}): Promise<void> {
  app.post<{ Body?: { keepOutbox?: number } }>('/admin/demo/cleanup', async (req) => {
    const keep = Math.max(0, Math.min(50_000, Math.floor(req.body?.keepOutbox ?? 1000)));
    const report: Record<string, unknown> = { at: new Date().toISOString(), keepOutbox: keep };

    // 1. Simulator — stop clocks and drop the sim:* fleet.
    const controller = opts.simulator?.() ?? null;
    let simRealmsRemoved = 0;
    if (controller) {
      const before = controller.fleetRealmIds().length;
      controller.reset();
      simRealmsRemoved = Math.max(0, before - controller.fleetRealmIds().length);
    }
    report.simRealmsRemoved = simRealmsRemoved;

    // 2. Durable decision fabric — demo outcome episodes + NBA decisions.
    const ws = opts.workspace?.() ?? null;
    let episodesRemoved = 0;
    let nbaDecisionsRemoved = 0;
    if (ws) {
      for (const e of await ws.list('outcome-episode')) if (await ws.remove('outcome-episode', e.id)) episodesRemoved += 1;
      for (const d of await ws.list('nba-decision')) if (await ws.remove('nba-decision', d.id)) nbaDecisionsRemoved += 1;
    }
    report.episodesRemoved = episodesRemoved;
    report.nbaDecisionsRemoved = nbaDecisionsRemoved;

    // 2b. Clear in-memory swarm runtime caches so the durable deletions take effect
    // immediately (coordinator cache + reference demo boundary).
    opts.resetRuntime?.();

    // 3. Persisted sim artifacts — fleet + sim:* realm specs/snapshots.
    if (opts.store) {
      if (typeof (opts.store as { clearSimulatorFleet?: unknown }).clearSimulatorFleet === 'function') {
        await opts.store.clearSimulatorFleet();
      }
      for (const s of await opts.store.listRealmSpecs()) {
        if (s.realmId.startsWith('sim:')) await opts.store.deleteRealmSpec(s.realmId);
      }
      for (const s of await opts.store.listRealmSnapshots()) {
        if (s.realmId.startsWith('sim:')) await opts.store.deleteRealmSnapshot(s.realmId);
      }
    }

    // 4. Event outbox — prune delivered rows keeping the latest `keep` (disk reclamation).
    let outboxRemoved = 0;
    if (opts.store && typeof (opts.store as { pruneOutboxDelivered?: unknown }).pruneOutboxDelivered === 'function') {
      outboxRemoved = await opts.store.pruneOutboxDelivered(keep);
    }
    report.outboxDeliveredRemoved = outboxRemoved;
    if (opts.store) report.outboxCounts = await opts.store.outboxCounts();

    // 5. Age-based retention policies.
    if (opts.retention) report.retentionDeleted = await opts.retention.purge();

    // 6. Compact the DB file (SQLite only, best-effort) so freed pages return to disk.
    let vacuumed = false;
    if (opts.store && typeof (opts.store as { vacuum?: unknown }).vacuum === 'function') {
      vacuumed = await opts.store.vacuum();
    }
    report.vacuumed = vacuumed;

    return { ok: true, report };
  });
}
