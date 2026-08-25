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

// Phase 6 — training pipeline.
//
//  • trainer orchestration (injectable runner — no cargo spawn in CI): a training job writes a
//    SafeTensors artifact and promotes it into the store with metrics,
//  • realm hot-swap: promoting a trained model makes a new liquid realm run LEARNED dynamics
//    (α active) — its patient traces diverge from the baseline-only realm,
//  • promoteExisting re-activates a previously-trained model,
//  • compare reports CfC vs LTC vs baseline-only held-out MAE.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { LabMaturationProcess, InsuranceClockProcess, Realm, populateFacility } from '../src/realm/index.js';
import { LiquidModelStore, LiquidTrainer, TrajectoryAmbientProcess, type TrainingRunner } from '../src/liquid/index.js';
import { ensureWasmSimulation } from '../src/liquid/wasm.js';

const TRAINED_FIXTURE = join(process.cwd(), 'native', 'domain-dialysis', 'tests', 'fixtures', 'trained_model.safetensors');

function tempStore(): LiquidModelStore {
  return new LiquidModelStore(mkdtempSync(join(tmpdir(), 'hh-liquid-')));
}

describe('LiquidTrainer (Phase 6)', () => {
  it('runs a training job via the runner, persists the artifact, and promotes it with metrics', async () => {
    const store = tempStore();
    const fixture = new Uint8Array(readFileSync(TRAINED_FIXTURE));
    const fakeRunner: TrainingRunner = async (args) => {
      const at = (k: string) => args[args.indexOf(k) + 1]!;
      const workDir = at('--out-dir');
      writeFileSync(join(workDir, 'model.safetensors'), Buffer.from(fixture));
      return JSON.stringify({
        modelId: at('--model-id'),
        modelKind: at('--model-kind'),
        artifactPath: join(workDir, 'model.safetensors'),
        losses: [0.02, 0.004, 0.001],
        finalLoss: 0.001,
        baselineMae: 0.0169,
        trainedMae: 0.0105,
      });
    };
    const trainer = new LiquidTrainer(store, fakeRunner);
    const run = await trainer.train({ modelKind: 'cfc', epochs: 3 });

    expect(run.record.modelKind).toBe('cfc');
    expect(store.activeModel('dialysis')?.modelId).toBe(run.record.modelId);
    expect(store.activeModel('dialysis')?.metrics?.trainedMae).toBe(0.0105);
    expect(store.weightsFor('dialysis')).toEqual(fixture);
  });

  it('promoteExisting re-activates a previously-trained model', () => {
    const store = tempStore();
    const fixture = new Uint8Array(readFileSync(TRAINED_FIXTURE));
    store.promote('dialysis', 'cfc', fixture, 'model-a', { finalLoss: 0.01, baselineMae: 0.017, trainedMae: 0.012, losses: [] });
    store.promote('dialysis', 'cfc', fixture, 'model-b', { finalLoss: 0.008, baselineMae: 0.017, trainedMae: 0.011, losses: [] });
    expect(store.activeModel('dialysis')?.modelId).toBe('model-b');
    expect(store.promoteExisting('dialysis', 'model-a')?.modelId).toBe('model-a');
    expect(store.activeModel('dialysis')?.modelId).toBe('model-a');
  });

  it('compare reports CfC vs LTC vs baseline-only held-out MAE', () => {
    const store = tempStore();
    const fixture = new Uint8Array(readFileSync(TRAINED_FIXTURE));
    store.promote('dialysis', 'cfc', fixture, 'cfc-1', { finalLoss: 0.001, baselineMae: 0.0169, trainedMae: 0.0105, losses: [] });
    store.promote('dialysis', 'ltc', fixture, 'ltc-1', { finalLoss: 0.002, baselineMae: 0.0169, trainedMae: 0.012, losses: [] });

    const cmp = store.compare('dialysis');
    expect(cmp.baselineMae).toBeCloseTo(0.0169);
    expect(cmp.cfc?.trainedMae).toBeCloseTo(0.0105);
    expect(cmp.ltc?.trainedMae).toBeCloseTo(0.012);
  });
});

describe('realm hot-swap to learned dynamics (Phase 6)', () => {
  it('a realm with promoted weights runs learned dynamics — traces diverge from baseline-only', async () => {
    await ensureWasmSimulation();

    const store = tempStore();
    const fixture = new Uint8Array(readFileSync(TRAINED_FIXTURE));
    store.promote('dialysis', 'cfc', fixture, 'trained-1', { finalLoss: 0.0004, baselineMae: 0.0169, trainedMae: 0.0144, losses: [] });

    const learnedTraj = new TrajectoryAmbientProcess({ store });
    await learnedTraj.whenReady();
    const learned = new Realm({
      id: 'realm:learned', mode: 'sim',
      ambientProcesses: [new LabMaturationProcess(), learnedTraj, new InsuranceClockProcess()],
    });

    const baselineTraj = new TrajectoryAmbientProcess(); // no store → α=0 baseline-only
    await baselineTraj.whenReady();
    const baseline = new Realm({
      id: 'realm:baseline', mode: 'sim',
      ambientProcesses: [new LabMaturationProcess(), baselineTraj, new InsuranceClockProcess()],
    });

    populateFacility(learned, { facilityId: 'f1', kind: 'dialysis', name: 'Learned', units: ['A'], patientCount: 4 });
    populateFacility(baseline, { facilityId: 'f1', kind: 'dialysis', name: 'Baseline', units: ['A'], patientCount: 4 });
    for (let i = 0; i < 48; i++) {
      learned.clock.advanceBy(60 * 60 * 1000);
      baseline.clock.advanceBy(60 * 60 * 1000);
    }

    const trace = (realm: Realm) => realm.graph.listKind('patient').map((p) => {
      const st = p.state as { labs?: { K: number; URR: number; PHOS: number }; risk?: number };
      return { id: p.id, K: st.labs?.K, URR: st.labs?.URR, PHOS: st.labs?.PHOS, risk: st.risk };
    });
    const a = trace(learned);
    const b = trace(baseline);
    // The learned (trained residual, α=0.15) trajectory must diverge from baseline (α=0).
    expect(a).not.toEqual(b);
    const maxRiskDelta = Math.max(...a.map((r, i) => Math.abs((r.risk ?? 0) - (b[i]?.risk ?? 0))));
    expect(maxRiskDelta).toBeGreaterThan(0.005);
    learned.stop();
    baseline.stop();
  });
});
