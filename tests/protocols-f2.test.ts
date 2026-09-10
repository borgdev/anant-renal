import { describe, expect, it } from 'vitest';
import {
  daugirdasSpKtV, spKtVFromUrr, ktvToUrr, urrToKtv, minDurationHoursForTarget, estimatedUreaVolumeL,
  weeklyKtV, adequacyPrior, fluidPrior, phosphatePrior, nutritionPrior, infectionPrior, hgbFromWeeklyDose,
  potassiumAfterSession, potassiumRebound, KTV_TARGET, URR_FLOOR_PCT,
} from '../src/protocols/priors.js';
import {
  auroc, auprc, brier, ece, reliabilityBins, reliabilitySlope, mae, rmse, mape, bias, correlation,
  forecastMetrics, relativeImprovementPct,
} from '../src/protocols/metrics.js';
import { patientLevelSplit, filterByPatientSplit, hasNoPatientOverlap, stableUnitInterval } from '../src/protocols/split.js';
import { fitRidgeLinear, predictLinear, fitLogistic, predictLogistic, compareForecasts, persistenceForecast } from '../src/protocols/baselines.js';
import {
  RENAL_SUBSTATES, RENAL_STATE_DIMS, latentFromDims, buildRenalState, forecastRenalState,
  buildBacktestRows, evaluateProtocolHeads, runF2Evaluation, defaultCohort, REGRESSION_TARGETS,
} from '../src/protocols/shared-state.js';
import { RENAL_PROTOCOLS, assessProtocols, evaluateProtocolForPatient, cockpitIndex, protocolById } from '../src/protocols/registry.js';
import { buildRenalCohort } from '../src/swarm/renal-cohort.js';

const baseFacts = (over: Partial<Record<string, unknown>> = {}) => ({
  patientId: 'p1', realmId: 'sim:renal-a', facilityId: 'fac-a',
  access: { type: 'avf', site: 'left-forearm', ageDays: 300, observations: 1, lastEvent: 'cannulation-difficulty', dysfunction: true },
  sessions: { count: 3, avgDeliveredMinutes: 200, avgUfVolumeL: 2.4, avgUfAchievementPct: 88, avgAdherencePct: 92, minNadirSbp: 88, avgRecirculationPct: 11.5, avgIdwgKg: 2.9, stoppedEarlyCount: 1, complicationCount: 1, telemetryPoints: 3 },
  labs: { K: 5.8, HGB: 9.4, URR: 64, PHOS: 6.4, FERRITIN: 260, TSAT: 18, calcium: 9.5, pth: 720, albumin: 3.2, creatinine: 8.5, bicarb: 20, crp: 14, wbc: 8.4, procalcitonin: 0.4 },
  vitals: { hr: 88, spo2: 95, tempC: 38.3, bp: '112/70', systolic: 112 },
  panel: { present: ['calcium', 'pth', 'albumin', 'creatinine', 'bicarb', 'crp', 'wbc', 'procalcitonin'], missing: [], completenessPct: 100 },
  exposure: { esaDoseUnits: 6000, maintenanceMeds: ['sevelamer'], phosphateBinders: ['sevelamer'], calcimimetics: [], vitaminD: [], ivIron: true },
  signals: { hypotensiveSessions: 1, shortSessions: 1, highRecirculation: true, hyperphosphatemia: true, hypercalcemia: false, hyperparathyroidism: true, lowAlbumin: true, inflammation: true, metabolicAcidosis: true, infectionRisk: true, accessRisk: true },
  ...over,
});

