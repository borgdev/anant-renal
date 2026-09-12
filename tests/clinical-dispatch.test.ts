import { describe, expect, it, afterEach } from 'vitest';

import { RealmRegistry, populateFacility } from '../src/realm/index.js';
import type { HITLGate } from '../src/realm/hitl.js';
import { OutcomeEpisodeCoordinator, type EpisodeOrder } from '../src/swarm/outcome-episode.js';
import { dispatchApprovedEpisode, DispatchError } from '../src/swarm/command-dispatch.js';
import { CLINICAL_ACTION_MAPS, anemiaFindings, clinicalNbaState } from '../src/swarm/clinical-nba.js';
import { esaRecommend, type EsaPatientWindow } from '../src/swarm/anemia.js';
import { ADEQUACY_CELLS } from '../src/swarm/adequacy.js';
import { FLUID_CELLS } from '../src/swarm/fluid.js';
import { ACCESS_CELLS } from '../src/swarm/access.js';
import { ESA_CELLS } from '../src/swarm/anemia.js';
import { MBD_CELLS } from '../src/swarm/mbd.js';
import { NUTRITION_CELLS } from '../src/swarm/nutrition.js';
import { INFECTION_CELLS } from '../src/swarm/infection.js';
import type { CellManifest } from '../src/swarm/cells.js';

/**
 * Phase 1 — the operative loop.
 *
 * These tests defend the three properties the dispatch seam exists for:
 *   1. an approved action becomes a real order in the patient's record, dose and all
 *   2. ONE approval (the episode's), never a second from the realm's HITL gate
 *   3. at-most-once, proven from the ledger — a replay places nothing
 *
 * A passing suite here is the difference between "the episode said Coordinating" and
 * "the chart has the order".
 */

const FACILITY = 'f1';
const PATIENT = 'f1-pt-0001';

/** A gate that WOULD suspend any medication order — the counterfactual in test 2. */
const medGate: HITLGate = {
  id: 'gate-order-med',
  reason: 'medication orders require human approval',
  matches: (_presence, effect) => effect.kind === 'order-med',
};

let counter = 0;
function makeRealm(): string {
  counter += 1;
  const id = `realm:dispatch-${counter}`;
  const realm = RealmRegistry.create({ id, mode: 'sim', hitlGates: [medGate] });
  populateFacility(realm, { facilityId: FACILITY, kind: 'dialysis', name: 'Dispatch Dialysis', units: ['U1'], patientCount: 1 });
  realm.start();
  return id;
}

afterEach(() => {
  for (const realm of RealmRegistry.list()) if (realm.id.startsWith('realm:dispatch-')) RealmRegistry.remove(realm.id);
});

const ESA_ORDER: EpisodeOrder = {
  effect: 'order-med',
  payload: { patientId: PATIENT, code: 'epoetin-alfa', dose: '10000', route: 'IV', frequency: 'weekly', indication: 'anemia' },
};

/** Walk an episode to the exact state a clinician's approval leaves it in. */
function approvedEpisode(
  coordinator: OutcomeEpisodeCoordinator,
  realmId: string,
  opts: { action?: 'titrate-med' | 'update-care-plan'; order?: EpisodeOrder; proposalOrder?: boolean } = {},
): string {
  const episode = coordinator.getOrOpen({ kind: 'anemia.esa-response', subject: `patient:${PATIENT}`, scopeType: 'patient' });
  coordinator.addEvidence(episode.episodeId, [{ sourceId: `lab:hgb:${PATIENT}`, contentType: 'fact' }], true);
  coordinator.propose(
    episode.episodeId,
    {
      proposalId: `prop-${episode.episodeId}`,
      cellId: 'esa-dose-optimization',
      kind: 'anemia.esa-response',
      subject: `patient:${PATIENT}`,
      scopeType: 'patient',
      option: 'Increase ESA dose',
      recommendation: 'Hb below band — increase 25%.',
      allowed: true,
      evidence: [{ sourceId: `lab:hgb:${PATIENT}`, contentType: 'fact' }],
      producedAt: new Date().toISOString(),
      // The order rides on the PROPOSAL, so the command can pick it up without the
      // caller restating it (a pack states its order once).
      payload: opts.proposalOrder === false || opts.order === undefined
        ? {}
        : { order: { effect: opts.order.effect, payload: opts.order.payload } },
    },
    true,
  );
  coordinator.requestApproval(episode.episodeId, 'C');
  coordinator.decide(episode.episodeId, 'approved', 'Dr. Alvarez (nephrology)', 'C');
  coordinator.dispatchCommand(episode.episodeId, opts.action ?? 'titrate-med', {
    ...(opts.order !== undefined ? { order: opts.order } : {}),
    realmId,
  });
  return episode.episodeId;
}

