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

// P5 — nutrition / electrolytes protocol pack (steps A–F): the five-pathway PEW
// decomposition, the potassium forecast, the mandatory lab-confirmation contract,
// the plan counterfactual, the twin, the artifact, governance and the routes.

import { describe, expect, it } from 'vitest';
import {
  NUTRITION_FEATURES, NUTRITION_REFERENCE, NUTRITION_CELLS, pewPathways, assessPew,
  forecastPotassium, guardNutritionPlan, nutritionLatent, nutritionRecommend,
  buildNutritionDemo, NUTRITION_EPISODE_KINDS,
  type NutritionGuardInput,
} from '../src/swarm/nutrition.js';
import {
  nutritionCoverage, nutritionRecommendCovered, NUTRITION_RED_TEAM_DEFS, NUTRITION_RED_TEAM_IDS,
  nutritionRedTeamProbe, ensureNutritionModel, ensureNutritionRedTeamScenarios, computeNutritionDrift,
  evaluateNutritionAdvisorGate, NUTRITION_COVERAGE_DEFAULTS, NUTRITION_MODEL_ID,
  NUTRITION_REGULATORY_POSTURE, isNutritionFinding,
} from '../src/swarm/nutrition-governance.js';
import { nutritionWhatIf, pathwayProjection, NUTRITION_TRADEOFF_WEIGHTS, NUTRITION_SIMULATOR_MODEL } from '../src/swarm/nutrition-simulator.js';
import { buildNutritionTwin, scoreNutritionTwinDrift, nutritionWindowFromTwin, type NutritionTwinEventInput } from '../src/swarm/nutrition-twin.js';
import {
  NUTRITION_MODEL_FEATURES, buildNutritionVector, buildNutritionTrainingRows, trainNutritionArtifact,
  loadNutritionArtifact, nutritionArtifactStatus, nutritionPewTrained, NUTRITION_ARTIFACT_ID,
} from '../src/swarm/nutrition-model.js';
import { SwarmWorkspaceStore } from '../src/swarm/workspace.js';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import type { PostgresEventStore } from '../src/server/postgres-event-store.js';
import type { CanonicalEvent } from '../src/healthcare-core/events.js';
import type { LedgerEntry } from '../src/hypergraph/ledger.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import type { ActorContext } from '../src/server/scoped-persistence.js';

const NOW = '2026-09-01T10:00:00Z';

/** Classic PEW with a definite cause list, and a potassium that is NOT explained by intake. */
const PEW_WINDOW: NutritionGuardInput = {
  patientId: 'p-pew-1',
  albumin: 3.2,
  albuminSeries: [3.7, 3.5, 3.2],
  crp: 4,
  crpSeries: [3, 4],
  handgripKg: 22,
  nonHdlMgDl: 88,
  creatinineMgDl: 10.8,
  dryWeightDeltaKg: 0.3,
  appetiteScore: 3,
  potassium: 5.1,
  potassiumSeries: [4.9, 5.1],
  potassiumMeasuredAt: NOW,
  bicarbonate: 22,
  interdialyticHours: 48,
  ktV: 1.35,
  raasi: false,
  asOf: NOW,
};

/** The inflammation phenotype: a falling albumin with a high CRP and a normal appetite. */
const INFLAMED_WINDOW: NutritionGuardInput = {
  ...PEW_WINDOW,
  albumin: 3.1,
  albuminSeries: [3.6, 3.4, 3.1],
  crp: 28,
  crpSeries: [12, 28],
  appetiteScore: 8,
  handgripKg: 30,
  nonHdlMgDl: 130,
};