describe('F2 mechanistic priors', () => {
  it('computes Daugirdas spKt/V and round-trips URR ↔ Kt/V', () => {
    // R = 0.35, t = 4 h, UF 2.5 L / 70 kg → textbook-range spKt/V ≈ 1.05–1.15
    const spKtV = daugirdasSpKtV({ preUrea: 60, postUrea: 21, durationHours: 4, ufVolumeL: 2.5, postWeightKg: 70 })!;
    expect(spKtV).toBeGreaterThan(1.0);
    expect(spKtV).toBeLessThan(1.4);
    // more UF and lower R both raise delivered clearance
    const more = daugirdasSpKtV({ preUrea: 60, postUrea: 21, durationHours: 4, ufVolumeL: 3.5, postWeightKg: 70 })!;
    expect(more).toBeGreaterThan(spKtV);
    expect(daugirdasSpKtV({ preUrea: 0, postUrea: 21, durationHours: 4, ufVolumeL: 2.5, postWeightKg: 70 })).toBeUndefined();
    expect(ktvToUrr(1.2)).toBeCloseTo(69.9, 1);
    expect(urrToKtv(69.9)).toBeCloseTo(1.2, 1);
    const fromUrr = spKtVFromUrr({ urrPct: 65, durationHours: 4, ufVolumeL: 2.5, postWeightKg: 70 })!;
    expect(fromUrr).toBeGreaterThan(0.9);
    expect(weeklyKtV(fromUrr, 3)).toBeCloseTo(fromUrr * 3, 2);
  });

  it('sizes treatment time and urea volume from anthropometrics', () => {
    const hours = minDurationHoursForTarget({ targetSpKtV: 1.2, clearanceMlMin: 250, volumeL: 35 })!;
    expect(hours).toBeCloseTo((1.2 * 35 * 1000) / 250 / 60, 1);
    const v = estimatedUreaVolumeL({ weightKg: 70, heightCm: 170, age: 60, sex: 'M' });
    expect(v).toBeGreaterThan(25);
    expect(v).toBeLessThan(50);
  });

  it('derives adequacy, fluid, MBD, nutrition and infection priors with drivers', () => {
    const adeq = adequacyPrior({ urrPct: 58, prescribedMinutes: 240, deliveredMinutes: 190, sessionsPerWeek: 3 });
    expect(adeq.meetsTarget).toBe(false);
    expect(adeq.spKtV).toBeLessThan(KTV_TARGET);
    expect(adeq.drivers.some((d) => d.includes('shortened'))).toBe(true);

    const fluid = fluidPrior({ avgIdwgKg: 3.4, avgUfAchievementPct: 80, minNadirSbp: 84, avgDeliveredMinutes: 190 });
    expect(fluid.volumeOverloaded).toBe(true);
    expect(fluid.ufUndelivered).toBe(true);
    expect(fluid.intradialyticHypotension).toBe(true);
    expect(fluid.ufRateMlH).toBeCloseTo(70.8, 0);

    const mbd = phosphatePrior({ phosMgDl: 6.4, binderCodes: ['sevelamer'], binderDoseMgPerDay: 2400, spKtV: 1.1, calciumMgDl: 10.6, pthPgMl: 720 });
    expect(mbd.inTarget).toBe(false);
    expect(mbd.boundMgPerDay).toBe(60); // 2.4 g × 25 mg/g
    expect(mbd.dialyticRemovalIndex).toBeCloseTo(3.3, 1);
    expect(mbd.drivers.some((d) => d.includes('hypercalcemia'))).toBe(true);
    // a non-binding binder contributes 0
    expect(phosphatePrior({ phosMgDl: 6, binderCodes: [], binderDoseMgPerDay: 2400 }).boundMgPerDay).toBe(0);

    const nut = nutritionPrior({ albuminGdL: 3.1, crpMgL: 22, spKtV: 1.1 });
    expect(nut.proteinEnergyWastingRisk).toBe(true);
    expect(nut.inflammatoryBurden).toBe(true);
    expect(nut.npcrProxy).toBe(1.3);

    const inf = infectionPrior({ tempC: 38.5, wbc: 13, procalcitoninNgMl: 0.6, crpMgL: 30, accessType: 'catheter', accessEvent: 'infection' });
    expect(inf.meetsSurveillanceCriteria).toBe(true);
    expect(inf.triageScore).toBeGreaterThan(0.5);
    // fever alone (no WBC/PCT) must NOT meet deterministic surveillance criteria
    expect(infectionPrior({ tempC: 38.5, wbc: 9, procalcitoninNgMl: 0.2 }).meetsSurveillanceCriteria).toBe(false);
  });

  it('models ESA dose response and potassium kinetics monotonically', () => {
    expect(hgbFromWeeklyDose(0)).toBeCloseTo(7.2, 2);
    expect(hgbFromWeeklyDose(12000)).toBeGreaterThan(hgbFromWeeklyDose(6000));
    expect(hgbFromWeeklyDose(6000, { crpMgL: 25 })).toBeLessThan(hgbFromWeeklyDose(6000));
    expect(hgbFromWeeklyDose(6000, { ironReplete: false })).toBeLessThan(hgbFromWeeklyDose(6000));
    expect(potassiumAfterSession(6, 1.2)).toBeLessThan(6);
    expect(potassiumAfterSession(6, 1.2)).toBeGreaterThan(3.5);
    expect(potassiumRebound(4.5, 48)).toBeGreaterThan(4.5);
  });
});