function medications(realmId: string) {
  const realm = RealmRegistry.get(realmId)!;
  return realm.graph.listKind('medication');
}

describe('Phase 1 — an approved action lands in the patient record', () => {
  it('places the order, with the dose the pack recommended', () => {
    const realmId = makeRealm();
    const coordinator = new OutcomeEpisodeCoordinator();
    const episodeId = approvedEpisode(coordinator, realmId, { order: ESA_ORDER });

    const result = dispatchApprovedEpisode({ coordinator, episodeId, realmOf: (id) => RealmRegistry.get(id) });

    expect(result.replayed).toBe(false);
    expect(result.effectKind).toBe('order-med');
    expect(result.orderUrn).toContain('medication');

    const meds = medications(realmId);
    expect(meds).toHaveLength(1);
    expect(meds[0]!.state.dose).toBe('10000');
    expect(meds[0]!.state.route).toBe('IV');
    expect(meds[0]!.state.frequency).toBe('weekly');
    expect(meds[0]!.state.patientId).toBe(PATIENT);
    expect(meds[0]!.state.status).toBe('active');

    // The episode records where its order landed.
    const episode = coordinator.get(episodeId)!;
    expect(episode.command?.dispatched?.effectId).toBe(result.effectId);
    expect(episode.command?.dispatched?.orderUrn).toBe(result.orderUrn);
  });

  it('carries the human approval on the ledger effect, and does NOT raise a second approval', () => {
    const realmId = makeRealm();
    const realm = RealmRegistry.get(realmId)!;
    const coordinator = new OutcomeEpisodeCoordinator();
    const episodeId = approvedEpisode(coordinator, realmId, { order: ESA_ORDER });

    // The gate is real: the same effect emitted WITHOUT preApproved suspends.
    const probe = realm.spawnPresence({
      agentSpecId: 'probe',
      runId: 'probe',
      role: 'md',
      clearance: 'restricted-phi',
      purposeOfUse: ['treatment'],
      location: { facilityId: FACILITY, unitId: 'U1' },
    });
    realm.emit(probe.presenceId, { kind: 'order-med', patientId: PATIENT, code: 'epoetin-alfa', dose: '1', route: 'IV', frequency: 'weekly' });
    expect(realm.hitl.pending()).toHaveLength(1);
    const before = realm.hitl.pending().length;

    const result = dispatchApprovedEpisode({ coordinator, episodeId, realmOf: (id) => RealmRegistry.get(id) });

    // One approval, not two: the episode's decision IS the approval.
    expect(realm.hitl.pending()).toHaveLength(before);
    const effect = realm.ledger.listAll().find((e) => e.effectId === result.effectId);
    expect(effect?.approvalRef).toMatchObject({
      idempotencyKey: coordinator.get(episodeId)!.command!.idempotencyKey,
      episodeId,
      approvedBy: 'Dr. Alvarez (nephrology)',
    });
  });

  it('is at-most-once: a retried dispatch returns the original order and places nothing', () => {
    const realmId = makeRealm();
    const coordinator = new OutcomeEpisodeCoordinator();
    const episodeId = approvedEpisode(coordinator, realmId, { order: ESA_ORDER });

    const first = dispatchApprovedEpisode({ coordinator, episodeId, realmOf: (id) => RealmRegistry.get(id) });
    const ledgerAfterFirst = RealmRegistry.get(realmId)!.ledger.listAll().length;

    const second = dispatchApprovedEpisode({ coordinator, episodeId, realmOf: (id) => RealmRegistry.get(id) });

    expect(second.replayed).toBe(true);
    expect(second.effectId).toBe(first.effectId);
    expect(second.orderUrn).toBe(first.orderUrn);
    expect(medications(realmId)).toHaveLength(1);
    expect(RealmRegistry.get(realmId)!.ledger.listAll().length).toBe(ledgerAfterFirst);
  });
});

