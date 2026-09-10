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

// P2 — fluid / dry weight / IDH protocol pack (steps A–F).

import { describe, expect, it } from 'vitest';
import {
  FLUID_FEATURES, FLUID_HORIZONS_MIN, FLUID_REFERENCE, UF_RATE_PER_KG_SAFE,
  fluidRecommend, guardFluidPrescription, fluidLatent, idhProbability,
  buildFluidDemo,
  type FluidPatientWindow,
} from '../src/swarm/fluid.js';
import {
  fluidCoverage, fluidRecommendCovered, FLUID_RED_TEAM_DEFS, FLUID_RED_TEAM_IDS,
  fluidRedTeamProbe, ensureFluidRedTeamScenarios, ensureFluidModel,
  computeFluidDrift, evaluateFluidAdvisorGate, FLUID_COVERAGE_DEFAULTS, FLUID_MODEL_ID,
} from '../src/swarm/fluid-governance.js';
import { fluidWhatIf, FLUID_RATE_FACTORS, FLUID_TIME_EXTENSIONS_MIN } from '../src/swarm/fluid-simulator.js';
import { buildFluidTwin, scoreFluidTwinDrift, fluidWindowFromTwin, sessionsFromState, IDH_NADIR_SBP } from '../src/swarm/fluid-twin.js';
import { buildFluidTrainingRows, trainFluidArtifact, loadFluidArtifact, fluidArtifactStatus, fluidRecommendTrained, buildFluidVector } from '../src/swarm/fluid-model.js';
import { SwarmWorkspaceStore } from '../src/swarm/workspace.js';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import type { PostgresEventStore } from '../src/server/postgres-event-store.js';
import type { CanonicalEvent } from '../src/healthcare-core/events.js';
import type { LedgerEntry } from '../src/hypergraph/ledger.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import type { ActorContext } from '../src/server/scoped-persistence.js';

const NOW = '2026-08-25T10:00:00Z';

/** Stable, telemetry-complete window: 6 sessions, 12 samples, fresh target weight. */
const WINDOW: FluidPatientWindow = {
  patientId: 'p-fluid-1',
  facilityId: 'fac-1',
  sessionCount: 6,
  telemetryPoints: 12,
  plannedMinutes: 210,
  deliveredMinutes: 205,
  ufVolumeL: 4.2,
  ufRateMlH: 1250,
  postWeightKg: 77,
  preSbp: 128,
  nadirSbp: 96,
  nadirSbpPrev: 92,
  idwgKg: 4.4,
  adherencePct: 98,
  age: 78,
  cardiacHistory: true,
  dryWeightAssessedAt: '2026-08-20T00:00:00Z',
  asOf: NOW,
};

const rt = (id: string) => FLUID_RED_TEAM_DEFS.find((d) => d.id === id)!;

