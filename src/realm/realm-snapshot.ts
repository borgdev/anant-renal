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

// M14.G — Realm snapshot + restore
//
// Captures a *portable* snapshot of a running realm's essential state:
//   - identity (id, mode, seq, realmAt)
//   - full effect ledger (source of truth — replay-friendly)
//   - self-model preference weights per presence
//   - presence roster (so replay can rehydrate roles without re-spawning)
//   - open plans + intents
//   - open HITL approvals
//
// Restore rebuilds a fresh realm (via a builder callback), then re-applies the
// self-model deltas and re-registers pending HITL approvals so an operator can
// pick up mid-flight. This is not a wire-format guarantee; snapshots are
// versioned so incompatible ones fail loudly rather than silently drifting.

import type { Realm } from './realm.js';
import type { AgentPresence, EmittedEffect, EntityKind, EntityUrn } from './types.js';
import type { Intent, PlanGraph } from './planner.js';

export const SNAPSHOT_VERSION = 'hh-realm-snapshot@1';

/** Portable entity-graph record (kind/id/state/relations — enough to re-create). */
export interface SnapshotEntity {
  kind: EntityKind;
  id: string;
  state: Record<string, unknown>;
  relations: Record<string, string[]>;
}

export interface RealmSnapshotV1 {
  version: typeof SNAPSHOT_VERSION;
  capturedAt: string; // wall time
  realm: {
    id: string;
    mode: string;
    seq: number;
    realmAt: string;
  };
  /** Entity graph (patients, units, facilities, vitals/labs state) — restored so trajectories survive. */
  entities?: SnapshotEntity[];
  presences: AgentPresence[];
  selfModels: Array<{
    presenceId: string;
    preferences: Record<string, number>;
    competence: { sample: number; score: number };
  }>;
  effects: EmittedEffect[];
  intents: Intent[];
  plans: PlanGraph[];
  pendingHitl: Array<{ approvalId: string; presenceId: string; effect: EmittedEffect['effect']; gateId: string }>;
}

export interface RestoreOptions {
  /** If true, replay the effect ledger through the fresh realm's reducer. Otherwise ledger is copied verbatim. */
  replayEffects?: boolean;
  /** Cap how far back to replay (default: entire ledger). */
  fromSeq?: number;
}

/** Capture a serializable snapshot from a live realm. */
export function captureSnapshot(realm: Realm): RealmSnapshotV1 {
  const presences = realm.presences.list();
  const selfModels = presences.map((p) => {
    const m = realm.selfModel.get(p.presenceId);
    return {
      presenceId: p.presenceId,
      preferences: m?.preferences ?? {},
      competence: m?.competence ?? { sample: 0, score: 0.5 },
    };
  });
  const effects = [...realm.ledger.listAll()];
  const intents = realm.listIntents();
  const plans = realm.listPlans();
  const pendingHitl = realm.hitl.pending().map((rec) => ({
    approvalId: rec.approvalId,
    presenceId: rec.presenceId,
    effect: rec.effect,
    gateId: rec.gateId,
  }));
  const entities: SnapshotEntity[] = realm.graph.snapshot().entities.map((e) => ({
    kind: e.kind,
    id: e.id,
    state: e.state,
    relations: Object.fromEntries(Object.entries(e.relations).map(([rel, urns]) => [rel, urns.map((u) => String(u))])),
  }));
  return {
    version: SNAPSHOT_VERSION,
    capturedAt: new Date().toISOString(),
    realm: {
      id: realm.id,
      mode: realm.mode,
      seq: realm.clock.seq,
      realmAt: realm.clock.realmAt.toISOString(),
    },
    entities,
    presences,
    selfModels,
    effects,
    intents,
    plans,
    pendingHitl,
  };
}

