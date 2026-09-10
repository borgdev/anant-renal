import { describe, expect, it, afterEach } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import type { PostgresEventStore } from '../src/server/postgres-event-store.js';
import type { CanonicalEvent } from '../src/healthcare-core/events.js';
import type { LedgerEntry } from '../src/hypergraph/ledger.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import type { ActorContext } from '../src/server/scoped-persistence.js';
import {
  ADEQUACY_FEATURES, ADEQUACY_CELLS, ADEQUACY_REFERENCE, KTV_BAND,
  adequacyRecommend, adequacyLatent, guardAdequacyPrescription,
  clearanceMultiplier, idhRiskProxy, buildAdequacyDemo,
  type AdequacyPatientWindow,
} from '../src/swarm/adequacy.js';
import {
  ADEQUACY_RED_TEAM_DEFS, ADEQUACY_RED_TEAM_IDS, adequacyCoverage, adequacyRecommendCovered,
  adequacyRedTeamProbe, evaluateAdequacyAdvisorGate, computeAdequacyDrift, isAdequacyFinding,
} from '../src/swarm/adequacy-governance.js';
import { adequacyWhatIf, ADEQUACY_CANDIDATE_DELTAS } from '../src/swarm/adequacy-prescription.js';
import { buildAdequacyTwin, scoreAdequacyTwinDrift, predictSessionUrr, sessionsFromState } from '../src/swarm/adequacy-twin.js';
import {
  ADEQUACY_MODEL_FEATURES, buildAdequacyVector, buildAdequacyTrainingRows, defaultAdequacyTrainingSpecs,
  trainAdequacyArtifact, adequacyArtifactStatus, adequacyRecommendTrained, loadAdequacyArtifact,
} from '../src/swarm/adequacy-model.js';
import { fitGbt, predictGbt, predictGbtWithBand, gbtAttribution, validateGbtModel, gbtModelCard } from '../src/protocols/gbdt.js';
import { twoSampleKs } from '../src/protocols/metrics.js';

/** A well-delivered, in-band patient. */
const GOOD: AdequacyPatientWindow = {
  patientId: 'pt-good', facilityId: 'fac-a', sessionCount: 6, sessionsPerWeek: 3,
  prescribedMinutes: 240, deliveredMinutes: 238, qbPrescribed: 350, qbAvg: 348, qd: 500,
  ufVolumeL: 2.4, postWeightKg: 70, recirculationPct: 4, accessType: 'avf',
  nadirSbp: 112, idwgKg: 2.2, potassium: 5.0, urrPct: 68, urrTrendPct: [67, 68, 68],
  adherencePct: 99, age: 62, cardiacHistory: false, asOf: '2026-09-01T00:00:00Z',
};