describe('P2-A — fluid engine + guardrails', () => {
  it('publishes a feature contract covering rate, pressure, volume load and vulnerability', () => {
    const ids = FLUID_FEATURES.map((f) => f.id);
    expect(ids).toContain('ufRatePerKg');
    expect(ids).toContain('nadirSbpPrev');
    expect(ids).toContain('idwgKg');
    expect(ids).toContain('cardiacHistory');
    expect(FLUID_FEATURES.every((f) => f.relevance > 0 && f.relevance <= 1)).toBe(true);
    expect(FLUID_REFERENCE.horizonsMin).toEqual([15, 30, 60]);
    expect(FLUID_REFERENCE.ufRatePerKgSafe).toBe(10);
  });

  it('blocks without intra-session telemetry and without a recent dry weight', () => {
    const noTelemetry = guardFluidPrescription({ ...WINDOW, telemetryPoints: 0 });
    expect(noTelemetry.blocked).toBe(true);
    expect(noTelemetry.flags).toContain('no-intra-session-telemetry');
    const staleWeight = guardFluidPrescription({ ...WINDOW, dryWeightAssessedAt: '2026-01-01T00:00:00Z' });
    expect(staleWeight.blocked).toBe(true);
    expect(staleWeight.flags).toContain('dry-weight-not-reassessed');
    expect(staleWeight.blockReason).toMatch(/weight/i);

    const missingWeight = guardFluidPrescription({ ...WINDOW, dryWeightAssessedAt: undefined });
    expect(missingWeight.blocked).toBe(true);
    expect(missingWeight.flags).toContain('dry-weight-not-reassessed');
  });

  it('puts adherence before ultrafiltration and never escalates for a hypotension-prone patient', () => {
    const adherence = guardFluidPrescription({ ...WINDOW, adherencePct: 62 });
    expect(adherence.blocked).toBe(true);
    expect(adherence.flags).toContain('shortened-sessions-adherence-first');
    expect(adherence.ufEscalationAllowed).toBe(false);

    const hypotensive = guardFluidPrescription({ ...WINDOW, nadirSbpPrev: 84, cardiacHistory: false });
    expect(hypotensive.blocked).toBe(false);
    expect(hypotensive.flags).toContain('idh-in-previous-session');
    expect(hypotensive.ufEscalationAllowed).toBe(false);
    expect(hypotensive.ufReductionAdvised).toBe(true);

    const fragile = guardFluidPrescription({ ...WINDOW, nadirSbpPrev: 105, cardiacHistory: true });
    expect(fragile.flags).toContain('cardiac-fragility');
    expect(fragile.ufEscalationAllowed).toBe(false);

    const ceiling = guardFluidPrescription({ ...WINDOW, nadirSbpPrev: 105, cardiacHistory: false, age: 62 });
    expect(ceiling.flags).toContain('uf-rate-above-refill-ceiling');
    expect(ceiling.ufRatePerKg).toBeGreaterThan(UF_RATE_PER_KG_SAFE);
    expect(ceiling.ufEscalationAllowed).toBe(false);
  });

  it('reports a bounded volume/fragility latent', () => {
    const stable = fluidLatent({ ...WINDOW, idwgKg: 1.2, nadirSbp: 118, nadirSbpPrev: 116, cardiacHistory: false });
    const loaded = fluidLatent(WINDOW);
    expect(loaded.l1).toBeGreaterThan(stable.l1);
    expect(loaded.polarRadius).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(loaded.polarAngleRad)).toBe(true);
  });

  it('keeps IDH probability monotone in UF rate and inverse in systolic pressure', () => {
    const atRate = (ratePerKg: number) => idhProbability({ ufRatePerKg: ratePerKg, currentSbp: 110, minute: 60 });
    expect(atRate(14)).toBeGreaterThan(atRate(8));
    expect(atRate(8)).toBeGreaterThan(atRate(4));

    const atSbp = (sbp: number) => idhProbability({ ufRatePerKg: 12, currentSbp: sbp, minute: 60 });
    expect(atSbp(80)).toBeGreaterThan(atSbp(100));
    expect(atSbp(100)).toBeGreaterThan(atSbp(125));

    const early = idhProbability({ ufRatePerKg: 12, currentSbp: 100, minute: 15 });
    const late = idhProbability({ ufRatePerKg: 12, currentSbp: 100, minute: 60 });
    expect(late).toBeGreaterThan(early);
  });

  it('recommends a rate reduction (never an increase) at the refill ceiling', () => {
    const rec = fluidRecommend({ ...WINDOW, nadirSbpPrev: 105, nadirSbp: 104, cardiacHistory: false, idwgKg: 4.6 });
    expect(rec.current.ufRatePerKg).toBeGreaterThan(UF_RATE_PER_KG_SAFE);
    // above the ceiling the advisor steps the rate down (extending time to keep
    // the same fluid removal) — never up
    expect(['reduce-uf-rate', 'extend-time-for-uf']).toContain(rec.action);
    expect(rec.recommended.ufRateMlH!).toBeLessThan(rec.current.ufRateMlH!);
    expect(Object.keys(rec.current.idhRiskByMinute!)).toEqual(['15', '30', '60']);
    expect(rec.synthetic).toBe(true);
  });

  it('routes a hypotension-prone patient to reduce-rate + extend-time instead of a volume increase', () => {
    const rec = fluidRecommend(WINDOW);
    expect(['reduce-uf-rate', 'extend-time-for-uf']).toContain(rec.action);
    const projected = rec.recommended.expectedIdhRiskByMinute![60]!;
    expect(projected).toBeLessThanOrEqual(rec.current.idhRiskByMinute![60]!);
  });

  it('blocks (not advises) a window that fails the guardrails', () => {
    const rec = fluidRecommend({ ...WINDOW, telemetryPoints: 0 });
    expect(rec.guardrails.blocked).toBe(true);
    expect(rec.action).toBe('blocked');
  });
});

