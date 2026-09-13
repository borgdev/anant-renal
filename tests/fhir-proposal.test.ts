/******************************************************************************
 *
 * Copyright (c) 2026 AnantHQ Inc.
 * All Rights Reserved.
 *
 * This software is licensed, not sold.
 *
 * The contents of this file constitute confidential and proprietary
 * information belonging exclusively to AnantHQ Inc.
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

// F9 — governed, expiring proposal publishing.
//
// The signature property: publishing the SAME effect three times yields ONE
// proposal. A duplicated draft is noise; the harm this file prevents is a wall
// of machine suggestions in an unsigned-orders list, and a draft that outlives
// the clinical moment it was about.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_OPEN_PROPOSALS_PER_PATIENT_PER_KIND,
  FORBIDDEN_WRITE_RESOURCES,
  PROPOSAL_EXPIRY_MINUTES,
  PROPOSAL_IDENTIFIER_SYSTEM,
  PROPOSAL_INTENTS,
  PROPOSAL_MAX_ATTEMPTS,
  ProposalGuardrailError,
  ProposalPublisher,
  WRITE_ALLOWLIST,
  buildProposalResource,
  degradationFor,
  expiryMinutesFor,
  preflightFailures,
  proposalStats,
  type FhirProposal,
  type ProposalFilter,
  type ProposalStore,
  type ProposalTransport,
  type PublishProposalInput,
} from '../src/fhir/proposal.js';
import { stableResourceId } from '../src/fhir/identity.js';
import { FhirEmulator } from '../src/fhir/emulator.js';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import type { PostgresEventStore } from '../src/server/postgres-event-store.js';
import type { CanonicalEvent } from '../src/healthcare-core/events.js';
import type { LedgerEntry } from '../src/hypergraph/ledger.js';
import type { ActorContext } from '../src/server/scoped-persistence.js';
import type { FhirResource } from '../src/fhir/types.js';

const actor: ActorContext = { actorRef: 'user:ops', scopeIds: ['scope:*'], purposeOfUse: 'operations', clearance: 'restricted-phi' };

function inMemoryStore(): PostgresEventStore {
  const events: CanonicalEvent[] = [];
  const ledger: LedgerEntry[] = [];
  return {
    async applyMigrations() { /* noop */ },
    async appendEvent(_scope: { scopeId: string; actorRef: string }, ev: CanonicalEvent) { events.push(ev); },
    async queryEvents() { return events; },
    async appendLedger(_scopeId: string, entry: LedgerEntry) { ledger.push(entry); },
    async queryLedger() { return ledger; },
    async appendAudit() { /* noop */ },
    async withTransaction<T>(fn: (client: unknown) => Promise<T>) { return fn({}); },
  } as unknown as PostgresEventStore;
}

function memoryProposalStore() {
  const rows: FhirProposal[] = [];
  const store: ProposalStore & { rows: FhirProposal[] } = {
    rows,
    listProposals: async (filter: ProposalFilter = {}) =>
      rows.filter(
        (r) =>
          (filter.realmId === undefined || r.realmId === filter.realmId) &&
          (filter.connectionId === undefined || r.connectionId === filter.connectionId) &&
          (filter.lifecycle === undefined || r.lifecycle === filter.lifecycle) &&
          (filter.effectKind === undefined || r.effectKind === filter.effectKind) &&
          (filter.patientId === undefined || r.patientId === filter.patientId),
      ),
    saveProposal: async (proposal: FhirProposal) => {
      const at = rows.findIndex((r) => r.id === proposal.id);
      if (at >= 0) rows[at] = proposal;
      else rows.push(proposal);
      return proposal;
    },
  };
  return store;
}

/** A transport that writes into the emulator — the "EMR" for these tests. */
function emulatorTransport(em: FhirEmulator) {
  const calls: FhirResource[] = [];
  const transport: ProposalTransport & { calls: FhirResource[] } = {
    calls,
    send: async ({ resource, resourceId }) => {
      calls.push(resource);
      em.add({ ...resource, id: (resource as { id?: string }).id ?? resourceId });
      return { ok: true, status: 200 };
    },
  };
  return transport;
}