describe('P1-A adequacy engine + guardrails', () => {
  it('catalogues the feature set and keeps the Kt/V band aligned with KDOQI', () => {
    expect(ADEQUACY_FEATURES.length).toBeGreaterThanOrEqual(10);
    expect(ADEQUACY_FEATURES[0]!.id).toBe('deliveredMinutes');
    expect(KTV_BAND.min).toBe(1.2);
    expect(KTV_BAND.max).toBe(1.4);
    expect(ADEQUACY_CELLS.map((c) => c.id)).toContain('adequacy-prescription');
    expect(ADEQUACY_CELLS.every((c) => c.approvalClass === 'C' || c.approvalClass === 'B')).toBe(true);
    expect(ADEQUACY_REFERENCE.maxQb).toBeLessThanOrEqual(450);
  });

  it('blocks when there is no delivered session, no clearance, or shortened treatments', () => {
    const none = guardAdequacyPrescription({});
    expect(none.blocked).toBe(true);
    expect(none.flags).toContain('no-session-telemetry');
    expect(none.blockReason).toMatch(/No delivered session/);

    const noKtv = guardAdequacyPrescription({ sessionCount: 4, deliveredMinutes: 240, prescribedMinutes: 240 });
    expect(noKtv.blocked).toBe(true);
    expect(noKtv.flags).toContain('no-ktv-measurement');

    const short = guardAdequacyPrescription({ sessionCount: 4, prescribedMinutes: 240, deliveredMinutes: 150, urrPct: 55 });
    expect(short.blocked).toBe(true);
    expect(short.flags).toContain('shortened-sessions-adherence-first');
    expect(short.timeEscalationAllowed).toBe(false);
  });

  it('refuses flow escalation for fragile patients and routes recirculation to access review', () => {
    const fragile = guardAdequacyPrescription({ sessionCount: 5, deliveredMinutes: 235, prescribedMinutes: 240, urrPct: 58, nadirSbp: 82, cardiacHistory: true });
    expect(fragile.qbEscalationAllowed).toBe(false);
    expect(fragile.flags).toContain('qb-escalation-cardiac-risk');
    expect(fragile.flags).toContain('hypotension-coupling-no-uf-increase');

    const recirc = guardAdequacyPrescription({ sessionCount: 5, deliveredMinutes: 235, prescribedMinutes: 240, urrPct: 56, recirculationPct: 16 });
    expect(recirc.qbEscalationAllowed).toBe(false);
    expect(recirc.flags).toContain('access-recirculation-review-first');

    const over = guardAdequacyPrescription({ sessionCount: 5, deliveredMinutes: 260, prescribedMinutes: 260, urrPct: 88 });
    expect(over.flags).toContain('ktv-above-over-delivery-ceiling');
    expect(over.timeEscalationAllowed).toBe(false);
  });

  it('recommends time extension below target, hold in band, and de-escalation above the ceiling', () => {
    const low = adequacyRecommend({ ...GOOD, urrPct: 58, urrTrendPct: [58, 58, 59] });
    expect(low.action).toBe('extend-time');
    expect(low.recommended.minutes).toBeGreaterThan(238);
    expect(low.recommended.expectedSpKtV).toBeGreaterThan(low.current.spKtV!);
    expect(low.recommended.expectedUrrPct).toBeGreaterThan(58);
    expect(low.inTargetBand).toBe(false);

    const inBand = adequacyRecommend(GOOD);
    expect(inBand.action).toBe('hold');
    expect(inBand.inTargetBand).toBe(true);
    expect(inBand.current.weeklyKtV).toBeGreaterThan(3);

    const over = adequacyRecommend({ ...GOOD, prescribedMinutes: 260, deliveredMinutes: 260, urrPct: 88 });
    expect(over.action).toBe('reduce-time');
    expect(over.recommended.minutes).toBeLessThan(260);

    const recirc = adequacyRecommend({ ...GOOD, urrPct: 56, recirculationPct: 18, urrTrendPct: [56, 56, 57] });
    expect(recirc.action).toBe('review-access');
    expect(recirc.recommended.qb).toBeUndefined();

    const adherence = adequacyRecommend({ ...GOOD, prescribedMinutes: 240, deliveredMinutes: 150, adherencePct: 62, urrPct: 55 });
    expect(adherence.action).toBe('adherence-first');
    expect(adherence.recommended.minutes).toBeUndefined();
  });

  it('keeps the coupling explicit: clearance scaling saturates in Qb and IDH risk responds to UF rate', () => {
    expect(clearanceMultiplier({ minutesNow: 240, minutesNext: 240, qbNow: 350, qbNext: 350 })).toBe(1);
    expect(clearanceMultiplier({ minutesNow: 240, minutesNext: 240, qbNow: 300, qbNext: 400 })).toBeLessThan(400 / 300);
    expect(clearanceMultiplier({ minutesNow: 240, minutesNext: 300, qbNow: 350, qbNext: 350 })).toBeCloseTo(1.25, 3);

    const calm = idhRiskProxy({ nadirSbp: 118, idwgKg: 1.5, ufVolumeL: 1.5, plannedMinutes: 240, postWeightKg: 70 });
    const risky = idhRiskProxy({ nadirSbp: 84, idwgKg: 4.5, ufVolumeL: 4.2, plannedMinutes: 200, postWeightKg: 70 });
    expect(risky).toBeGreaterThan(calm);
    expect(risky).toBeLessThanOrEqual(1);
  });

  it('produces a 2-D latent separating dose pressure from patient vulnerability', () => {
    const wellDelivered = adequacyLatent({ deliveredMinutes: 250, urrPct: 75, nadirSbp: 120, recirculationPct: 3, adherencePct: 99 });
    const frail = adequacyLatent({ deliveredMinutes: 180, urrPct: 52, nadirSbp: 84, recirculationPct: 18, adherencePct: 70, accessType: 'catheter' });
    expect(wellDelivered.l1).toBeGreaterThan(frail.l1);
    expect(frail.l2).toBeGreaterThan(wellDelivered.l2);
    expect(Math.abs(frail.polarRadius)).toBeLessThanOrEqual(Math.SQRT2 + 1e-9);
  });

  it('builds the reference boundary with proposals, insights and NBAs', () => {
    const demo = buildAdequacyDemo();
    expect(demo.cells.map((c) => c.id)).toEqual(['adequacy-prescription', 'access-clearance-review']);
    expect(demo.proposals.length).toBe(2);
    expect(demo.nbas.length).toBeGreaterThan(0);
    expect(demo.kpis.spKtVInBandPct).toBeGreaterThan(0);
    expect(demo.proposals.every((p) => p.recommendation.length > 40)).toBe(true);
  });
});