describe('P2-B — governance (coverage, red team, gate, drift)', () => {
  it('requires telemetry density and a fresh target weight for coverage', () => {
    const coverage = fluidCoverage(WINDOW);
    expect(coverage.covered).toBe(true);
    expect(coverage.telemetry.sessions).toBeGreaterThanOrEqual(FLUID_COVERAGE_DEFAULTS.minSessions);

    const thin = fluidCoverage({ ...WINDOW, telemetryPoints: 1 });
    expect(thin.covered).toBe(false);
    expect(thin.reason).toMatch(/telemetry/i);
    expect(fluidRecommendCovered({ ...WINDOW, telemetryPoints: 1 }).action).toBe('blocked');
    expect(fluidRecommendCovered({ ...WINDOW, telemetryPoints: 1 }, { coverageGateEnabled: false }).action).not.toBe('blocked');
  });

  it('contains all four adversarial fluid scenarios', () => {
    expect([...FLUID_RED_TEAM_IDS]).toEqual(['rt-021', 'rt-022', 'rt-023', 'rt-024']);
    for (const def of FLUID_RED_TEAM_DEFS) {
      const probe = fluidRedTeamProbe(def);
      expect(probe.passed, `${def.id}: ${probe.checks[0]?.observed}`).toBe(true);
    }
    // rt-024 explicitly never returns more ultrafiltration per hour than came in.
    const rt024 = fluidRedTeamProbe(rt('rt-024'));
    expect(rt024.passed).toBe(true);
  });

  it('registers the model + scenarios in the durable workspace', async () => {
    const store = new SwarmWorkspaceStore();
    expect(await ensureFluidModel(store)).toBe(true);
    expect(await ensureFluidModel(store)).toBe(false);
    expect(await ensureFluidRedTeamScenarios(store)).toBe(4);
    const models = await store.listModels();
    expect(models.some((m) => m.modelId === FLUID_MODEL_ID)).toBe(true);
  });

  it('gates on telemetry, interpretability, red team and never on machine control', async () => {
    const base = {
      registered: true, telemetryGateEnabled: true, interpretabilityPresent: true,
      openFindings: 0, machineControlAuthority: false, autonomousUfAuthority: false,
    };
    expect(evaluateFluidAdvisorGate(base).status).toBe('active');
    expect(evaluateFluidAdvisorGate({ ...base, telemetryGateEnabled: false }).status).toBe('gated');
    expect(evaluateFluidAdvisorGate({ ...base, openFindings: 1 }).status).toBe('blocked');
    const autonomous = evaluateFluidAdvisorGate({ ...base, autonomousUfAuthority: true });
    expect(autonomous.status).toBe('blocked');
    expect(autonomous.reasons.join(' ')).toMatch(/machine control/i);
    expect(evaluateFluidAdvisorGate(base).posture.machineControlAuthority).toBe('none');
  });

  it('scores drift on the UF-rate-per-kg distribution', () => {
    const baseline = Array.from({ length: 12 }, (_, i) => ({ ufRatePerKg: 8 + (i % 3) * 0.1, nadirSbp: 110 + i, idwgKg: 2.5 }));
    const stable = computeFluidDrift({ baseline, current: baseline });
    expect(stable.verdict).toBe('stable');
    expect(stable.status).toBe('healthy');

    const shifted = baseline.map((r) => ({ ufRatePerKg: 14, nadirSbp: r.nadirSbp - 30, idwgKg: 5.4 }));
    const drifted = computeFluidDrift({ baseline, current: shifted });
    expect(drifted.verdict).toBe('drift');
    expect(drifted.latentShift).toBeGreaterThan(0.15);
  });
});