describe('P5-A — feature contract, reference bounds and the five pathways', () => {
  it('declares the nutrition/electrolyte feature contract', () => {
    expect(NUTRITION_FEATURES).toHaveLength(12);
    expect(NUTRITION_FEATURES.map((f) => f.id)).toContain('potassium');
    expect(NUTRITION_FEATURES.map((f) => f.id)).toContain('bicarbonate');
    expect(NUTRITION_REFERENCE.potassiumHighMmolL).toBe(6.0);
    expect(NUTRITION_REFERENCE.potassiumLabMaxAgeHours).toBe(12);
    expect(NUTRITION_REFERENCE.horizonsDays).toEqual([30, 60, 90]);
  });

  it('disentangles PEW into five pathways with five different explanations', () => {
    const pathways = pewPathways(PEW_WINDOW);
    expect(pathways.map((p) => p.pathway).sort()).toEqual(['catabolism', 'dilution', 'inadequate-dialysis', 'inflammation', 'poor-intake']);
    expect(new Set(pathways.map((p) => p.because)).size).toBe(5);
    // appetite + low cholesterol + falling albumin → the intake pathway leads
    expect(pathways[0]!.pathway).toBe('poor-intake');
    expect(pewPathways(PEW_WINDOW)[0]!.score).toBeGreaterThan(0.5);
  });

  it('names inflammation — not intake — when the CRP is high and appetite is normal', () => {
    const pathways = pewPathways(INFLAMED_WINDOW);
    expect(pathways[0]!.pathway).toBe('inflammation');
    const intake = pathways.find((p) => p.pathway === 'poor-intake')!;
    expect(pathways[0]!.score).toBeGreaterThan(intake.score);
  });

  it('requires 3 of the 5 PEW markers and grades severity', () => {
    const assessment = assessPew(PEW_WINDOW);
    expect(assessment.markersPresent).toBeGreaterThanOrEqual(3);
    expect(assessment.pew).toBe(true);
    expect(['mild', 'moderate', 'severe']).toContain(assessment.severity);
    // a well-nourished patient is not PEW
    const healthy = assessPew({ patientId: 'p-ok', albumin: 4.0, albuminSeries: [4.0, 4.0], crp: 3, handgripKg: 32, nonHdlMgDl: 140, appetiteScore: 8 });
    expect(healthy.pew).toBe(false);
    expect(healthy.markersPresent).toBe(0);
  });
});

describe('P5-A — potassium forecast and the acidosis coupling', () => {
  it('projects the next session and reports P(K > 6.0) with ranked drivers', () => {
    const forecast = forecastPotassium(PEW_WINDOW);
    expect(forecast.nextSession).toBeDefined();
    expect(forecast.probabilityAbove6).toBeGreaterThanOrEqual(0);
    expect(forecast.probabilityAbove6).toBeLessThanOrEqual(1);
    expect(forecast.drivers.length).toBeGreaterThan(2);
    expect(forecast.drivers.map((d) => d.id)).toContain('interdialyticHours');
  });

  it('rises with the interdialytic interval and with acidosis, and falls with the delivered dose', () => {
    const base = forecastPotassium({ ...PEW_WINDOW, potassium: 5.2, bicarbonate: 24 });
    const longer = forecastPotassium({ ...PEW_WINDOW, potassium: 5.2, bicarbonate: 24, interdialyticHours: 96 });
    const acidotic = forecastPotassium({ ...PEW_WINDOW, potassium: 5.2, bicarbonate: 17 });
    const wellDialysed = forecastPotassium({ ...PEW_WINDOW, potassium: 5.2, bicarbonate: 24, ktV: 1.7 });
    expect(longer.nextSession!).toBeGreaterThan(base.nextSession!);
    expect(acidotic.nextSession!).toBeGreaterThan(base.nextSession!);
    expect(wellDialysed.nextSession!).toBeLessThan(base.nextSession!);
    // P(K>6) must be monotone in the projected value
    expect(longer.probabilityAbove6!).toBeGreaterThan(base.probabilityAbove6!);
  });

  it('cannot forecast without a potassium (and says so)', () => {
    const forecast = forecastPotassium({ patientId: 'p-none' });
    expect(forecast.nextSession).toBeUndefined();
    expect(forecast.note).toMatch(/no .*potassium/i);
  });
});