describe('P1-B adequacy governance', () => {
  it('gates coverage on session density, clearance density and interpretable recirculation', () => {
    expect(adequacyCoverage(GOOD).covered).toBe(true);

    const noSessions = adequacyCoverage({ ...GOOD, sessionCount: 1 });
    expect(noSessions.covered).toBe(false);
    expect(noSessions.reason).toMatch(/Insufficient delivered sessions/);

    const noClearance = adequacyCoverage({ ...GOOD, urrPct: undefined, urrTrendPct: undefined, deliveredSpKtV: undefined });
    expect(noClearance.covered).toBe(false);
    expect(noClearance.reason).toMatch(/Insufficient clearance data/);

    const wildRecirc = adequacyCoverage({ ...GOOD, recirculationPct: 34 });
    expect(wildRecirc.covered).toBe(false);
    expect(wildRecirc.reason).toMatch(/not interpretable/);

    const outOfRange = adequacyCoverage({ ...GOOD, deliveredMinutes: 12 });
    expect(outOfRange.covered).toBe(false);
    expect(outOfRange.range?.feature).toBe('deliveredMinutes');
  });

  it('coverage-gated advise returns no prescription for uncovered windows', () => {
    const blocked = adequacyRecommendCovered({ ...GOOD, sessionCount: 0 });
    expect(blocked.coverage.covered).toBe(false);
    expect(blocked.action).toBe('blocked');
    expect(blocked.recommended.minutes).toBeUndefined();
    expect(blocked.note).toMatch(/coverage|Insufficient|No delivered/i);

    const open = adequacyRecommendCovered(GOOD, { coverageGateEnabled: false });
    expect(open.coverage.covered).toBe(true);
    expect(open.action).toBe('hold');
  });

  it('contains every one of the four behavioral red-team probes', () => {
    expect(ADEQUACY_RED_TEAM_IDS).toHaveLength(4);
    expect(ADEQUACY_RED_TEAM_DEFS.map((d) => d.id)).toEqual(['rt-017', 'rt-018', 'rt-019', 'rt-020']);
    for (const def of ADEQUACY_RED_TEAM_DEFS) {
      const probe = adequacyRedTeamProbe(def);
      expect(probe.scenarioId).toBe(def.id);
      expect(probe.passed, `${def.id}: ${probe.checks[0]?.observed}`).toBe(true);
    }
    // the fragile-patient probe must never escalate flow
    const fragile = ADEQUACY_RED_TEAM_DEFS.find((d) => d.id === 'rt-017')!;
    const rec = adequacyRecommendCovered(fragile.probe);
    expect(rec.recommended.qb ?? 0).toBe(0);
  });

  it('blocks activation on open findings or machine-control authority', () => {
    const active = evaluateAdequacyAdvisorGate({ registered: true, interpretabilityPresent: true, coverageGateEnabled: true, openFindings: 0, posturePresent: true, machineControlAuthority: false });
    expect(active.status).toBe('active');
    expect(active.gates.every((g) => g.passed)).toBe(true);

    const withFinding = evaluateAdequacyAdvisorGate({ registered: true, interpretabilityPresent: true, coverageGateEnabled: true, openFindings: 1, posturePresent: true, machineControlAuthority: false });
    expect(withFinding.status).toBe('blocked');
    expect(withFinding.reasons.join(' ')).toMatch(/red team/i);

    const machine = evaluateAdequacyAdvisorGate({ registered: true, interpretabilityPresent: true, coverageGateEnabled: true, openFindings: 0, posturePresent: true, machineControlAuthority: true });
    expect(machine.status).toBe('blocked');
    expect(machine.gates.some((g) => g.name === 'No machine control' && !g.passed)).toBe(true);

    const gated = evaluateAdequacyAdvisorGate({ registered: false, interpretabilityPresent: true, coverageGateEnabled: true, openFindings: 0, posturePresent: true, machineControlAuthority: false });
    expect(gated.status).toBe('gated');
  });

  it('detects distribution drift with a two-sample KS statistic', () => {
    expect(twoSampleKs([1, 2, 3], [1, 2, 3])).toBe(0);
    expect(twoSampleKs([1, 2, 3], [10, 11, 12])).toBe(1);
    const stable = computeAdequacyDrift({
      baseline: [
        { deliveredMinutes: 240, qbAvg: 350, recirculationPct: 4, nadirSbp: 110, adherencePct: 99 },
        { deliveredMinutes: 240, qbAvg: 350, recirculationPct: 4, nadirSbp: 110, adherencePct: 99 },
        { deliveredMinutes: 238, qbAvg: 350, recirculationPct: 4, nadirSbp: 110, adherencePct: 99 },
        { deliveredMinutes: 238, qbAvg: 348, recirculationPct: 5, nadirSbp: 108, adherencePct: 98 },
      ],
      current: [
        { deliveredMinutes: 240, qbAvg: 350, recirculationPct: 4, nadirSbp: 110, adherencePct: 99 },
        { deliveredMinutes: 240, qbAvg: 350, recirculationPct: 4, nadirSbp: 110, adherencePct: 99 },
        { deliveredMinutes: 238, qbAvg: 350, recirculationPct: 4, nadirSbp: 110, adherencePct: 99 },
        { deliveredMinutes: 238, qbAvg: 348, recirculationPct: 5, nadirSbp: 108, adherencePct: 98 },
      ],
    });
    expect(stable.verdict).toBe('stable');
    expect(stable.ksStatistic).toBe(0);
    const drifted = computeAdequacyDrift({
      baseline: [{ deliveredMinutes: 240, qbAvg: 350 }, { deliveredMinutes: 238, qbAvg: 352 }],
      current: [{ deliveredMinutes: 150, qbAvg: 300 }, { deliveredMinutes: 140, qbAvg: 290 }],
    });
    expect(drifted.verdict).toBe('drift');
    expect(drifted.features.some((f) => f.drifted)).toBe(true);

    expect(isAdequacyFinding({ scenarioId: 'rt-017' })).toBe(true);
    expect(isAdequacyFinding({ threatModel: 'adequacy-ktv-advisor' })).toBe(true);
    expect(isAdequacyFinding({ scenarioId: 'rt-001' })).toBe(false);
  });
});

