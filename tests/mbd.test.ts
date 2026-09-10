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
 * business logic, computational optimization techniques,
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

// P4 — CKD-MBD protocol pack (steps A–F): coupled responder, KDIGO hard contract,
// counterfactual, twin, multi-output artifact, governance and the route surface.

import { describe, expect, it } from 'vitest';
import {
  MBD_FEATURES, MBD_REFERENCE, MBD_CELLS, correctedCalcium, projectMbdTherapy,
  mbdContractViolations, guardMbdTherapy, mbdLatent, mbdRecommend, buildMbdDemo,
  type MbdCoupledInput, type MbdTherapyState,
} from '../src/swarm/mbd.js';
import {
  mbdCoverage, mbdRecommendCovered, MBD_RED_TEAM_DEFS, MBD_RED_TEAM_IDS, mbdRedTeamProbe,
  ensureMbdModel, ensureMbdRedTeamScenarios, computeMbdDrift, evaluateMbdAdvisorGate,
  MBD_COVERAGE_DEFAULTS, MBD_MODEL_ID, MBD_REGULATORY_POSTURE, isMbdFinding,
} from '../src/swarm/mbd-governance.js';
import { mbdWhatIf, mbdCouplingMap, MBD_TRADEOFF_WEIGHTS } from '../src/swarm/mbd-simulator.js';
import { buildMbdTwin, scoreMbdTwinDrift, mbdWindowFromTwin, currentTherapyFromSteps, type MbdTwinEventInput } from '../src/swarm/mbd-twin.js';
import {
  MBD_MODEL_FEATURES, buildMbdVector, buildMbdTrainingRows, trainMbdArtifact, loadMbdArtifact,
  mbdArtifactStatus, mbdProjectTrained, MBD_ARTIFACT_ID,
} from '../src/swarm/mbd-model.js';
import { SwarmWorkspaceStore } from '../src/swarm/workspace.js';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import type { PostgresEventStore } from '../src/server/postgres-event-store.js';
import type { CanonicalEvent } from '../src/healthcare-core/events.js';
import type { LedgerEntry } from '../src/hypergraph/ledger.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import type { ActorContext } from '../src/server/scoped-persistence.js';

const NO_THERAPY: MbdTherapyState = { binderMgPerDay: 0, binderClass: 'none', calcimimeticMgPerDay: 0, activeVitaminDMcgPerDay: 0 };

/** Hyperphosphataemia + secondary hyperparathyroidism on a calcium-based binder. */
const HYPERPHOSPHATEMIC: MbdCoupledInput = {
  patientId: 'p-mbd-1',
  phosphate: 6.4,
  calcium: 9.1,
  albumin: 3.6,
  pth: 780,
  vitaminD: 17,
  triplets: 3,
  phosphateTrend30d: 0.3,
  calciumTrend30d: -0.1,
  therapy: { binderMgPerDay: 2400, binderClass: 'sevelamer', calcimimeticMgPerDay: 0, activeVitaminDMcgPerDay: 0 },
  binderDosesPerWeek: 19,
  prescribedDosesPerWeek: 21,
  ktV: 1.35,
  asOf: '2026-09-01T10:00:00Z',
};

