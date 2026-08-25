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

// Phase 8 — liquid hypergraph mechanic: dynamical-regime observables.
//
// The detector surfaces *regime changes* (tau collapse, critical slowing down, divergence from
// baseline) rather than just threshold crossings, and the realm turns them into Experiences
// agents can perceive.

import { describe, expect, it } from 'vitest';
import { Realm, populateFacility } from '../src/realm/index.js';
import { RegimeDetector, TrajectoryAmbientProcess } from '../src/liquid/index.js';
import { ensureWasmSimulation } from '../src/liquid/wasm.js';
import type { DialysisState } from '../src/liquid/types.js';

function state(partial: Partial<DialysisState>): DialysisState {
  return { ktv_adequacy: 0.7, deterioration_risk: 0.2, phosphate: 0.4, anemia_severity: 0.2, vitals_instability: 0.15, ...partial };
}

describe('RegimeDetector (Phase 8)', () => {
  it('flags divergence when the learned residual leaves the baseline', () => {
    const d = new RegimeDetector();
    // First observation → stable (no history).
    expect(d.observe('p1', state({}), 0, 't1')).toBeUndefined();
    // Divergence > 0.15 → regime change to 'divergence' (edge-triggered).
    const sig = d.observe('p1', state({}), 0.2, 't2');
    expect(sig?.regime).toBe('divergence');
    // Still diverging → no new signal.
    expect(d.observe('p1', state({}), 0.2, 't3')).toBeUndefined();
  });

  it('flags critical slowing down when a bad dimension is stuck (recovery stopped)', () => {
    const d = new RegimeDetector();
    // Drive vitals_instability into the bad region and stall it there (rate → ~0).
    d.observe('p1', state({ vitals_instability: 0.3 }), 0, 't1');
    d.observe('p1', state({ vitals_instability: 0.6 }), 0, 't2');
    const sig = d.observe('p1', state({ vitals_instability: 0.61 }), 0, 't3');
    expect(sig?.regime).toBe('critical-slowing-down');
  });

  it('flags high reactivity on time-constant collapse (fast oscillation)', () => {
    const d = new RegimeDetector();
    d.observe('p1', state({ vitals_instability: 0.1 }), 0, 't1');
    d.observe('p1', state({ vitals_instability: 0.6 }), 0, 't2');
    const sig = d.observe('p1', state({ vitals_instability: 0.1 }), 0, 't3');
    expect(sig?.regime).toBe('high-reactivity');
  });

  it('stays stable for a calm, recovering trajectory', () => {
    const d = new RegimeDetector();
    const signals: string[] = [];
    for (let i = 1; i <= 20; i++) {
      // Slow recovery toward good ktv, low everything else.
      const ktv = 0.5 + 0.01 * i;
      const s = d.observe('p1', state({ ktv_adequacy: Math.min(ktv, 0.9) }), 0, `t${i}`);
      if (s) signals.push(s.regime);
    }
    expect(signals).toEqual([]);
  });
});

describe('realm regime Experiences (Phase 8)', () => {
  it('a liquid realm emits liquid.regime-change experiences when a patient destabilizes', async () => {
    await ensureWasmSimulation();
    const realm = new Realm({ id: 'realm:regime', mode: 'sim', trajectoryEngine: 'liquid' });
    const traj = realm.ambient.list().find((p) => p.id === 'trajectory.liquid') as TrajectoryAmbientProcess;
    await traj.whenReady();

    populateFacility(realm, { facilityId: 'f1', kind: 'dialysis', name: 'Regime', units: ['A'], patientCount: 6 });
    const pid = realm.graph.listKind('patient')[0]!.id;
    // Drive one patient toward persistent vitals instability (a "sleep disruption" nudge) —
    // vitals will rise into the bad region and stall → critical slowing down.
    traj.biasPatient(pid, { abnormal_vital_reading: 0.8 });

    for (let i = 0; i < 48; i++) realm.clock.advanceBy(60 * 60 * 1000);

    const experiences = realm.rules.history().filter((e) => e.kind === 'liquid.regime-change');
    expect(experiences.length).toBeGreaterThan(0);
    const forPatient = experiences.find((e) => e.subjectUrn?.includes(pid));
    expect(forPatient?.subjectUrn).toContain(pid);
    expect(['warning', 'critical']).toContain(forPatient?.severity);
    realm.stop();
  });
});
