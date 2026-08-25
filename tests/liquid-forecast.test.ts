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

// Phase 7 — What-If forecast service (the in-browser/in-process forecast core).
//
// The forecast runs the WASM engine locally (zero round-trip) and projects a patient's
// trajectory under an optional one-shot intervention, mapping the learned dialysis state onto
// labs/vitals. With no trained weights α is gated to 0, so forecasts are deterministic.

import { beforeAll, describe, expect, it } from 'vitest';
import { forecastPatient } from '../src/liquid/index.js';
import { ensureWasmSimulation } from '../src/liquid/wasm.js';

describe('What-If forecast (Phase 7)', () => {
  beforeAll(async () => {
    await ensureWasmSimulation();
  });

  it('projects a bounded, plausible trajectory over the requested horizon', async () => {
    const points = await forecastPatient({ steps: 48, seed: 11 });
    expect(points.length).toBe(48);
    for (const p of points) {
      expect(p.labs.K).toBeGreaterThanOrEqual(3.5);
      expect(p.labs.K).toBeLessThanOrEqual(6.5);
      expect(p.labs.URR).toBeGreaterThanOrEqual(55);
      expect(p.labs.URR).toBeLessThanOrEqual(85);
      expect(p.labs.HGB).toBeGreaterThanOrEqual(8);
      expect(p.labs.HGB).toBeLessThanOrEqual(13);
      expect(p.labs.PHOS).toBeGreaterThanOrEqual(3.5);
      expect(p.labs.PHOS).toBeLessThanOrEqual(7.5);
      expect(p.risk).toBeGreaterThanOrEqual(0);
      expect(p.risk).toBeLessThanOrEqual(1);
      expect(p.hr).toBeGreaterThanOrEqual(50);
      expect(p.hr).toBeLessThanOrEqual(130);
    }
  });

  it('an intervention that raises Kt/V shifts the forecast upward', async () => {
    const baseline = await forecastPatient({ steps: 72, seed: 11 });
    const boosted = await forecastPatient({ steps: 72, seed: 11, intervention: { ktv_adequacy: 0.25 } });
    const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;
    expect(mean(boosted.map((p) => p.state.ktv_adequacy))).toBeGreaterThan(mean(baseline.map((p) => p.state.ktv_adequacy)));
  });

  it('forks from a given patient state (first point reflects the fork)', async () => {
    const points = await forecastPatient({ steps: 4, seed: 11, fromState: { ktv_adequacy: 0.9, deterioration_risk: 0.2, phosphate: 0.3, anemia_severity: 0.2, vitals_instability: 0.1 } });
    // First step still moves, but should start near the forked ktv (projected K near 3.8).
    expect(points[0]!.labs.K).toBeGreaterThanOrEqual(3.5);
    expect(points[0]!.labs.K).toBeLessThanOrEqual(4.5);
  });

  it('is deterministic for the same request', async () => {
    const a = await forecastPatient({ steps: 24, seed: 5 });
    const b = await forecastPatient({ steps: 24, seed: 5 });
    expect(a).toEqual(b);
  });
});