describe('P4-A/B — feature contract, KDIGO targets and the coupled responder', () => {
  it('declares the coupled feature contract with a normalised relevance budget', () => {
    expect(MBD_FEATURES).toHaveLength(10);
    expect(MBD_FEATURES.every((f) => f.relevance > 0 && f.relevance <= 1)).toBe(true);
    expect(MBD_FEATURES.map((f) => f.id)).toContain('phosphateTrend30d');
    // the targets are KDIGO, the envelope is the hard contract
    expect(MBD_REFERENCE.phosphateTargetMgDl).toEqual({ lower: 2.5, upper: 5.5 });
    expect(MBD_REFERENCE.correctedCalciumTargetMgDl).toEqual({ lower: 8.4, upper: 10.2 });
    expect(MBD_REFERENCE.calciumSafetyCeilingMgDl).toBeGreaterThan(MBD_REFERENCE.correctedCalciumTargetMgDl.upper);
  });

  it('corrects calcium for albumin with the Payne formula', () => {
    // +0.8 mg/dL per 1.0 g/dL of albumin below 4.0
    expect(correctedCalcium(9.0, 3.0)).toBeCloseTo(9.8, 2);
    expect(correctedCalcium(9.0, 4.0)).toBeCloseTo(9.0, 2);
    expect(correctedCalcium(9.0)).toBeCloseTo(9.0, 2);
  });

  it('projects all three analytes for every horizon and reports the KDIGO verdict', () => {
    const projection = projectMbdTherapy(HYPERPHOSPHATEMIC, { ...NO_THERAPY, binderMgPerDay: 2400, binderClass: 'sevelamer' });
    expect(Object.keys(projection.points).sort()).toEqual(['30', '60', '90']);
    for (const point of Object.values(projection.points)) {
      expect(Number.isFinite(point.phosphate)).toBe(true);
      expect(Number.isFinite(point.correctedCalcium)).toBe(true);
      expect(Number.isFinite(point.pth)).toBe(true);
    }
    // more binder → lower phosphate at every horizon (monotone in the lever)
    const flat = projectMbdTherapy(HYPERPHOSPHATEMIC, NO_THERAPY);
    expect(projection.points[30]!.phosphate).toBeLessThan(flat.points[30]!.phosphate);
    expect(MBD_REFERENCE.horizonsDays).toEqual([30, 60, 90]);
  });

  it('keeps the coupling: a calcium-based binder raises calcium while lowering phosphate', () => {
    const calciumBinder = projectMbdTherapy(
      { ...HYPERPHOSPHATEMIC, therapy: NO_THERAPY },
      { binderMgPerDay: 3000, binderClass: 'calcium-acetate', calcimimeticMgPerDay: 0, activeVitaminDMcgPerDay: 0 },
    );
    const noBinder = projectMbdTherapy({ ...HYPERPHOSPHATEMIC, therapy: NO_THERAPY }, NO_THERAPY);
    expect(calciumBinder.points[90]!.phosphate).toBeLessThan(noBinder.points[90]!.phosphate);
    expect(calciumBinder.points[90]!.correctedCalcium).toBeGreaterThan(noBinder.points[90]!.correctedCalcium);
    // a calcimimetic does the opposite on calcium and lowers PTH
    const calcimimetic = projectMbdTherapy({ ...HYPERPHOSPHATEMIC, therapy: NO_THERAPY }, { ...NO_THERAPY, calcimimeticMgPerDay: 90 });
    expect(calcimimetic.points[90]!.correctedCalcium).toBeLessThan(noBinder.points[90]!.correctedCalcium);
    expect(calcimimetic.points[90]!.pth).toBeLessThan(noBinder.points[90]!.pth);
  });
});