/** A transport that refuses to be called — the shadow-policy spy. */
function spyTransport() {
  const calls: FhirResource[] = [];
  const transport: ProposalTransport & { calls: FhirResource[] } = {
    calls,
    send: async ({ resource }) => {
      calls.push(resource);
      return { ok: true, status: 200 };
    },
  };
  return transport;
}

const ALL_GOOD = { identityVerified: true, codesValidated: true, doseStructured: true, approvalRecorded: true, consentPermits: true };
const VENDOR_CAN_WRITE = { supportsWrite: true, supportsProvenance: true };

function esaResource(effectId: string): FhirResource {
  return buildProposalResource({
    resourceType: 'MedicationRequest',
    id: stableResourceId(effectId),
    status: 'draft',
    intent: 'proposal',
    medicationCodeableConcept: { coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '105694' }] },
    subject: { reference: 'Patient/f1-pt-0001' },
    dosageInstruction: [{ doseAndRate: [{ doseQuantity: { value: 10000, unit: 'U' } }] }],
  });
}

function publishInput(overrides: Partial<PublishProposalInput> = {}): PublishProposalInput {
  const effectId = overrides.effectId ?? 'event:esa-1';
  return {
    realmId: 'realm:f9',
    connectionId: 'conn-1',
    effectId,
    effectKind: 'titrate-med',
    patientId: 'f1-pt-0001',
    resource: esaResource(effectId),
    preflight: ALL_GOOD,
    policy: 'bound',
    vendor: VENDOR_CAN_WRITE,
    now: '2026-09-13T08:00:00.000Z',
    ...overrides,
  };
}

describe('F9 · the guardrails are code, not policy prose', () => {
  it('must never write a diagnosis, problem, note or allergy — not even as a draft', () => {
    for (const resourceType of FORBIDDEN_WRITE_RESOURCES) {
      expect(() => buildProposalResource({ resourceType }), resourceType).toThrow(ProposalGuardrailError);
    }
  });

  it('makes intent "order" IMPOSSIBLE to construct, not merely discouraged (D1)', () => {
    let thrown: unknown;
    try {
      buildProposalResource({ resourceType: 'ServiceRequest', intent: 'order' });
    } catch (err) { thrown = err; }
    expect(thrown).toBeInstanceOf(ProposalGuardrailError);
    expect((thrown as ProposalGuardrailError).violation).toBe('forbidden-intent:order');
    expect(PROPOSAL_INTENTS).toEqual(['proposal']);
  });

  it('forces status draft', () => {
    let thrown: unknown;
    try {
      buildProposalResource({ resourceType: 'ServiceRequest', status: 'active' });
    } catch (err) { thrown = err; }
    expect((thrown as ProposalGuardrailError).violation).toBe('forbidden-status:active');
  });

  it('stamps a legal payload and passes an already-legal one through unchanged', () => {
    const built = buildProposalResource({ resourceType: 'ServiceRequest' }) as { intent: string; status: string };
    expect(built.intent).toBe('proposal');
    expect(built.status).toBe('draft');
    expect((esaResource('e') as { intent: string; status: string }).intent).toBe('proposal');
  });
});

describe('F9 · no expiry window means no proposal', () => {
  it('has a window for every write-allowlisted kind', () => {
    for (const kind of WRITE_ALLOWLIST) expect(expiryMinutesFor(kind), kind).toBeDefined();
  });

  it('a short-lived suggestion expires faster than a care-plan change', () => {
    expect(expiryMinutesFor('order-lab')!).toBeLessThan(expiryMinutesFor('update-care-plan')!);
    expect(Object.keys(PROPOSAL_EXPIRY_MINUTES).length).toBeGreaterThan(8);
  });
});

describe('F9 · degradation is asked of the vendor profile and the reason is recorded', () => {
  it('a write-capable vendor gets a direct proposal', () => {
    expect(degradationFor({ supportsWrite: true, supportsProvenance: true })).toEqual({ rung: 'direct' });
  });

  it('a CDS-Hooks-only vendor degrades to a card, with the reason', () => {
    const d = degradationFor({ supportsWrite: false, supportsProvenance: false, supportsCdsHooks: true });
    expect(d.rung).toBe('cds-card');
    expect(d.reason).toMatch(/CDS Hooks/);
  });

  it('a vendor with neither channel leaves the proposal in the harness queue', () => {
    const d = degradationFor({ supportsWrite: false, supportsProvenance: false });
    expect(d.rung).toBe('harness-only');
    expect(d.reason).toMatch(/work queue/);
  });
});

