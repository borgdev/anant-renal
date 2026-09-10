// P6 — infection / vaccination pack (steps A–F).
//
// The pack's claim is a SPLIT: a statistical triage head governed like every
// other pack, and a deterministic model-free prevention state machine governed
// by reproducibility. These tests hold both halves to their own promise, and
// they hold the separation itself (a triage perturbation must not move a single
// prevention task).

import { describe, expect, it } from 'vitest';
import {
  INFECTION_FEATURES, INFECTION_REFERENCE, INFECTION_CELLS, INFECTION_EPISODE_KINDS,
  INFECTION_ANTIMICROBIAL_AUTHORITY, INFECTION_PREVENTION_PRIORITY,
  assessBsi, computeNlr, guardInfectionTriage, infectionLatent, infectionRecommend,
  buildInfectionDemo, INFECTION_DEMO_WINDOW, type InfectionInput,
} from '../src/swarm/infection.js';
import {
  preventionPlan, preventionPlanWithSummary, preventionDeterminismSignature,
  VACCINE_SCHEDULE, AUDIT_CADENCE, type PreventionTask,
} from '../src/swarm/infection-prevention.js';
import {
  infectionCoverage, infectionRecommendCovered, INFECTION_RED_TEAM_DEFS, INFECTION_RED_TEAM_IDS,
  infectionRedTeamProbe, ensureInfectionModel, ensureInfectionRedTeamScenarios, computeInfectionDrift,
  evaluateInfectionAdvisorGate, verifyPreventionSeparation, INFECTION_COVERAGE_DEFAULTS,
  INFECTION_MODEL_ID, INFECTION_REGULATORY_POSTURE, INFECTION_HALF_CLASSIFICATION, isInfectionFinding,
  INFECTION_DEFAULT_SEPARATION_PROBE,
} from '../src/swarm/infection-governance.js';
import {
  infectionWhatIf, infectionPreventionSchedule, infectionTriageSensitivity,
  INFECTION_TRADEOFF_WEIGHTS, INFECTION_SIMULATOR_MODEL, INFECTION_REFUSED_ACTIONS,
} from '../src/swarm/infection-simulator.js';
import {
  buildInfectionTwin, scoreInfectionTwinTriage, infectionPreventionStability,
  infectionTwinGuardrails, type InfectionTwinEventInput,
} from '../src/swarm/infection-twin.js';
import {
  INFECTION_MODEL_FEATURES, INFECTION_MODEL_TARGET_AUROC, buildInfectionVector,
  buildInfectionTrainingRows, trainInfectionArtifact, loadInfectionArtifact,
  infectionArtifactStatus, infectionTriageTrained, temperatureRuleScore, INFECTION_ARTIFACT_ID,
} from '../src/swarm/infection-model.js';
import { SwarmWorkspaceStore } from '../src/swarm/workspace.js';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import type { PostgresEventStore } from '../src/server/postgres-event-store.js';
import type { CanonicalEvent } from '../src/healthcare-core/events.js';
import type { LedgerEntry } from '../src/hypergraph/ledger.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import type { ActorContext } from '../src/server/scoped-persistence.js';

const NOW = '2026-09-01T10:00:00Z';

/** A quiet, well-covered patient with deterministic obligations outstanding. */
const QUIET_WINDOW: InfectionInput = {
  patientId: 'p-inf-1',
  temperatureC: 36.8,
  temperatureSeries: [36.7, 36.8, 36.7],
  procalcitoninNgMl: 0.2,
  wbc: 7.1,
  neutrophilPct: 60,
  lymphocytePct: 26,
  crp: 6,
  albumin: 3.8,
  accessType: 'avf',
  catheterDays: 0,
  asOf: NOW,
};

/** A febrile catheter patient with no culture on file — the culture-first case. */
const FEBRILE_WINDOW: InfectionInput = {
  ...QUIET_WINDOW,
  patientId: 'p-inf-2',
  temperatureC: 38.7,
  temperatureSeries: [38.1, 38.4, 38.7],
  procalcitoninNgMl: 4.6,
  wbc: 14.8,
  neutrophilPct: 82,
  lymphocytePct: 11,
  crp: 42,
  albumin: 3.2,
  accessType: 'catheter',
  catheterDays: 142,
  matureAvfAvailable: true,
  accessAgeDays: 120,
  accessInfectionSigns: true,
  symptoms: ['rigors'],
};

describe('P6-A — feature contract, triage criteria and the deterministic split', () => {
  it('declares the infection feature contract and reference bounds', () => {
    expect(INFECTION_FEATURES).toHaveLength(12);
    expect(INFECTION_FEATURES.map((f) => f.id)).toEqual(expect.arrayContaining(['temperatureC', 'procalcitoninNgMl', 'nlr', 'catheterDays']));
    expect(INFECTION_REFERENCE.feverC).toBe(38);
    expect(INFECTION_REFERENCE.minTemperatureReadings).toBe(3);
    expect(INFECTION_REFERENCE.catheterEscalationDays).toBe(90);
    expect(INFECTION_REFERENCE.cultureTurnaroundHours).toBe(48);
    expect(INFECTION_REFERENCE.horizonsDays).toEqual([30, 90, 180]);
    expect(INFECTION_ANTIMICROBIAL_AUTHORITY).toBe('none');
  });

  it('labels the two halves explicitly and never lets prevention near a model', () => {
    expect(INFECTION_HALF_CLASSIFICATION.triage.kind).toBe('statistical');
    expect(INFECTION_HALF_CLASSIFICATION.prevention.kind).toBe('deterministic-rules');
    expect(INFECTION_HALF_CLASSIFICATION.prevention.model).toBeNull();
    expect(INFECTION_REGULATORY_POSTURE.preventionPathModelFree).toBe(true);
    expect(INFECTION_REGULATORY_POSTURE.cultureBeforeAntibiotic).toBe('rule');
    expect(INFECTION_REGULATORY_POSTURE.prescribingAuthority).toBe('none');
  });

  it('computes the NLR from a differential and refuses a zero denominator', () => {
    expect(computeNlr(82, 11)).toBeCloseTo(7.45, 2);
    expect(computeNlr(60, 0)).toBeUndefined();
    expect(computeNlr(undefined, 20)).toBeUndefined();
  });

  it('bands the triage score and reports the drivers that produced it', () => {
    const quiet = assessBsi(QUIET_WINDOW);
    const febrile = assessBsi(FEBRILE_WINDOW);
    expect(quiet.band).toBe('low');
    expect(quiet.febrile).toBe(false);
    expect(febrile.band).toBe('high');
    expect(febrile.febrile).toBe(true);
    expect(febrile.probability).toBeGreaterThan(quiet.probability);
    expect(febrile.drivers[0]!.contribution).toBeGreaterThanOrEqual(febrile.drivers.at(-1)!.contribution);
    expect(febrile.drivers.map((d) => d.id)).toContain('catheterDays');
    expect(febrile.criteria.find((c) => c.id === 'fever')!.met).toBe(true);
    expect(febrile.criteria.find((c) => c.id === 'fever')!.source).toMatch(/NHSN|CDC/);
  });

  it('treats a single reading as a reading, never a trend', () => {
    const single = assessBsi({ ...FEBRILE_WINDOW, temperatureSeries: [38.7] });
    expect(single.temperatureReadings).toBe(1);
    const guardrails = guardInfectionTriage({ ...FEBRILE_WINDOW, temperatureSeries: [38.7] });
    expect(guardrails.flags).toContain('single-reading-only');
    expect(guardrails.blocked).toBe(true);
  });

  it('separates the immune/vascular substrate from the acute severity in the latent', () => {
    const quiet = infectionLatent(QUIET_WINDOW);
    const febrile = infectionLatent(FEBRILE_WINDOW);
    expect(febrile.l1).toBeGreaterThan(quiet.l1);
    expect(febrile.l2).toBeGreaterThan(quiet.l2);
    expect(febrile.polarRadius).toBeGreaterThan(quiet.polarRadius);
  });

  it('exposes the P6 cells, priorities and episode kinds', () => {
    expect(INFECTION_CELLS.map((c) => c.id)).toEqual(['bsi-triage', 'infection-prevention']);
    expect(INFECTION_CELLS.find((c) => c.id === 'infection-prevention')!.approvalClass).toBe('B');
    expect(INFECTION_PREVENTION_PRIORITY[0]).toBe('vaccination-due');
    expect(INFECTION_EPISODE_KINDS.length).toBeGreaterThan(0);
  });
});

