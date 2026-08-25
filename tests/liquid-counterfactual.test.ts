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

// Phase 5 — counterfactual rehearsal with learned dynamics + M24 promotion gates.
//
// The README M24 acceptance story: propose "phosphate-reminder-at-4am"; three variants
// (silence, gentle, insistent); rehearsal shows the *insistent* variant improves adherence but
// degrades sleep-equity, so the system refuses to promote it and surfaces the reason.
//
// Here that maps to an `event-effect` intervention on the liquid trajectory process:
//   • gentle   — fewer missed treatments + phosphate violations (adherence up) → measure
//                (mean Kt/V) improves, no harm → PROMOTABLE
//   • insistent — the same, plus sleep-disruption (abnormal_vital_reading up) → the worst-off
//                patient's risk crosses the floor → NOT promotable (equity regression)

import { beforeAll, describe, expect, it } from 'vitest';
import { Realm, populateFacility, runCounterfactual, type Intervention } from '../src/realm/index.js';
import { ensureWasmSimulation } from '../src/liquid/wasm.js';

function buildRealm(tag: string): Realm {
  const realm = new Realm({ id: `realm:cf:${tag}:${Math.random().toString(36).slice(2, 8)}`, mode: 'sim', trajectoryEngine: 'liquid' });
  populateFacility(realm, { facilityId: 'f1', kind: 'dialysis', name: 'CF Test', units: ['A'], patientCount: 7 });
  return realm;
}

function rehearse(interventions: Intervention[], advanceTicks = 72) {
  return runCounterfactual({ build: () => buildRealm('run'), timeline: [], interventions, advanceTicks });
}

describe('counterfactual rehearsal with learned dynamics (Phase 5)', () => {
  beforeAll(async () => {
    // Pre-load the wasm so the sync counterfactual ticks see the engine immediately.
    await ensureWasmSimulation();
  });

  it('baseline run reports population metrics (patients, mean Kt/V, risk floor)', () => {
    const report = rehearse([]);
    expect(report.baseline.population.patients).toBe(7);
    expect(report.baseline.population.meanKtv).toBeGreaterThan(0);
    expect(report.baseline.population.meanKtv).toBeLessThanOrEqual(1);
    expect(report.counterfactual.population.patients).toBe(7);
  });

  it('gentle phosphate reminder improves the measure and is PROMOTABLE', () => {
    const report = rehearse([{ kind: 'event-effect', effect: { missed_treatment: -0.5, diet_phosphate_violation: -0.4 } }]);
    expect(report.gates.measureImproves).toBe(true);
    expect(report.gates.noEquityRegression).toBe(true);
    expect(report.gates.noPolicyViolation).toBe(true);
    expect(report.promotable).toBe(true);
    expect(report.gateReasons).toEqual([]);
  });

  it('insistent reminder improves the measure but degrades sleep-equity → REFUSED', () => {
    const report = rehearse([
      { kind: 'event-effect', effect: { missed_treatment: -0.5, diet_phosphate_violation: -0.4, abnormal_vital_reading: 0.5 } },
    ]);
    expect(report.gates.measureImproves).toBe(true); // adherence improves mean Kt/V
    expect(report.gates.noEquityRegression).toBe(false); // worst-off patient vitals cross the floor
    expect(report.gates.noPolicyViolation).toBe(true);
    expect(report.promotable).toBe(false);
    expect(report.gateReasons.join(' ')).toMatch(/equity/i);
  });

  it('rehearsal is deterministic — same intervention ⇒ identical report', () => {
    const a = rehearse([{ kind: 'event-effect', effect: { abnormal_vital_reading: 0.3 } }], 24);
    const b = rehearse([{ kind: 'event-effect', effect: { abnormal_vital_reading: 0.3 } }], 24);
    expect(a.counterfactual.population).toEqual(b.counterfactual.population);
    expect(a.promotable).toBe(b.promotable);
  });
});