describe('P1-C prescription simulator (coupled to fluid)', () => {
  it('simulates the candidate matrix and reports clearance AND hypotension risk', () => {
    const result = adequacyWhatIf({ ...GOOD, urrPct: 58, urrTrendPct: [58, 58, 59] });
    expect(result.candidates).toHaveLength(ADEQUACY_CANDIDATE_DELTAS.length);
    expect(result.current.idhRisk).toBeGreaterThanOrEqual(0);
    for (const c of result.candidates) {
      expect(c.expectedSpKtV).toBeDefined();
      expect(c.expectedUrrPct).toBeDefined();
      expect(c.expectedIdhRisk).toBeDefined();
      expect(c.score).toBeGreaterThanOrEqual(0);
    }
    expect(result.recommended).toBeDefined();
    expect(result.recommended!.allowed).toBe(true);
    expect(result.recommended!.expectedSpKtV!).toBeGreaterThan(result.current.spKtV!);
  });

  it('never proposes a blocked action for fragile or recirculating patients', () => {
    const fragile = adequacyWhatIf({ ...GOOD, urrPct: 56, urrTrendPct: [56, 56, 57], nadirSbp: 82, cardiacHistory: true });
    const qbCandidates = fragile.candidates.filter((c) => c.qbDelta > 0);
    expect(qbCandidates.length).toBeGreaterThan(0);
    expect(qbCandidates.every((c) => !c.allowed)).toBe(true);
    expect(fragile.recommended?.qbDelta ?? 0).toBe(0);

    const recirc = adequacyWhatIf({ ...GOOD, urrPct: 55, recirculationPct: 20, urrTrendPct: [55, 55, 56] });
    expect(recirc.candidates.filter((c) => c.qbDelta > 0).every((c) => !c.allowed)).toBe(true);
    expect(recirc.recommended?.blockedReason ?? '').toBeDefined();
  });

  it('refuses every candidate when the window is guardrail-blocked', () => {
    const blocked = adequacyWhatIf({ ...GOOD, prescribedMinutes: 240, deliveredMinutes: 150, adherencePct: 62, urrPct: 55 });
    expect(blocked.blocked).toBe(true);
    expect(blocked.blockReason).toBeTruthy();
    const increases = blocked.candidates.filter((c) => c.minutesDelta > 0 || c.qbDelta > 0);
    expect(increases.every((c) => !c.allowed)).toBe(true);
    expect(blocked.recommended).toBeUndefined();
  });

  it('de-escalates when already above the over-delivery ceiling', () => {
    const over = adequacyWhatIf({ ...GOOD, prescribedMinutes: 260, deliveredMinutes: 260, urrPct: 88 });
    expect(over.candidates.filter((c) => c.minutesDelta > 0).every((c) => !c.allowed)).toBe(true);
    expect(over.recommended).toBeDefined();
    expect(over.recommended!.minutesDelta).toBeLessThan(0);
    expect(over.recommended!.overDelivery).toBe(false);
    expect(over.recommended!.expectedSpKtV!).toBeLessThanOrEqual(1.8);
  });
});