describe('F2 metrics', () => {
  it('computes regression metrics exactly', () => {
    const pairs = [{ predicted: 1, observed: 0 }, { predicted: 3, observed: 4 }, { predicted: 5, observed: 4 }];
    expect(mae(pairs)).toBeCloseTo(1, 4);
    expect(rmse(pairs)).toBeCloseTo(1, 4);
    expect(bias(pairs)).toBeCloseTo(1 / 3, 4);
    // the zero-observed row is skipped: mean of 1/4 and 1/4 → 25%
    expect(mape(pairs)).toBeCloseTo(25, 2);
    expect(correlation(pairs)).toBeDefined();
    expect(forecastMetrics(pairs).n).toBe(3);
    expect(relativeImprovementPct(2, 1)).toBe(50);
    expect(mae([])).toBeUndefined();
  });

  it('computes AUROC/AUPRC exactly, including ties', () => {
    const perfect = [{ score: 0.9, label: 1 as const }, { score: 0.8, label: 1 as const }, { score: 0.2, label: 0 as const }, { score: 0.1, label: 0 as const }];
    expect(auroc(perfect)!.auroc).toBe(1);
    expect(auprc(perfect)).toBe(1);
    const inverted = perfect.map((p) => ({ score: 1 - p.score, label: p.label }));
    expect(auroc(inverted)!.auroc).toBe(0);
    // all ties → 0.5
    const ties = [{ score: 0.5, label: 1 as const }, { score: 0.5, label: 0 as const }];
    expect(auroc(ties)!.auroc).toBeCloseTo(0.5, 6);
    // single-class → undefined
    expect(auroc([{ score: 0.5, label: 1 as const }])).toBeUndefined();
  });

  it('computes Brier, ECE and reliability bins', () => {
    const pairs = [
      { score: 0.9, label: 1 as const }, { score: 0.8, label: 1 as const },
      { score: 0.2, label: 0 as const }, { score: 0.1, label: 0 as const },
    ];
    expect(brier(pairs)).toBeCloseTo((0.01 + 0.04 + 0.04 + 0.01) / 4, 4);
    const bins = reliabilityBins(pairs, 5);
    expect(bins).toHaveLength(5);
    expect(bins.filter((b) => b.n > 0)).toHaveLength(3);
    expect(ece(pairs, 5)).toBeGreaterThan(0);
    expect(ece(pairs, 5)).toBeLessThan(0.25);
    expect(reliabilitySlope(pairs)).toBeGreaterThan(0);
  });
});

describe('F2 patient-level splits', () => {
  it('is deterministic, salt-sensitive and leak-free', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `pt-${i}`);
    const a = patientLevelSplit(ids, { trainFraction: 0.7 });
    const b = patientLevelSplit(ids, { trainFraction: 0.7 });
    expect(a.train).toEqual(b.train);
    expect(a.test).toEqual(b.test);
    expect(hasNoPatientOverlap(a)).toBe(true);
    expect(a.train.length + a.test.length).toBe(40);
    // the hash must actually distribute (a prefix-biased hash would send every id to one side)
    expect(a.train.length).toBeGreaterThan(15);
    expect(a.test.length).toBeGreaterThan(5);
    const other = patientLevelSplit(ids, { trainFraction: 0.7, salt: 'fold-2' });
    expect(other.train).not.toEqual(a.train);
  });

  it('splits rows by patient, never within a patient', () => {
    const ids = Array.from({ length: 20 }, (_, i) => `pt-${i}`);
    const split = patientLevelSplit(ids);
    const rows = ids.flatMap((id) => [{ patientId: id, v: 1 }, { patientId: id, v: 2 }]);
    const { train, test } = filterByPatientSplit(rows, split);
    const trainPatients = new Set(train.map((r) => r.patientId));
    const testPatients = new Set(test.map((r) => r.patientId));
    expect(trainPatients.size).toBeGreaterThan(0);
    expect(testPatients.size).toBeGreaterThan(0);
    expect([...testPatients].every((p) => !trainPatients.has(p))).toBe(true);
    expect(train.length).toBe(trainPatients.size * 2);
    expect(stableUnitInterval('renal-f2:pt-1')).toBeGreaterThanOrEqual(0);
    expect(stableUnitInterval('renal-f2:pt-1')).toBeLessThan(1);
  });
});