describe('P2-C — UF counterfactual simulator', () => {
  it('builds the full rate × time matrix and never returns an escalation for a blocked window', () => {
    const result = fluidWhatIf(WINDOW);
    expect(result.candidates).toHaveLength(FLUID_RATE_FACTORS.length * FLUID_TIME_EXTENSIONS_MIN.length);
    expect(result.horizonsMin).toEqual([...FLUID_HORIZONS_MIN]);
    expect(result.recommended).toBeDefined();
    expect(result.recommended!.allowed).toBe(true);
    expect(result.recommended!.aboveRefillCeiling).toBe(false);
    for (const c of result.candidates) {
      if (c.ufRateMlH > WINDOW.ufRateMlH!) {
        expect(c.allowed, `escalation ${c.label} must be refused`).toBe(false);
      }
    }

    const blocked = fluidWhatIf({ ...WINDOW, telemetryPoints: 0 });
    expect(blocked.blocked).toBe(true);
    expect(blocked.recommended).toBeUndefined();
    expect(blocked.candidates.some((c) => c.allowed && c.ufRateMlH > (WINDOW.ufRateMlH ?? 0))).toBe(false);
  });

  it('trades fluid-goal achievement against per-horizon IDH risk', () => {
    const result = fluidWhatIf(WINDOW);
    const low = result.candidates.find((c) => c.ufRateMlH < WINDOW.ufRateMlH! && c.minutes === WINDOW.deliveredMinutes);
    const high = result.candidates.find((c) => c.ufRateMlH === WINDOW.ufRateMlH && c.minutes >= (WINDOW.deliveredMinutes ?? 0));
    expect(low).toBeDefined();
    expect(high).toBeDefined();
    if (low && high) {
      expect(low.goalAchievedPct).toBeLessThanOrEqual(high.goalAchievedPct);
      expect(low.peakIdhRisk).toBeLessThan(high.peakIdhRisk);
    }
    expect(result.note).toMatch(/advisory only/i);
  });

  it('de-escalates above the plasma-refill ceiling', () => {
    const result = fluidWhatIf({ ...WINDOW, nadirSbpPrev: 105, nadirSbp: 104, cardiacHistory: false, idwgKg: 4.6 });
    expect(result.candidates.some((c) => c.aboveRefillCeiling)).toBe(true);
    expect(result.recommended).toBeDefined();
    expect(result.recommended!.ufRatePerKg).toBeLessThanOrEqual(UF_RATE_PER_KG_SAFE);
  });
});

describe('P2-D — twin over the real ledger', () => {
  it('detects an IDH event from telemetry (nadir below floor / fall ≥20 mmHg / symptoms)', () => {
    const state = {
      sessions: [
        {
          sessionId: 's1', startedAt: NOW, endedAt: NOW, deliveredMinutes: 210, prescribedMinutes: 210,
          ufVolumeL: 4.1, postWeightKg: 77, nadirSbp: 82,
          telemetry: [
            { minute: 0, bp: '128/76', hr: 74, ufRateMlH: 1250 },
            { minute: 30, bp: '96/58', hr: 88, ufRateMlH: 1250, symptoms: ['cramp'] },
            { minute: 60, bp: '84/52', hr: 92, ufRateMlH: 1250 },
          ],
        },
        { sessionId: 's0', startedAt: NOW, endedAt: NOW, deliveredMinutes: 210, ufVolumeL: 3.0, postWeightKg: 77, telemetry: [{ minute: 0, bp: '130/80' }, { minute: 210, bp: '124/78' }] },
      ],
    };
    const sessions = sessionsFromState(state);
    const first = sessions.find((s) => s.sessionId === 's1')!;
    expect(first.telemetryPoints).toBe(3);
    // the reducer's recorded session nadir (82) wins over the telemetry minimum
    expect(first.nadirSystolic).toBe(82);
    expect(first.maxDropMmHg).toBeGreaterThanOrEqual(20);
    expect(first.idhEvent).toBe(true);
    expect(first.symptoms).toContain('cramp');
    expect(first.nadirSystolic! < IDH_NADIR_SBP).toBe(true);

    const calm = sessions.find((s) => s.sessionId === 's0')!;
    expect(calm.idhEvent).toBe(false);
  });

  it('says "insufficient" rather than inventing a discrimination number', () => {
    const twin = buildFluidTwin({ patientId: 'p-1', events: [], patients: [{ patientId: 'p-1', state: { sessions: [] } }] });
    const score = scoreFluidTwinDrift(twin);
    expect(score.verdict).toBe('insufficient');
    expect(score.auroc).toBeUndefined();
    expect(score.note).toMatch(/needed|scored/i);
  });

  it('reports provenance and builds a window from the newest session', () => {
    const twin = buildFluidTwin({
      patientId: 'p-twin',
      events: [
        { kind: 'record-session-telemetry', emittedAt: NOW, realmAt: NOW, payload: { patientId: 'p-twin', minute: 0, bp: '126/74', ufRateMlH: 1100 } },
        { kind: 'record-session-telemetry', emittedAt: NOW, realmAt: NOW, payload: { patientId: 'p-twin', minute: 60, bp: '88/54', ufRateMlH: 1100, symptoms: ['hypotension'] } },
      ],
      patients: [{ patientId: 'p-twin', state: {} }],
    });
    expect(twin.provenance.attributedBy).toBe('payload-patientId');
    expect(twin.provenance.telemetryEvents).toBe(2);
    expect(twin.summary.sessionsWithTelemetry).toBe(1);
    expect(twin.summary.idhEvents).toBe(1);

    const window = fluidWindowFromTwin(twin);
    expect(window.patientId).toBe('p-twin');
    expect(window.nadirSbp).toBe(88);
    expect(window.telemetryPoints).toBeGreaterThan(0);

    // A session stream with both outcomes scores, and can still be "insufficient"
    // when only one outcome is present — never a fabricated AUROC.
    const score = scoreFluidTwinDrift(twin);
    expect(['insufficient', 'watch', 'pass']).toContain(score.verdict);
  });
});