describe('P1-D adequacy twin over the real ledger', () => {
  it('predicts session URR from delivered machinery (monotone in delivered time)', () => {
    const base = predictSessionUrr({ sessionId: 's', startedAt: '', deliveredMinutes: 240, prescribedMinutes: 240, telemetryPoints: 2, stoppedEarly: false });
    const extended = predictSessionUrr({ sessionId: 's', startedAt: '', deliveredMinutes: 300, prescribedMinutes: 240, telemetryPoints: 2, stoppedEarly: false });
    const short = predictSessionUrr({ sessionId: 's', startedAt: '', deliveredMinutes: 150, prescribedMinutes: 240, telemetryPoints: 2, stoppedEarly: false });
    expect(extended.urrPct!).toBeGreaterThan(base.urrPct!);
    expect(short.urrPct!).toBeLessThan(base.urrPct!);
    expect(predictSessionUrr({ sessionId: 's', startedAt: '', deliveredMinutes: 0, prescribedMinutes: 240, telemetryPoints: 0, stoppedEarly: true }).spKtV).toBeUndefined();
  });

  it('folds the reducer session ring into a clinical series', () => {
    const sessions = sessionsFromState({
      sessions: [
        { sessionId: 's1', startedAt: '2026-08-01T07:00:00Z', endedAt: '2026-08-01T11:00:00Z', deliveredMinutes: 240, prescribedMinutes: 240, qbAvg: 348, ufVolumeL: 2.4, recirculationPct: 4, nadirSbp: 110, telemetryPoints: 2, stoppedEarly: false },
      ],
    });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.qbAvg).toBe(348);
    expect(sessions[0]!.telemetryPoints).toBe(2);
  });

  it('attributes ledger URR results (order-id only) and scores forecast-vs-observed drift', () => {
    const events = [
      { kind: 'end-session', emittedAt: '2026-08-01T11:00:00Z', patientId: 'pt-1', payload: { patientId: 'pt-1', deliveredMinutes: 240 } },
      { kind: 'result-lab', emittedAt: '2026-08-01T12:00:00Z', payload: { orderId: 'pt-1-URR-1', code: 'URR', value: 72.5 } },
      { kind: 'result-lab', emittedAt: '2026-08-08T12:00:00Z', payload: { orderId: 'pt-1-URR-2', code: 'URR', value: 73.1 } },
      { kind: 'result-lab', emittedAt: '2026-08-15T12:00:00Z', payload: { orderId: 'pt-1-URR-3', code: 'URR', value: 72.8 } },
      { kind: 'result-lab', emittedAt: '2026-08-15T12:00:00Z', payload: { orderId: 'pt-2-URR-1', code: 'URR', value: 55 } },
    ];
    const twin = buildAdequacyTwin({
      patientId: 'pt-1',
      events: events as never,
      patients: [
        { patientId: 'pt-1', state: { sessions: [{ sessionId: 's1', startedAt: '2026-08-01T07:00:00Z', endedAt: '2026-08-01T11:00:00Z', deliveredMinutes: 240, prescribedMinutes: 240, qbAvg: 348, telemetryPoints: 2, stoppedEarly: false }] } },
        { patientId: 'pt-2', state: {} },
      ],
    });
    expect(twin.observedUrr).toHaveLength(3); // pt-2's result is excluded
    expect(twin.observedUrr[0]!.urrPct).toBe(72.5);
    expect(twin.provenance.attributedBy).toBe('order-id-prefix');
    expect(twin.summary.sessionCount).toBe(1);

    const drift = scoreAdequacyTwinDrift(twin);
    expect(['pass', 'watch', 'insufficient']).toContain(drift.verdict);
    expect(drift.rows).toHaveLength(3);
  });

  it('reports insufficient evidence instead of a fake pass', () => {
    const twin = buildAdequacyTwin({ patientId: 'pt-x', events: [], patients: [{ patientId: 'pt-x', state: {} }] });
    const drift = scoreAdequacyTwinDrift(twin);
    expect(drift.verdict).toBe('insufficient');
    expect(drift.note).toMatch(/at least 3/);
  });
});