describe('F2 baselines', () => {
  it('fits a ridge-linear model that recovers a known linear relationship', () => {
    const samples = Array.from({ length: 30 }, (_, i) => ({ features: [i / 30], target: 2 * (i / 30) + 1 }));
    const model = fitRidgeLinear(samples, ['x'], 1e-6)!;
    expect(predictLinear(model, [0.5])).toBeCloseTo(2, 1);
    expect(model.weights[0]).toBeGreaterThan(0);
  });

  it('fits a logistic model that separates a linearly separable problem', () => {
    const samples = Array.from({ length: 40 }, (_, i) => ({ features: [i / 40], label: (i / 40 > 0.5 ? 1 : 0) as 0 | 1 }));
    const model = fitLogistic(samples, ['x'], { iterations: 600 })!;
    expect(predictLogistic(model, [0.9])).toBeGreaterThan(0.6);
    expect(predictLogistic(model, [0.1])).toBeLessThan(0.4);
  });

  it('compares a head against persistence and a tabular baseline', () => {
    const observed = [5, 6, 7, 8, 9, 10];
    const comparison = compareForecasts({
      label: 'demo',
      persistencePredicted: observed.map(() => 5),
      baselinePredicted: observed.map((o) => o - 0.5),
      headPredicted: observed.map((o) => o - 0.1),
      observed,
    });
    expect(comparison.n).toBe(6);
    expect(comparison.winner).toBe('head');
    expect(comparison.headVsPersistenceImprovementPct).toBeGreaterThan(0);
    expect(comparison.headVsBaselineImprovementPct).toBeGreaterThan(0);
    expect(persistenceForecast(4.2)).toBe(4.2);
  });
});

describe('F2 shared state and multi-protocol, multi-horizon forecasts', () => {
  it('encodes one normalized latent indexed by substate', () => {
    expect(RENAL_SUBSTATES).toHaveLength(7);
    expect(new Set(RENAL_SUBSTATES.map((s) => s.protocol)).size).toBe(7);
    const latent = latentFromDims({ urrPct: 55, hgbGdl: 8, phosMgDl: 7 });
    expect(latent).toHaveLength(RENAL_SUBSTATES.length + 1);
    expect(latent.every((v) => v >= 0 && v <= 1)).toBe(true);
    expect(latent[1]).toBeGreaterThan(0.6); // adequacy severity high at URR 55
    expect(latent[2]).toBeGreaterThan(0.5); // anemia severity high at HGB 8
    expect(latent[7]).toBeGreaterThan(0);   // global instability
  });

  it('builds a shared state from renal facts and forecasts every protocol at 3 horizons', () => {
    const facts = buildRenalCohort([{ id: 'p1', realmId: 'sim:renal-a', state: {}, medCodes: [] }]).patients[0]!;
    const withData = { ...facts, ...baseFacts() } as unknown as typeof facts;
    const state = buildRenalState(withData);
    expect(state.latent).toHaveLength(8);
    expect(state.instabilityIndex).toBeGreaterThan(0);
    expect(state.dims.urrPct).toBe(64);
    expect(state.dims.tempC).toBe(38.3);

    const forecasts = forecastRenalState(state);
    const protocols = new Set(forecasts.map((f) => f.protocol));
    const horizons = new Set(forecasts.map((f) => f.horizonDays));
    expect(protocols.size).toBe(7);            // every protocol head
    expect(horizons.size).toBe(3);             // 7d / 28d / 84d
    expect(forecasts).toHaveLength(21);
    for (const f of forecasts) {
      expect(Number.isFinite(f.value)).toBe(true);
      expect(f.band.low).toBeLessThanOrEqual(f.value);
      expect(f.band.high).toBeGreaterThanOrEqual(f.value);
      expect(f.substate).toMatch(/^S[A-L]$/);
    }
    // the same state drives at least two protocols at two horizons with different values
    const adeq7 = forecasts.find((f) => f.protocol === 'adequacy' && f.horizonDays === 7)!;
    const adeq84 = forecasts.find((f) => f.protocol === 'adequacy' && f.horizonDays === 84)!;
    expect(adeq7.value).not.toBe(adeq84.value);
    expect(RENAL_STATE_DIMS.length).toBeGreaterThanOrEqual(20);
  });
});