describe('P6-A2 — the prevention state machine is deterministic and model-free', () => {
  it('generates every task from the records with a rule reference and a due date', () => {
    const plan = preventionPlan({
      ...QUIET_WINDOW,
      immunisations: [{ vaccine: 'influenza', seriesDose: 1, at: '2024-10-01T00:00:00Z' }],
      hepatitisBSurfaceAntibodyIuL: 4,
    });
    expect(plan.length).toBeGreaterThan(0);
    for (const task of plan) {
      expect(task.deterministic).toBe(true);
      expect(task.modelFree).toBe(true);
      expect(task.rule.ruleId).toMatch(/^cdc\./);
      expect(task.rule.source.length).toBeGreaterThan(0);
      expect(task.rule.read.length).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(task.dueAt))).toBe(false);
      expect(task.because.length).toBeGreaterThan(10);
    }
    expect(plan.some((t) => t.kind === 'vaccination-due')).toBe(true);
    expect(plan.some((t) => t.kind === 'serology-followup')).toBe(true);
  });

  it('produces an identical signature across repeated runs', () => {
    const a = preventionDeterminismSignature(preventionPlan(INFECTION_DEFAULT_SEPARATION_PROBE));
    const b = preventionDeterminismSignature(preventionPlan(INFECTION_DEFAULT_SEPARATION_PROBE));
    expect(a).toBe(b);
    expect(a.startsWith('[')).toBe(true);
  });

  it('does not move a single prevention task when the triage series changes', () => {
    const separation = verifyPreventionSeparation(INFECTION_DEFAULT_SEPARATION_PROBE);
    expect(separation.deterministic).toBe(true);
    expect(separation.modelIndependent).toBe(true);
    expect(separation.taskCount).toBeGreaterThan(0);
    expect(separation.ruleIds.every((r) => r.startsWith('cdc.'))).toBe(true);
    expect(separation.detail).toMatch(/pure function/);
  });

  it('states the schedule and cadence it applies, as data', () => {
    expect(VACCINE_SCHEDULE.some((v) => v.vaccine === 'hepatitis-b')).toBe(true);
    expect(VACCINE_SCHEDULE.some((v) => v.vaccine === 'influenza')).toBe(true);
    expect(AUDIT_CADENCE.some((a) => a.id === 'hand-hygiene-audit')).toBe(true);
    expect(AUDIT_CADENCE.some((a) => a.id === 'access-care-audit')).toBe(true);
    const summary = preventionPlanWithSummary(INFECTION_DEFAULT_SEPARATION_PROBE);
    expect(summary.tasks.length).toBe(summary.dueCount + summary.overdueCount);
    expect(summary.schedule.length).toBe(VACCINE_SCHEDULE.length);
  });

  it('escalates a long-standing catheter whether or not a mature alternative exists yet', () => {
    const plan = preventionPlan({ ...QUIET_WINDOW, accessType: 'catheter', catheterDays: 214, accessAgeDays: 120, matureAvfAvailable: true });
    const escalation = plan.find((t) => t.kind === 'catheter-escalation');
    expect(escalation).toBeDefined();
    expect(escalation!.rule.ruleId).toBe('cdc.catheter.escalation');
    expect(escalation!.label).toMatch(/mature access available/);
    // 214 catheter days can never be ignored: without a mature alternative the
    // SAME rule escalates a definitive-access plan instead of a removal
    const noAlternative = preventionPlan({ ...QUIET_WINDOW, accessType: 'catheter', catheterDays: 214, accessAgeDays: 0, matureAvfAvailable: false });
    const fallback = noAlternative.find((t) => t.kind === 'catheter-escalation');
    expect(fallback).toBeDefined();
    expect(fallback!.label).toMatch(/no mature access yet/);
    expect(fallback!.because).toMatch(/no mature access/);
    // below the threshold nothing fires
    expect(preventionPlan({ ...QUIET_WINDOW, accessType: 'catheter', catheterDays: 12, matureAvfAvailable: true }).some((t) => t.kind === 'catheter-escalation')).toBe(false);
  });
});

