/******************************************************************************
 * Simulator — shared vocabulary.
 ******************************************************************************/

import type { Realm } from '../realm/realm.js';
import type { WorldEffect } from '../realm/types.js';
import type { FacilitySeed } from '../realm/sim-populator.js';

/** The agent roles the simulator may emit through (subset of AgentPresence.role). */
export type SimRole = 'md' | 'nurse' | 'coder' | 'ops' | 'admin';

/** Input handed to a script entry's `emit` builder on each fire. */
export interface ScriptEmitInput {
  realm: Realm;
  /** Seeded per-patient ids currently in the realm graph. */
  patientIds: string[];
  /** Deterministic 0..1 source (mulberry32 seeded by the scenario). */
  rng: () => number;
  realmAt: Date;
  seq: number;
  /** Realm-hours elapsed since the scenario clock started. */
  elapsedHours: number;
}

/** One scripted schedule entry — fires once (atHour) or repeatedly (everyHours). */
export interface SimScriptEntry {
  id: string;
  /** Fire once when the realm clock has passed this many realm-hours since start (0 = first tick). */
  atHour?: number;
  /** Fire every N realm-hours (accumulating; never skipped even if a tick jumps hours). */
  everyHours?: number;
  /** Emit through this role's presence (must be spawned by the scenario). */
  viaRole: SimRole;
  /** Build the WorldEffects for this fire. Return [] to skip. */
  emit: (input: ScriptEmitInput) => WorldEffect[];
}

export interface SimScript {
  entries: SimScriptEntry[];
}

/** Real/wall pacing for the scenario (AcceleratedClock options). */
export interface SimPace {
  /** Realm hours advanced per clock tick. */
  realmHoursPerTick: number;
  /** Wall milliseconds between ticks. */
  wallMsPerTick: number;
}

export interface SimRealmDef {
  id: string;
  /** 'liquid' runs the real CfC/LTC WASM engine per patient; 'legacy' the hand-authored physiology. */
  trajectoryEngine?: 'legacy' | 'liquid';
  facility: FacilitySeed;
  /** Roles to spawn as presences (used as emitters + the swarm can observe them). */
  presences: SimRole[];
  script: SimScript;
}

export interface SimScenario {
  id: string;
  label: string;
  description: string;
  /** Seeded RNG + realm clock start — the whole scenario is reproducible. */
  seed: number;
  /** Realm clock start instant. */
  startAt: Date;
  pace: SimPace;
  realms: SimRealmDef[];
}

export type SimulatorStatus = 'idle' | 'running' | 'paused';

/** Minimal controller state persisted so a running fleet survives process restarts. */
export interface FleetPersistState {
  scenarioId: string;
  status: SimulatorStatus;
  startedAt: string | null;
  tickCount: number;
  eventCount: number;
  realmIds: string[];
}

export interface SimRealmStatus {
  id: string;
  mode: string;
  trajectoryEngine: string | undefined;
  seq: number;
  realmAt: string;
  patients: number;
  presences: number;
  effects: number;
  pendingApprovals: number;
}

export interface SimulatorSnapshot {
  status: SimulatorStatus;
  scenario: string | null;
  scenarioLabel: string | null;
  pace: SimPace | null;
  startedAt: string | null;
  tickCount: number;
  eventCount: number;
  totals: { realms: number; patients: number; presences: number; effects: number };
  realms: SimRealmStatus[];
}
