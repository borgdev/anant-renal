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

// Phase 4 — native↔WASM parity + determinism (the "no mocks in the path" extension).
//
// The golden vectors below are produced by the NATIVE Rust engine
// (`native/domain-dialysis/tests/parity.rs`, same 24-tick event pattern + model init). This
// suite drives the WASM bundle with identical inputs and asserts the same outputs — proving
// the browser/server bundle doesn't drift from the Rust that training uses. It also asserts
// same-seed determinism at both the wasm and whole-realm level (which underpins the harness's
// replay/audit guarantees).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Realm, populateFacility } from '../src/realm/index.js';
import { ensureWasmSimulation } from '../src/liquid/wasm.js';
import { TrajectoryAmbientProcess } from '../src/liquid/trajectory.js';
import type { StepResult } from '../src/liquid/types.js';

const ALPHA0_GOLDEN = [0.043798365, 0.7189349, 0.43466473, 0.7349391, 0.40493095];
// α=1 golden on the committed trained-weight fixture (native golden in domain-dialysis/tests/parity.rs).
const FIXTURE_GOLDEN = [1.0, 0.07914606, 0.3338799, 0.0, 0.068443865];
const FIXTURE = join(process.cwd(), 'native', 'domain-dialysis', 'tests', 'fixtures', 'parity_model.safetensors');
const DIMS = ['vitals_instability', 'deterioration_risk', 'ktv_adequacy', 'phosphate', 'anemia_severity'] as const;

/** Same 24-tick event pattern + dt as the native golden generator. */
let __ctor: Awaited<ReturnType<typeof ensureWasmSimulation>> | null = null;
async function __runWasm(weights: Uint8Array, alpha: number): Promise<number[]> {
  __ctor ??= await ensureWasmSimulation();
  const sim = new __ctor('dialysis', 'cfc', weights, 7);
  sim.setResidualAlpha(alpha);
  let state: number[] = [];
  for (let i = 0; i < 24; i++) {
    const event = i % 3 === 0 ? [1, 0, 0, 0, 0] : i % 3 === 1 ? [0, 0, 0, 0, 1] : [0, 0, 0, 0, 0];
    const out = JSON.parse(sim.stepWithEvents(JSON.stringify(event), 1)) as StepResult;
    state = DIMS.map((d) => out.state[d]);
  }
  sim.free();
  return state;
}

describe('native ↔ wasm parity (Phase 4)', () => {
  it('alpha=0 (baseline ODE) matches the native golden vector', async () => {
    const state = await __runWasm(new Uint8Array(0), 0);
    for (let i = 0; i < state.length; i++) {
      expect(Math.abs(state[i]! - ALPHA0_GOLDEN[i]!)).toBeLessThan(1e-5);
    }
  });

  it('alpha=1 on trained-weight fixture matches the native golden vector', async () => {
    const fixture = new Uint8Array(readFileSync(FIXTURE));
    const state = await __runWasm(fixture, 1);
    for (let i = 0; i < state.length; i++) {
      expect(Math.abs(state[i]! - FIXTURE_GOLDEN[i]!)).toBeLessThan(1e-5);
    }
  });

  it('wasm is deterministic for the same loaded weights (bit-identical)', async () => {
    const fixture = new Uint8Array(readFileSync(FIXTURE));
    const a = await __runWasm(fixture, 1);
    const b = await __runWasm(fixture, 1);
    expect(a).toEqual(b);
  });
});

describe('realm determinism (Phase 4)', () => {
  async function trace(seedFacilityId: string): Promise<Array<{ id: string; risk: number; ktv: number }>> {
    const realm = new Realm({ id: `realm:det:${seedFacilityId}`, mode: 'sim', trajectoryEngine: 'liquid' });
    const proc = realm.ambient.list().find((p) => p.id === 'trajectory.liquid') as TrajectoryAmbientProcess;
    await proc.whenReady();
    populateFacility(realm, { facilityId: 'f1', kind: 'dialysis', name: 'Det', units: ['A'], patientCount: 3 });
    for (let i = 0; i < 24; i++) realm.clock.advanceBy(60 * 60 * 1000);
    const out = realm.graph.listKind('patient').map((p) => {
      const st = p.state as { risk?: number; liquid?: { state?: Record<string, number> } };
      return { id: p.id, risk: st.risk ?? 0, ktv: st.liquid?.state?.ktv_adequacy ?? 0 };
    });
    realm.stop();
    return out;
  }

  it('two identical liquid realms produce identical patient traces', async () => {
    const a = await trace('a');
    const b = await trace('b');
    expect(a).toEqual(b);
  });
});
