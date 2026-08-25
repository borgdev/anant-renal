/******************************************************************************
 * Simulator persistence — the demo fleet survives process restarts / reloads.
 *
 *   • saveFleetState/loadFleetState/clearFleetState — the controller's compact
 *     fleet record (scenario + status + counters + realm ids) in SqlStore.
 *   • saveSimRealm — persist a sim realm's creation spec (so restoreRealmsFromSpecs
 *     rebuilds its structure) + a full portable snapshot (so its accumulated
 *     state — patients, presences, ledger, clock — is restored).
 *   • snapshotSimRealms — refresh portable snapshots for the fleet at control
 *     points (start/step/pause/resume) so restarts resume close to live state.
 *   • resumeSimulatorFleet — after realms are restored on boot, re-wire the
 *     controller to the restored fleet (script generators + bridge + counters)
 *     and restart the clocks if it was running.
 *
 * Everything lands in the swappable SqlStore, so on `HH_STORAGE=postgres` the
 * fleet + realm state are persisted in Postgres exactly like the rest of the
 * durable product state.
 ******************************************************************************/

import { captureSnapshot, type Realm } from '../realm/index.js';
import { SimulatorController } from '../simulator/controller.js';
import type { FleetPersistState, SimRealmDef } from '../simulator/types.js';
import type { SqlStore } from './sql/sql-store.js';

export async function saveFleetState(store: SqlStore, state: FleetPersistState): Promise<void> {
  await store.saveSimulatorFleet({
    scenarioId: state.scenarioId,
    status: state.status,
    startedAt: state.startedAt,
    tickCount: state.tickCount,
    eventCount: state.eventCount,
    fleetJson: JSON.stringify({ realmIds: state.realmIds }),
  });
}

export async function loadFleetState(store: SqlStore): Promise<FleetPersistState | null> {
  const row = await store.getSimulatorFleet();
  if (!row) return null;
  let realmIds: string[] = [];
  try { realmIds = (JSON.parse(row.fleetJson) as { realmIds?: string[] }).realmIds ?? []; } catch { realmIds = []; }
  return {
    scenarioId: row.scenarioId,
    status: (row.status === 'running' || row.status === 'paused' ? row.status : 'idle'),
    startedAt: row.startedAt,
    tickCount: row.tickCount,
    eventCount: row.eventCount,
    realmIds,
  };
}

export async function clearFleetState(store: SqlStore): Promise<void> {
  await store.clearSimulatorFleet();
}

/** Persist one sim realm: creation spec (structure) + a full portable snapshot. */
export async function saveSimRealm(store: SqlStore, realm: Realm, def: SimRealmDef): Promise<void> {
  try {
    await store.saveRealmSpec({
      realmId: realm.id,
      mode: 'sim',
      ...(def.trajectoryEngine ? { trajectoryEngine: def.trajectoryEngine } : {}),
      specJson: JSON.stringify({ seed: def.facility, trajectoryEngine: def.trajectoryEngine }),
      createdAt: new Date().toISOString(),
    });
  } catch { /* best-effort — fleet still runs in-memory */ }
  await snapshotSimRealm(store, realm);
}

export async function snapshotSimRealm(store: SqlStore, realm: Realm): Promise<void> {
  try {
    const snapshot = captureSnapshot(realm);
    await store.saveRealmSnapshot({
      realmId: realm.id,
      mode: realm.mode,
      createdAt: new Date().toISOString(),
      snapshotJson: JSON.stringify(snapshot),
    });
  } catch { /* best-effort */ }
}

/** Snapshot every live fleet realm (control-point freshness for restarts). */
export async function snapshotSimRealms(store: SqlStore, realmIds: string[]): Promise<void> {
  for (const id of realmIds) {
    const realm = (await import('../realm/registry.js')).RealmRegistry.get(id);
    if (realm) await snapshotSimRealm(store, realm);
  }
}

/** SqlStore-backed adapter for the simulator routes' SimulatorPersistence seam. */
export function sqlSimulatorPersistence(store: SqlStore, opts: { snapshotIntervalMs?: number } = {}): {
  saveFleet(state: FleetPersistState): Promise<void>;
  persistRealm(realm: Realm, def: SimRealmDef): Promise<void>;
  snapshotRealms(realmIds: string[]): Promise<void>;
  clearFleet(): Promise<void>;
  snapshotIntervalMs: number;
} {
  return {
    saveFleet: (state) => saveFleetState(store, state),
    persistRealm: (realm, def) => saveSimRealm(store, realm, def),
    snapshotRealms: (realmIds) => snapshotSimRealms(store, realmIds),
    clearFleet: () => clearFleetState(store),
    snapshotIntervalMs: opts.snapshotIntervalMs ?? 20_000,
  };
}

/**
 * After restoreRealmsFromSpecs has rebuilt the persisted realms, adopt the
 * persisted fleet back onto the controller so controls / script generators /
 * broker bridge keep working and the clocks resume if it was running.
 */
export async function resumeSimulatorFleet(controller: SimulatorController | null, store: SqlStore): Promise<void> {
  if (!controller) return;
  const state = await loadFleetState(store);
  if (!state || state.status === 'idle') return;
  if (controller.scenarioId) return; // a fresh scenario was already started (HH_DEMO_SIM)
  try {
    await controller.adopt({
      scenarioId: state.scenarioId,
      status: state.status,
      startedAt: state.startedAt,
      tickCount: state.tickCount,
      eventCount: state.eventCount,
      realmIds: state.realmIds,
    });
  } catch {
    // If adopt fails (e.g. scenario removed), drop the stale fleet record so we
    // don't wedge the boot; the console stays usable and the user can restart.
    await clearFleetState(store).catch(() => undefined);
  }
}