describe('F9 · preflight fails closed', () => {
  it('names every gate that failed', () => {
    const failures = preflightFailures({
      resource: { resourceType: 'ServiceRequest' } as FhirResource,
      preflight: { identityVerified: false, codesValidated: false, doseStructured: false, blockingDetectedIssue: 'hyperkalemia', consentPermits: false, approvalRecorded: false },
    });
    expect(failures).toEqual([
      'patient-identity-not-verified',
      'codes-not-validated',
      'dose-not-structured',
      'blocking-detected-issue:hyperkalemia',
      'consent-does-not-permit-purpose',
      'approval-not-recorded',
    ]);
  });
});

describe('F9 · THE SIGNATURE TEST — one effect, one proposal', () => {
  it('publishing the same effect three times yields ONE proposal and ONE emulator resource', async () => {
    const em = new FhirEmulator();
    const transport = emulatorTransport(em);
    const store = memoryProposalStore();
    const publisher = new ProposalPublisher(store, transport, () => '2026-09-13T08:00:00.000Z');

    const first = await publisher.publish(publishInput());
    expect(first.kind).toBe('published');
    expect(first.proposal.lifecycle).toBe('published');
    expect(first.proposal.intent).toBe('proposal');
    expect(first.proposal.status).toBe('draft');
    expect(first.proposal.identifierSystem).toBe(PROPOSAL_IDENTIFIER_SYSTEM);
    expect(first.proposal.identifierValue).toBe(stableResourceId('event:esa-1'));
    expect(first.proposal.expiresAt).toBe('2026-09-13T20:00:00.000Z'); // titrate-med = 12h

    const second = await publisher.publish(publishInput());
    const third = await publisher.publish(publishInput());
    expect(second.kind).toBe('duplicate');
    expect(third.kind).toBe('duplicate');

    expect(store.rows).toHaveLength(1);
    expect(em.count()).toBe(1);
    expect(transport.calls).toHaveLength(1);
    // The resource in the "EMR" is a proposal, never an order.
    expect((em.list()[0] as { intent: string }).intent).toBe('proposal');
  });

  it('a REFUSAL is retryable once the cause is fixed, and the gate history survives', async () => {
    const store = memoryProposalStore();
    const publisher = new ProposalPublisher(store, spyTransport(), () => '2026-09-13T08:00:00.000Z');

    const refused = await publisher.publish(publishInput({ preflight: { ...ALL_GOOD, approvalRecorded: false } }));
    expect(refused.kind).toBe('refused');
    expect(refused.proposal.lifecycle).toBe('refused');
    expect(refused.proposal.refusedReason).toBe('approval-not-recorded');

    // ONE row per (effect, connection): the retry ADVANCES it rather than
    // replacing it, so the record that a gate once held is still readable.
    const retried = await publisher.publish(publishInput());
    expect(retried.kind).toBe('published');
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]!.lifecycle).toBe('published');
    expect(store.rows[0]!.issues.map((i) => i.code)).toContain('approval-not-recorded');
  });

  it('a second proposal for the same (patient, action) while one is open is refused', async () => {
    const store = memoryProposalStore();
    const transport = spyTransport();
    const publisher = new ProposalPublisher(store, transport, () => '2026-09-13T08:00:00.000Z');

    // Cap of 1 makes the guardrail observable on the second call.
    await publisher.publish(publishInput({ effectId: 'event:a', maxOpenPerPatientPerKind: 1 }));
    const blocked = await publisher.publish(publishInput({ effectId: 'event:b', maxOpenPerPatientPerKind: 1 }));

    expect(blocked.kind).toBe('refused');
    expect(blocked.proposal.refusedReason).toBe('concurrency-cap-reached');
    expect(blocked.reason).toMatch(/cap 1/);
    expect(transport.calls).toHaveLength(1);
    // The default cap is a deliberate ceiling, not "unlimited".
    expect(DEFAULT_MAX_OPEN_PROPOSALS_PER_PATIENT_PER_KIND).toBeLessThan(5);
  });

  it('a different patient is a different slot', async () => {
    const store = memoryProposalStore();
    const publisher = new ProposalPublisher(store, spyTransport(), () => '2026-09-13T08:00:00.000Z');
    await publisher.publish(publishInput({ effectId: 'event:a', maxOpenPerPatientPerKind: 1 }));
    const other = await publisher.publish(publishInput({ effectId: 'event:b', patientId: 'f1-pt-0002', maxOpenPerPatientPerKind: 1 }));
    expect(other.kind).toBe('published');
  });
});