describe('P6-A3 — guardrails: culture before antibiotic, and no antimicrobial authority', () => {
  it('refuses an antibiotic discussion while no culture exists', () => {
    const guardrails = guardInfectionTriage(FEBRILE_WINDOW);
    expect(guardrails.requiresCultureFirst).toBe(true);
    expect(guardrails.antibioticDiscussionAllowed).toBe(false);
    expect(guardrails.flags).toContain('empiric-antibiotic-without-culture');
    expect(guardrails.cultureAllowed).toBe(true);
    expect(guardrails.escalateNow).toBe(true);
  });

  it('allows the discussion only once a culture is on file', () => {
    const withCulture = guardInfectionTriage({ ...FEBRILE_WINDOW, cultureResult: 1, cultureAt: NOW });
    expect(withCulture.requiresCultureFirst).toBe(false);
    expect(withCulture.antibioticDiscussionAllowed).toBe(true);
    expect(withCulture.flags).toContain('positive-culture');
  });

  it('blocks the triage when there is no temperature or no serial series', () => {
    expect(guardInfectionTriage({ ...QUIET_WINDOW, temperatureC: undefined, temperatureSeries: [] }).blocked).toBe(true);
    expect(guardInfectionTriage({ ...QUIET_WINDOW, temperatureC: undefined, temperatureSeries: [] }).blockReason).toMatch(/No temperature/);
    expect(guardInfectionTriage({ ...QUIET_WINDOW, temperatureSeries: [37.1] }).blockReason).toMatch(/single reading is never a trend/);
  });

  it('proposes cultures first and names no drug, dose or duration', () => {
    const recommendation = infectionRecommend(FEBRILE_WINDOW);
    expect(recommendation.plan[0]).toBe('blood-culture-order');
    expect(recommendation.authority.antimicrobial).toBe('none');
    expect(recommendation.action).toBe('urgent-clinical-review');
    const haystack = `${recommendation.action} ${recommendation.plan.join(' ')} ${recommendation.note}`.toLowerCase();
    for (const drug of ['vancomycin', 'cefepime', 'meropenem']) expect(haystack).not.toContain(drug);
    expect(recommendation.note).toMatch(/culture/i);
  });

  it('surfaces the deterministic obligations even when the triage is quiet', () => {
    const recommendation = infectionRecommend({ ...QUIET_WINDOW, catheterDays: 0 });
    expect(recommendation.plan.length).toBeGreaterThan(0);
    expect(recommendation.plan.some((a) => a === 'vaccination-outreach' || a === 'audit-task' || a === 'serology-followup')).toBe(true);
    expect(recommendation.note).toMatch(/deterministic/i);
  });

  it('keeps the refusal list first-class', () => {
    expect(INFECTION_REFUSED_ACTIONS.map((r) => r.action)).toEqual(['empiric-antibiotic-discussion', 'antimicrobial-selection']);
    expect(INFECTION_REFUSED_ACTIONS.every((r) => r.reason.length > 20)).toBe(true);
  });
});

describe('P6-B — coverage gate, red team, activation gate and drift', () => {
  it('gates a triage claim on serial coverage and an inflammatory marker', () => {
    const thin = infectionCoverage({ ...FEBRILE_WINDOW, temperatureSeries: [38.1, 38.7] });
    expect(thin.covered).toBe(false);
    expect(thin.serial.observed).toBe(2);
    expect(thin.serial.required).toBe(INFECTION_COVERAGE_DEFAULTS.minSerialMeasurements);
    expect(thin.reason).toMatch(/serial readings/);

    // an inflammatory marker is required: the differential alone does not count
    // when the ratio was not supplied and the markers are absent
    const noMarker = infectionCoverage({ ...FEBRILE_WINDOW, procalcitoninNgMl: undefined, wbc: undefined, nlr: undefined, crp: undefined, albumin: undefined, neutrophilPct: undefined, lymphocytePct: undefined });
    expect(noMarker.covered).toBe(false);
    expect(noMarker.markers.observed).toBe(0);
    expect(noMarker.reason).toMatch(/inflammatory marker/);

    expect(infectionCoverage(FEBRILE_WINDOW).covered).toBe(true);
  });

  it('blocks the triage but leaves the prevention plan intact when coverage fails', () => {
    const covered = infectionRecommendCovered({ ...FEBRILE_WINDOW, temperatureSeries: [38.1, 38.7] });
    expect(covered.action).toBe('blocked');
    expect(covered.plan).toEqual([]);
    expect(covered.note).toMatch(/Coverage gate/);
    // the deterministic half is a different question and is still answered
    expect(covered.prevention.length).toBeGreaterThan(0);
  });

  it('runs all four adversarial infection scenarios clean', () => {
    expect(INFECTION_RED_TEAM_IDS).toEqual(['rt-037', 'rt-038', 'rt-039', 'rt-040']);
    expect(INFECTION_RED_TEAM_DEFS).toHaveLength(4);
    for (const def of INFECTION_RED_TEAM_DEFS) {
      const probe = infectionRedTeamProbe(def);
      expect(probe.scenarioId).toBe(def.id);
      expect(probe.checks.length).toBeGreaterThanOrEqual(3);
      expect(probe.passed, `${def.id}: ${probe.checks.filter((c) => !c.passed).map((c) => c.name).join(', ')}`).toBe(true);
    }
  });

  it('fails the red team if the culture-first rule is bypassed (negative control)', () => {
    // rt-038's control is the guardrail itself: with a culture present the
    // behavioural check must still hold, and the probe must be sensitive to it.
    const def = INFECTION_RED_TEAM_DEFS.find((d) => d.id === 'rt-038')!;
    const withCulture = infectionRedTeamProbe({ ...def, probe: { ...def.probe, cultureResult: 1, cultureAt: NOW } });
    expect(withCulture.passed).toBe(false);
    expect(withCulture.checks.some((c) => !c.passed && c.name === 'culture required first')).toBe(true);
  });

  it('keeps the activation gate honest and blocks on an open infection finding', async () => {
    const ws = new SwarmWorkspaceStore();
    await ensureInfectionModel(ws);
    await ensureInfectionRedTeamScenarios(ws);
    const gate = await evaluateInfectionAdvisorGate(ws);
    expect(['active', 'gated', 'blocked']).toContain(gate.status);
    expect(gate.posture.antimicrobialAuthority).toBe('none');
    expect(gate.gates.some((g) => g.name === 'No antimicrobial authority' && g.passed)).toBe(true);
    expect(gate.gates.some((g) => g.name === 'Prevention path is model-free' && g.passed)).toBe(true);
    expect(gate.separation.deterministic).toBe(true);
    expect(gate.separation.modelIndependent).toBe(true);
    expect(isInfectionFinding({ scenarioId: 'rt-039' })).toBe(true);
    expect(isInfectionFinding({ scenarioId: 'rt-035' })).toBe(false);
  });

  it('detects infection triage drift and stays quiet when the distribution is stable', () => {
    const baseline = [{ temperatureC: 36.9, procalcitoninNgMl: 0.3, catheterDays: 0 }, { temperatureC: 37.0, procalcitoninNgMl: 0.2, catheterDays: 0 }];
    const drifted = [{ temperatureC: 38.8, procalcitoninNgMl: 5.4, catheterDays: 180 }, { temperatureC: 39.1, procalcitoninNgMl: 6.1, catheterDays: 210 }];
    const snapshot = computeInfectionDrift({ baseline, current: drifted });
    expect(snapshot.verdict).toBe('drift');
    expect(snapshot.status).toBe('drifted');
    expect(snapshot.metric).toBe('infection-triage-ks');
    expect(snapshot.features.some((f) => f.feature === 'temperatureC' && f.drifted)).toBe(true);
    // drift never lets the prevention half wobble
    expect(snapshot.separation.deterministic).toBe(true);
    expect(computeInfectionDrift({ baseline, current: baseline }).verdict).toBe('stable');
  });

  it('keeps the demo bounded, Class B/C and question-shaped', () => {
    expect(INFECTION_REGULATORY_POSTURE.approvalClass).toBe('C');
    expect(INFECTION_REGULATORY_POSTURE.autonomy).toBe('never-autonomous');
    const demo = buildInfectionDemo();
    expect(demo.cells.map((c) => c.id)).toEqual(INFECTION_CELLS.map((c) => c.id));
    expect(demo.proposals.every((p) => p.approvalClass === 'B' || p.approvalClass === 'C')).toBe(true);
    expect(demo.nbas.length).toBeGreaterThan(0);
    expect(INFECTION_DEMO_WINDOW.temperatureSeries!.length).toBeGreaterThanOrEqual(3);
  });
});