describe('P5-B — guardrails: emergency vs routine and the lab-confirmation contract', () => {
  it('blocks a window with no serial measurements at all', () => {
    const guardrails = guardNutritionPlan({ patientId: 'p-1', albumin: 3.0, potassium: 5.0, asOf: NOW });
    expect(guardrails.blocked).toBe(true);
    expect(guardrails.flags).toContain('no-serial-measurements');
    expect(guardrails.blockReason).toMatch(/serial/i);
  });

  it('never lets an ECG pattern stand alone', () => {
    const guardrails = guardNutritionPlan({ ...PEW_WINDOW, ecgFlags: ['peaked-t'] });
    expect(guardrails.ecgAdjunctOnly).toBe(true);
    expect(guardrails.flags).toContain('ecg-adjunct-only');
    // a NORMAL potassium with an ECG pattern is not an emergency
    const normal = nutritionRecommend({ ...PEW_WINDOW, potassium: 4.7, potassiumSeries: [4.6, 4.7], ecgFlags: ['peaked-t'] });
    expect(normal.safety.emergency).toBe(false);
    expect(normal.action).not.toBe('ed-triage');
    expect(normal.safety.requiresLabConfirmation).toBe(false);
  });

  it('downgrades a stale potassium to a lab request and requires confirmation', () => {
    const stale = nutritionRecommend({ ...PEW_WINDOW, potassium: 6.6, potassiumMeasuredAt: '2026-08-29T06:00:00Z', asOf: NOW });
    expect(stale.guardrails.flags).toContain('potassium-lab-stale');
    expect(stale.action).toBe('urgent-lab-confirmation');
    expect(stale.safety.requiresLabConfirmation).toBe(true);
    expect(stale.note).toMatch(/confirm|stale/i);
  });

  it('escalates to ED triage ONLY with a current lab and a potassium ≥ 6.5', () => {
    const confirmed = nutritionRecommend({ ...PEW_WINDOW, potassium: 6.7, potassiumSeries: [6.2, 6.7], potassiumMeasuredAt: NOW, asOf: NOW });
    expect(confirmed.action).toBe('ed-triage');
    expect(confirmed.safety.emergency).toBe(true);
    expect(confirmed.safety.requiresLabConfirmation).toBe(true);
    expect(confirmed.note).toMatch(/rule, not a model output/i);
    // every hyperkalaemia action requires a lab — without exception
    expect(confirmed.plan).toContain('k-binder-plan');
    expect(confirmed.safety.requiresLabConfirmation).toBe(true);
  });

  it('raises a GI red flag rather than burying it under a nutrition plan', () => {
    const guardrails = guardNutritionPlan({ ...PEW_WINDOW, gastrointestinalBleeding: true });
    expect(guardrails.flags).toContain('gi-red-flag');
  });

  it('checks the pathway before the plan (dose first when dialysis is inadequate)', () => {
    const underdialysed = nutritionRecommend({ ...PEW_WINDOW, ktV: 1.05, creatinineMgDl: 12.2, creatinineSeries: [11.8, 12.2] });
    expect(underdialysed.pew.dominant).toBe('inadequate-dialysis');
    expect(underdialysed.action).toBe('dialysis-dose-review');
    expect(underdialysed.note).toMatch(/under-dialysis|prescription/i);
  });

  it('separates the nutrition deficit from the electrolyte risk in the latent', () => {
    const latent = nutritionLatent(PEW_WINDOW);
    expect(latent.polarRadius).toBeGreaterThan(0);
    const risky = nutritionLatent({ ...PEW_WINDOW, potassium: 6.4, bicarbonate: 16, interdialyticHours: 96 });
    expect(risky.polarRadius).toBeGreaterThan(latent.polarRadius);
    // a normal window collapses toward the origin
    expect(nutritionLatent({ patientId: 'p-ok', albumin: 4.0, albuminSeries: [4.0, 4.0], crp: 3, handgripKg: 32, nonHdlMgDl: 140, potassium: 4.4, bicarbonate: 24, ktV: 1.5 }).polarRadius).toBeLessThan(latent.polarRadius);
  });
});

describe('P5-B — coverage gate', () => {
  it('blocks a window without serial measurements', () => {
    const coverage = nutritionCoverage({ patientId: 'p-1', albumin: 3.0, crp: 12, handgripKg: 20, potassium: 5.2, asOf: NOW });
    expect(coverage.covered).toBe(false);
    expect(coverage.reason).toMatch(/serial/i);
    expect(coverage.serial.required).toBe(NUTRITION_COVERAGE_DEFAULTS.minSerialMeasurements);
    expect(nutritionRecommendCovered({ patientId: 'p-1', albumin: 3.0, crp: 12, potassium: 5.2, asOf: NOW }).action).toBe('blocked');
  });

  it('covers a window with serial markers', () => {
    const covered = nutritionRecommendCovered(PEW_WINDOW);
    expect(covered.coverage.covered).toBe(true);
    expect(covered.action).not.toBe('blocked');
    expect(covered.coverage.markers.observed).toBeGreaterThanOrEqual(NUTRITION_COVERAGE_DEFAULTS.minNutritionMarkers);
  });
});

