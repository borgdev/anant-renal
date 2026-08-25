/******************************************************************************
 * Simulator — a start/stop/step-able scenario driver that generates ticks and
 * events so the WHOLE system runs on synthetic data for demos.
 *
 * Design (grounded):
 *   • The realm layer (`src/realm/realm.ts`) is already a running, tickable
 *     world: AcceleratedClock (1 realm-hour per 50ms in sim), ambient
 *     processes (labs/vitals/insurance + the liquid CfC/LTC trajectory), the
 *     EffectReducer (30 WorldEffect kinds), ledger, rules → experiences,
 *     perception, HITL, cost.
 *   • The swarm reasoners (`src/swarm/*`) and the exec console already run off
 *     real realm snapshots + ledger events — they light up automatically as
 *     soon as a realm produces effects.
 *   • So the simulator only adds the BOTTOM layer: a controller that builds a
 *     fleet of realms from a declarative scenario and a ScriptedEventGenerator
 *     that emits realistic WorldEffects on a realm-time schedule. Everything
 *     above (swarm insights/NBA, exec feed, broker/outbox, measures) is
 *     downstream and already wired.
 *
 * The controller is deterministic (seeded RNG + seeded realm clock), can
 * start/pause/resume/step/reset, and is isolated to `sim:*` realm ids so it
 * can be torn down without touching prod realms or persisted specs.
 ******************************************************************************/

export * from './types.js';
export * from './rng.js';
export * from './script.js';
export * from './scenarios.js';
export * from './controller.js';
