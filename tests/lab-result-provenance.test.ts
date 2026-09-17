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

// `result-lab` provenance — the two S3 defects that made ingested laboratories
// unreachable from a patient and stamped with the wrong day.
//
// Both were deferred with a named fix in §5 S3 of
// docs/synthea-population-integration.md and are closed here.

import { describe, expect, it } from 'vitest';
import { Realm } from '../src/realm/realm.js';
import { effectToFhirResource } from '../src/fhir/effect-map.js';
import type { FhirCtx } from '../src/fhir/types.js';
import type { AgentPresence } from '../src/realm/types.js';

const OBSERVED_AT = '2026-01-05T09:30:00.000Z';

function ctxOf(realmId: string): FhirCtx {
  return {
    realmId,
    facilityId: 'f1',
    scopeId: `scope:${realmId}`,
    ingestedAt: '2026-09-17T00:00:00.000Z',
  } as unknown as FhirCtx;
}

function makeRealm(): { realm: Realm; presence: AgentPresence } {
  const realm = new Realm({ id: 'realm:lp', mode: 'sim' });
  const presence = realm.spawnPresence({
    agentSpecId: 'lab-tech',
    runId: 'run-lp',
    role: 'md',
    clearance: 'restricted-phi',
    purposeOfUse: ['treatment'],
    location: { facilityId: 'f1', unitId: 'U1' },
  });
  return { realm, presence };
}

describe('result-lab provenance (S3 deferred items)', () => {
  // The orphan. A bare `Observation` produces no `ServiceRequest`, so there was no order
  // to answer and the patient was never written — a graph walk for a patient's labs found
  // nothing, which is why S3 summarises patients from the bundle instead of the graph.
  it('writes the patient onto the result, so a bare observation is reachable', () => {
    const { realm, presence } = makeRealm();
    realm.emit(presence.presenceId, {
      kind: 'result-lab', orderId: 'obs-1', code: '718-7', value: 9.1, unit: 'g/dL', patientId: 'p1',
    });

    const results = realm.graph.listKind('result');
    expect(results).toHaveLength(1);
    expect((results[0]!.state as { patientId?: string }).patientId).toBe('p1');
    // …and the walk a consumer actually performs finds it, rather than merely holding a
    // field nothing would read.
    const forPatient = results.filter((r) => (r.state as { patientId?: string }).patientId === 'p1');
    expect(forPatient).toHaveLength(1);
  });

  // The instant. Every ingested or backfilled result used to be stamped with the moment
  // the ingest ran, so a realm seeded from a 90-day history showed every laboratory drawn
  // on the same day. The value was on the wire the whole time — the Observation cast in
  // `canonical.ts` simply did not list `effectiveDateTime`, so it was dropped at the
  // boundary.
  it("stamps the observation's own instant, not the realm's", () => {
    const { realm, presence } = makeRealm();
    realm.emit(presence.presenceId, {
      kind: 'result-lab', orderId: 'obs-2', code: '718-7', value: 9.1, unit: 'g/dL',
      patientId: 'p1', observedAt: OBSERVED_AT,
    });

    const state = realm.graph.listKind('result')[0]!.state as { at?: string };
    expect(state.at).toBe(OBSERVED_AT);
  });

  // Non-vacuity: with no instant on the effect the result falls back to the realm clock,
  // so the assertion above is about `observedAt` being HONOURED and not about a string
  // that would be written regardless.
  it('falls back to the realm instant when the effect carries none', () => {
    const { realm, presence } = makeRealm();
    realm.emit(presence.presenceId, {
      kind: 'result-lab', orderId: 'obs-3', code: '718-7', value: 9.1, unit: 'g/dL', patientId: 'p1',
    });

    const state = realm.graph.listKind('result')[0]!.state as { at?: string };
    expect(state.at).toBeDefined();
    expect(state.at).not.toBe(OBSERVED_AT);
  });

  // The residual limitation, asserted rather than claimed away: an effect that names no
  // patient AND answers no order is still orphaned. That is now a fact a reader can test,
  // instead of an absence indistinguishable from "this patient has no labs".
  it('still leaves an orphan when the effect names neither a patient nor an order', () => {
    const { realm, presence } = makeRealm();
    realm.emit(presence.presenceId, {
      kind: 'result-lab', orderId: 'nowhere', code: '718-7', value: 9.1, unit: 'g/dL',
    });

    const state = realm.graph.listKind('result')[0]!.state as { patientId?: string };
    expect(state.patientId).toBeUndefined();
  });

  // The instant survives to the wire, matching the two effects that already read their own
  // field (`record-assessment`, `record-immunisation`). Before this, `result-lab` was the
  // one laboratory-ish effect that did not.
  it('projects the observed instant onto the outbound Observation', () => {
    const resources = effectToFhirResource(
      {
        kind: 'result-lab', orderId: 'obs-4', code: '718-7', value: 9.1, unit: 'g/dL',
        patientId: 'p1', observedAt: OBSERVED_AT,
      },
      { ctx: ctxOf('realm:lp') },
    );

    expect(resources[0]!.resourceType).toBe('Observation');
    expect((resources[0] as { effectiveDateTime?: string }).effectiveDateTime).toBe(OBSERVED_AT);
  });
});
