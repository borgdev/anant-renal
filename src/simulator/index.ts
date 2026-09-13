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