describe('F2 backtest harness (patient-level, multi-protocol)', () => {
  const cohort = defaultCohort().slice(0, 14); // 2 patients per trajectory — keeps the test fast
  const rows = buildBacktestRows({ patients: cohort, horizonsDays: [7, 28] });

  it('builds labeled rows for 4 regression protocols at 2 horizons', () => {
    expect(rows.regression.length).toBeGreaterThan(50);
    expect(new Set(rows.regression.map((r) => r.protocol))).toEqual(new Set(REGRESSION_TARGETS.map((t) => t.protocol)));
    expect(new Set(rows.regression.map((r) => r.horizonDays))).toEqual(new Set([7, 28]));
    for (const row of rows.regression) expect(row.latent).toHaveLength(8);
    expect(rows.classification.length).toBeGreaterThan(10);
  });

  it('evaluates heads on a leak-free patient split and beats persistence', () => {
    const report = evaluateProtocolHeads(rows, { salt: 'f2-test' });
    expect(report.noPatientOverlap).toBe(true);
    expect(report.regressionHeads.length).toBeGreaterThanOrEqual(8); // 4 protocols × 2 horizons
    expect(report.coverage.protocols.length).toBeGreaterThanOrEqual(4);
    expect(report.coverage.horizonsDays).toEqual([7, 28]);
    expect(report.summary.totalHeads).toBe(report.regressionHeads.length);
    for (const head of report.regressionHeads) {
      expect(head.comparison.head.mae).toBeDefined();
      expect(head.split.trainPatients).toBeGreaterThan(0);
      expect(head.split.testPatients).toBeGreaterThan(0);
    }
    // the shared-state head must beat the persistence floor on most heads
    expect(report.summary.headsBeatingPersistence).toBeGreaterThanOrEqual(Math.ceil(report.summary.totalHeads * 0.75));
    expect(report.summary.meanHeadMae!).toBeLessThan(report.summary.meanPersistenceMae!);
    expect(report.classificationHeads.length).toBeGreaterThanOrEqual(1);
    for (const cls of report.classificationHeads) {
      expect(cls.stateScoreMetrics.auroc).toBeDefined();
      expect(cls.reliability.length).toBe(5);
    }
  });

  it('produces a deterministic, re-runnable F2 evaluation', () => {
    const a = runF2Evaluation({ patients: cohort, horizonsDays: [7, 28], salt: 'f2-determinism' });
    const b = runF2Evaluation({ patients: cohort, horizonsDays: [7, 28], salt: 'f2-determinism' });
    expect(a.regressionHeads.map((r) => r.comparison.head.mae)).toEqual(b.regressionHeads.map((r) => r.comparison.head.mae));
    expect(a.patientLevelSplit.train).toEqual(b.patientLevelSplit.train);
    expect(a.coverage.protocolHorizonPairs).toBe(a.regressionHeads.length);
  });
});

