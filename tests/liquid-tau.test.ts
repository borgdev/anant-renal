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

// Phase 8 deep slice — adaptive per-vertex time constant as a native mechanic.
//
// Each patient vertex carries an effective τ; the trajectory process feeds it back into the
// evolution rate (high-reactivity vertices advance faster, sluggish ones slower) and stores it
// on the vertex as an observable.

import { beforeAll, describe, expect, it } from 'vitest';
import { Realm, populateFacility } from '../src/realm/index.js';
import { TrajectoryAmbientProcess, computeEffectiveTau, tauDtFactor } from '../src/liquid/index.js';
import { ensureWasmSimulation } from '../src/liquid/wasm.js';
import type { DialysisState } from '../src/liquid/types.js';

describe('adaptive per-vertex tau', () => {
  it('tauDtFactor scales evolution by regime', () => {
    expect(tauDtFactor(0)).toBe(0.7); // stalled → slower
    expect(tauDtFactor(1)).toBe(1.5); // high reactivity → faster
    expect(tauDtFactor(10)).toBe(1); // nominal
    expect(tauDtFactor(50)).toBe(0.7); // sluggish → slower
  });

  it('computeEffectiveTau reflects movement magnitude', () => {
    const prev: DialysisState = { vitals_instability: 0.1, deterioration_risk: 0.2, ktv_adequacy: 0.7, phosphate: 0.4, anemia_severity: 0.2 };
    const fast: DialysisState = { ...prev, vitals_instability: 0.6 };
    const slow: DialysisState = { ...prev, vitals_instability: 0.11 };
    expect(computeEffectiveTau(prev, fast)).toBeLessThan(computeEffectiveTau(prev, slow));
  });

  it('a liquid realm stores per-patient tau and applies dt feedback (deterministically)', async () => {
    await ensureWasmSimulation();
    const realm = new Realm({ id: 'realm:tau', mode: 'sim', trajectoryEngine: 'liquid' });
    const traj = realm.ambient.list().find((p) => p.id === 'trajectory.liquid') as TrajectoryAmbientProcess;
    await traj.whenReady();
    populateFacility(realm, { facilityId: 'f1', kind: 'dialysis', name: 'Tau', units: ['A'], patientCount: 4 });
    // Drive one patient toward high reactivity (fast vitals swings).
    traj.biasPatient(realm.graph.listKind('patient')[0]!.id, { abnormal_vital_reading: 0.9 });

    for (let i = 0; i < 48; i++) realm.clock.advanceBy(60 * 60 * 1000);

    const liquids = realm.graph.listKind('patient').map((p) => (p.state as { liquid?: { tau?: number; tauFactor?: number } }).liquid);
    expect(liquids.every((l) => typeof l?.tau === 'number' && Number.isFinite(l.tau))).toBe(true);
    expect(liquids.every((l) => l!.tauFactor !== undefined && [0.7, 1, 1.5].includes(l!.tauFactor!))).toBe(true);
    // The mechanic is actually active: at least one patient runs a non-nominal factor.
    expect(liquids.some((l) => l!.tauFactor !== 1)).toBe(true);
    realm.stop();
  });
});