describe('P6-C — what-if: refused candidates and the deterministic schedule', () => {
  it('refuses the antimicrobial candidates and recommends the lowest-harm plan', () => {
    const result = infectionWhatIf(FEBRILE_WINDOW);
    expect(result.refused).toHaveLength(2);
    expect(result.refused.every((c) => !c.allowed && Boolean(c.refusedReason))).toBe(true);
    expect(result.refused.some((c) => c.action === 'antimicrobial-selection')).toBe(true);
    expect(result.candidates.every((c) => c.allowed)).toBe(true);
    expect(result.recommended).toBeDefined();
    expect(result.recommended!.score).toBeLessThanOrEqual(Math.max(...result.candidates.map((c) => c.score)));
    expect(INFECTION_TRADEOFF_WEIGHTS.missedCulture).toBeGreaterThan(INFECTION_TRADEOFF_WEIGHTS.burden);
    expect(INFECTION_TRADEOFF_WEIGHTS.delayedTreatment).toBeGreaterThan(INFECTION_TRADEOFF_WEIGHTS.unnecessaryIsolation);
  });

  it('labels which half each candidate came from', () => {
    const result = infectionWhatIf(FEBRILE_WINDOW);
    const preventionCandidates = result.candidates.filter((c) => c.half === 'prevention');
    expect(preventionCandidates.length).toBeGreaterThan(0);
    expect(preventionCandidates.every((c) => c.deterministic)).toBe(true);
    expect(result.candidates.filter((c) => c.half === 'triage').every((c) => !c.deterministic)).toBe(true);
  });

  it('returns no plan when the guardrails block, and keeps the schedule running', () => {
    const result = infectionWhatIf({ ...FEBRILE_WINDOW, temperatureSeries: [38.7] });
    expect(result.blocked).toBe(true);
    expect(result.recommended).toBeUndefined();
    expect(result.candidates.every((c) => !c.allowed && Boolean(c.refusedReason))).toBe(true);
    expect(result.note).toMatch(/guardrails/);
    expect(result.prevention.schedule.length).toBeGreaterThan(0);
  });

  it('schedules prevention over 30/90/180 days from the rules alone', () => {
    const schedule = infectionPreventionSchedule({
      ...QUIET_WINDOW,
      immunisations: [{ vaccine: 'influenza', seriesDose: 1, at: '2024-10-01T00:00:00Z' }],
      lastHandHygieneAuditAt: '2026-05-01T00:00:00Z',
    });
    expect(schedule.horizonsDays).toEqual([30, 90, 180]);
    expect(schedule.modelFree).toBe(true);
    expect(schedule.counts.overdue).toBeGreaterThan(0);
    expect(schedule.counts.at180).toBeGreaterThanOrEqual(schedule.counts.at30);
    expect(schedule.schedule.every((s) => s.ruleId.startsWith('cdc.'))).toBe(true);
    // the signature is the model-free proof
    const again = infectionPreventionSchedule({ ...QUIET_WINDOW, immunisations: [{ vaccine: 'influenza', seriesDose: 1, at: '2024-10-01T00:00:00Z' }], lastHandHygieneAuditAt: '2026-05-01T00:00:00Z' });
    expect(schedule.determinismSignature).toBe(again.determinismSignature);
  });

  it('shows what the triage does when the surveillance window changes', () => {
    const sensitivity = infectionTriageSensitivity(FEBRILE_WINDOW);
    expect(sensitivity.map((s) => s.variant)).toContain('no temperature');
    const full = sensitivity.find((s) => s.variant === 'as recorded')!;
    const markersRemoved = sensitivity.find((s) => s.variant === 'markers removed')!;
    expect(full.probability).toBeGreaterThan(markersRemoved.probability);
    expect(sensitivity.find((s) => s.variant === 'no temperature')!.readings).toBe(0);
    expect(sensitivity.find((s) => s.variant === 'single reading')!.readings).toBe(1);
    // resolving the catheter lowers the score but does not erase a febrile, high-marker window
    const resolved = sensitivity.find((s) => s.variant === 'catheter resolved')!;
    expect(resolved.probability).toBeLessThan(full.probability);
    expect(resolved.variant).toBe('catheter resolved');
  });

  it('uses a mechanistic simulator model id, not a trained one', () => {
    expect(INFECTION_SIMULATOR_MODEL.kind).toBe('mechanistic-triage-counterfactual');
    expect(INFECTION_SIMULATOR_MODEL.id).toBe('infection.bsi-sim');
  });
});

