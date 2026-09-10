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

// P3 — vascular access protocol pack (steps A–F).
//
// (tests/access.test.ts covers the access-control evaluator; this file covers
// the vascular access protocol pack.)

import { describe, expect, it } from 'vitest';
import {
  ACCESS_FEATURES, ACCESS_REFERENCE, ACCESS_CELLS, accessLatent, accessRecommend,
  guardAccessReferral, stenosisProbability, thrombosisRisk, buildAccessDemo,
  type AccessGuardInput,
} from '../src/swarm/access.js';
import {
  accessCoverage, accessRecommendCovered, ACCESS_RED_TEAM_DEFS, ACCESS_RED_TEAM_IDS,
  accessRedTeamProbe, ensureAccessModel, ensureAccessRedTeamScenarios, computeAccessDrift,
  evaluateAccessAdvisorGate, ACCESS_COVERAGE_DEFAULTS, ACCESS_MODEL_ID, ACCESS_ACOUSTIC_FLAG,
  accessAcousticEnabled,
} from '../src/swarm/access-governance.js';
import { accessWhatIf, accessRiskSurface, ACCESS_SURVEILLANCE_INTERVALS, ACCESS_REFERRAL_ARMS } from '../src/swarm/access-simulator.js';
import { buildAccessTwin, scoreAccessTwinDrift, accessWindowFromTwin, accessObservationsFromState } from '../src/swarm/access-twin.js';
import {
  ACCESS_MODEL_FEATURES, buildAccessVector, buildAccessTrainingRows, trainAccessArtifact,
  loadAccessArtifact, accessArtifactStatus, accessAcousticDelta, ACCESS_ARTIFACT_ID,
} from '../src/swarm/access-model.js';
import { SwarmWorkspaceStore } from '../src/swarm/workspace.js';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import type { PostgresEventStore } from '../src/server/postgres-event-store.js';
import type { CanonicalEvent } from '../src/healthcare-core/events.js';
import type { LedgerEntry } from '../src/hypergraph/ledger.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import type { ActorContext } from '../src/server/scoped-persistence.js';

const NOW = '2026-09-01T10:00:00Z';

/** A progressing AVF: pressure +42%, recirculation 15%, Qa 560 mL/min. */
const STENOSING: AccessGuardInput & { patientId: string } = {
  patientId: 'p-access-1',
  accessType: 'avf',
  accessAgeDays: 1_040,
  site: 'left-forearm',
  observations: 6,
  venousPressureMmHg: 199,
  venousPressureBaselineMmHg: 140,
  recirculationPct: 15,
  accessFlowMlMin: 560,
  accessFlowBaselineMlMin: 960,
  deliveredClearancePct: 74,
  deliveredClearanceBaselinePct: 96,
  cannulationDifficulty: 'difficult',
  priorInterventions: 1,
  daysSinceIntervention: 220,
  asOf: NOW,
};

/** A stable AVF: everything within range. */
const STABLE: AccessGuardInput & { patientId: string } = {
  patientId: 'p-access-2',
  accessType: 'avf',
  accessAgeDays: 400,
  observations: 5,
  venousPressureMmHg: 142,
  venousPressureBaselineMmHg: 138,
  recirculationPct: 4,
  accessFlowMlMin: 980,
  accessFlowBaselineMlMin: 1_000,
  deliveredClearancePct: 96,
  deliveredClearanceBaselinePct: 97,
  cannulationDifficulty: 'easy',
  priorInterventions: 0,
  asOf: NOW,
};

const rt = (id: string) => ACCESS_RED_TEAM_DEFS.find((d) => d.id === id)!;

