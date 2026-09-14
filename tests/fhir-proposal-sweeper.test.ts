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

// F9.2/F9.3 — the wire, and the thing that acts on an expiry.
//
// Two properties this file exists to protect:
//
//  1. A `bound` proposal travels down the CONFIGURED connection. The first cut
//     published to the in-process emulator unconditionally, so an operator who
//     configured an EMR and set a kind to `bound` saw a "published" proposal and
//     no chart was ever touched. Fail closed beats fail quietly.
//  2. Expiry happens WITHOUT a human. A proposal expiry is only meaningful if
//     something retires it, and the retraction itself can fail — in which case
//     the proposal must stay open and be retried rather than be marked expired
//     while the stale draft sits in the EMR.

import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SWEEP_INTERVAL_MS,
  ProposalSweeper,
  expiredWithoutSweep,
} from '../src/server/proposal-sweeper.js';
import {
  EMULATOR_PATH_MARKER,
  clientProposalTransport,
  emulatorProposalTransport,
  isEmulatorConnection,
  isRetryableStatus,
  resolveProposalTransport,
  writePolicyFor,
} from '../src/server/proposal-transport.js';
import { authConfigForConnection } from '../src/fhir/auth.js';
import { FhirEmulator } from '../src/fhir/emulator.js';
import { ProposalPublisher, PROPOSAL_IDENTIFIER_SYSTEM, buildProposalResource } from '../src/fhir/proposal.js';
import { stableResourceId } from '../src/fhir/identity.js';
import type { FhirProposal, ProposalFilter, ProposalStore, ProposalTransport } from '../src/fhir/proposal.js';
import type { FhirIntegration } from '../src/swarm/workspace.js';
import type { SwarmWorkspaceStore } from '../src/swarm/workspace.js';
import type { FhirResource } from '../src/fhir/types.js';

/* ------------------------------------------------------------------ fixtures */

function connection(overrides: Partial<FhirIntegration> = {}): FhirIntegration {
  return {
    id: 'default',
    label: 'Riverbend · Epic production',
    realmId: 'realm:f9s',
    vendor: 'generic',
    baseUrl: 'https://emr.example.org/api/FHIR/R4',
    authMode: 'none',
    readEnabled: true,
    status: 'contract-verified',
    ...overrides,
  } as FhirIntegration;
}

function memoryStore() {
  const rows: FhirProposal[] = [];
  const store: ProposalStore & { rows: FhirProposal[] } = {
    rows,
    listProposals: async (filter: ProposalFilter = {}) =>
      rows.filter(
        (r) =>
          (filter.realmId === undefined || r.realmId === filter.realmId) &&
          (filter.lifecycle === undefined || r.lifecycle === filter.lifecycle) &&
          (filter.effectKind === undefined || r.effectKind === filter.effectKind) &&
          (filter.patientId === undefined || r.patientId === filter.patientId),
      ),
    saveProposal: async (p: FhirProposal) => {
      const at = rows.findIndex((r) => r.id === p.id);
      if (at >= 0) rows[at] = p;
      else rows.push(p);
      return p;
    },
  };
  return store;
}

/** A credential store that resolves nothing — enough to prove a connection needs one. */
const NO_SECRETS = {
  get: async () => undefined,
  set: async () => undefined,
  rotate: async () => ({ previousVersion: 0, newVersion: 1 }),
  list: async () => [],
};

const ALL_GOOD = { identityVerified: true, codesValidated: true, doseStructured: true, approvalRecorded: true, consentPermits: true };
const VENDOR = { supportsWrite: true, supportsProvenance: true };

function resource(effectId: string): FhirResource {
  return buildProposalResource({
    resourceType: 'MedicationRequest',
    id: stableResourceId(effectId),
    status: 'draft',
    intent: 'proposal',
    medicationCodeableConcept: { coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '105694' }] },
    subject: { reference: 'Patient: p' },
    dosageInstruction: [{ doseAndRate: [{ doseQuantity: { value: 10000, unit: 'U' } }] }],
  });
}

/**
 * A publisher whose only job is to leave one BOUND, PUBLISHED row behind.
 *
 * It seeds over its OWN always-succeeding transport rather than the one under
 * test. The seed is itself a send, so seeding through the transport being
 * examined is a trap: a failing transport never produces the published row the
 * test is premised on, a gated one hangs on the seed, and a recording one counts
 * the seed as a retraction.
 */
async function seedPublished(
  store: ProposalStore,
  effectId: string,
  at: string,
  now: string,
): Promise<FhirProposal> {
  const publisher = new ProposalPublisher(
    store,
    { async send() { return { ok: true, status: 200 }; } },
    () => now,
  );
  const outcome = await publisher.publish({
    realmId: 'realm:f9s',
    connectionId: 'default',
    effectId,
    effectKind: 'titrate-med',
    patientId: 'pt-1',
    resource: resource(effectId),
    preflight: ALL_GOOD,
    policy: 'bound',
    vendor: VENDOR,
    now: at,
  });
  expect(outcome.kind).toBe('published');
  return outcome.proposal;
}