describe('F2/F3 protocol registry', () => {
  it('registers all seven protocols with substates, models and safety classes', () => {
    expect(RENAL_PROTOCOLS).toHaveLength(7);
    expect(new Set(RENAL_PROTOCOLS.map((p) => p.substate)).size).toBe(7);
    for (const p of RENAL_PROTOCOLS) {
      expect(p.model.family.length).toBeGreaterThan(10);
      expect(p.model.validationGate.length).toBeGreaterThan(10);
      expect(['A', 'B', 'C']).toContain(p.safetyClass);
      expect(p.requiredSignals.length).toBeGreaterThan(0);
    }
    expect(protocolById('anemia')?.safetyClass).toBe('C');
    expect(protocolById('nope')).toBeUndefined();
  });

  it('derives a red/amber/green status per protocol from real patient facts only', () => {
    const facts = { ...buildRenalCohort([{ id: 'p1', realmId: 'sim:renal-a', state: {}, medCodes: [] }]).patients[0]!, ...baseFacts() } as never;
    const dialysis = evaluateProtocolForPatient('fluid', facts);
    expect(dialysis.status).toBe('red');
    expect(dialysis.signals.length).toBeGreaterThan(0);
    expect(dialysis.drivers.length).toBeGreaterThan(0);
    const anemia = evaluateProtocolForPatient('anemia', facts);
    expect(anemia.status).toBe('red');
    const infection = evaluateProtocolForPatient('infection', facts);
    expect(infection.signals.some((s) => s.label === 'NHSN criteria' && s.value.includes('met'))).toBe(true);

    // a healthy patient is green
    const healthy = {
      ...facts,
      access: { type: 'avf', ageDays: 500, observations: 3, dysfunction: false },
      sessions: { count: 3, avgDeliveredMinutes: 220, avgUfAchievementPct: 98, avgAdherencePct: 99, minNadirSbp: 108, avgRecirculationPct: 4, avgIdwgKg: 1.6, stoppedEarlyCount: 0, complicationCount: 0, telemetryPoints: 3 },
      labs: { K: 4.4, HGB: 11.4, URR: 72, PHOS: 4.4, TSAT: 28, calcium: 9.2, pth: 240, albumin: 3.9, bicarb: 24, crp: 3, wbc: 6.5, procalcitonin: 0.1 },
      vitals: { hr: 74, spo2: 97, tempC: 36.6, bp: '126/78', systolic: 126 },
      exposure: { esaDoseUnits: 4000, maintenanceMeds: ['sevelamer'], phosphateBinders: ['sevelamer'], calcimimetics: [], vitaminD: [], ivIron: false },
      signals: { hypotensiveSessions: 0, shortSessions: 0, highRecirculation: false, hyperphosphatemia: false, hypercalcemia: false, hyperparathyroidism: false, lowAlbumin: false, inflammation: false, metabolicAcidosis: false, infectionRisk: false, accessRisk: false },
    } as never;
    for (const p of RENAL_PROTOCOLS) expect(evaluateProtocolForPatient(p.id, healthy).status).toBe('green');
  });

  it('rolls a cohort into cockpit rows and a fleet index', () => {
    const s1 = { ...buildRenalCohort([{ id: 'p1', realmId: 'sim:renal-a', state: {}, medCodes: [] }]).patients[0]!, ...baseFacts() } as never;
    const s2 = { ...s1, patientId: 'p2', realmId: 'sim:renal-b' } as never;
    const reports = assessProtocols([s1, s2]);
    expect(reports).toHaveLength(7);
    for (const r of reports) {
      expect(r.evaluated).toBe(2);
      expect(r.counts.green + r.counts.amber + r.counts.red + r.counts.unknown).toBe(2);
      expect(r.examples.length).toBeGreaterThan(0);
      expect(r.topDrivers.length).toBeGreaterThan(0);
    }
    const fluid = reports.find((r) => r.protocol === 'fluid')!;
    expect(fluid.status).toBe('red');
    expect(fluid.attentionPct).toBe(100);
    const index = cockpitIndex(reports, { patients: 2, realms: 2, sessions: 6, patientsWithSessions: 2, avgSessionsPerPatient: 3, hypotensionRatePct: 50, shortSessionRatePct: 50, avgPanelCompletenessPct: 100, hyperphosphatemiaCount: 2, hyperparathyroidismCount: 2, lowAlbuminCount: 2, inflammationCount: 2, infectionRiskCount: 2, accessRiskCount: 2 });
    expect(index.status).toBe('red');
    expect(index.redProtocols).toBeGreaterThan(0);
    expect(index.patients).toBe(2);
  });
});

describe('F2/F3 cross-checks', () => {
  it('keeps deterministic surveillance criteria independent of model scores', () => {
    // fever without leukocytosis/PCT → surveillance NOT met, but triage can still be elevated
    const prior = infectionPrior({ tempC: 38.6, wbc: 9.5, procalcitoninNgMl: 0.2, crpMgL: 18 });
    expect(prior.meetsSurveillanceCriteria).toBe(false);
    expect(prior.triageScore).toBeGreaterThan(0.2);
    expect(URR_FLOOR_PCT).toBe(60);
  });
});