describe('P3-A — access engine + guardrails', () => {
  it('publishes a Δ-from-baseline feature contract', () => {
    const ids = ACCESS_FEATURES.map((f) => f.id);
    expect(ids).toContain('venousPressureDeltaPct');
    expect(ids).toContain('accessFlowDeltaPct');
    expect(ids).toContain('recirculationPct');
    expect(ids).toContain('acousticDeltaScore');
    expect(ACCESS_FEATURES.every((f) => f.relevance > 0)).toBe(true);
    expect(ACCESS_REFERENCE.minObservationsForReferral).toBe(3);
    expect(ACCESS_REFERENCE.thrombosisHorizonsDays).toEqual([30, 90]);
    expect(ACCESS_CELLS.map((c) => c.approvalClass)).toEqual(['B', 'C']);
  });

  it('refuses a referral from a single reading and asks for a measured series instead', () => {
    const single = guardAccessReferral({ ...STENOSING, observations: 1 });
    expect(single.blocked).toBe(true);
    expect(single.flags).toContain('single-reading-no-trend');
    expect(single.referralAllowed).toBe(false);
    expect(single.blockReason).toMatch(/trend/i);

    const unmeasured = guardAccessReferral({ observations: 0 });
    expect(unmeasured.blocked).toBe(true);
    expect(unmeasured.flags).toContain('no-access-observations');

    // observed but never measured: blocked, and asked for a measurable series
    const noNumbers = guardAccessReferral({ observations: 4, recirculationPct: 4 });
    expect(noNumbers.flags).toContain('no-flow-measurement');
    expect(noNumbers.referralAllowed).toBe(false);
  });

  it('suppresses re-referral inside the post-intervention window and escalates bleeding', () => {
    const post = guardAccessReferral({ ...STENOSING, daysSinceIntervention: 3 });
    expect(post.flags).toContain('post-intervention-quiet-window');
    expect(post.referralAllowed).toBe(false);

    const bleeding = guardAccessReferral({ ...STENOSING, activeBleeding: true });
    expect(bleeding.escalateNow).toBe(true);
    expect(accessRecommend({ ...STENOSING, activeBleeding: true }).action).toBe('escalate-now');
  });

  it('treats a catheter deterministically (removal escalation, never a stenosis referral)', () => {
    const catheter = guardAccessReferral({ ...STENOSING, accessType: 'catheter', catheterDays: 120 });
    expect(catheter.flags).toContain('catheter-in-situ');
    expect(catheter.flags).toContain('catheter-removal-candidate');
    expect(catheter.referralAllowed).toBe(false);
    expect(accessRecommend({ ...STENOSING, accessType: 'catheter', catheterDays: 120 }).action).toBe('catheter-removal-escalation');
  });

  it('keeps stenosis probability monotone in pressure rise, recirculation and flow decline', () => {
    const at = (over: Partial<AccessGuardInput>) => stenosisProbability({ ...STABLE, ...over });
    expect(at({ venousPressureDeltaPct: 45 })).toBeGreaterThan(at({ venousPressureDeltaPct: 20 }));
    expect(at({ venousPressureDeltaPct: 20 })).toBeGreaterThan(at({ venousPressureDeltaPct: 0 }));
    expect(at({ recirculationPct: 18 })).toBeGreaterThan(at({ recirculationPct: 8 }));
    expect(at({ accessFlowMlMin: 500 })).toBeGreaterThan(at({ accessFlowMlMin: 950 }));
    // a catheter carries less stenosis risk than a fistula at the same physiology
    expect(at({ accessType: 'catheter' })).toBeLessThan(at({ accessType: 'avf' }));
  });

  it('separates the thrombosis horizons and stays inside a sane bound', () => {
    const risk30 = thrombosisRisk(STENOSING, 30);
    const risk90 = thrombosisRisk(STENOSING, 90);
    expect(risk90).toBeGreaterThan(risk30);
    expect(risk90).toBeLessThanOrEqual(0.9);
    expect(thrombosisRisk(STABLE, 90)).toBeLessThan(0.05);
  });

  it('recommends a referral for a progressing stenosis and no action for a stable access', () => {
    const progressing = accessRecommend(STENOSING);
    expect(progressing.stenosisProbability).toBeGreaterThanOrEqual(ACCESS_REFERENCE.stenosisReferralThreshold);
    expect(progressing.action).toBe('refer-duplex-ultrasound');
    expect(progressing.recommended.surveillanceIntervalDays).toBe(14);
    expect(progressing.recommended.projectedThrombosisRisk30d).toBeGreaterThan(0);
    expect(progressing.note).toMatch(/access team decides/i);

    const stable = accessRecommend(STABLE);
    expect(stable.action).toBe('no-action');
    expect(stable.stenosisProbability).toBeLessThan(ACCESS_REFERENCE.stenosisReferralThreshold);
  });

  it('separates recirculation-without-pressure-rise into a technique problem', () => {
    const technique = accessRecommend({
      ...STABLE, patientId: 'p-rec', observations: 5, recirculationPct: 17,
      venousPressureMmHg: 144, venousPressureBaselineMmHg: 138,
    });
    expect(technique.action).toBe('change-cannulation-technique');
    expect(technique.note).toMatch(/cannulation technique/i);
  });

  it('reports a bounded progression × vulnerability latent', () => {
    const stable = accessLatent(STABLE);
    const progressing = accessLatent(STENOSING);
    expect(progressing.l1).toBeGreaterThan(stable.l1);
    expect(progressing.polarRadius).toBeGreaterThan(0);
    expect(Number.isFinite(progressing.polarAngleRad)).toBe(true);
  });
});