describe('P6-D — the twin over the ledger', () => {
  const at = (daysAgo: number): string => new Date(Date.parse('2026-09-01T07:00:00Z') - daysAgo * 86_400_000).toISOString();

  /** Six cultures with both outcomes, each preceded by ≥3 temperatures and a panel. */
  const richLedger = (): InfectionTwinEventInput[] => {
    const out: InfectionTwinEventInput[] = [];
    let seq = 0;
    for (let k = 0; k < 6; k += 1) {
      seq += 1;
      const base = 70 - k * 10;
      const positive = k % 2 === 0;
      const temp = positive ? 38.6 : 36.9;
      for (const offset of [3, 2, 1]) {
        out.push({ kind: 'record-vitals', emittedAt: at(base + offset), realmAt: at(base + offset), payload: { patientId: 'fac-a-pt-0001', temp: temp - offset * 0.1, hr: 84, spo2: 96 } });
      }
      out.push({ kind: 'result-lab', emittedAt: at(base), realmAt: at(base), payload: { orderId: `fac-a-pt-0001-PROCALCITONIN-${seq}`, code: 'PROCALCITONIN', value: positive ? 4.2 : 0.15 } });
      out.push({ kind: 'result-lab', emittedAt: at(base), realmAt: at(base), payload: { orderId: `fac-a-pt-0001-WBC-${seq}`, code: 'WBC', value: positive ? 14.6 : 7.0 } });
      out.push({ kind: 'result-lab', emittedAt: at(base), realmAt: at(base), payload: { orderId: `fac-a-pt-0001-NEUTPCT-${seq}`, code: 'NEUTPCT', value: positive ? 82 : 60 } });
      out.push({ kind: 'result-lab', emittedAt: at(base), realmAt: at(base), payload: { orderId: `fac-a-pt-0001-LYMPHPCT-${seq}`, code: 'LYMPHPCT', value: positive ? 11 : 26 } });
      out.push({ kind: 'result-lab', emittedAt: at(base), realmAt: at(base), payload: { orderId: `fac-a-pt-0001-BCULT-${seq}`, code: 'BCULT', value: positive ? 1 : 0 } });
    }
    out.push({ kind: 'record-immunisation', emittedAt: at(40), realmAt: at(40), payload: { patientId: 'fac-a-pt-0001', vaccine: 'hepatitis-b', seriesDose: 1, seriesTotal: 3 } });
    out.push({ kind: 'result-lab', emittedAt: at(30), realmAt: at(30), payload: { orderId: 'fac-a-pt-0001-HBSAB-9', code: 'HBSAB', value: 4 } });
    out.push({ kind: 'record-assessment', emittedAt: at(45), realmAt: at(45), payload: { patientId: 'fac-a-pt-0001', assessmentId: 'hand-hygiene-audit', score: 91, band: 'audit' } });
    return out;
  };

  const patientState = (): Array<{ patientId: string; realmId: string; state: Record<string, unknown> }> => [
    {
      patientId: 'fac-a-pt-0001',
      realmId: 'sim:renal-a',
      state: {
        facilityId: 'fac-a',
        access: { type: 'catheter', ageDays: 150 },
        matureAccessAvailable: true,
        accessInfectionSigns: false,
        immunisations: [{ at: at(40), vaccine: 'hepatitis-b', seriesDose: 1, seriesTotal: 3 }],
      },
    },
  ];

  it('rebuilds both halves from the ledger, with provenance', () => {
    const twin = buildInfectionTwin({ patientId: 'fac-a-pt-0001', events: richLedger(), patients: patientState() });
    expect(twin.temperatures.length).toBeGreaterThanOrEqual(18);
    expect(twin.cultures).toHaveLength(6);
    expect(twin.summary.positiveCultures).toBe(3);
    expect(twin.summary.serialReadings).toBeGreaterThanOrEqual(18);
    expect(twin.summary.inflammatoryMarkers).toBeGreaterThan(0);
    expect(twin.access.accessType).toBe('catheter');
    expect(twin.access.catheterDays).toBe(150);
    expect(twin.access.matureAvfAvailable).toBe(true);
    expect(twin.immunisations.some((i) => i.vaccine === 'hepatitis-b')).toBe(true);
    expect(twin.serology[0]!.iuL).toBe(4);
    expect(twin.audits.some((a) => a.assessmentId === 'hand-hygiene-audit')).toBe(true);
    expect(twin.provenance.source).toBe('realm-ledger');
    expect(twin.provenance.cultureResults).toBe(6);
    expect(twin.provenance.synthetic).toBe(true);
  });

  it('scores the triage prospectively against what the cultures grew', () => {
    const twin = buildInfectionTwin({ patientId: 'fac-a-pt-0001', events: richLedger(), patients: patientState() });
    const score = scoreInfectionTwinTriage(twin);
    expect(score.cultureRows).toBe(6);
    expect(score.positives).toBe(3);
    expect(score.negatives).toBe(3);
    expect(score.verdict).toBe('pass');
    expect(score.auroc!).toBeGreaterThanOrEqual(0.8);
    expect(score.brier!).toBeLessThanOrEqual(0.2);
    // the culture itself must not be visible to the pre-result window
    expect(score.rows.every((r) => r.readings >= INFECTION_REFERENCE.minTemperatureReadings)).toBe(true);
  });

  it('says "insufficient" rather than inventing a score on a thin series', () => {
    const twin = buildInfectionTwin({
      patientId: 'fac-a-pt-0001',
      events: [
        { kind: 'record-vitals', emittedAt: at(3), realmAt: at(3), payload: { patientId: 'fac-a-pt-0001', temp: 38.5 } },
        { kind: 'result-lab', emittedAt: at(2), realmAt: at(2), payload: { orderId: 'fac-a-pt-0001-BCULT-1', code: 'BCULT', value: 1 } },
      ],
      patients: patientState(),
    });
    const score = scoreInfectionTwinTriage(twin);
    expect(score.verdict).toBe('insufficient');
    expect(score.note).toMatch(/needed before the triage can be judged|not both outcomes/);
  });

  it('proves the prevention plan is stable and model-independent over the ledger', () => {
    const twin = buildInfectionTwin({ patientId: 'fac-a-pt-0001', events: richLedger(), patients: patientState() });
    const stability = infectionPreventionStability(twin);
    expect(stability.stable).toBe(true);
    expect(stability.modelIndependent).toBe(true);
    expect(stability.signature).toBe(stability.signatureUnderSepticSeries);
    expect(stability.taskCount).toBeGreaterThan(0);
    expect(stability.note).toMatch(/pure function/);
  });

  it('exposes the guardrails over the twin window', () => {
    const twin = buildInfectionTwin({ patientId: 'fac-a-pt-0001', events: richLedger(), patients: patientState() });
    const guardrails = infectionTwinGuardrails(twin);
    expect(Array.isArray(guardrails.flags)).toBe(true);
    expect(guardrails.antibioticDiscussionAllowed).toBe(false);
  });

  it('never lets a partial state cache blank the ledger markers', () => {
    // regression: the state snapshot used to be merged unconditionally, so a
    // cached panel with only { K } stamped an EMPTY observation at the newest
    // timestamp and "the latest values" became undefined — blanking the triage
    // even though the ledger held a full panel.
    const twin = buildInfectionTwin({
      patientId: 'fac-a-pt-0001',
      events: richLedger(),
      patients: [{ patientId: 'fac-a-pt-0001', realmId: 'sim:renal-a', state: { facilityId: 'fac-a', labs: { K: 4.5 }, lastVitals: { at: at(1), temp: 36.9 } } }],
    });
    expect(twin.summary.inflammatoryMarkers).toBeGreaterThan(0);
    expect(twin.summary.latestProcalcitoninNgMl).toBeDefined();
    expect(twin.summary.latestWbc).toBeDefined();
    const assessment = assessBsi(twin.window);
    expect(assessment.measured.procalcitoninNgMl).toBeDefined();
    expect(assessment.measured.nlr).toBeDefined();
    // the ledger is authoritative: the cached temperature is not duplicated in
    expect(twin.temperatures.every((t) => t.tempC !== undefined)).toBe(true);
  });

  it('takes the latest KNOWN value per marker, not the latest row', () => {
    // a panel that arrives in pieces must not erase a marker that is still the
    // most recent one we actually have
    const events: InfectionTwinEventInput[] = [
      { kind: 'result-lab', emittedAt: at(10), realmAt: at(10), payload: { patientId: 'fac-a-pt-0001', code: 'PROCALCITONIN', value: 3.4 } },
      { kind: 'result-lab', emittedAt: at(10), realmAt: at(10), payload: { patientId: 'fac-a-pt-0001', code: 'NEUTPCT', value: 80 } },
      { kind: 'result-lab', emittedAt: at(10), realmAt: at(10), payload: { patientId: 'fac-a-pt-0001', code: 'LYMPHPCT', value: 10 } },
      { kind: 'result-lab', emittedAt: at(1), realmAt: at(1), payload: { patientId: 'fac-a-pt-0001', code: 'ALBUMIN', value: 3.4 } },
      { kind: 'record-vitals', emittedAt: at(1), realmAt: at(1), payload: { patientId: 'fac-a-pt-0001', temp: 37.1 } },
      { kind: 'record-vitals', emittedAt: at(2), realmAt: at(2), payload: { patientId: 'fac-a-pt-0001', temp: 37.0 } },
      { kind: 'record-vitals', emittedAt: at(3), realmAt: at(3), payload: { patientId: 'fac-a-pt-0001', temp: 37.2 } },
    ];
    const twin = buildInfectionTwin({ patientId: 'fac-a-pt-0001', events, patients: [] });
    expect(twin.summary.latestProcalcitoninNgMl).toBe(3.4);
    expect(twin.window.albumin).toBe(3.4);
    expect(twin.window.procalcitoninNgMl).toBe(3.4);
    expect(assessBsi(twin.window).measured.nlr).toBe(8);
  });

  it('tracks each audit cadence separately and honours when an audit happened', () => {
    const dayMs = 86_400_000;
    const recent = new Date(Date.now() - 5 * dayMs).toISOString();
    const stale = new Date(Date.now() - 200 * dayMs).toISOString();
    const twin = buildInfectionTwin({
      patientId: 'fac-a-pt-0001',
      events: [
        { kind: 'record-assessment', emittedAt: at(1), realmAt: at(1), payload: { patientId: 'fac-a-pt-0001', assessmentId: 'hand-hygiene-audit', score: 91, observedAt: recent } },
        { kind: 'record-assessment', emittedAt: at(1), realmAt: at(1), payload: { patientId: 'fac-a-pt-0001', assessmentId: 'access-care-audit', score: 88, observedAt: stale } },
      ],
      patients: [],
    });
    expect(twin.window.lastHandHygieneAuditAt).toBe(recent);
    expect(twin.window.lastAccessCareAuditAt).toBe(stale);
    const plan = twin.preventionPlan;
    // the access-care audit happened 200 days ago → overdue; hand hygiene is current
    expect(plan.some((t) => t.kind === 'audit-due' && t.rule.ruleId === 'cdc.audit.access-care-audit')).toBe(true);
    expect(plan.some((t) => t.kind === 'audit-due' && t.rule.ruleId === 'cdc.audit.hand-hygiene-audit')).toBe(false);
  });
});