describe('P5-C — plan counterfactual', () => {
  it('projects every candidate on the pathway markers and flags the contract', () => {
    const result = nutritionWhatIf(PEW_WINDOW);
    expect(result.model).toEqual(NUTRITION_SIMULATOR_MODEL);
    expect(result.candidates.length).toBeGreaterThan(6);
    expect(result.recommended).toBeDefined();
    expect(result.recommended!.allowed).toBe(true);
    for (const candidate of result.candidates) {
      expect(Number.isFinite(candidate.score)).toBe(true);
      expect(Number.isFinite(candidate.projected.albumin)).toBe(true);
      expect(Number.isFinite(candidate.projected.potassium)).toBe(true);
    }
    // the dietitian lever must move the intake markers, the binder the potassium
    const dietitian = result.candidates.find((c) => c.action === 'dietitian-referral')!;
    expect(dietitian.projected.albumin).toBeGreaterThan(PEW_WINDOW.albumin!);
    const binder = result.candidates.find((c) => c.action === 'k-binder-plan')!;
    expect(binder.projected.potassium).toBeLessThan(PEW_WINDOW.potassium!);
  });

  it('recommends no plan at all when the guardrails block, and every candidate is refused', () => {
    const blocked = nutritionWhatIf({ patientId: 'p-none', albumin: 3.0, potassium: 5.0, asOf: NOW });
    expect(blocked.blocked).toBe(true);
    expect(blocked.candidates.every((c) => c.allowed === false)).toBe(true);
    expect(blocked.recommended).toBeUndefined();
    expect(blocked.note).toMatch(/no viable plan/i);
  });

  it('requires a lab confirmation for any candidate the contract puts in the hyperkalaemic range', () => {
    const risky = nutritionWhatIf({ ...PEW_WINDOW, potassium: 6.2, potassiumSeries: [6.0, 6.2], potassiumMeasuredAt: NOW });
    const potassiumRaising = risky.candidates.filter((c) => c.projected.potassium > NUTRITION_REFERENCE.potassiumHighMmolL - 0.2);
    expect(potassiumRaising.every((c) => c.requiresLabConfirmation)).toBe(true);
    expect(Object.keys(NUTRITION_TRADEOFF_WEIGHTS)).toContain('hyperkalemia');
    expect(NUTRITION_TRADEOFF_WEIGHTS.hyperkalemia).toBeGreaterThan(NUTRITION_TRADEOFF_WEIGHTS.burden);
  });

  it('reports how each candidate shifts the pathway attribution', () => {
    const shift = pathwayProjection(INFLAMED_WINDOW, 'inflammation-review');
    expect(shift).toHaveLength(5);
    // the targeted pathway must fall and the intake pathway must not be the one moved
    const inflammation = shift.find((s) => s.pathway === 'inflammation')!;
    expect(inflammation.after).toBeLessThan(inflammation.before);
    const noOp = pathwayProjection(INFLAMED_WINDOW, 'continue');
    expect(noOp.find((s) => s.pathway === 'inflammation')!.after).toBe(noOp.find((s) => s.pathway === 'inflammation')!.before);
  });
});