describe('P4-B — the KDIGO hard contract and the guardrails', () => {
  it('refuses a projection that breaches the calcium ceiling', () => {
    const points = {
      30: { phosphate: 5.0, correctedCalcium: 11.2, pth: 400 },
      60: { phosphate: 4.8, correctedCalcium: 11.4, pth: 380 },
      90: { phosphate: 4.6, correctedCalcium: 11.6, pth: 360 },
    };
    const verdict = mbdContractViolations(points);
    expect(verdict.safe).toBe(false);
    expect(verdict.violations.join(' ')).toMatch(/calcium/i);
  });

  it('refuses a projection that breaches the hypocalcaemia floor or the phosphate floor', () => {
    const hypocalcaemia = mbdContractViolations({ 30: { phosphate: 4.0, correctedCalcium: 7.4, pth: 500 } });
    expect(hypocalcaemia.safe).toBe(false);
    expect(hypocalcaemia.violations.join(' ')).toMatch(/hypocal|floor|calcium/i);
    const hypophosphataemia = mbdContractViolations({ 30: { phosphate: 1.6, correctedCalcium: 9.2, pth: 500 } });
    expect(hypophosphataemia.safe).toBe(false);
    expect(hypophosphataemia.violations.join(' ')).toMatch(/phosphate/i);
  });

  it('passes a projection inside the KDIGO envelope', () => {
    expect(mbdContractViolations({ 30: { phosphate: 4.4, correctedCalcium: 9.4, pth: 420 } }).safe).toBe(true);
  });

  it('blocks on a single cross-sectional panel and on a stale triplet', () => {
    const single = guardMbdTherapy({ ...HYPERPHOSPHATEMIC, triplets: 1 });
    expect(single.blocked).toBe(true);
    expect(single.blockReason).toMatch(/serial|triplet/i);

    const stale = guardMbdTherapy({ ...HYPERPHOSPHATEMIC, lastTripletAt: '2025-01-01T00:00:00Z', asOf: '2026-09-01T10:00:00Z' });
    expect(stale.flags).toContain('stale-triplet');
  });

  it('flags a calcium-based binder when calcium is already raised', () => {
    const raised = guardMbdTherapy({
      ...HYPERPHOSPHATEMIC,
      calcium: 10.4,
      albumin: 4.0,
      therapy: { binderMgPerDay: 3000, binderClass: 'calcium-acetate', calcimimeticMgPerDay: 0, activeVitaminDMcgPerDay: 0 },
    });
    expect(raised.flags.includes('hypercalcemia-present') || raised.flags.includes('calcium-binder-with-hypercalcemia')).toBe(true);
  });

  it('never proposes a therapy change without a serial trend', () => {
    const rec = mbdRecommend({ ...HYPERPHOSPHATEMIC, triplets: 1 });
    expect(rec.action).toBe('blocked');
    expect(rec.note).toMatch(/serial|triplet/i);
  });

  it('separates the set-point latent from the therapy burden', () => {
    const latent = mbdLatent(HYPERPHOSPHATEMIC);
    expect(latent.polarRadius).toBeGreaterThan(0);
    expect(Math.abs(latent.l1)).toBeLessThanOrEqual(1);
    expect(Math.abs(latent.l2)).toBeLessThanOrEqual(1);
    // axis 1 is deviation OUTSIDE the KDIGO targets: in-range ⇒ no deviation
    expect(latent.l1).toBeGreaterThan(0);
    expect(mbdLatent({ ...HYPERPHOSPHATEMIC, phosphate: 4.6, calcium: 9.2, pth: 300 }).l1).toBe(0);
    // axis 2 is a burden magnitude: an in-target untreated plan sits near the origin
    const untreated = mbdLatent({ ...HYPERPHOSPHATEMIC, phosphate: 4.6, pth: 300, calcium: 9.2, therapy: NO_THERAPY, binderDosesPerWeek: undefined, prescribedDosesPerWeek: undefined });
    expect(untreated.l1).toBe(0);
    expect(untreated.polarRadius).toBe(0);
    // a tighter set point on the SAME therapy has a smaller radius
    const controlled = mbdLatent({ ...HYPERPHOSPHATEMIC, phosphate: 4.6, pth: 300, calcium: 9.2 });
    expect(controlled.polarRadius).toBeLessThan(latent.polarRadius);
    // a heavier therapy burden at the same set point has a larger radius
    const loaded = mbdLatent({ ...HYPERPHOSPHATEMIC, therapy: { binderMgPerDay: 6000, binderClass: 'sevelamer', calcimimeticMgPerDay: 120, activeVitaminDMcgPerDay: 1 } });
    expect(loaded.polarRadius).toBeGreaterThan(latent.polarRadius);
  });
});

describe('P4-B — coverage gate', () => {
  it('blocks a window with fewer than the required serial triplets', () => {
    const coverage = mbdCoverage({ ...HYPERPHOSPHATEMIC, triplets: 1 });
    expect(coverage.covered).toBe(false);
    expect(coverage.reason).toMatch(/triplet|serial/i);
    expect(coverage.triplets.required).toBe(MBD_COVERAGE_DEFAULTS.minTriplets);
    expect(mbdRecommendCovered({ ...HYPERPHOSPHATEMIC, triplets: 1 }).action).toBe('blocked');
  });

  it('blocks a window with triplets but no phosphate trend', () => {
    const coverage = mbdCoverage({ ...HYPERPHOSPHATEMIC, tripletCount: 3 } as never);
    expect(coverage.phosphateSeries.observed).toBe(0);
    expect(coverage.reason).toMatch(/phosphate/i);
  });

  it('covers a window with serial triplets', () => {
    const covered = mbdRecommendCovered({ ...HYPERPHOSPHATEMIC, phosphateSeries: 4 });
    expect(covered.coverage.covered).toBe(true);
    expect(covered.action).not.toBe('blocked');
  });
});