describe('Phase 1 — fail closed', () => {
  it('refuses to dispatch a command with no order draft rather than inventing one', () => {
    const realmId = makeRealm();
    const coordinator = new OutcomeEpisodeCoordinator();
    const episodeId = approvedEpisode(coordinator, realmId, { proposalOrder: false });
    const ledgerBefore = RealmRegistry.get(realmId)!.ledger.listAll().length;

    let caught: DispatchError | undefined;
    try {
      dispatchApprovedEpisode({ coordinator, episodeId, realmOf: (id) => RealmRegistry.get(id) });
    } catch (err) {
      caught = err as DispatchError;
    }

    expect(caught?.code).toBe('no-order-draft');
    expect(medications(realmId)).toHaveLength(0);
    expect(RealmRegistry.get(realmId)!.ledger.listAll().length).toBe(ledgerBefore);
  });

  it('refuses an episode that was not approved', () => {
    const realmId = makeRealm();
    const coordinator = new OutcomeEpisodeCoordinator();

    // An unknown episode is reported as such, never silently created.
    let unknown: DispatchError | undefined;
    try {
      dispatchApprovedEpisode({ coordinator, episodeId: 'out-ep-does-not-exist', realmOf: (id) => RealmRegistry.get(id) });
    } catch (err) {
      unknown = err as DispatchError;
    }
    expect(unknown?.code).toBe('outcome-episode-not-found');

    // An Observed episode with a command still refuses — on its STATE.
    const episode = coordinator.getOrOpen({ kind: 'anemia.esa-response', subject: `patient:${PATIENT}`, scopeType: 'patient' });
    coordinator.addEvidence(episode.episodeId, [{ sourceId: 'x', contentType: 'fact' }], true);
    coordinator.propose(episode.episodeId, {
      proposalId: `prop-${episode.episodeId}`, cellId: 'esa-dose-optimization', kind: 'anemia.esa-response',
      subject: `patient:${PATIENT}`, scopeType: 'patient', option: 'Increase ESA dose', recommendation: 'x',
      allowed: true, evidence: [{ sourceId: 'x', contentType: 'fact' }], producedAt: new Date().toISOString(),
      payload: { order: { effect: 'order-med', payload: { patientId: PATIENT, code: 'epoetin-alfa', dose: '10000', route: 'IV', frequency: 'weekly' } } },
    }, true);
    let second: DispatchError | undefined;
    try {
      dispatchApprovedEpisode({ coordinator, episodeId: episode.episodeId, realmOf: (id) => RealmRegistry.get(id) });
    } catch (err) {
      second = err as DispatchError;
    }
    expect(second?.code).toBe('episode-not-approved');
  });

  it('refuses when the realm is unknown, and when it is not named at all', () => {
    const coordinator = new OutcomeEpisodeCoordinator();
    const episodeId = approvedEpisode(coordinator, 'realm:does-not-exist', { order: ESA_ORDER });
    // The episode carries the (bogus) realm, so the failure is realm-not-found…
    let caught: DispatchError | undefined;
    try {
      dispatchApprovedEpisode({ coordinator, episodeId, realmId: 'realm:does-not-exist', realmOf: () => undefined });
    } catch (err) {
      caught = err as DispatchError;
    }
    expect(caught?.code).toBe('realm-not-found');

    // …and an episode with no realm at all refuses before guessing.
    const realmId = makeRealm();
    const orphan = new OutcomeEpisodeCoordinator();
    orphan.getOrOpen({ kind: 'x', subject: `patient:${PATIENT}`, scopeType: 'patient' });
    const e2 = orphan.list()[0]!;
    orphan.addEvidence(e2.episodeId, [{ sourceId: 'x', contentType: 'fact' }], true);
    orphan.propose(e2.episodeId, {
      proposalId: `prop-${e2.episodeId}`, cellId: 'esa-dose-optimization', kind: 'x', subject: `patient:${PATIENT}`,
      scopeType: 'patient', option: 'Increase ESA dose', recommendation: 'x', allowed: true,
      evidence: [{ sourceId: 'x', contentType: 'fact' }], producedAt: new Date().toISOString(),
      payload: { order: { effect: 'order-med', payload: { patientId: PATIENT, code: 'epoetin-alfa', dose: '1', route: 'IV', frequency: 'weekly' } } },
    }, true);
    orphan.requestApproval(e2.episodeId, 'C');
    orphan.decide(e2.episodeId, 'approved', 'Dr. X', 'C');
    orphan.dispatchCommand(e2.episodeId, 'titrate-med');
    let unnamed: DispatchError | undefined;
    try {
      dispatchApprovedEpisode({ coordinator: orphan, episodeId: e2.episodeId, realmOf: (id) => RealmRegistry.get(id) });
    } catch (err) {
      unnamed = err as DispatchError;
    }
    expect(unnamed?.code).toBe('episode-realm-unknown');
    expect(medications(realmId)).toHaveLength(0);
  });
});