describe('P1-E gradient-boosted artifact', () => {
  it('fits and predicts monotone trees, with gain attribution and a model card', () => {
    const samples = Array.from({ length: 60 }, (_, i) => ({ features: [i / 60, (i % 7) / 7], target: 3 * (i / 60) + 0.2 }));
    const model = fitGbt(samples, ['x', 'noise'], { trees: 20, maxDepth: 2 })!;
    expect(predictGbt(model, [1, 0.5])).toBeGreaterThan(predictGbt(model, [0, 0.5]));
    expect(predictGbt(model, [0.5, 0.5])).toBeCloseTo(1.7, 0);
    const band = predictGbtWithBand(model, [0.5, 0.5]);
    expect(band.low).toBeLessThan(band.value);
    expect(band.high).toBeGreaterThan(band.value);
    const attribution = gbtAttribution(model);
    expect(attribution[0]!.feature).toBe('x');
    expect(attribution[0]!.share).toBeGreaterThan(0.5);
    expect(validateGbtModel(model).valid).toBe(true);
    expect(validateGbtModel({ kind: 'nope' }).valid).toBe(false);
    expect(gbtModelCard(model).attributionMethod).toMatch(/gain/);
  });

  it('generates causally consistent synthetic training rows', () => {
    const rows = buildAdequacyTrainingRows(defaultAdequacyTrainingSpecs().slice(0, 4));
    expect(rows.length).toBeGreaterThan(20);
    expect(rows.every((r) => r.features.length === ADEQUACY_MODEL_FEATURES.length)).toBe(true);
    // delivered time in the features drives the target (physics, not noise)
    const sorted = [...rows].sort((a, b) => a.features[1]! - b.features[1]!);
    const low = sorted.slice(0, 5).reduce((a, r) => a + r.observed, 0) / 5;
    const high = sorted.slice(-5).reduce((a, r) => a + r.observed, 0) / 5;
    expect(high).toBeGreaterThan(low);
  });

  it('trains the shipped artifact that meets the recorded acceptance criteria', () => {
    const rows = buildAdequacyTrainingRows(defaultAdequacyTrainingSpecs());
    const artifact = trainAdequacyArtifact(rows, { salt: 'adequacy-test' });
    // any given split varies a little, but the head must always beat its prior
    expect(artifact.metrics.head.mape!).toBeLessThanOrEqual(6);
    expect(artifact.metrics.head.mae!).toBeLessThan(artifact.metrics.referencePrior.mae!);
    expect(artifact.modelCard.patientLevelSplit).toMatchObject({ overlap: false });
    const attr = artifact.modelCard.attribution as Array<{ feature: string }>;
    // clearance physics dominates, not per-patient constants
    expect(['recirculationPct', 'qbAvg', 'priorUrrPct']).toContain(attr[0]!.feature);

    // the SHIPPED artifact (scripts/train-adequacy-model.ts, salt 'adequacy-v1')
    // is the one held to the recorded acceptance criteria (§2.3)
    const shipped = loadAdequacyArtifact();
    expect(shipped).toBeDefined();
    expect(shipped!.metrics.head.mape!).toBeLessThanOrEqual(5);
    expect(shipped!.metrics.head.correlation!).toBeGreaterThanOrEqual(0.85);
    expect(shipped!.metrics.head.mae!).toBeLessThan(shipped!.metrics.referencePrior.mae!);
  });

  it('loads the shipped artifact and re-scores the advisor against it', () => {
    const status = adequacyArtifactStatus();
    expect(status.present).toBe(true);
    expect(status.id).toBe('adequacy.ktv-v1');
    expect(status.attribution?.length).toBeGreaterThan(0);
    const loaded = loadAdequacyArtifact();
    expect(loaded).toBeDefined();
    expect(buildAdequacyVector(GOOD, 71).length).toBe(ADEQUACY_MODEL_FEATURES.length);

    const trained = adequacyRecommendTrained(GOOD) as ReturnType<typeof adequacyRecommendTrained> & { trained?: { predictedUrrPct: number; band: { low: number; high: number } } };
    if (trained.trained) {
      expect(trained.model.kind).toBe('trained');
      expect(trained.trained.predictedUrrPct).toBeGreaterThan(40);
      expect(trained.trained.band.low).toBeLessThanOrEqual(trained.trained.predictedUrrPct);
      expect(trained.note).toMatch(/Trained head/);
    } else {
      // no artifact on disk → the advisor must degrade to the reference surrogate
      expect(trained.model.kind).toBe('reference-surrogate');
    }
  });
});

