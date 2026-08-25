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

// Phase 3 — WASM bindings + TS boundary.
//
// Verifies:
//   1. the wasm-bindgen bundle loads in Node and `stepWithEvents` drives the dialysis
//      trajectory (missed treatments erode Kt/V vs. a treated patient recovering),
//   2. a realm with `trajectoryEngine: 'liquid'` produces plausible labs/vitals/risk that stay
//      in clinical range and converge over time,
//   3. the legacy hand-authored trajectory remains the default (flag stays opt-in),
//   4. LiquidModelStore persists and serves trained weights.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { Realm, populateFacility } from '../src/realm/index.js';
import { TrajectoryAmbientProcess } from '../src/liquid/trajectory.js';
import { ensureWasmSimulation } from '../src/liquid/wasm.js';
import { LiquidModelStore } from '../src/liquid/model-store.js';
import type { DialysisState, StepResult } from '../src/liquid/types.js';

const DIMS: (keyof DialysisState)[] = ['vitals_instability', 'deterioration_risk', 'ktv_adequacy', 'phosphate', 'anemia_severity'];

describe('liquid wasm engine (Phase 3)', () => {
  it('loads in Node and stepWithEvents returns bounded dialysis state', async () => {
    const Ctor = await ensureWasmSimulation();
    const sim = new Ctor('dialysis', 'cfc', new Uint8Array(0), 42);
    const out = JSON.parse(sim.stepWithEvents(JSON.stringify([0, 0, 0, 0, 0]), 1)) as StepResult;
    for (const d of DIMS) {
      expect(typeof out.state[d]).toBe('number');
      expect(out.state[d]).toBeGreaterThanOrEqual(0);
      expect(out.state[d]).toBeLessThanOrEqual(1);
    }
    sim.free();
  });

  it('missed treatments erode Kt/V vs a treated patient recovering (same seed)', async () => {
    const Ctor = await ensureWasmSimulation();
    const run = (missed: 0 | 1): number[] => {
      const sim = new Ctor('dialysis', 'cfc', new Uint8Array(0), 7);
      sim.setResidualAlpha(0); // baseline-only (untrained) — deterministic
      const ktvs: number[] = [];
      for (let i = 0; i < 72; i++) {
        const out = JSON.parse(sim.stepWithEvents(JSON.stringify([missed, 0, 0, 0, 0]), 1)) as StepResult;
        ktvs.push(out.state.ktv_adequacy);
      }
      sim.free();
      return ktvs;
    };
    const treated = run(0);
    const missed = run(1);
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    expect(mean(missed)).toBeLessThan(mean(treated));
    expect(missed[missed.length - 1]!).toBeLessThan(treated[treated.length - 1]!);
  });
});

describe('liquid trajectory ambient process (Phase 3)', () => {
  it('a realm with trajectoryEngine liquid produces plausible converging labs', async () => {
    const realm = new Realm({ id: 'realm:lt', mode: 'sim', trajectoryEngine: 'liquid' });
    const proc = realm.ambient.list().find((p) => p.id === 'trajectory.liquid') as TrajectoryAmbientProcess | undefined;
    expect(proc).toBeDefined();
    await proc!.whenReady();

    populateFacility(realm, { facilityId: 'f1', kind: 'dialysis', name: 'Test Dialysis', units: ['A'], patientCount: 4 });

    // 72 realm-hours (~3 days) of dialysis care.
    for (let i = 0; i < 72; i++) realm.clock.advanceBy(60 * 60 * 1000);

    const patients = realm.graph.listKind('patient');
    expect(patients.length).toBeGreaterThan(0);
    for (const p of patients) {
      const st = p.state as { labs?: { K: number; HGB: number; URR: number; PHOS: number }; risk?: number; trajectory?: string; lastVitals?: { hr: number; spo2: number } };
      expect(st.labs, `patient ${p.id} should have labs`).toBeDefined();
      expect(st.labs!.K).toBeGreaterThanOrEqual(3.5);
      expect(st.labs!.K).toBeLessThanOrEqual(6.5);
      expect(st.labs!.URR).toBeGreaterThanOrEqual(55);
      expect(st.labs!.URR).toBeLessThanOrEqual(85);
      expect(st.labs!.HGB).toBeGreaterThanOrEqual(8);
      expect(st.labs!.HGB).toBeLessThanOrEqual(13);
      expect(st.labs!.PHOS).toBeGreaterThanOrEqual(3.5);
      expect(st.labs!.PHOS).toBeLessThanOrEqual(7.5);
      expect(st.risk!).toBeGreaterThanOrEqual(0);
      expect(st.risk!).toBeLessThanOrEqual(1);
      expect(st.lastVitals!.hr).toBeGreaterThanOrEqual(50);
      expect(st.lastVitals!.hr).toBeLessThanOrEqual(130);
      expect(['stable', 'recovering', 'decompensating', 'underdialyzed', 'hyperphosphatemia', 'anemic-worsening']).toContain(st.trajectory);
    }
    realm.stop();
  });

  it('legacy trajectory remains the default (liquid is opt-in)', async () => {
    const realm = new Realm({ id: 'realm:lg', mode: 'sim' });
    const ids = realm.ambient.list().map((p) => p.id);
    expect(ids).toContain('patient.trajectory');
    expect(ids).not.toContain('trajectory.liquid');
    realm.stop();
  });
});

describe('LiquidModelStore (Phase 3)', () => {
  it('persists and serves active model weights', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-liquid-'));
    const store = new LiquidModelStore(dir);
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const rec = store.promote('dialysis', 'cfc', bytes, 'test-1');
    expect(rec.modelId).toBe('test-1');
    expect(store.activeModel('dialysis')?.modelKind).toBe('cfc');
    expect(store.weightsFor('dialysis')).toEqual(bytes);
    expect(store.weightsFor('unknown')).toBeUndefined();
  });
});