describe('P4-C — candidate-therapy counterfactual', () => {
  it('scores candidates and never recommends one the contract refuses', () => {
    const result = mbdWhatIf(HYPERPHOSPHATEMIC);
    expect(result.candidates.length).toBeGreaterThan(5);
    for (const candidate of result.candidates) {
      expect(Number.isFinite(candidate.score)).toBe(true);
      if (!candidate.allowed) expect(candidate.violations.length).toBeGreaterThan(0);
    }
    if (result.recommended) {
      expect(result.recommended.allowed).toBe(true);
      expect(result.recommended.violations).toEqual([]);
    }
  });

  it('produces no recommendation at all for a blocked window', () => {
    const blocked = mbdWhatIf({ ...HYPERPHOSPHATEMIC, triplets: 1 });
    expect(blocked.blocked).toBe(true);
    expect(blocked.candidates.every((c) => c.allowed === false)).toBe(true);
    expect(blocked.recommended).toBeUndefined();
  });

  it('exposes the coupling map and weights every analyte', () => {
    const map = mbdCouplingMap(HYPERPHOSPHATEMIC);
    expect(map.length).toBeGreaterThanOrEqual(4);
    expect(map.every((row) => Number.isFinite(row.phosphate) && Number.isFinite(row.correctedCalcium) && Number.isFinite(row.pth))).toBe(true);
    expect(Object.keys(MBD_TRADEOFF_WEIGHTS)).toContain('hypercalcemia');
    // raising PTH is not a free lever: the weights must price calcium above phosphate burden
    expect(MBD_TRADEOFF_WEIGHTS.hypercalcemia).toBeGreaterThan(MBD_TRADEOFF_WEIGHTS.pillBurden);
  });
});

describe('P4-D — twin over the real ledger', () => {
  const at = (daysAgo: number): string => new Date(Date.parse('2026-09-01T07:00:00Z') - daysAgo * 86_400_000).toISOString();
  const ev = (kind: string, at: string, payload: Record<string, unknown>): MbdTwinEventInput => ({ kind, emittedAt: at, realmAt: at, payload });

  const events: MbdTwinEventInput[] = [
    // three ascending phosphate triplets, attributed by orderId prefix
    ev('result-lab', at(80), { orderId: 'fac-a-pt-0001-PHOS-1', code: 'PHOS', value: 5.1 }),
    ev('result-lab', at(80), { orderId: 'fac-a-pt-0001-CALCIUM-1', code: 'CALCIUM', value: 9.3 }),
    ev('result-lab', at(80), { orderId: 'fac-a-pt-0001-PTH-1', code: 'PTH', value: 420 }),
    ev('result-lab', at(50), { orderId: 'fac-a-pt-0001-PHOS-2', code: 'PHOS', value: 5.6 }),
    ev('result-lab', at(50), { orderId: 'fac-a-pt-0001-CALCIUM-2', code: 'CALCIUM', value: 9.2 }),
    ev('result-lab', at(50), { orderId: 'fac-a-pt-0001-PTH-2', code: 'PTH', value: 560 }),
    ev('result-lab', at(20), { orderId: 'fac-a-pt-0001-PHOS-3', code: 'PHOS', value: 6.3 }),
    ev('result-lab', at(20), { orderId: 'fac-a-pt-0001-CALCIUM-3', code: 'CALCIUM', value: 9.1 }),
    ev('result-lab', at(20), { orderId: 'fac-a-pt-0001-PTH-3', code: 'PTH', value: 740 }),
    ev('result-lab', at(20), { orderId: 'fac-a-pt-0001-ALBUMIN-3', code: 'ALBUMIN', value: 3.6 }),
    ev('result-lab', at(20), { orderId: 'fac-a-pt-0001-VITD-3', code: 'VITD', value: 17 }),
    // therapy: sevelamer 800 mg three times daily (a per-dose order + frequency)
    ev('order-med', at(50), { orderId: 'fac-a-pt-0001-sevelamer-1', code: 'sevelamer', dose: '800 mg', frequency: 'three times daily' }),
  ];

  function build() {
    return buildMbdTwin({
      patientId: 'fac-a-pt-0001',
      events,
      patients: [{ patientId: 'fac-a-pt-0001', realmId: 'sim:renal-a', state: {} }],
      asOf: '2026-09-01T10:00:00Z',
    });
  }

  it('reconstructs the triplets, the trends and the current therapy from the ledger', () => {
    const twin = build();
    expect(twin.triplets.length).toBe(3);
    expect(twin.summary.completeTriplets).toBe(3);
    expect(twin.summary.latestPhosphate).toBe(6.3);
    expect(twin.summary.latestCorrectedCalcium).toBeCloseTo(9.42, 2);
    expect(twin.summary.latestPth).toBe(740);
    expect(twin.provenance.labEvents).toBe(11);
    expect(twin.provenance.medEvents).toBe(1);
    expect(twin.provenance.attributedBy).toBe('order-id-prefix');
    expect(twin.currentTherapy.binderMgPerDay).toBe(2400);
    expect(twin.currentTherapy.binderClass).toBe('sevelamer');
  });

  it('feeds the advisor a window with serial triplets (so coverage passes)', () => {
    const window = mbdWindowFromTwin(build());
    expect(window.triplets).toBe(3);
    expect(window.phosphate).toBe(6.3);
    expect(window.therapy?.binderMgPerDay).toBe(2400);
    expect(mbdRecommendCovered(window).coverage.covered).toBe(true);
  });

  it('scores per-analyte error against the coupled responder and reports insufficiency honestly', () => {
    const score = scoreMbdTwinDrift(build());
    // three steps is the minimum: below it the verdict must be insufficient
    expect(['pass', 'watch', 'insufficient']).toContain(score.verdict);
    expect(score.rows.length).toBeGreaterThan(0);
    for (const row of score.rows) {
      expect(row.step).toBeTruthy();
      for (const analyte of ['phosphate', 'correctedCalcium', 'pth'] as const) {
        const observed = row.observedDelta[analyte];
        const projected = row.projectedDelta[analyte];
        if (observed !== undefined && projected !== undefined) {
          expect(Number.isFinite(observed - projected)).toBe(true);
        }
      }
    }
    const thin = scoreMbdTwinDrift(buildMbdTwin({
      patientId: 'fac-a-pt-0001',
      events: events.slice(0, 3),
      patients: [{ patientId: 'fac-a-pt-0001', realmId: 'sim:renal-a', state: {} }],
    }));
    expect(thin.verdict).toBe('insufficient');
    expect(thin.note).toMatch(/at least|needed/i);
  });

  it('converts per-dose orders with their frequency into a daily-equivalent therapy state', () => {
    // sevelamer 800 mg three times daily = 2400 mg/day — NOT 800/7
    const state = currentTherapyFromSteps([
      { at: at(50), code: 'sevelamer', doseValue: 800, unit: 'mg', frequency: 'three times daily', class: 'sevelamer', kind: 'binder' },
      { at: at(20), code: 'cinacalcet', doseValue: 30, unit: 'mg', frequency: 'daily', class: 'none', kind: 'calcimimetic' },
      { at: at(20), code: 'calcitriol', doseValue: 0.25, unit: 'mcg', frequency: 'daily', class: 'none', kind: 'vitamin-d' },
    ]);
    expect(state.binderMgPerDay).toBe(2400);
    expect(state.calcimimeticMgPerDay).toBe(30);
    expect(state.activeVitaminDMcgPerDay).toBe(0.25);
    // a weekly order is divided by 7, and a switch of binder class is visible
    const weekly = currentTherapyFromSteps([
      { at: at(40), code: 'sevelamer', doseValue: 16800, unit: 'mg', frequency: 'weekly', class: 'sevelamer', kind: 'binder' },
      { at: at(10), code: 'calcium-acetate', doseValue: 667, unit: 'mg', frequency: 'three times daily', class: 'calcium-acetate', kind: 'binder' },
    ]);
    expect(weekly.binderClass).toBe('calcium-acetate');
    expect(weekly.binderMgPerDay).toBe(2001);
  });
});