describe('P5-D — twin over the real ledger', () => {
  const at = (daysAgo: number): string => new Date(Date.parse('2026-09-01T07:00:00Z') - daysAgo * 86_400_000).toISOString();
  const lab = (code: string, value: number, days: number, seq: number): NutritionTwinEventInput => ({
    kind: 'result-lab', emittedAt: at(days), realmAt: at(days),
    payload: { orderId: `fac-a-pt-0001-${code}-${seq}`, code, value },
  });

  const events: NutritionTwinEventInput[] = [
    lab('ALBUMIN', 3.6, 70, 1), lab('CRP', 14, 70, 1),
    lab('ALBUMIN', 3.4, 50, 2), lab('CRP', 22, 50, 2),
    lab('ALBUMIN', 3.1, 30, 3), lab('CRP', 28, 30, 3), lab('BICARB', 19, 30, 3),
    lab('K', 4.6, 30, 3), lab('K', 4.8, 25, 4), lab('K', 5.1, 20, 5), lab('K', 5.4, 15, 6),
    lab('K', 5.8, 10, 7), lab('K', 6.2, 5, 8), lab('K', 6.5, 3, 9), lab('K', 6.8, 1, 10),
    lab('NONHDL', 92, 30, 3), lab('CREATININE', 11.2, 30, 3),
    { kind: 'record-assessment', emittedAt: at(30), realmAt: at(30), payload: { patientId: 'fac-a-pt-0001', assessmentId: 'handgrip', score: 21, band: 'low' } },
    { kind: 'flag-safety-event', emittedAt: at(5), realmAt: at(5), payload: { patientId: 'fac-a-pt-0001', safetyKind: 'ecg-peaked-t-pattern', severity: 'moderate' } },
  ];

  const build = () => buildNutritionTwin({
    patientId: 'fac-a-pt-0001',
    events,
    patients: [{ patientId: 'fac-a-pt-0001', realmId: 'sim:renal-a', state: {} }],
    asOf: '2026-09-01T10:00:00Z',
  });

  it('reconstructs the serial nutrition series, the handgrip and the ECG adjunct from the ledger', () => {
    const twin = build();
    expect(twin.observations.length).toBeGreaterThan(5);
    expect(twin.summary.latestAlbumin).toBe(3.1);
    expect(twin.summary.latestCrp).toBe(28);
    expect(twin.summary.latestHandgripKg).toBe(21);
    expect(twin.summary.latestNonHdlMgDl).toBe(92);
    expect(twin.summary.latestPotassium).toBe(6.8);
    expect(twin.summary.latestBicarbonate).toBe(19);
    expect(twin.summary.pew).toBe(true);
    // serial labs arrive with only an orderId (prefix attribution); the handgrip
    // assessment carries a patientId, so provenance records the stronger evidence
    expect(['payload-patientId', 'order-id-prefix']).toContain(twin.provenance.attributedBy);
    expect(twin.provenance.labEvents).toBeGreaterThan(10);
    expect(twin.provenance.assessmentEvents).toBe(1);
    expect(twin.ecgFlags).toHaveLength(1);
    expect(twin.ecgFlags[0]!.pattern).toBe('peaked-t-pattern');
    expect(twin.observations[0]!.at < twin.observations.at(-1)!.at).toBe(true);
  });

  it('feeds the advisor a covered window and carries the ECG as an adjunct only', () => {
    const window = nutritionWindowFromTwin(build());
    expect(window.potassium).toBe(6.8);
    expect(window.ecgFlags).toEqual(['peaked-t-pattern']);
    expect(nutritionRecommendCovered(window).coverage.covered).toBe(true);
    const recommendation = nutritionRecommend(window);
    expect(recommendation.safety.ecgAdjunctOnly).toBe(true);
    expect(recommendation.safety.requiresLabConfirmation).toBe(true);
  });

  it('scores the potassium forecast against the observed next-session values', () => {
    const score = scoreNutritionTwinDrift(build());
    expect(score.potassiumPairs).toBeGreaterThanOrEqual(4);
    expect(score.observedEvents).toBeGreaterThan(0);
    expect(score.potassiumMae).toBeDefined();
    expect(score.auroc).toBeDefined();
    expect(['pass', 'watch']).toContain(score.verdict);
    expect(score.rows.length).toBe(score.potassiumPairs);
    for (const row of score.rows) {
      expect(row.projected).toBeDefined();
      expect(row.observed).toBeDefined();
    }
  });

  it('reports insufficiency rather than inventing an AUROC', () => {
    const thin = scoreNutritionTwinDrift(buildNutritionTwin({
      patientId: 'fac-a-pt-0001',
      events: events.filter((e) => e.payload.code !== 'K'),
      patients: [{ patientId: 'fac-a-pt-0001', realmId: 'sim:renal-a', state: {} }],
    }));
    expect(thin.verdict).toBe('insufficient');
    expect(thin.potassiumMae).toBeUndefined();
    expect(thin.note).toMatch(/at least|needed/i);
  });
});