describe('P3-B — governance (coverage, red team, gate, drift)', () => {
  it('gates on observation density, a measured series, recency and the manifold', () => {
    const covered = accessCoverage({ ...STENOSING, lastObservationAt: '2026-08-28T10:00:00Z' });
    expect(covered.covered).toBe(true);
    expect(covered.observations.measured).toBe(6);

    const sparse = accessCoverage({ ...STENOSING, observations: 2, lastObservationAt: NOW });
    expect(sparse.covered).toBe(false);
    expect(sparse.reason).toMatch(/observation/i);

    const stale = accessCoverage({ ...STENOSING, lastObservationAt: '2026-01-01T00:00:00Z' });
    expect(stale.covered).toBe(false);
    expect(stale.reason).toMatch(/days ago/i);

    const far = accessCoverage({ ...STENOSING, venousPressureDeltaPct: 150, recirculationPct: 38, accessAgeDays: 2_400, priorInterventions: 6 });
    expect(far.manifold.inside).toBe(false);
    expect(far.range?.feature).toBe('venousPressureDeltaPct');
  });

  it('blocks the recommendation (never silently proceeds) when coverage fails', () => {
    const gated = accessRecommendCovered({ ...STENOSING, lastObservationAt: '2026-01-01T00:00:00Z' });
    expect(gated.action).toBe('blocked');
    expect(gated.note).toMatch(/coverage gate/i);
    // with the gate off the guardrails still decide (here: a referral is fine)
    const ungated = accessRecommendCovered({ ...STENOSING, lastObservationAt: '2026-01-01T00:00:00Z' }, { coverageGateEnabled: false });
    expect(ungated.action).toBe('refer-duplex-ultrasound');
  });

  it('contains all four adversarial access scenarios', () => {
    expect([...ACCESS_RED_TEAM_IDS]).toEqual(['rt-025', 'rt-026', 'rt-027', 'rt-028']);
    for (const def of ACCESS_RED_TEAM_DEFS) {
      const probe = accessRedTeamProbe(def);
      const detail = probe.checks.map((c) => `${c.name}=${c.passed} (${c.observed})`).join(' | ');
      expect(probe.passed, `${def.id}: ${detail}`).toBe(true);
    }
  });

  it('ignores an unlabelled or flag-off acoustic capture (rt-027)', () => {
    const probe = rt('rt-027');
    const withAcoustic = accessRecommend(probe.probe);
    expect(withAcoustic.guardrails.flags).toContain('acoustic-flag-disabled');

    const clean = accessRecommend({ ...probe.probe, acousticDeltaScore: undefined });
    expect(clean.action).toBe(withAcoustic.action);
    expect(clean.stenosisProbability).toBe(withAcoustic.stenosisProbability);

    // the adapter zeroes the slot whenever the flag, provenance or label disagree
    expect(accessAcousticDelta({ features: [1.4], baselineFeatures: [1.0], provenance: 'test', synthetic: true })).toBeUndefined();
    expect(accessAcousticEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(accessAcousticEnabled({ [ACCESS_ACOUSTIC_FLAG]: '1' } as unknown as NodeJS.ProcessEnv)).toBe(true);
  });

  it('registers the model + scenarios and gates on coverage, interpretability and findings', async () => {
    const store = new SwarmWorkspaceStore();
    expect(await ensureAccessModel(store)).toBe(true);
    expect(await ensureAccessModel(store)).toBe(false);
    expect(await ensureAccessRedTeamScenarios(store)).toBe(4);
    expect((await store.listModels()).some((m) => m.modelId === ACCESS_MODEL_ID)).toBe(true);

    const gate = await evaluateAccessAdvisorGate(store);
    expect(gate.status).toBe('active');
    expect(gate.gates.some((g) => g.name === 'Referral is human-approved' && g.passed)).toBe(true);
    expect(gate.gates.some((g) => g.name === 'No machine control' && g.passed)).toBe(true);
    expect(gate.gates.some((g) => g.name === 'Acoustic ingestion gated')).toBe(true);
    expect(gate.posture.procedureOrderingAuthority).toBe('none');
  });

  it('scores drift on the Δ-from-baseline distribution', () => {
    const baseline = Array.from({ length: 12 }, (_, i) => ({ venousPressureDeltaPct: 2 + (i % 3), recirculationPct: 4 + (i % 2), accessFlowDeltaPct: -1 - (i % 3) }));
    const stable = computeAccessDrift({ baseline, current: baseline });
    expect(stable.verdict).toBe('stable');
    expect(stable.status).toBe('healthy');

    const shifted = baseline.map(() => ({ venousPressureDeltaPct: 55, recirculationPct: 20, accessFlowDeltaPct: -40 }));
    const drifted = computeAccessDrift({ baseline, current: shifted });
    expect(drifted.verdict).toBe('drift');
    expect(drifted.metric).toBe('access-stenosis-delta-ks');
  });
});

describe('P3-C — surveillance / referral counterfactual', () => {
  it('builds the interval × arm matrix and never offers imaging for a stable access', () => {
    const result = accessWhatIf(STENOSING);
    expect(result.candidates).toHaveLength(ACCESS_SURVEILLANCE_INTERVALS.length * ACCESS_REFERRAL_ARMS.length);
    expect(result.horizonsDays).toEqual([30, 90]);
    expect(result.recommended).toBeDefined();
    expect(result.recommended!.allowed).toBe(true);
    expect(result.note).toMatch(/advisory only/i);

    const stableResult = accessWhatIf(STABLE);
    expect(stableResult.candidates.filter((c) => c.arm === 'refer-now').every((c) => !c.allowed)).toBe(true);
    expect(stableResult.recommended?.arm).toBe('surveillance-only');
  });

  it('shows that a longer surveillance interval raises the projected thrombosis risk', () => {
    // a moderate, still-early stenosis (the surface saturates at high risk)
    const moderate: AccessGuardInput & { patientId: string } = {
      ...STENOSING, patientId: 'p-moderate', venousPressureMmHg: 168, venousPressureBaselineMmHg: 140,
      recirculationPct: 10, accessFlowMlMin: 780, accessFlowBaselineMlMin: 960, deliveredClearancePct: 88,
    };
    const surface = accessRiskSurface(moderate);
    expect(surface).toHaveLength(ACCESS_SURVEILLANCE_INTERVALS.length);
    // the 30-day risk is the discriminating quantity: it rises with the interval
    expect(surface[surface.length - 1]!.surveillanceOnly30d).toBeGreaterThan(surface[0]!.surveillanceOnly30d);
    expect(surface.every((s, i) => i === 0 || s.surveillanceOnly30d >= surface[i - 1]!.surveillanceOnly30d)).toBe(true);
    // imaging now truncates the risk for every interval and both horizons
    expect(surface.every((s) => s.referNow <= s.surveillanceOnly)).toBe(true);
    expect(surface.every((s) => s.referNow30d <= s.surveillanceOnly30d)).toBe(true);
    expect(accessWhatIf(STENOSING).candidates.find((c) => c.arm === 'refer-now')!.procedureBurden).toBe(1);
  });

  it('saturates the 90-day risk for a far-progressed access (and says so by the numbers)', () => {
    const surface = accessRiskSurface(STENOSING);
    expect(surface.every((s) => s.surveillanceOnly === surface[0]!.surveillanceOnly)).toBe(true);
    expect(surface[0]!.surveillanceOnly).toBeGreaterThan(0.8);
    // the 30-day horizon still separates the plans
    expect(surface[surface.length - 1]!.surveillanceOnly30d).toBeGreaterThan(surface[0]!.surveillanceOnly30d);
  });

  it('returns no plan at all for a blocked window', () => {
    const blocked = accessWhatIf({ ...STENOSING, observations: 1 });
    expect(blocked.blocked).toBe(true);
    expect(blocked.recommended).toBeUndefined();
    expect(blocked.candidates.some((c) => c.allowed)).toBe(false);
  });
});

describe('P3-D — twin over the real ledger', () => {
  it('folds the observation ring into Δ-from-baseline series with predicted risk', () => {
    const state = {
      access: { type: 'avf', site: 'left-forearm', ageDays: 900, events: [{ at: '2026-06-01T00:00:00.000Z', event: 'angioplasty' }] },
      accessObservations: [
        { at: '2026-08-01T07:00:00.000Z', event: 'surveillance', venousPressureMmHg: 140, accessFlowMlMin: 950, recirculationPct: 4 },
        { at: '2026-08-05T07:00:00.000Z', event: 'surveillance', venousPressureMmHg: 158, accessFlowMlMin: 880, recirculationPct: 7 },
        { at: '2026-08-09T07:00:00.000Z', event: 'cannulation-difficulty', venousPressureMmHg: 176, accessFlowMlMin: 790, recirculationPct: 11, cannulationDifficulty: 'moderate' },
        { at: '2026-08-13T07:00:00.000Z', event: 'surveillance', venousPressureMmHg: 192, accessFlowMlMin: 690, recirculationPct: 14, cannulationDifficulty: 'difficult' },
        { at: '2026-08-17T07:00:00.000Z', event: 'surveillance', venousPressureMmHg: 205, accessFlowMlMin: 600, recirculationPct: 17, cannulationDifficulty: 'difficult' },
        { at: '2026-08-21T07:00:00.000Z', event: 'angioplasty', venousPressureMmHg: 208, accessFlowMlMin: 580, recirculationPct: 18, note: 'fistulogram + angioplasty' },
      ],
    };
    expect(accessObservationsFromState(state)).toHaveLength(6);

    const twin = buildAccessTwin({
      patientId: 'p-twin',
      events: [],
      patients: [{ patientId: 'p-twin', state }],
      asOf: NOW,
    });
    expect(twin.summary.observations).toBe(6);
    // baseline = median of the first three measured pressures (140, 158, 176 → 158)
    expect(twin.summary.venousPressureDeltaPct).toBeGreaterThan(30);
    expect(twin.summary.accessFlowDeltaPct).toBeLessThan(-30);
    expect(twin.summary.interventions).toBe(2); // the ring angioplasty + the recorded one
    expect(twin.summary.thromboses).toBe(0);
    expect(twin.observations.every((o) => o.stenosisProbability !== undefined)).toBe(true);
    // the observation preceding the angioplasty carries the observed outcome
    expect(twin.observations.some((o) => o.outcome === true && o.outcomeEvent === 'angioplasty')).toBe(true);
    expect(twin.provenance.synthetic).toBe(true);

    const window = accessWindowFromTwin(twin);
    expect(window.patientId).toBe('p-twin');
    expect(window.venousPressureMmHg).toBe(208);
    expect(window.venousPressureBaselineMmHg).toBe(140);
    expect(window.daysSinceIntervention).toBeGreaterThan(0);
  });

  it('says "insufficient" rather than inventing a discrimination number', () => {
    const twin = buildAccessTwin({ patientId: 'p-empty', events: [], patients: [{ patientId: 'p-empty', state: {} }] });
    const score = scoreAccessTwinDrift(twin);
    expect(score.verdict).toBe('insufficient');
    expect(score.auroc).toBeUndefined();
    expect(score.note).toMatch(/needed/i);
    expect(twin.acoustic.enabled).toBe(false);
  });

  it('never uses an acoustic capture unless the flag is on (provenance reported only)', () => {
    const state = {
      access: { type: 'avf', ageDays: 400, events: [] },
      accessObservations: [
        { at: '2026-08-01T07:00:00.000Z', event: 'surveillance', venousPressureMmHg: 140, accessFlowMlMin: 950 },
        { at: '2026-08-05T07:00:00.000Z', event: 'surveillance', venousPressureMmHg: 150, accessFlowMlMin: 900 },
        { at: '2026-08-09T07:00:00.000Z', event: 'surveillance', venousPressureMmHg: 160, accessFlowMlMin: 850 },
      ],
      accessAcoustic: [
        { at: '2026-08-01T07:00:00.000Z', features: [1, 1, 1, 1], baseline: true, provenance: 'simulator:test', synthetic: true },
        { at: '2026-08-09T07:00:00.000Z', features: [1.3, 1.2, 0.9, 0.8], baseline: false, provenance: 'simulator:test', synthetic: true },
      ],
    };
    const twin = buildAccessTwin({ patientId: 'p-acoustic', events: [], patients: [{ patientId: 'p-acoustic', state }], asOf: NOW });
    expect(twin.acoustic.captures).toBe(2);
    expect(twin.acoustic.provenance).toContain('simulator:test');
    expect(twin.acoustic.synthetic).toBe(true);
    expect(twin.acoustic.enabled).toBe(false);
    // flag off → no acoustic delta is ever attached to a scored observation
    expect(twin.observations.every((o) => o.acousticDeltaScore === undefined)).toBe(true);
  });

  it('accepts ledger telemetry for restored states and reports provenance', () => {
    const twin = buildAccessTwin({
      patientId: 'p-ledger',
      events: [
        { kind: 'record-access', emittedAt: NOW, realmAt: NOW, payload: { patientId: 'p-ledger', event: 'surveillance', venousPressureMmHg: 150, accessFlowMlMin: 900, recirculationPct: 5 } },
        { kind: 'record-access', emittedAt: NOW, realmAt: NOW, payload: { patientId: 'p-ledger', event: 'surveillance', venousPressureMmHg: 178, accessFlowMlMin: 760, recirculationPct: 10 } },
        { kind: 'record-access-acoustic', emittedAt: NOW, realmAt: NOW, payload: { patientId: 'p-ledger', captureId: 'c1', features: [1, 1], baseline: true, provenance: 'simulator:access-acoustic-v1', synthetic: true } },
      ],
      patients: [{ patientId: 'p-ledger', state: {} }],
    });
    expect(twin.provenance.attributedBy).toBe('payload-patientId');
    expect(twin.provenance.accessEvents).toBe(2);
    expect(twin.provenance.acousticEvents).toBe(1);
    expect(twin.summary.observations).toBe(2);
    // baseline = median of the first two measured pressures (150, 178 → 164)
    expect(twin.summary.venousPressureDeltaPct).toBeGreaterThan(5);
  });
});

describe('P3-E — trained artifact + gated audio adapter', () => {
  it('trains, persists and reports the longitudinal-only verdict', () => {
    const rows = buildAccessTrainingRows({ patients: 40, observationsPerPatient: 8, seed: 3 });
    const artifact = trainAccessArtifact(rows, { salt: 'access-test' });
    expect(artifact.model.kind).toBe('gbdt-regression');
    expect(artifact.metrics.positives).toBeGreaterThan(0);
    expect(artifact.metrics.negatives).toBeGreaterThan(0);
    expect(artifact.metrics.longitudinalOnlyAuroc).toBeGreaterThan(0.5);
    expect(artifact.metrics.priorAuroc).toBeGreaterThan(0.5);
    expect(artifact.metrics.baselineAuroc).toBeDefined();
    expect(artifact.reliability.length).toBeGreaterThan(0);
    expect(artifact.synthetic).toBe(true);
    // the audio path is never used by the served artifact
    expect(artifact.acoustic.captures).toBe(0);
    expect(artifact.acoustic.synthetic).toBe(true);
    expect(String(artifact.modelCard.servedPath)).toMatch(/longitudinal/i);
    expect(String(artifact.modelCard.referenceArchitecture)).toMatch(/ResNet50/);

    const missing = accessArtifactStatus('/tmp/does-not-exist.json');
    expect(missing.present).toBe(false);
    expect(missing.band).toBe('insufficient');
  });

  it('ships an artifact that meets the strategy acceptance target', () => {
    const artifact = loadAccessArtifact();
    expect(artifact, 'run `npx tsx scripts/train-access-model.ts`').toBeDefined();
    const status = accessArtifactStatus();
    expect(status.present).toBe(true);
    expect(status.meetsLongitudinalTarget).toBe(true);
    expect(status.metrics?.longitudinalOnlyAuroc).toBeGreaterThanOrEqual(0.8);
    expect(status.acoustic?.captures).toBe(0);
    expect(status.note.length).toBeGreaterThan(20);
  });

  it('zeroes the acoustic slot unless the flag, provenance and label all agree', () => {
    expect(accessAcousticDelta(undefined)).toBeUndefined();
    expect(accessAcousticDelta({ features: [2], baselineFeatures: [1], provenance: 'x', synthetic: true })).toBeUndefined();
    expect(accessAcousticDelta({ features: [2], baselineFeatures: [1], provenance: '', synthetic: true })).toBeUndefined();
    expect(accessAcousticDelta({ features: [2], baselineFeatures: [1], provenance: 'x', synthetic: false })).toBeUndefined();

    const original = process.env[ACCESS_ACOUSTIC_FLAG];
    process.env[ACCESS_ACOUSTIC_FLAG] = '1';
    try {
      const delta = accessAcousticDelta({ features: [1.4, 1.2], baselineFeatures: [1, 1], provenance: 'simulator:test', synthetic: true });
      expect(delta).toBeCloseTo(0.3, 5);
    } finally {
      if (original === undefined) delete process.env[ACCESS_ACOUSTIC_FLAG];
      else process.env[ACCESS_ACOUSTIC_FLAG] = original;
    }
  });

  it('builds a model vector aligned with the declared feature list', () => {
    const vector = buildAccessVector(STENOSING);
    expect(vector).toHaveLength(ACCESS_MODEL_FEATURES.length);
    expect(vector.every((v) => Number.isFinite(v))).toBe(true);
    // flow decline is positive-signed (higher = worse)
    expect(vector[2]).toBeGreaterThan(0);
  });
});

describe('P3-F — routes over the live ledger', () => {
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
      async recordFhirResource(_scope: { scopeId: string; actorRef: string }, _r: unknown) { /* noop */ },
      async listFhirResources() { return []; },
    } as unknown as PostgresEventStore;
  }
  const actor: ActorContext = { actorRef: 'user:test', scopeIds: ['scope:*'], clearance: 'restricted-phi', purposeOfUse: 'operations' } as ActorContext;
  const at = (daysAgo: number): string => new Date(Date.parse('2026-09-01T07:00:00.000Z') - daysAgo * 86_400_000).toISOString();

  async function build() {
    return buildApp({
      store: inMemoryStore(),
      telemetry: new Telemetry('test', new InMemorySink()),
      packs: [healthcareCorePack],
      authenticate: async () => actor,
      checkHealth: async () => ({ db: true, redis: true }),
      renalPatients: () => [
        {
          id: 'fac-a-pt-0001', realmId: 'sim:renal-a', medCodes: ['sevelamer'],
          state: {
            facilityId: 'fac-a',
            access: { type: 'avf', site: 'left-forearm', ageDays: 1_050, events: [{ at: at(200), event: 'angioplasty' }] },
            accessObservations: [
              { at: at(28), event: 'surveillance', venousPressureMmHg: 142, accessFlowMlMin: 950, recirculationPct: 4, deliveredClearancePct: 96, cannulationDifficulty: 'easy' },
              { at: at(20), event: 'surveillance', venousPressureMmHg: 156, accessFlowMlMin: 880, recirculationPct: 7, deliveredClearancePct: 92, cannulationDifficulty: 'easy' },
              { at: at(12), event: 'cannulation-difficulty', venousPressureMmHg: 178, accessFlowMlMin: 780, recirculationPct: 11, deliveredClearancePct: 86, cannulationDifficulty: 'moderate' },
              { at: at(4), event: 'surveillance', venousPressureMmHg: 196, accessFlowMlMin: 640, recirculationPct: 15, deliveredClearancePct: 78, cannulationDifficulty: 'difficult' },
            ],
            accessAcoustic: [
              { at: at(28), features: [1, 1, 1, 1, 1, 1, 1, 1], baseline: true, provenance: 'simulator:access-acoustic-v1', synthetic: true },
              { at: at(4), features: [1.4, 1.3, 1.2, 1, 0.9, 0.85, 0.8, 0.75], baseline: false, provenance: 'simulator:access-acoustic-v1', synthetic: true },
            ],
          },
        },
      ],
    });
  }

  it('exposes features, cells, live windows and the gated acoustic contract', async () => {
    const app = await build();
    try {
      const features = await app.inject({ method: 'GET', url: '/admin/swarm/access/features' });
      expect(features.statusCode).toBe(200);
      const body = features.json() as { features: unknown[]; safety: { procedureOrdering: string; referralRequiresHumanApproval: boolean }; acoustic: { flag: string; enabled: boolean; note: string } };
      expect(body.features).toHaveLength(ACCESS_FEATURES.length);
      expect(body.safety.procedureOrdering).toBe('none');
      expect(body.safety.referralRequiresHumanApproval).toBe(true);
      expect(body.acoustic.flag).toBe(ACCESS_ACOUSTIC_FLAG);
      expect(body.acoustic.enabled).toBe(false);
      expect(body.acoustic.note).toMatch(/benchmarks/i);

      for (const url of ['/admin/swarm/access/cells', '/admin/swarm/access/state', '/admin/swarm/access/acoustic', '/admin/swarm/access/artifact', '/admin/swarm/access/assurance', '/admin/swarm/access/validation', '/admin/swarm/access/demo']) {
        const res = await app.inject({ method: 'GET', url });
        expect(res.statusCode, url).toBe(200);
      }

      const state = await app.inject({ method: 'GET', url: '/admin/swarm/access/state' });
      const stateBody = state.json() as { patients: number; kpis: { observations: number }; windows: Array<{ patientId: string; recommendation: { action: string; stenosisProbability: number }; coverage: { covered: boolean } }> };
      expect(stateBody.patients).toBe(1);
      expect(stateBody.kpis.observations).toBe(4);
      expect(stateBody.windows[0]!.coverage.covered).toBe(true);
      expect(stateBody.windows[0]!.recommendation.stenosisProbability).toBeGreaterThan(0.4);

      // the live window must roll up to a referral proposal (human-approved)
      const advise = await app.inject({ method: 'POST', url: '/admin/swarm/access/advise', payload: { patientId: 'fac-a-pt-0001' } });
      expect(advise.statusCode).toBe(200);
      const advised = advise.json() as { recommendation: { action: string; guardrails: { referralAllowed: boolean } }; whatIf: { candidates: unknown[] } };
      expect(advised.recommendation.action).toBe('refer-duplex-ultrasound');
      expect(advised.recommendation.guardrails.referralAllowed).toBe(true);
      expect(advised.whatIf.candidates.length).toBe(ACCESS_SURVEILLANCE_INTERVALS.length * ACCESS_REFERRAL_ARMS.length);

      const trained = await app.inject({ method: 'POST', url: '/admin/swarm/access/advise', payload: { patientId: 'fac-a-pt-0001', model: 'trained' } });
      expect(trained.statusCode).toBe(200);
      expect((trained.json() as { trained: { artifactId: string } }).trained.artifactId).toBe(ACCESS_ARTIFACT_ID);

      const acoustic = await app.inject({ method: 'GET', url: '/admin/swarm/access/acoustic' });
      const acousticBody = acoustic.json() as { enabled: boolean; capturesOnLedger: number; gating: string[] };
      expect(acousticBody.enabled).toBe(false);
      expect(acousticBody.capturesOnLedger).toBe(1);
      expect(acousticBody.gating.join(' ')).toMatch(/provenance/i);
    } finally {
      await app.close();
    }
  });

  it('serves the twin, the counterfactual and the risk surface', async () => {
    const app = await build();
    try {
      const twin = await app.inject({ method: 'POST', url: '/admin/swarm/access/twin', payload: { patientId: 'fac-a-pt-0001' } });
      expect(twin.statusCode).toBe(200);
      const twinBody = twin.json() as { twin: { summary: { observations: number; venousPressureDeltaPct?: number }; acoustic: { captures: number; enabled: boolean } }; drift: { verdict: string; auroc?: number } };
      expect(twinBody.twin.summary.observations).toBe(4);
      // baseline = median of the first three measured pressures (142, 156, 178 → 156)
      expect(twinBody.twin.summary.venousPressureDeltaPct).toBeGreaterThan(20);
      expect(twinBody.twin.acoustic.captures).toBe(2);
      expect(twinBody.twin.acoustic.enabled).toBe(false);
      // four observations is below the six needed: never a fabricated AUROC
      expect(twinBody.drift.verdict).toBe('insufficient');
      expect(twinBody.drift.auroc).toBeUndefined();

      const whatIf = await app.inject({ method: 'POST', url: '/admin/swarm/access/what-if', payload: { patientId: 'fac-a-pt-0001' } });
      expect(whatIf.statusCode).toBe(200);
      const whatIfBody = whatIf.json() as { result: { candidates: unknown[] }; riskSurface: unknown[] };
      expect(whatIfBody.result.candidates.length).toBeGreaterThan(0);
      expect(whatIfBody.riskSurface).toHaveLength(ACCESS_SURVEILLANCE_INTERVALS.length);

      const score = await app.inject({ method: 'POST', url: '/admin/swarm/access/twin/score', payload: { patientId: 'fac-a-pt-0001' } });
      expect(score.statusCode).toBe(200);

      const drift = await app.inject({ method: 'POST', url: '/admin/swarm/access/drift', payload: {} });
      expect(drift.statusCode).toBe(200);
      expect((drift.json() as { snapshot: { targetId: string } }).snapshot.targetId).toBe(ACCESS_MODEL_ID);
    } finally {
      await app.close();
    }
  });

  it('runs the red team, writes the MDR file and records study decisions', async () => {
    const app = await build();
    try {
      const redTeam = await app.inject({ method: 'POST', url: '/admin/swarm/access/red-team', payload: { ranBy: 'test' } });
      expect(redTeam.statusCode).toBe(200);
      const rtBody = redTeam.json() as { passed: boolean; runs: unknown[]; probes: Array<{ passed: boolean }> };
      expect(rtBody.runs).toHaveLength(4);
      expect(rtBody.probes.every((p) => p.passed)).toBe(true);
      expect(rtBody.passed).toBe(true);

      const mdr = await app.inject({ method: 'GET', url: '/admin/swarm/access/mdr' });
      expect(mdr.statusCode).toBe(200);
      const mdrBody = mdr.json() as { mdr: { classification: { riskClass: string }; limitations: string[] } };
      expect(mdrBody.mdr.classification.riskClass).toBe('high-risk-cdss');
      expect(mdrBody.mdr.limitations.join(' ')).toMatch(/synthetic/i);

      const validation = await app.inject({ method: 'GET', url: '/admin/swarm/access/validation' });
      const report = (validation.json() as { report: { criteria: Array<{ criterion: string; met: boolean }>; benchmarkNote: string; synthetic: boolean } }).report;
      expect(report.synthetic).toBe(true);
      expect(report.criteria.some((c) => c.criterion.includes('Longitudinal-only') && c.met)).toBe(true);
      expect(report.criteria.some((c) => c.criterion.includes('Referral always human-approved') && c.met)).toBe(true);
      expect(report.benchmarkNote).toMatch(/not results of this system/i);

      const study = await app.inject({ method: 'POST', url: '/admin/swarm/access/study/record', payload: { patientId: 'fac-a-pt-0001', action: 'modify', clinician: 'access-nurse' } });
      expect(study.statusCode).toBe(200);
      const listed = await app.inject({ method: 'GET', url: '/admin/swarm/access/study' });
      expect((listed.json() as { count: number }).count).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it('seeds a Class C referral plus a closed Class B cannulation loop, then resets only access episodes', async () => {
    const app = await build();
    try {
      const seeded = await app.inject({ method: 'POST', url: '/admin/swarm/access/demo', payload: {} });
      expect(seeded.statusCode).toBe(200);
      const seededBody = seeded.json() as { opened: string[]; existing: string[]; closed: string[]; episodes: Array<{ state: string; proposal?: { approvalClass?: string } }> };
      expect(seededBody.opened.length + seededBody.existing.length + seededBody.closed.length).toBe(2);
      expect(seededBody.episodes).toHaveLength(2);
      expect(seededBody.episodes.some((e) => e.proposal?.approvalClass === 'C')).toBe(true);
      expect(seededBody.episodes.some((e) => e.state === 'AwaitingApproval')).toBe(true);
      expect(seededBody.episodes.some((e) => e.state === 'Resolved')).toBe(true);

      const reset = await app.inject({ method: 'POST', url: '/admin/swarm/access/reset', payload: {} });
      expect(reset.statusCode).toBe(200);
      expect((reset.json() as { removed: number }).removed).toBe(2);
      const afterReset = await app.inject({ method: 'GET', url: '/admin/swarm/access/demo' });
      expect((afterReset.json() as { episodes: unknown[] }).episodes).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('merges access proposals into the swarm insight/nba surface', () => {
    const demo = buildAccessDemo();
    expect(demo.proposals).toHaveLength(2);
    expect(demo.proposals.some((p) => p.approvalClass === 'C')).toBe(true);
    expect(demo.nbas.length).toBeGreaterThan(0);
    expect(demo.cells).toHaveLength(2);
  });
});

describe('P3 data model — coverage defaults align with the referral guardrail', () => {
  it('keeps the metrics the gate and the guardrail share in one place', () => {
    expect(ACCESS_COVERAGE_DEFAULTS.minObservations).toBe(ACCESS_REFERENCE.minObservationsForReferral);
    expect(ACCESS_COVERAGE_DEFAULTS.maxObservationGapDays).toBe(45);
  });
});
