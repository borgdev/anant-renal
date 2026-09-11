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
import { FleetGovernor, type GovernorThresholds } from '../simulator/governor.js';
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
  /**
   * Undelivered backlog (outbox pending), used to hold generation to what the rest
   * of the system can consume. Absent → the fleet runs at its configured pace.
   */
  readBacklog?: () => Promise<number>;
  /** Governor thresholds/behaviour override (tests use this). */
  governor?: Partial<GovernorThresholds>;
}

function idleSnapshot() {
  return { status: 'idle' as const, scenario: null, scenarioLabel: null, pace: null, startedAt: null, tickCount: 0, eventCount: 0, totals: { realms: 0, patients: 0, presences: 0, effects: 0 }, realms: [] };
}

export async function registerSimulatorRoutes(app: FastifyInstance, opts: SimulatorRouteOptions = {}): Promise<void> {
  bridge = opts.realmEventBridge;
  const persistence = opts.persistence;
  // Persistence here is best-effort ON THE HOT PATH (a tick must not block on a
  // write), but a failure must never be silent: discarding the error entirely
  // meant a fleet that was never saved looked identical to one that was, until a
  // restart came back with no worlds. Failures are logged once per signal so a
  // broken store does not flood the log either.
  const warnOnce = (() => {
    const seen = new Set<string>();
    return (what: string, err: unknown) => {
      if (seen.has(what)) return;
      seen.add(what);
      app.log.warn(`[simulator] ${what} failed and will not survive a restart: ${err instanceof Error ? err.message : String(err)}`);
    };
  })();
  controller = new SimulatorController({
    onRealmCreated: (realm, def) => {
      if (bridge) bridge.attach(realm);
      if (persistence) void persistence.persistRealm(realm, def).catch((err: unknown) => warnOnce('persistRealm', err));
    },
    persistFleet: (state) => { if (persistence) void persistence.saveFleet(state).catch((err: unknown) => warnOnce('saveFleet', err)); },
  });

  // Periodic full-fleet snapshot while running, so a process restart / reload
  // resumes close to live state. Bounded by the controller being running; 0 disables.
  const snapshotTimer = setInterval(() => {
    if (!controller || !persistence || controller.snapshot().status !== 'running') return;
    void persistence.snapshotRealms(controller.fleetRealmIds()).catch(() => undefined);
  }, persistence?.snapshotIntervalMs ?? 0);

  // Cadence coupling: hold generation to what downstream consumes. Without this
  // the fleet is an unbounded producer — measured at ~74 events/s produced against
  // ~59/s delivered, one core pinned, backlog growing indefinitely. The governor
  // slows the clocks (and pauses them if the backlog keeps climbing) instead of
  // leaving the consumer to lose the race.
  let governor: FleetGovernor | null = null;
  let governorTimer: ReturnType<typeof setInterval> | undefined;
  if (opts.readBacklog && controller) {
    const control = controller;
    governor = new FleetGovernor({
      readBacklog: opts.readBacklog,
      isRunning: () => control.snapshot().status === 'running',
      setTickInterval: (ms) => control.setTickInterval(ms),
      stopClocks: () => { try { control.pause(); } catch { /* not started */ } },
      startClocks: () => { try { control.resume(); } catch { /* not started */ } },
      baseTickIntervalMs: control.baseTickIntervalMs(),
      ...(opts.governor ? { thresholds: opts.governor } : {}),
      onDecision: (report) => app.log.warn(`[simulator] governor ${report.state}: ${report.lastReason}`),
    });
    // 2s: fast enough to react before the backlog compounds, slow enough to stay
    // off the hot path. Each step is one count query.
    governorTimer = setInterval(() => { void governor?.step().catch(() => undefined); }, 2000);
    governorTimer.unref?.();
  }
  app.addHook('onClose', async () => {
    clearInterval(snapshotTimer);
    if (governorTimer) clearInterval(governorTimer);
  });

  app.get('/admin/simulator/scenarios', async () => ({ scenarios: listScenarios() }));

  app.get('/admin/simulator/status', async () => ({
    simulator: controller ? controller.snapshot() : idleSnapshot(),
    // Visible on purpose: a fleet that slows itself without saying so is its own
    // kind of silent failure.
    governor: governor ? governor.report() : null,
  }));

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