describe('every protocol leaves a record of what a human approved', () => {
  const PACKS: Array<{ protocol: keyof typeof CLINICAL_ACTION_MAPS; cells: CellManifest[] }> = [
    { protocol: 'adequacy', cells: ADEQUACY_CELLS },
    { protocol: 'fluid', cells: FLUID_CELLS },
    { protocol: 'access', cells: ACCESS_CELLS },
    { protocol: 'anemia', cells: ESA_CELLS },
    { protocol: 'mbd', cells: MBD_CELLS },
    { protocol: 'nutrition', cells: NUTRITION_CELLS },
    { protocol: 'infection', cells: INFECTION_CELLS },
  ];

  it.each(PACKS)('$protocol: the bridge drafts what the owning cell permits', ({ protocol, cells }) => {
    // A pack whose output is a plan still has to leave something behind, so the
    // bridge falls back to a care-plan update — but only where the cell allows one.
    const entry = Object.entries(CLINICAL_ACTION_MAPS[protocol]).find(([, spec]) => {
      if (spec === null) return false;
      const cell = cells.find((c) => c.id === spec.cellId);
      return Boolean(cell?.allowedActions.includes('update-care-plan'));
    });
    expect(entry, `${protocol} has no action whose cell may update a care plan`).toBeDefined();
    const [token, spec] = entry!;

    const state = clinicalNbaState({
      protocol,
      insightKind: `${protocol}.proposal`,
      cells,
      consumedBy: {},
      actionMap: CLINICAL_ACTION_MAPS[protocol],
      findings: [
        {
          patientId: 'pt-draft-1',
          action: token,
          recommendation: 'draft under test',
          evidence: [{ sourceId: `x:${protocol}`, contentType: 'fact' }],
        },
      ],
    });

    const order = (state.proposals[0]?.payload as { order?: { effect: string; payload: Record<string, unknown> } } | undefined)?.order;
    expect(order, `${protocol}.${token} produced no order draft`).toBeDefined();
    // The fallback is a care-plan update, patient-scoped, and allowed by the cell.
    const cell = cells.find((c) => c.id === spec!.cellId)!;
    expect(cell.allowedActions).toContain(order!.effect);
    expect(order!.payload.patientId, 'the bridge must inject the patient').toBe('pt-draft-1');
  });

  it('a pack that names a concrete order keeps its own draft', () => {
    const state = clinicalNbaState({
      protocol: 'infection',
      insightKind: 'infection.bsi.proposal',
      cells: INFECTION_CELLS,
      consumedBy: {},
      actionMap: CLINICAL_ACTION_MAPS.infection,
      findings: [
        {
          patientId: 'pt-culture-1',
          realmId: 'realm:x',
          action: 'blood-culture-order',
          recommendation: 'cultures first',
          evidence: [{ sourceId: 'x', contentType: 'fact' }],
        },
      ],
    });
    const order = (state.proposals[0]?.payload as { order?: { effect: string; payload: Record<string, unknown> } } | undefined)?.order;
    expect(order?.effect).toBe('order-lab');
    expect(order?.payload).toMatchObject({ code: 'BCULT', priority: 'stat', patientId: 'pt-culture-1' });
    // The realm travels with the proposal, so the episode knows where to write.
    expect((state.proposals[0]?.payload as { realmId?: string })?.realmId).toBe('realm:x');
  });
});