/* ---------------------------------------------------- F9.2 — which wire */

describe('F9.2 · the transport is resolved from the CONFIGURED connection', () => {
  it('fails closed with no connection — "nowhere to send it" is never satisfied elsewhere', () => {
    const resolution = resolveProposalTransport({ emulator: new FhirEmulator() });
    expect(resolution.kind).toBe('none');
    if (resolution.kind === 'none') {
      expect(resolution.reason).toMatch(/no EMR connection is configured/);
      expect(resolution.reason).toMatch(/Platform → Integrations/);
    }
  });

  it('fails closed for a connection with an empty baseUrl (the seeded state)', () => {
    expect(resolveProposalTransport({ connection: connection({ baseUrl: '' }) }).kind).toBe('none');
  });

  it('prefers a real connection over the emulator, even when an emulator is supplied', () => {
    const resolution = resolveProposalTransport({
      connection: connection(),
      emulator: new FhirEmulator(),
      authCtx: { secrets: NO_SECRETS },
    });
    expect(resolution.kind).toBe('configured');
    if (resolution.kind === 'configured') {
      expect(resolution.baseUrl).toBe('https://emr.example.org/api/FHIR/R4');
      expect(resolution.label).toBe('Riverbend · Epic production');
      expect(resolution.connectionId).toBe('default');
    }
  });

  it('treats a /fhir-mock baseUrl as the emulator — the operator pointed it there on purpose', () => {
    expect(isEmulatorConnection(`http://127.0.0.1:3000${EMULATOR_PATH_MARKER}`)).toBe(true);
    expect(isEmulatorConnection('https://emr.example.org/api/FHIR/R4')).toBe(false);

    const emulator = new FhirEmulator();
    const resolution = resolveProposalTransport({
      connection: connection({ baseUrl: `http://127.0.0.1:3000${EMULATOR_PATH_MARKER}` }),
      emulator,
    });
    expect(resolution.kind).toBe('emulator');
    // No credential context is needed for our own double.
    if (resolution.kind === 'emulator') expect(resolution.transport).toBeDefined();
  });

  it('refuses a real connection with no credential context, rather than sending unauthenticated', () => {
    const resolution = resolveProposalTransport({ connection: connection() });
    expect(resolution.kind).toBe('none');
    if (resolution.kind === 'none') expect(resolution.reason).toMatch(/needs a credential context/);
  });

  it('an emulator connection with no emulator instance is a refusal, not a silent no-op', () => {
    const resolution = resolveProposalTransport({
      connection: connection({ baseUrl: `${EMULATOR_PATH_MARKER}` }),
    });
    expect(resolution.kind).toBe('none');
  });

  it('the emulator transport upserts, so a retry does not duplicate the draft', async () => {
    const emulator = new FhirEmulator();
    const transport = emulatorProposalTransport(emulator);
    const payload = resource('event:f9s-upsert');
    await transport.send({ resource: payload, resourceId: payload.id! });
    await transport.send({ resource: payload, resourceId: payload.id! });
    const stored = emulator.list().filter((r) => r.id === payload.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.resourceType).toBe('MedicationRequest');
  });
});

describe('F9.2 · retryability is a decision, not a guess', () => {
  it('treats a transport failure and a 5xx/408/429 as retryable', () => {
    for (const status of [undefined, 408, 425, 429, 500, 503]) {
      expect(isRetryableStatus(status), String(status)).toBe(true);
    }
  });

  it('treats a clinical rejection as final — retrying a 400 would just spam the vendor', () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(isRetryableStatus(status), String(status)).toBe(false);
    }
  });

  it('maps a client error to the retryable flag, so the outbox does not retry a 400 forever', async () => {
    const transport = clientProposalTransport({
      connection: connection(),
      authCtx: { secrets: NO_SECRETS },
      fetch: async () => new Response('{"resourceType":"OperationOutcome"}', { status: 400 }),
    });
    const result = await transport.send({ resource: resource('event:f9s-400'), resourceId: 'x' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a rejection');
    expect(result.status).toBe(400);
    expect(result.retryable).toBe(false);
  });
});