describe('P4-E — the coupled multi-output artifact', () => {
  it('builds a vector aligned with the declared feature list', () => {
    const vector = buildMbdVector(HYPERPHOSPHATEMIC, HYPERPHOSPHATEMIC.therapy!);
    expect(vector).toHaveLength(MBD_MODEL_FEATURES.length);
    expect(vector.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('trains three heads whose error is coupled and beats the mechanical responder', () => {
    const rows = buildMbdTrainingRows({ patients: 60 });
    const artifact = trainMbdArtifact(rows, { salt: 'mbd-test' });
    expect(Object.keys(artifact.heads).sort()).toEqual(['correctedCalcium', 'phosphate', 'pth']);
    for (const head of ['phosphate', 'correctedCalcium', 'pth'] as const) {
      expect(artifact.heads[head].metrics.mae, head).toBeDefined();
      expect(artifact.heads[head].metrics.mae!).toBeLessThan(artifact.heads[head].prior.mae!);
      expect(artifact.heads[head].metrics.correlation!).toBeGreaterThan(0.8);
    }
    expect(artifact.modelCard.attribution).toBeDefined();
  });

  it('loads the served artifact and reports its acceptance band', () => {
    const artifact = loadMbdArtifact();
    // the artifact is committed by scripts/train-mbd-model.ts
    if (!artifact) {
      expect(mbdArtifactStatus().band).toBe('insufficient');
      return;
    }
    expect(artifact.id).toBe(MBD_ARTIFACT_ID);
    const status = mbdArtifactStatus();
    expect(status.present).toBe(true);
    expect(status.beatsPriorOnAllHeads).toBe(true);
    expect(status.band).toBe('pass');
    expect(status.note).toMatch(/beat/i);
  });

  it('projects the recommended therapy with the trained heads and names the ranker', () => {
    if (!loadMbdArtifact()) return;
    const projection = mbdProjectTrained(HYPERPHOSPHATEMIC, { ...NO_THERAPY, binderMgPerDay: 2400, binderClass: 'sevelamer' });
    expect(projection.trained?.artifactId).toBe(MBD_ARTIFACT_ID);
    expect(Number.isFinite(projection.trained!.point.phosphate)).toBe(true);
    expect(['head', 'prior']).toContain(projection.trained!.ranker);
  });
});

describe('P4-B — governance: red team, gate and drift', () => {
  it('defines rt-029..rt-032, each containing its attack', () => {
    expect(MBD_RED_TEAM_IDS).toEqual(['rt-029', 'rt-030', 'rt-031', 'rt-032']);
    expect(MBD_RED_TEAM_DEFS).toHaveLength(4);
    for (const def of MBD_RED_TEAM_DEFS) {
      const probe = mbdRedTeamProbe(def);
      expect(probe.scenarioId).toBe(def.id);
      expect(probe.checks.length).toBeGreaterThan(0);
      expect(probe.passed, `${def.id} — ${JSON.stringify(probe.checks)}`).toBe(true);
    }
  });

  it('holds no prescribing authority and registers the model + scenarios durably', async () => {
    const store = new SwarmWorkspaceStore();
    await ensureMbdModel(store);
    await ensureMbdModel(store);
    await ensureMbdRedTeamScenarios(store);
    const models = (await store.listModels()).filter((m) => m.modelId === MBD_MODEL_ID);
    expect(models).toHaveLength(1);
    const scenarios = await store.list('red-team-scenario');
    for (const id of MBD_RED_TEAM_IDS) expect(scenarios.some((s) => s.id === id)).toBe(true);

    const gate = await evaluateMbdAdvisorGate(store);
    expect(gate.posture.prescribingAuthority).toBe('none');
    expect(gate.posture.machineControlAuthority).toBe('none');
    expect(gate.gates.some((g) => g.name === 'No prescribing authority' && g.passed)).toBe(true);
    expect(gate.reasons).toEqual([]);
    expect(isMbdFinding({ scenarioId: 'rt-029' })).toBe(true);
    expect(isMbdFinding({ scenarioId: 'rt-999' })).toBe(false);
  });

  it('detects and records set-point drift', async () => {
    const baseline = [{ phosphate: 4.6, correctedCalcium: 9.2, pth: 300 }, { phosphate: 4.8, correctedCalcium: 9.3, pth: 320 }];
    const drifted = [{ phosphate: 6.4, correctedCalcium: 10.3, pth: 700 }, { phosphate: 6.6, correctedCalcium: 10.4, pth: 760 }];
    const snapshot = computeMbdDrift({ baseline, current: drifted });
    expect(snapshot.verdict).toBe('drift');
    expect(snapshot.features.some((f) => f.feature === 'phosphate' && f.drifted)).toBe(true);
    const stable = computeMbdDrift({ baseline, current: baseline });
    expect(stable.verdict).toBe('stable');
  });

  it('keeps the episode demo bounded and Class C/B', () => {
    expect(MBD_REGULATORY_POSTURE.approvalClass).toBe('C');
    expect(MBD_REGULATORY_POSTURE.autonomy).toBe('never-autonomous');
    const demo = buildMbdDemo();
    expect(demo.cells.map((c) => c.id)).toEqual(MBD_CELLS.map((c) => c.id));
    const classes = new Set(demo.proposals.map((p) => p.approvalClass));
    expect([...classes].every((c) => c === 'B' || c === 'C')).toBe(true);
  });
});

describe('P4-F — routes over the live ledger', () => {
  function inMemoryStore(): PostgresEventStore {
    const events: CanonicalEvent[] = [];
    const ledger: LedgerEntry[] = [];
    const audit: unknown[] = [];
    return {
      async applyMigrations() { /* noop */ },
      async appendEvent(_scope: { scopeId: string; actorRef: string }, ev: CanonicalEvent) { events.push(ev); },
      async queryEvents() { return events; },
      async ledgerAppend(_scope: { scopeId: string; actorRef: string }, e: LedgerEntry) { ledger.push(e); },
      async ledgerQuery() { return ledger; },
      async appendAudit(_scope: { scopeId: string; actorRef: string }, row: unknown) { audit.push(row); },
      async queryAudit() { return audit; },
      async recordFhirResource() { /* noop */ },
      async listFhirResources() { return []; },
    } as unknown as PostgresEventStore;
  }
  const actor: ActorContext = { actorRef: 'user:test', scopeIds: ['scope:*'], clearance: 'restricted-phi', purposeOfUse: 'operations' } as ActorContext;
  const at = (daysAgo: number): string => new Date(Date.parse('2026-09-01T07:00:00Z') - daysAgo * 86_400_000).toISOString();
  const lab = (code: string, value: number, days: number, seq: number): MbdTwinEventInput => ({
    kind: 'result-lab', emittedAt: at(days), realmAt: at(days),
    payload: { orderId: `fac-a-pt-0001-${code}-${seq}`, code, value },
  });

  const ledgerEvents: MbdTwinEventInput[] = [
    lab('PHOS', 5.1, 80, 1), lab('CALCIUM', 9.3, 80, 1), lab('PTH', 420, 80, 1),
    lab('PHOS', 5.6, 50, 2), lab('CALCIUM', 9.2, 50, 2), lab('PTH', 560, 50, 2),
    lab('PHOS', 6.3, 20, 3), lab('CALCIUM', 9.1, 20, 3), lab('PTH', 740, 20, 3), lab('ALBUMIN', 3.6, 20, 3),
    { kind: 'order-med', emittedAt: at(50), realmAt: at(50), payload: { orderId: 'fac-a-pt-0001-sevelamer-1', code: 'sevelamer', dose: '800 mg', frequency: 'three times daily' } },
  ];

  async function build() {
    return buildApp({
      store: inMemoryStore(),
      telemetry: new Telemetry('test', new InMemorySink()),
      packs: [healthcareCorePack],
      authenticate: async () => actor,
      checkHealth: async () => ({ db: true, redis: true }),
      mbdEvents: () => ledgerEvents,
      renalPatients: () => [
        {
          id: 'fac-a-pt-0001', realmId: 'sim:renal-a', medCodes: ['sevelamer', 'cinacalcet'],
          state: { facilityId: 'fac-a', labs: { calcium: 9.1, pth: 740, albumin: 3.6, PHOS: 6.3 } },
        },
      ],
    });
  }

  it('exposes the feature contract, cells, live windows, coupling and artifact', async () => {
    const app = await build();
    try {
      const features = await app.inject({ method: 'GET', url: '/admin/swarm/mbd/features' });
      expect(features.statusCode).toBe(200);
      const featuresBody = features.json() as { features: unknown[]; safety: { prescribingAuthority: string; orderAuthority: string }; coupling: { map: unknown[] } };
      expect(featuresBody.features).toHaveLength(MBD_FEATURES.length);
      expect(featuresBody.safety.prescribingAuthority).toBe('none');
      expect(featuresBody.safety.orderAuthority).toBe('none');
      expect(featuresBody.coupling.map.length).toBeGreaterThan(0);

      for (const url of ['/admin/swarm/mbd/cells', '/admin/swarm/mbd/coupling', '/admin/swarm/mbd/state', '/admin/swarm/mbd/artifact', '/admin/swarm/mbd/assurance', '/admin/swarm/mbd/validation', '/admin/swarm/mbd/demo']) {
        const res = await app.inject({ method: 'GET', url });
        expect(res.statusCode, url).toBe(200);
      }

      const state = await app.inject({ method: 'GET', url: '/admin/swarm/mbd/state' });
      const stateBody = state.json() as { patients: number; kpis: { patientsTracked: number; hyperphosphatemic: number; coverageBlocked: number }; windows: Array<{ patientId: string; recommendation: { action: string; inTarget: boolean }; coverage: { covered: boolean } }> };
      expect(stateBody.patients).toBe(1);
      expect(stateBody.kpis.patientsTracked).toBe(1);
      // the live window is built from the ledger's three triplets → covered
      expect(stateBody.windows[0]!.coverage.covered).toBe(true);
      expect(stateBody.kpis.hyperphosphatemic).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('advises, runs the counterfactual and serves the twin', async () => {
    const app = await build();
    try {
      const advise = await app.inject({ method: 'POST', url: '/admin/swarm/mbd/advise', payload: { patientId: 'fac-a-pt-0001' } });
      expect(advise.statusCode).toBe(200);
      const advised = advise.json() as { recommendation: { action: string; coverage: { covered: boolean } }; coupling: unknown[]; guardrails: { flags: string[] } };
      expect(advised.recommendation.coverage.covered).toBe(true);
      expect(advised.recommendation.action).not.toBe('blocked');
      expect(advised.coupling.length).toBeGreaterThan(0);

      const trained = await app.inject({ method: 'POST', url: '/admin/swarm/mbd/advise', payload: { patientId: 'fac-a-pt-0001', model: 'trained' } });
      expect(trained.statusCode).toBe(200);
      if (loadMbdArtifact()) {
        expect((trained.json() as { trained: { artifactId: string } }).trained.artifactId).toBe(MBD_ARTIFACT_ID);
      }

      const whatIf = await app.inject({ method: 'POST', url: '/admin/swarm/mbd/what-if', payload: { patientId: 'fac-a-pt-0001' } });
      expect(whatIf.statusCode).toBe(200);
      const whatIfBody = whatIf.json() as { result: { candidates: unknown[]; recommended?: { allowed: boolean } }; contract: { envelope: { correctedCalciumCeilingMgDl: number }; refused: unknown[] } };
      expect(whatIfBody.result.candidates.length).toBeGreaterThan(0);
      expect(whatIfBody.contract.envelope.correctedCalciumCeilingMgDl).toBe(MBD_REFERENCE.calciumSafetyCeilingMgDl);

      const twin = await app.inject({ method: 'POST', url: '/admin/swarm/mbd/twin', payload: { patientId: 'fac-a-pt-0001' } });
      expect(twin.statusCode).toBe(200);
      const twinBody = twin.json() as { twin: { summary: { completeTriplets: number; latestPhosphate?: number } }; drift: { verdict: string } };
      // the chart baseline in state.labs plus the three ledger triplets
      expect(twinBody.twin.summary.completeTriplets).toBeGreaterThanOrEqual(3);
      expect(twinBody.twin.summary.latestPhosphate).toBe(6.3);

      const score = await app.inject({ method: 'POST', url: '/admin/swarm/mbd/twin/score', payload: { patientId: 'fac-a-pt-0001' } });
      expect(score.statusCode).toBe(200);
      expect(['pass', 'watch', 'insufficient']).toContain((score.json() as { score: { verdict: string } }).score.verdict);

      const project = await app.inject({ method: 'POST', url: '/admin/swarm/mbd/twin/project', payload: { patientId: 'fac-a-pt-0001' } });
      expect(project.statusCode).toBe(200);
      expect((project.json() as { projection: { points: Record<string, unknown> } }).projection.points[30]).toBeDefined();
    } finally {
      await app.close();
    }
  });

  it('runs the red team, records drift and files the MDR', async () => {
    const app = await build();
    try {
      const redTeam = await app.inject({ method: 'POST', url: '/admin/swarm/mbd/red-team', payload: { ranBy: 'test' } });
      expect(redTeam.statusCode).toBe(200);
      const rtBody = redTeam.json() as { passed: boolean; probes: Array<{ scenarioId: string; passed: boolean }> };
      expect(rtBody.probes.map((p) => p.scenarioId).sort()).toEqual([...MBD_RED_TEAM_IDS].sort());
      expect(rtBody.passed).toBe(true);

      const drift = await app.inject({ method: 'POST', url: '/admin/swarm/mbd/drift', payload: {} });
      expect(drift.statusCode).toBe(200);
      expect((drift.json() as { snapshot: { metric: string } }).snapshot.metric).toMatch(/ks|mbd/i);

      const mdr = await app.inject({ method: 'GET', url: '/admin/swarm/mbd/mdr' });
      expect(mdr.statusCode).toBe(200);
      const mdrBody = mdr.json() as { mdr: { classification: { approvalClass: string }; limitations: string[]; postMarket: { redTeam: string[] } } };
      expect(mdrBody.mdr.classification.approvalClass).toBe('C');
      expect(mdrBody.mdr.limitations.join(' ')).toMatch(/synthetic/i);
      expect(mdrBody.mdr.postMarket.redTeam).toEqual([...MBD_RED_TEAM_IDS]);

      const study = await app.inject({ method: 'POST', url: '/admin/swarm/mbd/study/record', payload: { patientId: 'fac-a-pt-0001', clinician: 'dr-test', action: 'accept' } });
      expect(study.statusCode).toBe(200);
      const listed = await app.inject({ method: 'GET', url: '/admin/swarm/mbd/study' });
      expect((listed.json() as { count: number }).count).toBe(1);

      const demo = await app.inject({ method: 'POST', url: '/admin/swarm/mbd/demo' });
      expect(demo.statusCode).toBe(200);
      const reset = await app.inject({ method: 'POST', url: '/admin/swarm/mbd/reset' });
      expect(reset.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