describe('Phase 1 — order drafts obey the cell contract', () => {
  const PACKS: Array<{ protocol: keyof typeof CLINICAL_ACTION_MAPS; cells: CellManifest[] }> = [
    { protocol: 'adequacy', cells: ADEQUACY_CELLS },
    { protocol: 'fluid', cells: FLUID_CELLS },
    { protocol: 'access', cells: ACCESS_CELLS },
    { protocol: 'anemia', cells: ESA_CELLS },
    { protocol: 'mbd', cells: MBD_CELLS },
    { protocol: 'nutrition', cells: NUTRITION_CELLS },
    { protocol: 'infection', cells: INFECTION_CELLS },
  ];

  it.each(PACKS)('$protocol: an order draft may only emit what its cell allows', ({ protocol, cells }) => {
    for (const [token, spec] of Object.entries(CLINICAL_ACTION_MAPS[protocol])) {
      if (spec === null || spec.order === undefined) continue;
      const cell = cells.find((c) => c.id === spec.cellId);
      expect(cell, `${protocol}.${token} draft references unknown cell ${spec.cellId}`).toBeDefined();
      // A draft must not smuggle in an effect the cell is not allowed to perform.
      expect(
        cell!.allowedActions,
        `${protocol}.${token} drafts ${spec.order.effect} but ${spec.cellId} allows ${cell!.allowedActions.join(', ')}`,
      ).toContain(spec.order.effect);
    }
  });

  it('no order draft names its own patient — the bridge injects it from the finding', () => {
    for (const { protocol } of PACKS) {
      for (const [token, spec] of Object.entries(CLINICAL_ACTION_MAPS[protocol])) {
        if (spec === null || spec.order === undefined) continue;
        expect(
          Object.keys(spec.order.payload),
          `${protocol}.${token} hard-codes patientId in its order draft; the bridge must inject it`,
        ).not.toContain('patientId');
      }
    }
  });
});

describe('Phase 1 — the pack drafts the order', () => {
  const window = (over: Partial<EsaPatientWindow>): EsaPatientWindow => ({
    patientId: PATIENT,
    currentHgb: 9.4,
    onESA: true,
    currentDose: 8000,
    hgbTrendLast90d: [9.2, 9.4],
    esaEscalationsLast90d: 0,
    ferritin: 420,
    transferrinSat: 28,
    lastIronPanelAt: '2026-08-01T00:00:00.000Z',
    asOf: '2026-09-01T00:00:00.000Z',
    ...over,
  });

  it('a dose change drafts the order at the recommended dose', () => {
    const rec = esaRecommend(window({}));
    expect(rec.direction).toBe('increase');
    const [finding] = anemiaFindings([{ rec, realmId: 'realm:x' }]);
    expect(finding!.order).toEqual({
      effect: 'order-med',
      payload: {
        code: 'epoetin-alfa',
        dose: String(rec.recommendedDose),
        route: 'IV',
        frequency: 'weekly',
        indication: 'anemia',
      },
    });
  });

  it('an in-band hold drafts nothing — no paper trail of no-op orders', () => {
    const rec = esaRecommend(window({ currentHgb: 11.1, hgbTrendLast90d: [11.0, 11.1] }));
    expect(rec.direction).toBe('hold');
    const [finding] = anemiaFindings([{ rec }]);
    expect(finding!.order).toBeUndefined();
  });

  it('a guardrail block drafts nothing', () => {
    const rec = esaRecommend(window({ transferrinSat: 12, mcv: 74 }));
    expect(rec.direction).toBe('blocked');
    const [finding] = anemiaFindings([{ rec }]);
    expect(finding!.order).toBeUndefined();
  });
});
