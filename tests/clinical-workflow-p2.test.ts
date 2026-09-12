import { describe, expect, it } from 'vitest';

import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import type { PostgresEventStore } from '../src/server/postgres-event-store.js';
import type { CanonicalEvent } from '../src/healthcare-core/events.js';
import type { LedgerEntry } from '../src/hypergraph/ledger.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import type { ActorContext } from '../src/server/scoped-persistence.js';
import { OutcomeEpisodeCoordinator } from '../src/swarm/outcome-episode.js';
import { esaPatientOutcome, ESA_TWIN_DRIFT_TARGET_MAPE_PCT, type EsaTwinDriftScore } from '../src/swarm/anemia-twin.js';

/**
 * Phase 2 — patient-level verification and clinical language.
 *
 * The cohort measure answers "did the facility move". These tests defend the
 * different question a clinician asks after changing one patient's dose, and the
 * rule that a dismissal without a reason teaches the ranking nothing.
 */

function drift(over: Partial<EsaTwinDriftScore>): EsaTwinDriftScore {
  return {
    patientId: 'f1-pt-0001',
    n: 4,
    mae: 0.2,
    mape: 2.6,
    rmse: 0.3,
    withinBandPct: 75,
    verdict: 'pass',
    targetMapePct: ESA_TWIN_DRIFT_TARGET_MAPE_PCT,
    rows: [],
    note: 'Online Hb-forecast MAPE 2.6% over 4 weekly step(s).',
    ...over,
  };
}

describe('Phase 2 — a patient outcome is not a facility measure', () => {
  it('a forecast within the paper-A bar is met', () => {
    const outcome = esaPatientOutcome(drift({}));
    expect(outcome.met).toBe(true);
    expect(outcome.verdict).toBe('pass');
    expect(outcome.mapePct).toBe(2.6);
    expect(outcome.detail).toContain('MAPE');
  });

  it('drifting beyond the bar is NOT met, and keeps the numbers', () => {
    const outcome = esaPatientOutcome(drift({ mape: 14.2, verdict: 'watch', note: 'drift' }));
    expect(outcome.met).toBe(false);
    expect(outcome.mapePct).toBe(14.2);
  });

  it('too little observation is NOT success — insufficient never resolves on a guess', () => {
    const outcome = esaPatientOutcome(drift({ n: 1, mape: 0, verdict: 'insufficient', note: 'one weekly pair only' }));
    expect(outcome.met).toBe(false);
    expect(outcome.verdict).toBe('insufficient');
  });

  it('verify records the KIND and the detail, not just a boolean', () => {
    const coordinator = new OutcomeEpisodeCoordinator();
    const episode = coordinator.getOrOpen({ kind: 'anemia.esa-response', subject: 'patient:f1-pt-0001', scopeType: 'patient' });
    coordinator.addEvidence(episode.episodeId, [{ sourceId: 'lab:hgb', contentType: 'fact' }], true);
    coordinator.propose(episode.episodeId, {
      proposalId: `prop-${episode.episodeId}`, cellId: 'esa-dose-optimization', kind: 'anemia.esa-response',
      subject: 'patient:f1-pt-0001', scopeType: 'patient', option: 'Increase ESA dose', recommendation: 'x',
      allowed: true, evidence: [{ sourceId: 'lab:hgb', contentType: 'fact' }], producedAt: new Date().toISOString(),
      payload: { action: 'titrate-med' },
    }, true);
    coordinator.requestApproval(episode.episodeId, 'C');
    coordinator.decide(episode.episodeId, 'approved', 'Dr. Alvarez', 'C');
    coordinator.dispatchCommand(episode.episodeId, 'titrate-med');
    coordinator.acknowledge(episode.episodeId, 'facility');

    const outcome = esaPatientOutcome(drift({}));
    const after = coordinator.verify(
      episode.episodeId,
      { measureId: 'patient:f1-pt-0001:hgb-response', met: outcome.met, kind: 'patient-outcome', detail: outcome.detail },
      'patient-twin',
    );

    expect(after.measureResult?.kind).toBe('patient-outcome');
    expect(after.measureResult?.measureId).toBe('patient:f1-pt-0001:hgb-response');
    expect(after.measureResult?.detail).toContain('MAPE');
    expect(after.state).toBe('Resolved');
  });
});

describe('Phase 2 — a dismissal must say why', () => {
  const actor: ActorContext = {
    actorId: 'test-admin', role: 'admin', scopes: ['*'], clearance: 'restricted-phi',
    purposeOfUse: ['treatment', 'operations', 'quality'], tenantId: 't1',
  } as unknown as ActorContext;

  const makeApp = async () =>
    buildApp({
      store: undefined as unknown as PostgresEventStore,
      onEvent: async (_e: CanonicalEvent) => undefined,
      telemetry: new Telemetry('test', new InMemorySink()),
      packs: [healthcareCorePack],
      authenticate: async () => actor,
      checkHealth: async () => ({ db: true, redis: true }),
    });

  it('rejects a dismissal with no reason, and records one that has it', async () => {
    const app = await makeApp();
    await app.inject({ method: 'POST', url: '/admin/swarm/demo' });
    const stateRes = await app.inject({ method: 'GET', url: '/admin/swarm/state' });
    const nbas = (stateRes.json() as { nbas: Array<{ nbaId: string; title: string }> }).nbas;
    expect(nbas.length).toBeGreaterThan(0);
    const target = nbas[0]!;

    const noReason = await app.inject({
      method: 'POST',
      url: `/admin/swarm/nba/${encodeURIComponent(target.nbaId)}/decide`,
      payload: { decision: 'dismissed', approver: 'Dr. Alvarez' },
    });
    expect(noReason.statusCode).toBe(400);
    expect((noReason.json() as { error: string }).error).toBe('reason-required');

    const withReason = await app.inject({
      method: 'POST',
      url: `/admin/swarm/nba/${encodeURIComponent(target.nbaId)}/decide`,
      payload: { decision: 'dismissed', approver: 'Dr. Alvarez', reason: 'chair already booked for this patient' },
    });
    expect(withReason.statusCode).toBe(200);
    expect((withReason.json() as { decision: { decision: string; reason?: string } }).decision.decision).toBe('dismissed');
    expect((withReason.json() as { decision: { reason?: string } }).decision.reason).toBe('chair already booked for this patient');
  });

  it('an approval needs no reason', async () => {
    const app = await makeApp();
    await app.inject({ method: 'POST', url: '/admin/swarm/demo' });
    const stateRes = await app.inject({ method: 'GET', url: '/admin/swarm/state' });
    const target = (stateRes.json() as { nbas: Array<{ nbaId: string }> }).nbas[0]!;
    const res = await app.inject({
      method: 'POST',
      url: `/admin/swarm/nba/${encodeURIComponent(target.nbaId)}/decide`,
      payload: { decision: 'approved', approver: 'Dr. Alvarez' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { decision: { decision: string } }).decision.decision).toBe('approved');
  });
});