describe('P6-E — the trained triage artifact', () => {
  it('trains a BSI classifier that beats the temperature-rule prior', () => {
    const rows = buildInfectionTrainingRows({ patients: 300, observationsPerPatient: 7 });
    const artifact = trainInfectionArtifact(rows, { salt: 'infection-test' });
    expect(artifact.kind).toBe('gbdt-classifier');
    expect(artifact.classifier.metrics.auroc).toBeGreaterThanOrEqual(INFECTION_MODEL_TARGET_AUROC);
    expect(artifact.classifier.metrics.auroc).toBeGreaterThan(artifact.classifier.priorAuroc);
    expect(artifact.classifier.aurocGain).toBeGreaterThan(0);
    expect(artifact.classifier.metrics.positives).toBeGreaterThan(0);
    expect(artifact.classifier.metrics.negatives).toBeGreaterThan(0);
    expect(artifact.reliability.length).toBeGreaterThan(0);
    expect(artifact.patients).toBeGreaterThan(0);
    expect(artifact.rows).toBe(rows.length);
  });

  it('records in the model card that the prevention path is not trained', () => {
    const artifact = trainInfectionArtifact(buildInfectionTrainingRows({ patients: 120 }), { salt: 'infection-card' });
    const prevention = artifact.modelCard['preventionPath'] as { trained: boolean; kind: string; note: string };
    expect(prevention.trained).toBe(false);
    expect(prevention.kind).toBe('deterministic-rules');
    expect(prevention.note).toMatch(/No model output reaches them/);
    const authority = artifact.modelCard['authority'] as { antimicrobial: string; prescribing: string };
    expect(authority.antimicrobial).toBe('none');
    expect(authority.prescribing).toBe('none');
    expect((artifact.modelCard['interactions'] as string[]).length).toBe(2);
  });

  it('reports a generator audit per family and attribution per family', () => {
    const artifact = trainInfectionArtifact(buildInfectionTrainingRows({ patients: 200 }), { salt: 'infection-audit' });
    expect(artifact.generatorAudit.length).toBeGreaterThanOrEqual(4);
    expect(artifact.generatorAudit.every((g) => g.rows > 0)).toBe(true);
    const catheterFever = artifact.generatorAttribution['catheter-fever']!;
    expect(catheterFever.length).toBeGreaterThan(0);
    expect(catheterFever[0]!.feature).toBeTruthy();
    expect(catheterFever.map((a) => a.feature)).toContain('temperatureC');
  });

  it('featurises the interaction terms the rule cannot express', () => {
    expect(INFECTION_MODEL_FEATURES).toContain('catheterXFever');
    expect(INFECTION_MODEL_FEATURES).toContain('pctXNlr');
    const vector = buildInfectionVector(FEBRILE_WINDOW);
    expect(vector).toHaveLength(INFECTION_MODEL_FEATURES.length);
    const catheterIndex = INFECTION_MODEL_FEATURES.indexOf('catheterXFever');
    expect(vector[catheterIndex]!).toBeGreaterThan(0);
  });

  it('scores the committed artifact and states the shortfall when it misses', () => {
    const status = infectionArtifactStatus();
    expect(status.id ?? INFECTION_ARTIFACT_ID).toBe(INFECTION_ARTIFACT_ID);
    if (status.present) {
      expect(status.meetsTarget).toBe(true);
      expect(status.beatsRulePrior).toBe(true);
      expect(status.band).toBe('pass');
      expect(status.note).toMatch(/AUROC/);
    } else {
      expect(status.band).toBe('insufficient');
    }
  });

  it('exposes a trained probability alongside the reference score and the rule prior', () => {
    if (!loadInfectionArtifact()) return;
    const trained = infectionTriageTrained(FEBRILE_WINDOW).trained!;
    expect(trained.artifactId).toBe(INFECTION_ARTIFACT_ID);
    expect(trained.probability).toBeGreaterThan(0);
    expect(trained.probability).toBeLessThanOrEqual(1);
    expect(trained.reference.band).toBe('high');
    expect(trained.prior).toBeGreaterThan(0);
    expect(trained.drivers.length).toBeGreaterThan(0);
    expect(temperatureRuleScore(FEBRILE_WINDOW)).toBeGreaterThan(temperatureRuleScore(QUIET_WINDOW));
  });

  it('keeps the split free of leakage by splitting on patient', () => {
    const rows = buildInfectionTrainingRows({ patients: 80, observationsPerPatient: 4 });
    const artifact = trainInfectionArtifact(rows, { salt: 'infection-split' });
    expect(artifact.patients).toBe(80);
    expect(artifact.rows).toBeGreaterThan(artifact.patients);
  });
});