describe('F9.2 · the write policy defaults to the state that writes nothing', () => {
  it('defaults an absent kind to shadow, never to bound', () => {
    expect(writePolicyFor(connection(), 'titrate-med')).toBe('shadow');
    expect(writePolicyFor(null, 'titrate-med')).toBe('shadow');
    expect(writePolicyFor(undefined, 'titrate-med')).toBe('shadow');
  });

  it('honours an explicit per-kind policy', () => {
    expect(writePolicyFor(connection({ writePolicy: { 'titrate-med': 'bound' } }), 'titrate-med')).toBe('bound');
    expect(writePolicyFor(connection({ writePolicy: { 'order-lab': 'off' } }), 'order-lab')).toBe('off');
  });
});

describe('F9.2 · one auth config, shared with the contract test', () => {
  it('derives the mode from the connection rather than a second mapping', () => {
    expect(authConfigForConnection(connection({ authMode: 'none' })).mode).toBe('none');
    expect(authConfigForConnection(connection({ authMode: 'smart-backend-services', clientId: 'c1', privateKeyRef: 'binding:K', tokenEndpoint: 'https://t/token' })).mode)
      .toBe('smart-backend-services');
  });
});

/* -------------------------------------------------- F9.3 — the sweeper */

describe('F9.3 · nothing retires a stale proposal unless something runs', () => {
  it('expiredWithoutSweep finds exactly the open, out-of-time proposals', () => {
    const base = {
      connectionId: 'c', realmId: 'r', effectKind: 'titrate-med', patientId: 'p',
      resourceType: 'MedicationRequest', resourceJson: {}, intent: 'proposal' as const, status: 'draft' as const,
      identifierSystem: PROPOSAL_IDENTIFIER_SYSTEM, identifierValue: 'v', policy: 'bound' as const,
      degradation: 'direct' as const, attempts: 0, issues: [], createdAt: 'x', updatedAt: 'x',
    };
    const rows: FhirProposal[] = [
      { ...base, id: 'open-stale', effectId: 'e1', lifecycle: 'published' as const, expiresAt: '2026-09-13T09:00:00.000Z' },
      { ...base, id: 'open-fresh', effectId: 'e2', lifecycle: 'created' as const, expiresAt: '2026-09-13T12:00:00.000Z' },
      { ...base, id: 'already-expired', effectId: 'e3', lifecycle: 'expired' as const, expiresAt: '2026-09-13T09:00:00.000Z' },
      { ...base, id: 'accepted', effectId: 'e4', lifecycle: 'accepted' as const, expiresAt: '2026-09-13T09:00:00.000Z' },
    ];
    const due = expiredWithoutSweep(rows, '2026-09-13T10:00:00.000Z');
    expect(due.map((p) => p.id)).toEqual(['open-stale']);
  });

  it('expires and RETRACTS an out-of-time bound proposal — a stale draft must not outlive its moment', async () => {
    const store = memoryStore();
    const retracted: string[] = [];
    const transport: ProposalTransport = {
      async send({ resourceId }) {
        retracted.push(resourceId);
        return { ok: true, status: 200 };
      },
    };
    await seedPublished(store, 'event:f9s-stale', '2026-09-13T08:00:00.000Z', '2026-09-13T08:00:00.000Z');

    let clock = '2026-09-13T20:00:00.000Z'; // 12h later; titrate-med expires at 720m
    const sweeper = new ProposalSweeper({
      workspace: { proposalStore: () => store } as unknown as SwarmWorkspaceStore,
      resolveTransport: () => ({ kind: 'emulator', connectionId: 'default', label: 'test', baseUrl: 'http://x/fhir-mock', transport }),
      now: () => clock,
    });

    const report = await sweeper.sweepNow();
    expect(report.expired).toBe(1);
    expect(report.retracted).toBe(1);
    expect(report.deferred).toBe(0);
    expect(retracted).toHaveLength(1); // the vendor was actually told

    const row = store.rows[0]!;
    expect(row.lifecycle).toBe('expired');
    expect(row.retractedAt).toBe(clock);

    // Idempotent: an expired proposal is no longer open, so a second sweep is a no-op.
    clock = '2026-09-13T21:00:00.000Z';
    expect((await sweeper.sweepNow()).expired).toBe(0);
    expect(retracted).toHaveLength(1);
  });

  it('KEEPS a proposal open when the retraction fails — the stale draft is still in the EMR', async () => {
    const store = memoryStore();
    const transport: ProposalTransport = { async send() { return { ok: false, error: 'vendor 503', retryable: true }; } };
    await seedPublished(store, 'event:f9s-flaky', '2026-09-13T08:00:00.000Z', '2026-09-13T08:00:00.000Z');

    const sweeper = new ProposalSweeper({
      workspace: { proposalStore: () => store } as unknown as SwarmWorkspaceStore,
      resolveTransport: () => ({ kind: 'emulator', connectionId: 'default', label: 'test', baseUrl: 'http://x/fhir-mock', transport }),
      now: () => '2026-09-13T20:00:00.000Z',
    });

    const report = await sweeper.sweepNow();
    expect(report.expired).toBe(0);
    expect(report.retracted).toBe(0);
    expect(report.deferred).toBe(1);
    expect(report.deferredReasons[0]).toMatch(/vendor 503/);

    const row = store.rows[0]!;
    // Still open, so the next sweep tries again. Marking it expired here would
    // stop us looking at a draft that is still sitting in the chart.
    expect(row.lifecycle).toBe('published');
    expect(row.retractionReason).toMatch(/retraction-failed/);
    expect(expiredWithoutSweep(store.rows, '2026-09-13T21:00:00.000Z')).toHaveLength(1);
  });

  it('resolves the transport PER SWEEP, so a connection fixed after boot is honoured', async () => {
    const store = memoryStore();
    const transport: ProposalTransport = { async send() { return { ok: true, status: 200 }; } };
    await seedPublished(store, 'event:f9s-late', '2026-09-13T08:00:00.000Z', '2026-09-13T08:00:00.000Z');

    const calls: string[] = [];
    let kind: 'none' | 'emulator' = 'none';
    const sweeper = new ProposalSweeper({
      workspace: { proposalStore: () => store } as unknown as SwarmWorkspaceStore,
      resolveTransport: () => {
        calls.push(kind);
        return kind === 'none'
          ? { kind: 'none', reason: 'no EMR connection is configured' }
          : { kind: 'emulator', connectionId: 'default', label: 'test', baseUrl: 'http://x/fhir-mock', transport };
      },
      now: () => '2026-09-13T20:00:00.000Z',
    });

    // First sweep: nowhere to send the retraction, so the row must NOT expire.
    const first = await sweeper.sweepNow();
    expect(first.transport).toBe('none');
    expect(first.transportReason).toMatch(/no EMR connection/);
    expect(first.expired).toBe(0);
    expect(first.deferred).toBe(1);

    // Operator configures the connection. No restart, no re-construction.
    kind = 'emulator';
    const second = await sweeper.sweepNow();
    expect(second.transport).toBe('emulator');
    expect(second.expired).toBe(1);
    expect(second.retracted).toBe(1);
    expect(calls).toEqual(['none', 'emulator']);
  });

  it('is single-flight — a slow sweep must not stack up behind itself', async () => {
    const store = memoryStore();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const transport: ProposalTransport = {
      async send() { await gate; return { ok: true, status: 200 }; },
    };
    await seedPublished(store, 'event:f9s-slow', '2026-09-13T08:00:00.000Z', '2026-09-13T08:00:00.000Z');

    const sweeper = new ProposalSweeper({
      workspace: { proposalStore: () => store } as unknown as SwarmWorkspaceStore,
      resolveTransport: () => ({ kind: 'emulator', connectionId: 'default', label: 'test', baseUrl: 'http://x/fhir-mock', transport }),
      now: () => '2026-09-13T20:00:00.000Z',
    });

    const first = sweeper.sweepNow();
    const second = await sweeper.sweepNow(); // returns the in-flight marker, does not run
    expect(second.transportReason).toMatch(/already in flight/);
    expect(sweeper.status().inFlight).toBe(true);

    release!();
    await first;
    expect(sweeper.status().inFlight).toBe(false);
    expect(sweeper.status().sweeps).toBe(1);
  });

  it('start() is idempotent and stop() is clean; neither leaks a handle', () => {
    const sweeper = new ProposalSweeper({
      workspace: { proposalStore: () => memoryStore() } as unknown as SwarmWorkspaceStore,
      resolveTransport: () => ({ kind: 'none', reason: 'x' }),
      intervalMs: 60_000,
    });
    expect(sweeper.status().running).toBe(false);
    sweeper.start();
    sweeper.start(); // twice must not create two timers
    expect(sweeper.status().running).toBe(true);
    expect(sweeper.status().intervalMs).toBe(60_000);
    sweeper.stop();
    sweeper.stop();
    expect(sweeper.status().running).toBe(false);
  });

  it('a sweep that dies is recorded and rethrown, and the timer survives it', async () => {
    const sweeper = new ProposalSweeper({
      workspace: {
        proposalStore: () => { throw new Error('store offline'); },
      } as unknown as SwarmWorkspaceStore,
      resolveTransport: () => ({ kind: 'none', reason: 'x' }),
      now: () => '2026-09-13T20:00:00.000Z',
    });
    await expect(sweeper.sweepNow()).rejects.toThrow(/store offline/);
    expect(sweeper.status().lastError).toMatch(/store offline/);
    expect(sweeper.status().inFlight).toBe(false); // the next interval still runs
  });

  it('defaults to a five-minute interval', () => {
    expect(DEFAULT_SWEEP_INTERVAL_MS).toBe(5 * 60 * 1000);
  });
});