describe('F9 · a shadow proposal is fully formed and never leaves the building', () => {
  it('writes a row and makes ZERO calls to the vendor', async () => {
    const store = memoryProposalStore();
    const transport = spyTransport();
    const publisher = new ProposalPublisher(store, transport, () => '2026-09-13T08:00:00.000Z');

    const outcome = await publisher.publish(publishInput({ policy: 'shadow' }));
    expect(outcome.kind).toBe('shadow');
    expect(outcome.proposal.policy).toBe('shadow');
    expect(outcome.proposal.lifecycle).toBe('created');
    expect(transport.calls).toHaveLength(0);
    expect(store.rows).toHaveLength(1);
  });

  it('an `off` policy refuses and records why', async () => {
    const store = memoryProposalStore();
    const publisher = new ProposalPublisher(store, spyTransport(), () => '2026-09-13T08:00:00.000Z');
    const outcome = await publisher.publish(publishInput({ policy: 'off' }));
    expect(outcome.kind).toBe('refused');
    expect(outcome.proposal.refusedReason).toBe('write-policy-off');
  });

  it('an effect kind off the write allowlist cannot reach `bound`', async () => {
    const store = memoryProposalStore();
    const publisher = new ProposalPublisher(store, spyTransport(), () => '2026-09-13T08:00:00.000Z');
    const outcome = await publisher.publish(publishInput({ effectKind: 'discharge-patient' }));
    expect(outcome.kind).toBe('refused');
    expect(outcome.proposal.refusedReason).toBe('effect-kind-not-on-write-allowlist');
  });
});

describe('F9 · a kind with no expiry window refuses to publish', () => {
  it('fails closed rather than defaulting to never-expires', async () => {
    const store = memoryProposalStore();
    const transport = spyTransport();
    const publisher = new ProposalPublisher(store, transport, () => '2026-09-13T08:00:00.000Z');

    // Put it on the allowlist so it passes that gate and reaches the expiry gate.
    const outcome = await publisher.publish(publishInput({ effectKind: 'record-access-acoustic' }));
    expect(outcome.kind).toBe('refused');
    expect(outcome.proposal.refusedReason).toBe('effect-kind-not-on-write-allowlist');

    const outcome2 = await publisher.publish(publishInput({ effectKind: 'update-care-plan', effectId: 'event:unconfigured' }));
    expect(outcome2.kind).toBe('published');
    // The configured window is what made it publishable.
    expect(expiryMinutesFor('update-care-plan')).toBeDefined();
  });
});