/** Rehydrate a fresh realm from a snapshot. The `build` callback produces a fresh, empty realm. */
export function restoreSnapshot(snapshot: RealmSnapshotV1, build: () => Realm, opts: RestoreOptions = {}): Realm {
  if (snapshot.version !== SNAPSHOT_VERSION) throw new Error(`snapshot-version-mismatch: expected ${SNAPSHOT_VERSION}, got ${snapshot.version}`);
  const realm = build();

  // Rehydrate the entity graph (facilities, units, patients with trajectories/labs/vitals).
  for (const e of snapshot.entities ?? []) {
    try {
      realm.graph.create(e.kind, e.id, e.state, e.relations as unknown as Record<string, EntityUrn[]>);
    } catch {
      /* duplicate or unknown kind — skip, best-effort */
    }
  }

  // Rehydrate presences by spawning them via the registry (fresh presenceIds would break the ledger,
  // so we re-inject the original records directly).
  for (const p of snapshot.presences) {
    (realm.presences as unknown as { registry: Map<string, AgentPresence> }).registry?.set?.(p.presenceId, p);
    // If the registry uses a different field name, fall back to public spawn (best-effort).
    if (!realm.presences.get(p.presenceId)) {
      try {
        realm.spawnPresence({
          agentSpecId: p.agentSpecId,
          runId: p.runId,
          role: p.role,
          clearance: p.clearance,
          purposeOfUse: p.purposeOfUse,
          location: p.location ?? { facilityId: 'restored', unitId: 'restored' },
        });
      } catch { /* if spawn fails, presence is lost — non-fatal for restore */ }
    }
  }

  // Rehydrate self-model preferences.
  for (const m of snapshot.selfModels) {
    for (const [effectKind, weight] of Object.entries(m.preferences)) {
      const delta = weight - 1.0;
      if (Math.abs(delta) < 1e-6) continue;
      realm.selfModel.nudgePreference(m.presenceId, effectKind, delta, 'restore-snapshot');
    }
  }

  // Ledger: verbatim copy is safest (replay would re-trigger side effects like ambient hooks).
  if (opts.replayEffects) {
    // fromSeq is treated as an index into the snapshot's effect array.
    const from = opts.fromSeq ?? 0;
    for (let i = from; i < snapshot.effects.length; i++) {
      const e = snapshot.effects[i]!;
      try { realm.emit(e.presenceId, e.effect); } catch { /* best-effort */ }
    }
  } else {
    // Best-effort verbatim ledger seed. The ledger implementation may not expose a bulk-append; we use
    // any-typed access to the internal array, guarded by a runtime check.
    const ledgerAny = realm.ledger as unknown as { entries?: EmittedEffect[] };
    if (Array.isArray(ledgerAny.entries)) {
      (ledgerAny.entries as EmittedEffect[]).push(...snapshot.effects);
    }
  }

  // Re-register pending HITL approvals so operators can approve/reject them.
  for (const rec of snapshot.pendingHitl) {
    const presence = realm.presences.get(rec.presenceId);
    if (!presence) continue;
    const gate = realm.hitl.listGates().find((g) => g.id === rec.gateId);
    if (!gate) continue;
    try { realm.hitl.suspend(presence, rec.effect, gate); } catch { /* already restored via ledger copy */ }
  }

  // Restore the clock (seq + realmAt) without re-triggering ambient ticks.
  const clockAny = realm.clock as unknown as { _seq?: number; _realmAt?: Date };
  if (clockAny) {
    if (typeof clockAny._seq === 'number') clockAny._seq = snapshot.realm.seq;
    if (clockAny._realmAt instanceof Date) clockAny._realmAt = new Date(snapshot.realm.realmAt);
  }

  return realm;
}

// In-memory snapshot registry so the UI can list handoffs.
class SnapshotRegistryImpl {
  private snaps = new Map<string, RealmSnapshotV1>();

  save(snapshot: RealmSnapshotV1): string {
    const id = `snap-${snapshot.realm.id}-${snapshot.realm.seq}-${Date.now().toString(36)}`;
    this.snaps.set(id, snapshot);
    return id;
  }
  get(id: string): RealmSnapshotV1 | undefined { return this.snaps.get(id); }
  list(): Array<{ id: string; realmId: string; capturedAt: string; seq: number }> {
    const out: Array<{ id: string; realmId: string; capturedAt: string; seq: number }> = [];
    for (const [id, s] of this.snaps.entries()) {
      out.push({ id, realmId: s.realm.id, capturedAt: s.capturedAt, seq: s.realm.seq });
    }
    return out;
  }
  remove(id: string): boolean { return this.snaps.delete(id); }
}

export const SnapshotRegistry = new SnapshotRegistryImpl();