describe('P2-E — trained artifact', () => {
  it('trains, persists and reports honest verdicts against the mechanistic prior', async () => {
    const rows = buildFluidTrainingRows({ patients: 24, sessionsPerPatient: 8, seed: 7 });
    const artifact = trainFluidArtifact(rows, { salt: 'fluid-test' });
    expect(artifact.model.kind).toBe('gbdt-regression');
    expect(artifact.metrics.positives).toBeGreaterThan(0);
    expect(artifact.metrics.negatives).toBeGreaterThan(0);
    expect(artifact.metrics.priorAuroc).toBeGreaterThan(0.5);
    expect(artifact.reliability.length).toBeGreaterThan(0);
    expect(artifact.synthetic).toBe(true);
    expect(artifact.modelCard).toBeTruthy();

    const status = fluidArtifactStatus('/tmp/does-not-exist.json');
    expect(status.present).toBe(false);
    expect(status.ranker).toBe('prior');
  });

  it('loads the shipped artifact and ranks with the better model', () => {
    const artifact = loadFluidArtifact();
    expect(artifact, 'run `npx tsx scripts/train-fluid-model.ts`').toBeDefined();
    const status = fluidArtifactStatus();
    expect(status.present).toBe(true);
    expect(status.ranker === 'head' || status.ranker === 'prior').toBe(true);
    // The shipped artifact must at minimum be calibrated better than the prior.
    expect(status.improvesCalibration).toBe(true);
    expect(status.note.length).toBeGreaterThan(20);

    const rec = fluidRecommendTrained(WINDOW);
    expect('trained' in rec && rec.trained).toBeTruthy();
    if ('trained' in rec && rec.trained) {
      expect(rec.trained.artifactId).toBe(artifact!.id);
      expect(rec.trained.ranker).toBe(status.ranker);
      expect(Object.keys(rec.trained.horizon)).toEqual(['15', '30', '60']);
    }
  });

  it('builds a model vector aligned with the declared feature list', () => {
    const vector = buildFluidVector(WINDOW, 0.42);
    expect(vector).toHaveLength(11);
    expect(vector.every((v) => Number.isFinite(v))).toBe(true);
  });
});