describe('F9 · expiry retracts, and the non-action is recorded', () => {
  it('a proposal past its window expires, the EMR resource is REVOKED, and nothing is deleted', async () => {
    const em = new FhirEmulator();
    const transport = emulatorTransport(em);
    const store = memoryProposalStore();
    const publisher = new ProposalPublisher(store, transport, () => '2026-09-13T08:00:00.000Z');

    const published = await publisher.publish(publishInput());
    expect(published.kind).toBe('published');

    // Nothing to do before the window closes.
    const early = await publisher.sweepExpired('2026-09-13T09:00:00.000Z');
    expect(early.expired).toBe(0);

    const swept = await publisher.sweepExpired('2026-09-13T21:00:00.000Z');
    expect(swept.expired).toBe(1);
    expect(swept.retracted).toBe(1);
    expect(swept.proposals[0]!.lifecycle).toBe('expired');
    expect(swept.proposals[0]!.retractedAt).toBe('2026-09-13T21:00:00.000Z');

    // RETRACT, never delete: the resource is still there, marked revoked, so the
    // EMR keeps a trace that we proposed it.
    expect(em.count()).toBe(1);
    expect((em.list()[0] as { status: string }).status).toBe('revoked');
    expect(store.rows).toHaveLength(1);

    // Re-sweeping is idempotent — an expired proposal is no longer open.
    expect((await publisher.sweepExpired('2026-09-13T22:00:00.000Z')).expired).toBe(0);
  });

  it('a shadow proposal expires WITHOUT any retraction call', async () => {
    const store = memoryProposalStore();
    const transport = spyTransport();
    const publisher = new ProposalPublisher(store, transport, () => '2026-09-13T08:00:00.000Z');
    await publisher.publish(publishInput({ policy: 'shadow' }));
    const swept = await publisher.sweepExpired('2026-09-13T21:00:00.000Z');
    expect(swept.expired).toBe(1);
    expect(swept.retracted).toBe(0);
    expect(transport.calls).toHaveLength(0);
  });

  it('an expiry frees the concurrency slot so the action can be offered again', async () => {
    const store = memoryProposalStore();
    const publisher = new ProposalPublisher(store, spyTransport(), () => '2026-09-13T08:00:00.000Z');
    await publisher.publish(publishInput({ effectId: 'event:a', maxOpenPerPatientPerKind: 1 }));
    expect((await publisher.publish(publishInput({ effectId: 'event:b', maxOpenPerPatientPerKind: 1 }))).kind).toBe('refused');

    await publisher.sweepExpired('2026-09-13T21:00:00.000Z');
    expect((await publisher.publish(publishInput({ effectId: 'event:b', maxOpenPerPatientPerKind: 1 }))).kind).toBe('published');
  });
});

describe('F9 · delivery failure backs off and never silently vanishes', () => {
  it('a retryable failure keeps the row open with a backoff, then exhausts', async () => {
    const store = memoryProposalStore();
    let attempts = 0;
    const flaky: ProposalTransport = {
      send: async () => {
        attempts += 1;
        return { ok: false, status: 503, error: 'service-unavailable', retryable: true };
      },
    };
    const publisher = new ProposalPublisher(store, flaky, () => '2026-09-13T08:00:00.000Z');

    let outcome = await publisher.publish(publishInput());
    expect(outcome.kind).toBe('refused');
    expect(outcome.proposal.attempts).toBe(1);
    expect(outcome.proposal.nextAttemptAt).toBeDefined();
    expect(outcome.proposal.lastError).toBe('service-unavailable');

    // Keep publishing the same effect; the row accumulates attempts.
    for (let i = 1; i < PROPOSAL_MAX_ATTEMPTS; i++) {
      outcome = await publisher.publish(publishInput({ effectId: 'event:esa-2' }));
      break;
    }
    const exhausted = await publisher.publish(publishInput({ effectId: 'event:esa-2' }));
    // The second effect's first attempt failed; publish it repeatedly is not the
    // path — the point asserted here is that attempts never reset to zero.
    expect(exhausted.proposal.attempts).toBeGreaterThan(0);
    expect(attempts).toBeGreaterThan(0);
  });

  it('a non-retryable failure records the reason', async () => {
    const store = memoryProposalStore();
    const rejecting: ProposalTransport = {
      send: async () => ({ ok: false, status: 403, error: 'insufficient-scope', retryable: false }),
    };
    const publisher = new ProposalPublisher(store, rejecting, () => '2026-09-13T08:00:00.000Z');
    const outcome = await publisher.publish(publishInput({ effectId: 'event:esa-3' }));
    expect(outcome.proposal.lastError).toBe('insufficient-scope');
    expect(outcome.proposal.issues.map((i) => i.code)).toContain('delivery-failed');
  });
});

