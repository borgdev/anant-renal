/******************************************************************************
 * Simulator control plane — /admin/simulator/*.
 *
 * The controller is a module singleton (like the swarm workspace) so the
 * boot-time demo hook (dev.ts / bootstrap.ts) can drive the same instance the
 * HTTP layer exposes. Realms created by the controller get the realm → broker
 * bridge attached, so simulated effects stream to Kafka/outbox/webhooks/SSE
 * exactly like real ones.
 ******************************************************************************/

import type { FastifyInstance } from 'fastify';
import { SimulatorController } from '../simulator/controller.js';
import { listScenarios } from '../simulator/scenarios.js';
import type { FleetPersistState, SimRealmDef } from '../simulator/types.js';
import type { Realm } from '../realm/index.js';
import type { RealmEventBridge } from './realm-event-bridge.js';

let controller: SimulatorController | null = null;
let bridge: RealmEventBridge | undefined;

/** The active controller — used by dev/bootstrap to auto-start a demo scenario. */
export function getSimulatorController(): SimulatorController | null {
  return controller;
}

export interface SimulatorPersistence {
  /** Persist the controller's compact fleet record (scenario + status + realm ids). */
  saveFleet(state: FleetPersistState): Promise<void>;
  /** Persist a freshly-created sim realm (creation spec + portable snapshot). */
  persistRealm(realm: Realm, def: SimRealmDef): Promise<void>;
  /** Refresh portable snapshots for the live fleet (control points / periodic). */
  snapshotRealms(realmIds: string[]): Promise<void>;
  /** Drop the persisted fleet (on reset). */
  clearFleet(): Promise<void>;
  /** Wall-ms between periodic fleet snapshots while running; 0 disables. */
  snapshotIntervalMs?: number;
}

export interface SimulatorRouteOptions {
  realmEventBridge?: RealmEventBridge;
  /** Durable fleet persistence (SqlStore-backed in dev/prod; absent in tests). */
  persistence?: SimulatorPersistence;
}

function idleSnapshot() {
  return { status: 'idle' as const, scenario: null, scenarioLabel: null, pace: null, startedAt: null, tickCount: 0, eventCount: 0, totals: { realms: 0, patients: 0, presences: 0, effects: 0 }, realms: [] };
}

export async function registerSimulatorRoutes(app: FastifyInstance, opts: SimulatorRouteOptions = {}): Promise<void> {
  bridge = opts.realmEventBridge;
  const persistence = opts.persistence;
  controller = new SimulatorController({
    onRealmCreated: (realm, def) => {
      if (bridge) bridge.attach(realm);
      if (persistence) void persistence.persistRealm(realm, def).catch(() => undefined);
    },
    persistFleet: (state) => { if (persistence) void persistence.saveFleet(state).catch(() => undefined); },
  });

  // Periodic full-fleet snapshot while running, so a process restart / reload
  // resumes close to live state. Bounded by the controller being running; 0 disables.
  const snapshotTimer = setInterval(() => {
    if (!controller || !persistence || controller.snapshot().status !== 'running') return;
    void persistence.snapshotRealms(controller.fleetRealmIds()).catch(() => undefined);
  }, persistence?.snapshotIntervalMs ?? 0);
  app.addHook('onClose', async () => { clearInterval(snapshotTimer); });

  app.get('/admin/simulator/scenarios', async () => ({ scenarios: listScenarios() }));

  app.get('/admin/simulator/status', async () => ({ simulator: controller ? controller.snapshot() : idleSnapshot() }));

  app.post<{ Body: { scenario?: string; autoRun?: boolean; realmHoursPerTick?: number; wallMsPerTick?: number } }>(
    '/admin/simulator/start',
    async (req, reply) => {
      try {
        if (!controller) return reply.code(503).send({ error: 'simulator-unavailable' });
        const body = req.body ?? {};
        const snapshot = await controller.start(body.scenario ?? 'dialysis-demo', {
          ...(body.autoRun !== undefined ? { autoRun: body.autoRun } : {}),
          ...(body.realmHoursPerTick !== undefined || body.wallMsPerTick !== undefined
            ? { pace: {
                ...(body.realmHoursPerTick !== undefined ? { realmHoursPerTick: body.realmHoursPerTick } : {}),
                ...(body.wallMsPerTick !== undefined ? { wallMsPerTick: body.wallMsPerTick } : {}),
              } }
            : {}),
        });
        if (persistence) await persistence.snapshotRealms(controller.fleetRealmIds()).catch(() => undefined);
        return { ok: true, simulator: snapshot };
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.post('/admin/simulator/pause', async (_req, reply) => {
    if (!controller) return reply.code(503).send({ error: 'simulator-unavailable' });
    try {
      const snapshot = controller.pause();
      if (persistence) await persistence.snapshotRealms(controller.fleetRealmIds()).catch(() => undefined);
      return { ok: true, simulator: snapshot };
    } catch (err) { return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) }); }
  });

  app.post('/admin/simulator/resume', async (_req, reply) => {
    if (!controller) return reply.code(503).send({ error: 'simulator-unavailable' });
    try { return { ok: true, simulator: controller.resume() }; }
    catch (err) { return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) }); }
  });

  app.post<{ Body: { ticks?: number } }>('/admin/simulator/step', async (req, reply) => {
    if (!controller) return reply.code(503).send({ error: 'simulator-unavailable' });
    try {
      const ticks = Math.max(1, Math.min(1000, Math.floor(req.body?.ticks ?? 1)));
      const result = controller.step(ticks);
      if (persistence) await persistence.snapshotRealms(controller.fleetRealmIds()).catch(() => undefined);
      return { ok: true, ...result };
    } catch (err) { return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) }); }
  });

  app.post('/admin/simulator/reset', async () => {
    if (controller) controller.reset();
    if (persistence) await persistence.clearFleet().catch(() => undefined);
    return { ok: true, simulator: controller ? controller.snapshot() : idleSnapshot() };
  });
}