describe('P2-F — routes over the live ledger', () => {
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

  /** A telemetry-complete patient whose last session ended hypotensive. */
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
            dryWeightKg: 74,
            labs: { URR: 66, K: 5.4 },
            lastVitals: { hr: 82, bp: '108/66', spo2: 96, temp: 36.7, at: '2026-08-06T07:00:00.000Z' },
            sessions: [
              { sessionId: 's1', startedAt: '2026-08-01T07:00:00.000Z', endedAt: '2026-08-01T10:40:00.000Z', deliveredMinutes: 220, prescribedMinutes: 240, ufVolumeL: 2.2, targetUfL: 2.6, preWeightKg: 71.2, postWeightKg: 69.0, qbAvg: 320, nadirSbp: 104, meanSbp: 114, stoppedEarly: false, telemetryPoints: 2, telemetry: [{ minute: 0, bp: '126/74', hr: 74, ufRateMlH: 640 }, { minute: 60, bp: '104/62', hr: 82, ufRateMlH: 640 }] },
              { sessionId: 's2', startedAt: '2026-08-03T07:00:00.000Z', endedAt: '2026-08-03T10:35:00.000Z', deliveredMinutes: 215, prescribedMinutes: 240, ufVolumeL: 2.1, targetUfL: 2.6, preWeightKg: 71.0, postWeightKg: 68.9, qbAvg: 318, nadirSbp: 84, meanSbp: 108, stoppedEarly: false, telemetryPoints: 2, telemetry: [{ minute: 0, bp: '124/72', hr: 76, ufRateMlH: 660 }, { minute: 45, bp: '84/50', hr: 90, ufRateMlH: 660, symptoms: ['hypotension'] }] },
              { sessionId: 's3', startedAt: '2026-08-05T07:00:00.000Z', endedAt: '2026-08-05T10:30:00.000Z', deliveredMinutes: 210, prescribedMinutes: 240, ufVolumeL: 2.0, targetUfL: 2.6, preWeightKg: 70.8, postWeightKg: 68.8, qbAvg: 316, nadirSbp: 92, meanSbp: 110, stoppedEarly: false, telemetryPoints: 2, telemetry: [{ minute: 0, bp: '122/70', hr: 78, ufRateMlH: 650 }, { minute: 90, bp: '92/56', hr: 86, ufRateMlH: 650 }] },
            ],
          },
        },
      ],
    });
  }

  it('exposes the full route surface with live ledger windows', async () => {
    const app = await build();
    try {
      const features = await app.inject({ method: 'GET', url: '/admin/swarm/fluid/features' });
      expect(features.statusCode).toBe(200);
      const body = features.json() as { features: unknown[]; reference: { horizonsMin: number[] }; safety: { machineControl: string } };
      expect(body.features).toHaveLength(FLUID_FEATURES.length);
      expect(body.reference.horizonsMin).toEqual([15, 30, 60]);
      expect(body.safety.machineControl).toBe('none');

      for (const url of ['/admin/swarm/fluid/cells', '/admin/swarm/fluid/state', '/admin/swarm/fluid/artifact', '/admin/swarm/fluid/assurance', '/admin/swarm/fluid/validation', '/admin/swarm/fluid/demo']) {
        const res = await app.inject({ method: 'GET', url });
        expect(res.statusCode, url).toBe(200);
      }

      const state = await app.inject({ method: 'GET', url: '/admin/swarm/fluid/state' });
      expect(state.statusCode).toBe(200);
      const stateBody = state.json() as { patients: number; withTelemetry: number; windows: Array<{ patientId: string; dryWeightSource: string; recommendation: { action: string; guardrails: { blocked: boolean } } }> };
      expect(stateBody.patients).toBe(1);
      expect(stateBody.windows[0]!.patientId).toBe('fac-a-pt-0001');
      // target weight comes from the session close, and is stated as such
      expect(stateBody.windows[0]!.dryWeightSource).toBe('last-session-close');
      // the last session ended hypotensive (nadir 92 after 84) → rate reduction, never escalation
      expect(['reduce-uf-rate', 'extend-time-for-uf', 'profile-temperature-sodium']).toContain(stateBody.windows[0]!.recommendation.action);

      const twin = await app.inject({ method: 'POST', url: '/admin/swarm/fluid/twin', payload: { patientId: 'fac-a-pt-0001' } });
      expect(twin.statusCode).toBe(200);
      const twinBody = twin.json() as { twin: { summary: { sessionCount: number; idhEvents: number } }; drift: { verdict: string; auroc?: number } };
      expect(twinBody.twin.summary.sessionCount).toBe(3);
      expect(twinBody.twin.summary.idhEvents).toBeGreaterThan(0);
      // three sessions is below the four-session minimum: never a fabricated AUROC
      expect(twinBody.drift.verdict).toBe('insufficient');
      expect(twinBody.drift.auroc).toBeUndefined();

      const whatIf = await app.inject({ method: 'POST', url: '/admin/swarm/fluid/what-if', payload: WINDOW });
      expect(whatIf.statusCode).toBe(200);
      expect((whatIf.json() as { result: { candidates: unknown[]; recommended?: unknown } }).result.candidates.length).toBe(FLUID_RATE_FACTORS.length * FLUID_TIME_EXTENSIONS_MIN.length);

      const redTeam = await app.inject({ method: 'POST', url: '/admin/swarm/fluid/red-team', payload: { ranBy: 'test' } });
      expect(redTeam.statusCode).toBe(200);
      const rtBody = redTeam.json() as { passed: boolean; runs: unknown[]; probes: Array<{ passed: boolean }> };
      expect(rtBody.runs).toHaveLength(4);
      expect(rtBody.probes.every((p) => p.passed)).toBe(true);
      expect(rtBody.passed).toBe(true);

      const drift = await app.inject({ method: 'POST', url: '/admin/swarm/fluid/drift', payload: {} });
      expect(drift.statusCode).toBe(200);
      expect((drift.json() as { snapshot: { targetId: string } }).snapshot.targetId).toBe(FLUID_MODEL_ID);

      const mdr = await app.inject({ method: 'GET', url: '/admin/swarm/fluid/mdr' });
      expect(mdr.statusCode).toBe(200);
      const mdrBody = mdr.json() as { mdr: { classification: { riskClass: string }; limitations: string[] } };
      expect(mdrBody.mdr.classification.riskClass).toBe('high-risk-cdss');
      expect(mdrBody.mdr.limitations.join(' ')).toMatch(/synthetic/i);

      const validation = await app.inject({ method: 'GET', url: '/admin/swarm/fluid/validation' });
      expect(validation.statusCode).toBe(200);
      const report = (validation.json() as { report: { criteria: Array<{ criterion: string; met: boolean }>; synthetic: boolean; note: string } }).report;
      expect(report.synthetic).toBe(true);
      expect(report.criteria.some((c) => c.criterion.includes('No autonomous UF') && c.met)).toBe(true);
      expect(report.note).toMatch(/benchmark/i);

      const study = await app.inject({ method: 'POST', url: '/admin/swarm/fluid/study/record', payload: { patientId: 'fac-a-pt-0001', action: 'modify', clinician: 'nurse-a' } });
      expect(study.statusCode).toBe(200);
      const listed = await app.inject({ method: 'GET', url: '/admin/swarm/fluid/study' });
      expect((listed.json() as { count: number }).count).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it('seeds a Class C UF change plus a closed Class B nursing loop, then resets only fluid episodes', async () => {
    const app = await build();
    try {
      const seeded = await app.inject({ method: 'POST', url: '/admin/swarm/fluid/demo', payload: {} });
      expect(seeded.statusCode).toBe(200);
      const seededBody = seeded.json() as { opened: string[]; existing: string[]; closed: string[]; episodes: Array<{ state: string; proposal?: { approvalClass?: string } }> };
      // the coordinator is process-global: assert the buckets account for both
      expect(seededBody.opened.length + seededBody.existing.length + seededBody.closed.length).toBe(2);
      expect(seededBody.episodes).toHaveLength(2);
      expect(seededBody.episodes.some((e) => e.proposal?.approvalClass === 'C')).toBe(true);
      // one episode waits for human approval; the other ran the full closed loop
      expect(seededBody.episodes.some((e) => e.state === 'AwaitingApproval')).toBe(true);
      expect(seededBody.episodes.some((e) => e.state === 'Resolved')).toBe(true);

      const reset = await app.inject({ method: 'POST', url: '/admin/swarm/fluid/reset', payload: {} });
      expect(reset.statusCode).toBe(200);
      expect((reset.json() as { removed: number }).removed).toBe(2);
      const afterReset = await app.inject({ method: 'GET', url: '/admin/swarm/fluid/demo' });
      expect((afterReset.json() as { episodes: unknown[] }).episodes).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('merges fluid proposals into the swarm insight/nba surface', () => {
    const demo = buildFluidDemo();
    expect(demo.proposals).toHaveLength(2);
    expect(demo.proposals.some((p) => p.approvalClass === 'C')).toBe(true);
    expect(demo.nbas.length).toBeGreaterThan(0);
    expect(demo.cells).toHaveLength(2);
  });
});