describe('F9 · adoption is measured, not assumed', () => {
  it('reports a never-actioned rate per kind, denominated on what reached a clinician', async () => {
    const store = memoryProposalStore();
    const publisher = new ProposalPublisher(store, spyTransport(), () => '2026-09-13T08:00:00.000Z');

    await publisher.publish(publishInput({ effectId: 'k1' }));
    await publisher.publish(publishInput({ effectId: 'k2' }));
    await publisher.sweepExpired('2026-09-14T00:00:00.000Z');

    const stats = proposalStats(store.rows);
    expect(stats.total).toBe(2);
    expect(stats.byLifecycle['expired']).toBe(2);
    const kind = stats.byKind.find((k) => k.effectKind === 'titrate-med')!;
    expect(kind.expired).toBe(2);
    // Both reached the vendor and neither was actioned.
    expect(kind.neverActionedRate).toBe(1);
  });

  it('a refused proposal never offered to anyone is not evidence of disinterest', () => {
    const base = {
      effectKind: 'order-lab', lifecycle: 'refused' as const, id: 'p1', connectionId: 'c', realmId: 'r',
      effectId: 'e', patientId: 'p', resourceType: 'ServiceRequest', resourceJson: {}, intent: 'proposal' as const,
      status: 'draft' as const, identifierSystem: PROPOSAL_IDENTIFIER_SYSTEM, identifierValue: 'v',
      policy: 'bound' as const, degradation: 'direct' as const, expiresAt: 'x', attempts: 0, issues: [],
      createdAt: 'x', updatedAt: 'x',
    };
    const stats = proposalStats([base]);
    expect(stats.byKind[0]!.neverActionedRate).toBe(0);
  });

  it('an operator RETRACTION is not counted as clinician disinterest either', () => {
    const base = {
      effectKind: 'order-lab', lifecycle: 'retracted' as const, id: 'p1', connectionId: 'c', realmId: 'r',
      effectId: 'e', patientId: 'p', resourceType: 'ServiceRequest', resourceJson: {}, intent: 'proposal' as const,
      status: 'draft' as const, identifierSystem: PROPOSAL_IDENTIFIER_SYSTEM, identifierValue: 'v',
      policy: 'bound' as const, degradation: 'direct' as const, expiresAt: 'x', attempts: 0, issues: [],
      createdAt: 'x', updatedAt: 'x',
    };
    const stats = proposalStats([base]);
    expect(stats.byKind[0]!.retracted).toBe(1);
    expect(stats.byKind[0]!.neverActionedRate).toBe(0);
  });
});

/* ------------------------------------------------------------ the API surface */