describe('P5-E — the PEW classifier + potassium regressor artifact', () => {
  it('builds a vector aligned with the declared feature list', () => {
    const vector = buildNutritionVector(PEW_WINDOW);
    expect(vector).toHaveLength(NUTRITION_MODEL_FEATURES.length);
    expect(vector.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('trains a PEW classifier that beats the marker-count prior and a potassium head that beats the forecast', () => {
    const rows = buildNutritionTrainingRows({ patients: 80 });
    const artifact = trainNutritionArtifact(rows, { salt: 'nutrition-test' });
    expect(artifact.rows).toBe(rows.length);
    expect(artifact.patients).toBeGreaterThan(40);
    expect(artifact.classifier.priorAuroc).toBeLessThan(artifact.classifier.metrics.auroc);
    expect(artifact.regressor.metrics.mae).toBeLessThan(artifact.regressor.prior.mae!);
    expect(artifact.reliability.length).toBeGreaterThan(2);
    // five generating pathways, each with its own attribution and audit row
    expect(Object.keys(artifact.pathwayAttribution).length).toBe(5);
    expect(artifact.pathwayAudit.length).toBe(5);
    // the ECG is never a feature
    expect(NUTRITION_MODEL_FEATURES as readonly string[]).not.toContain('ecgFlags');
    expect(NUTRITION_MODEL_FEATURES as readonly string[]).not.toContain('ecg');
  });

  it('loads the served artifact and reports the acceptance band honestly', () => {
    const artifact = loadNutritionArtifact();
    if (!artifact) {
      expect(nutritionArtifactStatus().band).toBe('insufficient');
      return;
    }
    expect(artifact.id).toBe(NUTRITION_ARTIFACT_ID);
    const status = nutritionArtifactStatus();
    expect(status.present).toBe(true);
    expect(status.meetsPewTarget).toBe(true);
    expect(status.beatsMarkerPrior).toBe(true);
    expect(status.band).toBe('pass');
    expect(status.note).toMatch(/prior/i);
  });

  it('attaches a trained PEW probability to a window', () => {
    if (!loadNutritionArtifact()) return;
    const trained = nutritionPewTrained(PEW_WINDOW).trained;
    expect(trained?.artifactId).toBe(NUTRITION_ARTIFACT_ID);
    expect(trained!.pewProbability).toBeGreaterThanOrEqual(0);
    expect(trained!.pewProbability).toBeLessThanOrEqual(1);
    expect(trained!.drivers.length).toBeGreaterThan(0);
  });
});

describe('P5-B — governance: red team, gate and drift', () => {
  it('defines rt-033..rt-036 and each probe contains its attack', () => {
    expect(NUTRITION_RED_TEAM_IDS).toEqual(['rt-033', 'rt-034', 'rt-035', 'rt-036']);
    expect(NUTRITION_RED_TEAM_DEFS).toHaveLength(4);
    for (const def of NUTRITION_RED_TEAM_DEFS) {
      const probe = nutritionRedTeamProbe(def);
      expect(probe.scenarioId).toBe(def.id);
      expect(probe.passed, `${def.id} — ${JSON.stringify(probe.checks)}`).toBe(true);
    }
  });

  it('registers the model + scenarios and gates on the lab-confirmation contract', async () => {
    const store = new SwarmWorkspaceStore();
    expect(await ensureNutritionModel(store)).toBe(true);
    expect(await ensureNutritionModel(store)).toBe(false);
    expect(await ensureNutritionRedTeamScenarios(store)).toBe(4);
    expect((await store.listModels()).some((m) => m.modelId === NUTRITION_MODEL_ID)).toBe(true);

    const gate = await evaluateNutritionAdvisorGate(store);
    expect(gate.status).toBe('active');
    expect(gate.posture.ecgStandaloneAuthority).toBe('never');
    expect(gate.posture.prescribingAuthority).toBe('none');
    expect(gate.gates.some((g) => g.name === 'Lab-confirmation contract' && g.passed)).toBe(true);
    expect(gate.reasons).toEqual([]);
    expect(isNutritionFinding({ scenarioId: 'rt-033' })).toBe(true);
    expect(isNutritionFinding({ scenarioId: 'rt-029' })).toBe(false);
  });

  it('detects nutrition/electrolyte drift and stays quiet when stable', () => {
    const baseline = [{ albumin: 3.6, potassium: 4.6, bicarbonate: 23 }, { albumin: 3.7, potassium: 4.7, bicarbonate: 22 }];
    const drifted = [{ albumin: 2.9, potassium: 6.3, bicarbonate: 17 }, { albumin: 2.8, potassium: 6.5, bicarbonate: 16 }];
    const snapshot = computeNutritionDrift({ baseline, current: drifted });
    expect(snapshot.verdict).toBe('drift');
    expect(snapshot.status).toBe('drifted');
    expect(snapshot.features.some((f) => f.feature === 'potassium' && f.drifted)).toBe(true);
    expect(computeNutritionDrift({ baseline, current: baseline }).verdict).toBe('stable');
  });

  it('keeps the demo bounded, Class C/B and question-shaped', () => {
    expect(NUTRITION_REGULATORY_POSTURE.approvalClass).toBe('C');
    expect(NUTRITION_REGULATORY_POSTURE.autonomy).toBe('never-autonomous');
    expect(NUTRITION_EPISODE_KINDS).toEqual(['nutrition.pew-response']);
    const demo = buildNutritionDemo();
    expect(demo.cells.map((c) => c.id)).toEqual(NUTRITION_CELLS.map((c) => c.id));
    expect(demo.proposals.every((p) => p.approvalClass === 'B' || p.approvalClass === 'C')).toBe(true);
  });
});

describe('P5-F — routes over the live ledger', () => {
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
  const lab = (code: string, value: number, days: number, seq: number): NutritionTwinEventInput => ({
    kind: 'result-lab', emittedAt: at(days), realmAt: at(days),
    payload: { orderId: `fac-a-pt-0001-${code}-${seq}`, code, value },
  });

  const ledgerEvents: NutritionTwinEventInput[] = [
    lab('ALBUMIN', 3.6, 70, 1), lab('CRP', 14, 70, 1),
    lab('ALBUMIN', 3.4, 50, 2), lab('CRP', 22, 50, 2),
    lab('ALBUMIN', 3.1, 30, 3), lab('CRP', 28, 30, 3), lab('BICARB', 19, 30, 3),
    lab('K', 5.1, 30, 3), lab('K', 5.4, 20, 4), lab('K', 5.8, 12, 5), lab('K', 6.2, 5, 6), lab('K', 6.5, 2, 7),
    lab('NONHDL', 92, 30, 3), lab('CREATININE', 11.2, 30, 3),
    { kind: 'record-assessment', emittedAt: at(30), realmAt: at(30), payload: { patientId: 'fac-a-pt-0001', assessmentId: 'handgrip', score: 21, band: 'low' } },
  ];

  async function build() {
    return buildApp({
      store: inMemoryStore(),
      telemetry: new Telemetry('test', new InMemorySink()),
      packs: [healthcareCorePack],
      authenticate: async () => actor,
      checkHealth: async () => ({ db: true, redis: true }),
      nutritionEvents: () => ledgerEvents,
      renalPatients: () => [
        {
          id: 'fac-a-pt-0001', realmId: 'sim:renal-a', medCodes: ['sevelamer'],
          state: { facilityId: 'fac-a', labs: { albumin: 3.1, crp: 28, K: 6.5, bicarb: 19, creatinine: 11.2, NONHDL: 92 } },
        },
      ],
    });
  }

  it('exposes the feature contract, cells, pathways, safety and live windows', async () => {
    const app = await build();
    try {
      const features = await app.inject({ method: 'GET', url: '/admin/swarm/nutrition/features' });
      expect(features.statusCode).toBe(200);
      const body = features.json() as { features: unknown[]; safety: { orderAuthority: string; ecgStandaloneAuthority: string }; pathways: { list: unknown[] }; tradeoffWeights: Record<string, number> };
      expect(body.features).toHaveLength(NUTRITION_FEATURES.length);
      expect(body.safety.orderAuthority).toBe('none');
      expect(body.safety.ecgStandaloneAuthority).toBe('never');
      expect(body.pathways.list).toHaveLength(5);
      expect(body.tradeoffWeights.hyperkalemia!).toBeGreaterThan(body.tradeoffWeights.burden!);

      for (const url of ['/admin/swarm/nutrition/cells', '/admin/swarm/nutrition/pathways', '/admin/swarm/nutrition/safety', '/admin/swarm/nutrition/state', '/admin/swarm/nutrition/artifact', '/admin/swarm/nutrition/assurance', '/admin/swarm/nutrition/validation', '/admin/swarm/nutrition/demo']) {
        const res = await app.inject({ method: 'GET', url });
        expect(res.statusCode, url).toBe(200);
      }

      const pathways = await app.inject({ method: 'GET', url: '/admin/swarm/nutrition/pathways?patientId=fac-a-pt-0001' });
      const pathwaysBody = pathways.json() as { source: string; pathways: Array<{ pathway: string; score: number }>; dominant: string; potassium: { nextSession?: number } };
      expect(pathwaysBody.source).toBe('realm-ledger');
      expect(pathwaysBody.pathways).toHaveLength(5);
      expect(pathwaysBody.potassium.nextSession).toBeDefined();

      const safety = await app.inject({ method: 'GET', url: '/admin/swarm/nutrition/safety' });
      const safetyBody = safety.json() as { ecgAuthority: string; rules: string[]; probe: { recommendation: { action: string; safety: { requiresLabConfirmation: boolean } } } };
      expect(safetyBody.ecgAuthority).toBe('adjunct-only');
      expect(safetyBody.rules.join(' ')).toMatch(/never trigger|adjunct/i);
      expect(safetyBody.probe.recommendation.safety.requiresLabConfirmation).toBe(true);

      const state = await app.inject({ method: 'GET', url: '/admin/swarm/nutrition/state' });
      const stateBody = state.json() as { patients: number; kpis: { patientsTracked: number; labConfirmationRequired: number }; windows: Array<{ patientId: string; coverage: { covered: boolean } }> };
      expect(stateBody.patients).toBe(1);
      expect(stateBody.kpis.patientsTracked).toBe(1);
      expect(stateBody.windows[0]!.coverage.covered).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('advises, runs the plan counterfactual and serves the twin', async () => {
    const app = await build();
    try {
      const advise = await app.inject({ method: 'POST', url: '/admin/swarm/nutrition/advise', payload: { patientId: 'fac-a-pt-0001' } });
      expect(advise.statusCode).toBe(200);
      const advised = advise.json() as { recommendation: { action: string; safety: { requiresLabConfirmation: boolean }; pew: { pew: boolean } }; safety: { requiresLabConfirmation: boolean } };
      expect(advised.recommendation.safety.requiresLabConfirmation).toBe(true);
      expect(['urgent-lab-confirmation', 'ed-triage']).toContain(advised.recommendation.action);

      const trained = await app.inject({ method: 'POST', url: '/admin/swarm/nutrition/advise', payload: { patientId: 'fac-a-pt-0001', model: 'trained' } });
      expect(trained.statusCode).toBe(200);
      if (loadNutritionArtifact()) {
        expect((trained.json() as { trained: { artifactId: string } }).trained.artifactId).toBe(NUTRITION_ARTIFACT_ID);
      }

      const whatIf = await app.inject({ method: 'POST', url: '/admin/swarm/nutrition/what-if', payload: { patientId: 'fac-a-pt-0001' } });
      expect(whatIf.statusCode).toBe(200);
      const whatIfBody = whatIf.json() as { result: { candidates: unknown[] }; pathwayShift: unknown[]; potassiumContract: { requiresLabConfirmation: boolean } };
      expect(whatIfBody.result.candidates.length).toBeGreaterThan(6);
      expect(whatIfBody.pathwayShift).toHaveLength(5);

      const twin = await app.inject({ method: 'POST', url: '/admin/swarm/nutrition/twin', payload: { patientId: 'fac-a-pt-0001' } });
      expect(twin.statusCode).toBe(200);
      const twinBody = twin.json() as { twin: { summary: { latestPotassium?: number; pew: boolean; latestHandgripKg?: number } }; drift: { verdict: string } };
      expect(twinBody.twin.summary.latestPotassium).toBe(6.5);
      expect(twinBody.twin.summary.latestHandgripKg).toBe(21);

      const score = await app.inject({ method: 'POST', url: '/admin/swarm/nutrition/twin/score', payload: { patientId: 'fac-a-pt-0001' } });
      expect(score.statusCode).toBe(200);
      const scoreBody = score.json() as { score: { verdict: string }; ecg: { note: string } };
      expect(['pass', 'watch', 'insufficient']).toContain(scoreBody.score.verdict);
      expect(scoreBody.ecg.note).toMatch(/never trigger|adjunct/i);
    } finally {
      await app.close();
    }
  });

  it('runs the red team, records drift, files the MDR and records a study decision', async () => {
    const app = await build();
    try {
      const redTeam = await app.inject({ method: 'POST', url: '/admin/swarm/nutrition/red-team', payload: { ranBy: 'test' } });
      expect(redTeam.statusCode).toBe(200);
      const rtBody = redTeam.json() as { passed: boolean; probes: Array<{ scenarioId: string; passed: boolean; checks: Array<{ name: string }> }> };
      expect(rtBody.probes.map((p) => p.scenarioId).sort()).toEqual([...NUTRITION_RED_TEAM_IDS].sort());
      expect(rtBody.passed, JSON.stringify(rtBody.probes.filter((p) => !p.passed))).toBe(true);
      expect(rtBody.probes.flatMap((p) => p.checks.map((c) => c.name))).toContain('lab required');

      const drift = await app.inject({ method: 'POST', url: '/admin/swarm/nutrition/drift', payload: {} });
      expect(drift.statusCode).toBe(200);
      expect((drift.json() as { snapshot: { metric: string } }).snapshot.metric).toMatch(/nutrition/i);

      const mdr = await app.inject({ method: 'GET', url: '/admin/swarm/nutrition/mdr' });
      expect(mdr.statusCode).toBe(200);
      const mdrBody = mdr.json() as { mdr: { classification: { approvalClass: string }; limitations: string[]; postMarket: { redTeam: string[] } } };
      expect(mdrBody.mdr.classification.approvalClass).toBe('C');
      expect(mdrBody.mdr.limitations.join(' ')).toMatch(/ECG is not a model input/i);
      expect(mdrBody.mdr.postMarket.redTeam).toEqual([...NUTRITION_RED_TEAM_IDS]);

      const study = await app.inject({ method: 'POST', url: '/admin/swarm/nutrition/study/record', payload: { patientId: 'fac-a-pt-0001', clinician: 'dietitian-1', action: 'accept' } });
      expect(study.statusCode).toBe(200);
      const listed = await app.inject({ method: 'GET', url: '/admin/swarm/nutrition/study' });
      expect((listed.json() as { count: number }).count).toBe(1);

      const demo = await app.inject({ method: 'POST', url: '/admin/swarm/nutrition/demo' });
      expect(demo.statusCode).toBe(200);
      const reset = await app.inject({ method: 'POST', url: '/admin/swarm/nutrition/reset' });
      expect(reset.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

export { NOW };