describe('P1-F adequacy routes', () => {
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
            access: { type: 'avf', ageDays: 320 },
            labs: { URR: 58, K: 5.4, PHOS: 5.1, HGB: 10.4, calcium: 9.3, pth: 320, albumin: 3.8, creatinine: 8.4, bicarb: 23, crp: 5, wbc: 7, procalcitonin: 0.2 },
            lastVitals: { hr: 82, bp: '112/70', spo2: 96, temp: 36.7, at: '2026-08-06T07:00:00.000Z' },
            sessions: [
              { sessionId: 's1', startedAt: '2026-08-01T07:00:00.000Z', endedAt: '2026-08-01T10:40:00.000Z', deliveredMinutes: 220, prescribedMinutes: 240, ufVolumeL: 2.2, targetUfL: 2.6, preWeightKg: 71.2, postWeightKg: 69.0, qbAvg: 320, recirculationPct: 4.1, nadirSbp: 106, meanSbp: 114, stoppedEarly: false, telemetryPoints: 2 },
              { sessionId: 's2', startedAt: '2026-08-03T07:00:00.000Z', endedAt: '2026-08-03T10:35:00.000Z', deliveredMinutes: 215, prescribedMinutes: 240, ufVolumeL: 2.1, targetUfL: 2.6, preWeightKg: 71.0, postWeightKg: 68.9, qbAvg: 318, recirculationPct: 4.4, nadirSbp: 104, meanSbp: 112, stoppedEarly: false, telemetryPoints: 2 },
              { sessionId: 's3', startedAt: '2026-08-05T07:00:00.000Z', endedAt: '2026-08-05T10:30:00.000Z', deliveredMinutes: 210, prescribedMinutes: 240, ufVolumeL: 2.0, targetUfL: 2.6, preWeightKg: 70.8, postWeightKg: 68.8, qbAvg: 316, recirculationPct: 4.6, nadirSbp: 102, meanSbp: 110, stoppedEarly: false, telemetryPoints: 2 },
            ],
          },
        },
      ],
    });
  }

  afterEach(() => { /* app closed per test */ });

  it('serves the feature catalog, cells, live state and the CMS QIP tie-in', async () => {
    const app = await build();
    try {
      const features = await app.inject({ method: 'GET', url: '/admin/swarm/adequacy/features' });
      expect(features.statusCode).toBe(200);
      expect(features.json().features.length).toBeGreaterThanOrEqual(10);
      expect(features.json().safety.machineControl).toBe('none');

      const cells = await app.inject({ method: 'GET', url: '/admin/swarm/adequacy/cells' });
      expect(cells.statusCode).toBe(200);
      expect(cells.json().cells.map((c: { id: string }) => c.id)).toContain('adequacy-prescription');

      const state = await app.inject({ method: 'GET', url: '/admin/swarm/adequacy/state' });
      expect(state.statusCode).toBe(200);
      const s = state.json();
      expect(s.patients).toBe(1);
      expect(s.windows[0].patientId).toBe('fac-a-pt-0001');
      expect(s.windows[0].recommendation.current.urrPct).toBe(58);
      expect(s.windows[0].recommendation.action).toBe('extend-time');

      const qip = await app.inject({ method: 'GET', url: '/admin/swarm/adequacy/qip' });
      expect(qip.statusCode).toBe(200);
      expect(qip.json().measure).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  it('advises (reference + what-if), runs the simulator and the twin', async () => {
    const app = await build();
    try {
      const advise = await app.inject({
        method: 'POST', url: '/admin/swarm/adequacy/advise',
        payload: { patientId: 'fac-a-pt-0001' },
      });
      expect(advise.statusCode).toBe(200);
      const body = advise.json();
      // the live patient has a single URR sample → coverage gate blocks the dose
      expect(body.coverage.covered).toBe(false);
      expect(body.recommendation.action).toBe('blocked');
      expect(body.recommendation.recommended.minutes).toBeUndefined();
      expect(body.whatIf.candidates.length).toBeGreaterThan(3);

      const whatIf = await app.inject({
        method: 'POST', url: '/admin/swarm/adequacy/what-if',
        payload: { patientId: 'pt-inline', sessionCount: 6, prescribedMinutes: 240, deliveredMinutes: 240, qbAvg: 350, urrPct: 58, urrTrendPct: [58, 58, 59], accessType: 'avf', nadirSbp: 110, recirculationPct: 4 },
      });
      expect(whatIf.statusCode).toBe(200);
      expect(whatIf.json().result.recommended.expectedSpKtV).toBeGreaterThan(1.2);

      const trained = await app.inject({ method: 'POST', url: '/admin/swarm/adequacy/advise', payload: { patientId: 'pt-inline', sessionCount: 6, prescribedMinutes: 240, deliveredMinutes: 240, qbAvg: 350, urrPct: 58, model: 'trained' } });
      expect(trained.statusCode).toBe(200);
      expect(['trained', 'reference-surrogate']).toContain(trained.json().recommendation.model.kind);

      const twin = await app.inject({ method: 'POST', url: '/admin/swarm/adequacy/twin', payload: { patientId: 'fac-a-pt-0001' } });
      expect(twin.statusCode).toBe(200);
      expect(twin.json().twin.summary.sessionCount).toBe(3);
      expect(twin.json().drift.verdict).toBeDefined();
    } finally {
      await app.close();
    }
  });

  it('serves governance, validation and the MDR technical file', async () => {
    const app = await build();
    try {
      const assurance = await app.inject({ method: 'GET', url: '/admin/swarm/adequacy/assurance' });
      expect(assurance.statusCode).toBe(200);
      const a = assurance.json();
      expect(a.gate.status).toBe('active');
      expect(a.redTeam.scenarios).toHaveLength(4);
      expect(a.posture.machineControlAuthority).toBe('none');

      const redTeam = await app.inject({ method: 'POST', url: '/admin/swarm/adequacy/red-team', payload: {} });
      expect(redTeam.statusCode).toBe(200);
      expect(redTeam.json().runs.length).toBe(4);
      expect(redTeam.json().passed).toBe(true);

      const drift = await app.inject({ method: 'POST', url: '/admin/swarm/adequacy/drift', payload: {} });
      expect(drift.statusCode).toBe(200);
      expect(drift.json().snapshot.targetId).toBe('adequacy.ktv-v0');

      const validation = await app.inject({ method: 'GET', url: '/admin/swarm/adequacy/validation' });
      expect(validation.statusCode).toBe(200);
      const report = validation.json().report;
      expect(report.artifactPresent).toBe(true);
      expect(report.criteria.some((c: { criterion: string; met: boolean }) => c.criterion.includes('MAPE') && c.met)).toBe(true);
      expect(report.synthetic).toBe(true);

      const mdr = await app.inject({ method: 'GET', url: '/admin/swarm/adequacy/mdr' });
      expect(mdr.statusCode).toBe(200);
      expect(mdr.json().mdr.classification.riskClass).toBe('high-risk-cdss');
      expect(mdr.json().mdr.limitations.join(' ')).toMatch(/synthetic/i);

      const seeded = await app.inject({ method: 'POST', url: '/admin/swarm/adequacy/demo', payload: {} });
      expect(seeded.statusCode).toBe(200);
      const seededBody = seeded.json();
      // the coordinator is process-global: one episode is opened for review, the
      // other runs the full closed loop, so all three buckets must account for both
      expect(seededBody.opened.length + seededBody.existing.length + seededBody.closed.length).toBe(2);
      expect(seededBody.episodes.length).toBe(2);
      const reset = await app.inject({ method: 'POST', url: '/admin/swarm/adequacy/reset', payload: {} });
      expect(reset.json().removed).toBe(2);
      const afterReset = await app.inject({ method: 'GET', url: '/admin/swarm/adequacy/demo' });
      expect(afterReset.json().episodes.length).toBe(0);
    } finally {
      await app.close();
    }
  });
});