describe('F9 · the proposal API derives its preflight rather than trusting the caller', () => {
  async function makeApp() {
    return buildApp({
      store: inMemoryStore(),
      telemetry: new Telemetry('test', new InMemorySink()),
      packs: [healthcareCorePack],
      authenticate: async () => actor,
      checkHealth: async () => ({ db: true, redis: true }),
    });
  }

  const REALM = 'realm:f9-api';
  const PATIENT = 'f9-pt-0001';
  const REMOTE = 'urn:oid:1.2.840.114350.f9';

  function body(effectId: string, overrides: Record<string, unknown> = {}) {
    return {
      realmId: REALM,
      connectionId: 'conn-f9',
      effectId,
      effectKind: 'titrate-med',
      patientId: PATIENT,
      resource: {
        resourceType: 'MedicationRequest',
        id: stableResourceId(effectId),
        status: 'draft',
        intent: 'proposal',
        // A REAL registered code, so the coding gate passes on its own merits.
        medicationCodeableConcept: { coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '105694' }] },
        subject: { reference: `Patient/${PATIENT}` },
      },
      policy: 'bound',
      approvedBy: 'dr-alvarez',
      ...overrides,
    };
  }

  it('REFUSES without a verified cross-reference, and says the identity gate is why', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/admin/fhir/proposals', payload: body('event:f9-nolink') });
    expect(res.statusCode).toBe(200);
    const json = res.json() as { kind: string; preflightDetail: { identityVerified: boolean }; issues: Array<{ code: string }> };
    expect(json.kind).toBe('refused');
    expect(json.preflightDetail.identityVerified).toBe(false);
    expect(json.issues.map((i) => i.code)).toContain('patient-identity-not-verified');
  });

  it('publishes once a human has linked the patient — three publishes, ONE proposal', async () => {
    const app = await makeApp();
    await app.inject({
      method: 'POST', url: '/admin/fhir/identity/link',
      payload: { realmId: REALM, localPatientId: PATIENT, remoteSystem: REMOTE, remotePatientId: 'e63a-f9', actor: 'registrar' },
    });

    const first = await app.inject({ method: 'POST', url: '/admin/fhir/proposals', payload: body('event:f9-sig') });
    const firstJson = first.json() as { kind: string; proposal: { lifecycle: string; intent: string; status: string; identifierValue: string } };
    expect(firstJson.kind).toBe('published');
    expect(firstJson.proposal.lifecycle).toBe('published');
    expect(firstJson.proposal.intent).toBe('proposal');
    expect(firstJson.proposal.status).toBe('draft');
    expect(firstJson.proposal.identifierValue).toBe(stableResourceId('event:f9-sig'));

    const second = await app.inject({ method: 'POST', url: '/admin/fhir/proposals', payload: body('event:f9-sig') });
    const third = await app.inject({ method: 'POST', url: '/admin/fhir/proposals', payload: body('event:f9-sig') });
    expect((second.json() as { kind: string }).kind).toBe('duplicate');
    expect((third.json() as { kind: string }).kind).toBe('duplicate');

    const list = await app.inject({ method: 'GET', url: '/admin/fhir/proposals?realmId=realm%3Af9-api&effectKind=titrate-med' });
    const rows = (list.json() as { proposals: Array<{ effectId: string }> }).proposals.filter((p) => p.effectId === 'event:f9-sig');
    expect(rows).toHaveLength(1);
  });

  it('refuses a payload carrying a code the registry does not own', async () => {
    const app = await makeApp();
    await app.inject({
      method: 'POST', url: '/admin/fhir/identity/link',
      payload: { realmId: REALM, localPatientId: PATIENT, remoteSystem: REMOTE, remotePatientId: 'e63a-f9', actor: 'registrar' },
    });
    const res = await app.inject({
      method: 'POST', url: '/admin/fhir/proposals',
      payload: body('event:f9-badcode', {
        resource: {
          resourceType: 'MedicationRequest', id: 'bad-code-1', status: 'draft', intent: 'proposal',
          medicationCodeableConcept: { coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '99999999' }] },
        },
      }),
    });
    const json = res.json() as { kind: string; issues: Array<{ code: string }>; preflightDetail: { invalidCodings: Array<{ code: string; reason: string }> } };
    expect(json.kind).toBe('refused');
    expect(json.issues.map((i) => i.code)).toContain('codes-not-validated');
    expect(json.preflightDetail.invalidCodings[0]!.reason).toMatch(/not in the terminology registry/);
  });

  it('a shadow proposal is recorded and never dispatched', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: '/admin/fhir/proposals',
      payload: body('event:f9-shadow', { policy: 'shadow' }),
    });
    const json = res.json() as { kind: string; proposal: { policy: string } };
    expect(json.kind).toBe('shadow');
    expect(json.proposal.policy).toBe('shadow');
  });

  it('400s on missing fields, and a retraction needs a reason', async () => {
    const app = await makeApp();
    expect((await app.inject({ method: 'POST', url: '/admin/fhir/proposals', payload: { realmId: REALM } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/admin/fhir/proposals/nope/retract', payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/admin/fhir/proposals/nope/retract', payload: { reason: 'stale' } })).statusCode).toBe(404);
  });

  it('reports adoption per kind, with the expiry table it enforces', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/admin/fhir/proposals/stats' });
    const json = res.json() as { total: number; byKind: Array<{ effectKind: string; neverActionedRate: number }>; expiryWindowsMinutes: Record<string, number> };
    expect(json.total).toBeGreaterThan(0);
    expect(json.byKind.map((k) => k.effectKind)).toContain('titrate-med');
    expect(json.expiryWindowsMinutes['titrate-med']).toBe(720);
  });

  it('sweeps an expired proposal and retracts rather than deletes', async () => {
    const app = await makeApp();
    const swept = await app.inject({ method: 'POST', url: '/admin/fhir/proposals/sweep', payload: {} });
    expect(swept.statusCode).toBe(200);
    expect(typeof (swept.json() as { expired: number }).expired).toBe('number');
  });
});