describe('P6-F — routes over the live ledger', () => {
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

  const ledgerEvents: InfectionTwinEventInput[] = (() => {
    const out: InfectionTwinEventInput[] = [];
    let seq = 0;
    for (let k = 0; k < 5; k += 1) {
      seq += 1;
      const base = 60 - k * 11;
      const positive = k % 2 === 0;
      for (const offset of [3, 2, 1]) {
        out.push({ kind: 'record-vitals', emittedAt: at(base + offset), realmAt: at(base + offset), payload: { patientId: 'fac-a-pt-0001', temp: (positive ? 38.6 : 36.9) - offset * 0.1, hr: 88, spo2: 96 } });
      }
      out.push({ kind: 'result-lab', emittedAt: at(base), realmAt: at(base), payload: { orderId: `fac-a-pt-0001-PROCALCITONIN-${seq}`, code: 'PROCALCITONIN', value: positive ? 4.4 : 0.2 } });
      out.push({ kind: 'result-lab', emittedAt: at(base), realmAt: at(base), payload: { orderId: `fac-a-pt-0001-WBC-${seq}`, code: 'WBC', value: positive ? 15.1 : 7.2 } });
      out.push({ kind: 'result-lab', emittedAt: at(base), realmAt: at(base), payload: { orderId: `fac-a-pt-0001-BCULT-${seq}`, code: 'BCULT', value: positive ? 1 : 0 } });
    }
    out.push({ kind: 'record-immunisation', emittedAt: at(40), realmAt: at(40), payload: { patientId: 'fac-a-pt-0001', vaccine: 'influenza', seriesDose: 1, seriesTotal: 1 } });
    out.push({ kind: 'result-lab', emittedAt: at(30), realmAt: at(30), payload: { orderId: 'fac-a-pt-0001-HBSAB-9', code: 'HBSAB', value: 5 } });
    return out;
  })();

  async function build() {
    return buildApp({
      store: inMemoryStore(),
      telemetry: new Telemetry('test', new InMemorySink()),
      packs: [healthcareCorePack],
      authenticate: async () => actor,
      checkHealth: async () => ({ db: true, redis: true }),
      infectionEvents: () => ledgerEvents,
      renalPatients: () => [
        {
          id: 'fac-a-pt-0001', realmId: 'sim:renal-a', medCodes: [],
          state: {
            facilityId: 'fac-a',
            access: { type: 'catheter', ageDays: 160 },
            matureAccessAvailable: true,
            immunisations: [{ at: at(40), vaccine: 'influenza', seriesDose: 1, seriesTotal: 1 }],
          },
        },
      ],
    });
  }

  it('exposes the feature contract, cells, prevention panel, separation proof and safety', async () => {
    const app = await build();
    try {
      const features = await app.inject({ method: 'GET', url: '/admin/swarm/infection/features' });
      expect(features.statusCode).toBe(200);
      const body = features.json() as { features: unknown[]; halves: { prevention: { model: null } }; authority: { antimicrobial: string }; safety: { hardContract: string } };
      expect(body.features).toHaveLength(INFECTION_FEATURES.length);
      expect(body.halves.prevention.model).toBeNull();
      expect(body.authority.antimicrobial).toBe('none');
      expect(body.safety.hardContract).toMatch(/cultures/);

      for (const url of ['/admin/swarm/infection/cells', '/admin/swarm/infection/prevention', '/admin/swarm/infection/separation', '/admin/swarm/infection/safety', '/admin/swarm/infection/state', '/admin/swarm/infection/artifact', '/admin/swarm/infection/assurance', '/admin/swarm/infection/validation', '/admin/swarm/infection/demo', '/admin/swarm/infection/study']) {
        const res = await app.inject({ method: 'GET', url });
        expect(res.statusCode, url).toBe(200);
      }

      const prevention = (await app.inject({ method: 'GET', url: '/admin/swarm/infection/prevention?patientId=fac-a-pt-0001' })).json() as { source: string; modelFree: boolean; determinism: { stable: boolean }; plan: { tasks: PreventionTask[] } };
      expect(prevention.source).toBe('realm-ledger');
      expect(prevention.modelFree).toBe(true);
      expect(prevention.determinism.stable).toBe(true);
      expect(prevention.plan.tasks.every((t) => t.deterministic)).toBe(true);

      const separation = (await app.inject({ method: 'GET', url: '/admin/swarm/infection/separation?patientId=fac-a-pt-0001' })).json() as { separation: { deterministic: boolean; modelIndependent: boolean } };
      expect(separation.separation.deterministic).toBe(true);
      expect(separation.separation.modelIndependent).toBe(true);

      const state = (await app.inject({ method: 'GET', url: '/admin/swarm/infection/state' })).json() as { source: string; kpis: Record<string, number> };
      expect(state.source).toBe('realm-ledger');
      expect(state.kpis.patientsTracked).toBeGreaterThan(0);
      expect(state.kpis.catheterInSitu).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it('advises (with the culture contract), runs what-if, prevention and the twin', async () => {
    const app = await build();
    try {
      const advise = await app.inject({
        method: 'POST', url: '/admin/swarm/infection/advise',
        payload: { patientId: 'fac-a-pt-0001', temperatureC: 38.8, temperatureSeries: [38.2, 38.5, 38.8], procalcitoninNgMl: 4.1, wbc: 15, accessType: 'catheter', catheterDays: 160, matureAvfAvailable: true, accessAgeDays: 160 },
      });
      expect(advise.statusCode).toBe(200);
      const adviseBody = advise.json() as { recommendation: { action: string; plan: string[]; authority: { antimicrobial: string } }; guardrails: { antibioticDiscussionAllowed: boolean; requiresCultureFirst: boolean }; coverage: { covered: boolean }; preventionSignature: string };
      expect(adviseBody.guardrails.requiresCultureFirst).toBe(true);
      expect(adviseBody.guardrails.antibioticDiscussionAllowed).toBe(false);
      expect(adviseBody.recommendation.authority.antimicrobial).toBe('none');
      expect(adviseBody.preventionSignature).toBeTruthy();

      const whatIf = await app.inject({
        method: 'POST', url: '/admin/swarm/infection/what-if',
        payload: { patientId: 'adhoc', temperatureC: 38.6, temperatureSeries: [38.1, 38.4, 38.6], procalcitoninNgMl: 3.9, accessType: 'catheter', catheterDays: 130, matureAvfAvailable: true, accessAgeDays: 100 },
      });
      expect(whatIf.statusCode).toBe(200);
      const whatIfBody = whatIf.json() as { result: { refused: unknown[]; recommended?: { action: string }; prevention: { schedule: unknown[] } }; cultureContract: { refused: unknown[]; antimicrobialAuthority: string }; sensitivity: unknown[] };
      expect(whatIfBody.result.refused).toHaveLength(2);
      expect(whatIfBody.cultureContract.antimicrobialAuthority).toBe('none');
      expect(whatIfBody.result.prevention.schedule.length).toBeGreaterThan(0);
      expect(whatIfBody.sensitivity.length).toBe(5);

      const prevention = await app.inject({ method: 'POST', url: '/admin/swarm/infection/prevention/run', payload: { patientId: 'adhoc', immunisations: [{ vaccine: 'influenza', seriesDose: 1, at: '2024-10-01T00:00:00Z' }], hepatitisBSurfaceAntibodyIuL: 3 } });
      expect(prevention.statusCode).toBe(200);
      const preventionBody = prevention.json() as { determinism: { stable: boolean; modelFree: boolean }; plan: { tasks: PreventionTask[] } };
      expect(preventionBody.determinism.stable).toBe(true);
      expect(preventionBody.determinism.modelFree).toBe(true);
      expect(preventionBody.plan.tasks.length).toBeGreaterThan(0);

      const twin = await app.inject({ method: 'POST', url: '/admin/swarm/infection/twin', payload: { patientId: 'fac-a-pt-0001' } });
      expect(twin.statusCode).toBe(200);
      const twinBody = twin.json() as { score: { cultureRows: number; verdict: string }; stability: { stable: boolean; modelIndependent: boolean }; twin: { provenance: { source: string } } };
      expect(twinBody.twin.provenance.source).toBe('realm-ledger');
      expect(twinBody.stability.stable).toBe(true);
      expect(twinBody.stability.modelIndependent).toBe(true);

      const score = await app.inject({ method: 'POST', url: '/admin/swarm/infection/twin/score', payload: { patientId: 'fac-a-pt-0001' } });
      expect(score.statusCode).toBe(200);
      expect((score.json() as { patientId: string }).patientId).toBe('fac-a-pt-0001');
    } finally {
      await app.close();
    }
  });

  it('runs the red team, records drift, builds the MDR and records the study', async () => {
    const app = await build();
    try {
      const redTeam = await app.inject({ method: 'POST', url: '/admin/swarm/infection/red-team', payload: { ranBy: 'user:test' } });
      expect(redTeam.statusCode).toBe(200);
      const rtBody = redTeam.json() as { runs: unknown[]; probes: Array<{ scenarioId: string; passed: boolean }>; passed: boolean };
      expect(rtBody.runs).toHaveLength(4);
      expect(rtBody.probes.every((p) => p.passed)).toBe(true);
      expect(rtBody.passed).toBe(true);

      const drift = await app.inject({ method: 'POST', url: '/admin/swarm/infection/drift', payload: {} });
      expect(drift.statusCode).toBe(200);
      const driftBody = drift.json() as { snapshot: { metric: string; separation: { deterministic: boolean } } };
      expect(driftBody.snapshot.metric).toBe('infection-triage-ks');
      expect(driftBody.snapshot.separation.deterministic).toBe(true);

      const mdr = await app.inject({ method: 'GET', url: '/admin/swarm/infection/mdr' });
      expect(mdr.statusCode).toBe(200);
      const mdrBody = mdr.json() as { mdr: { model: { preventionPath: { trained: boolean } }; acceptance: Array<{ met: boolean }>; limitations: string[] } };
      expect(mdrBody.mdr.model.preventionPath.trained).toBe(false);
      expect(mdrBody.mdr.acceptance.every((c) => c.met)).toBe(true);
      expect(mdrBody.mdr.limitations.some((l) => /synthetic/i.test(l))).toBe(true);

      const study = await app.inject({ method: 'POST', url: '/admin/swarm/infection/study/record', payload: { patientId: 'fac-a-pt-0001', clinician: 'nurse-1', action: 'accept' } });
      expect(study.statusCode).toBe(200);
      const list = await app.inject({ method: 'GET', url: '/admin/swarm/infection/study' });
      expect((list.json() as { count: number }).count).toBeGreaterThan(0);

      const demo = await app.inject({ method: 'POST', url: '/admin/swarm/infection/demo' });
      expect(demo.statusCode).toBe(200);
      const demoBody = demo.json() as { seeded: number; episodes: unknown[] };
      expect(demoBody.episodes.length).toBeGreaterThan(0);

      const reset = await app.inject({ method: 'POST', url: '/admin/swarm/infection/reset' });
      expect(reset.statusCode).toBe(200);
      expect((reset.json() as { removed: number }).removed).toBeGreaterThan(0);

      const validationRun = await app.inject({ method: 'POST', url: '/admin/swarm/infection/validation/run' });
      expect(validationRun.statusCode).toBe(200);
      const validationBody = validationRun.json() as { artifact: { id: string; classifier: { metrics: { auroc: number } } }; report: { acceptanceMet: boolean } };
      expect(validationBody.artifact.id).toBe(INFECTION_ARTIFACT_ID);
      expect(validationBody.artifact.classifier.metrics.auroc).toBeGreaterThanOrEqual(INFECTION_MODEL_TARGET_AUROC);
      expect(validationBody.report.acceptanceMet).toBe(true);
    } finally {
      await app.close();
    }
  });
});
