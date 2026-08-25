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

// Phase 1b — live RealmHypergraph bridge: effects auto-populate typed nodes + edges.

import { describe, expect, it } from 'vitest';
import { buildHealthcareHypergraphSchema } from '../packs/healthcare-core/hypergraph.js';
import { Realm } from '../src/realm/realm.js';
import { RealmHypergraph } from '../src/realm/hypergraph-bridge.js';
import { countsByType, edgesByType, effectAttributionFor } from '../src/hypergraph/queries/healthcare.js';
import type { AgentPresence } from '../src/realm/types.js';

function spawn(realm: Realm, agentSpecId: string, role: AgentPresence['role'], clearance: AgentPresence['clearance']): AgentPresence {
  return realm.spawnPresence({ agentSpecId, runId: 'run-1', role, clearance, purposeOfUse: ['treatment'], location: { facilityId: 'f1', unitId: 'U1' } });
}

function makeRealm(): { realm: Realm; hg: RealmHypergraph } {
  const hg = new RealmHypergraph(buildHealthcareHypergraphSchema(), 'realm:b1');
  const realm = new Realm({ id: 'realm:b1', mode: 'sim', hypergraph: hg });
  realm.start();
  return { realm, hg };
}

describe('RealmHypergraph — live effect bridge (Phase 1b)', () => {
  it('populates nodes + membership + relation-derived edges from emitted effects', () => {
    const { realm, hg } = makeRealm();
    const p = spawn(realm, 'rounding-md', 'md', 'restricted-phi');
    realm.emit(p.presenceId, { kind: 'admit-patient', patientId: 'p1', facilityId: 'f1', unitId: 'U1' });
    realm.emit(p.presenceId, { kind: 'order-lab', patientId: 'p1', code: '17861-6', priority: 'routine', encounterId: 'enc1' });
    // result-lab targets the actual order the reducer created, so an of-order relation exists
    const orderId = realm.graph.listKind('order')[0]!.id;
    realm.emit(p.presenceId, { kind: 'result-lab', orderId, code: '17861-6', value: 4.2, unit: 'mg/dL', abnormal: 'H' });

    const snap = hg.now();
    const counts = countsByType(snap);
    // facility (org), patient, order, result + realm + presence + agent-run + effects
    expect(counts['patient']).toBeGreaterThanOrEqual(1);
    expect(counts['realm']).toBe(1);
    expect(counts['effect']).toBeGreaterThanOrEqual(3);
    expect(counts['presence']).toBeGreaterThanOrEqual(1);
    expect(counts['agent-run']).toBeGreaterThanOrEqual(1);
    // membership edge per node, effect-attribution edge per effect
    const membership = edgesByType(snap, 'realm-membership');
    expect(membership.length).toBeGreaterThanOrEqual(snap.nodes.size - 1);
    const attributions = edgesByType(snap, 'effect-attribution');
    expect(attributions.length).toBeGreaterThanOrEqual(3);
    // relation-derived edges: result → order via of-order
    const derived = edgesByType(snap, 'derived-reference');
    expect(derived.length).toBeGreaterThanOrEqual(1);
    expect(derived[0]!.attributes['relation']).toBe('of-order');
  });

  it('asserts an effect-attribution edge linking an effect to its presence + agent-run', () => {
    const { realm, hg } = makeRealm();
    const p = spawn(realm, 'rounding-md', 'md', 'restricted-phi');
    realm.emit(p.presenceId, { kind: 'order-med', patientId: 'p1', code: '853653', dose: '50 mg', route: 'PO', frequency: 'Q8H' });
    const snap = hg.now();
    const effectNode = [...snap.nodes.values()].find((n) => n.type === 'effect');
    expect(effectNode).toBeDefined();
    const attr = effectAttributionFor(snap, effectNode!.attributes['effectId'] as string);
    expect(attr?.type).toBe('effect-attribution');
    expect(attr?.roles['presence']?.[0]).toContain(p.presenceId);
    expect(attr?.roles['agent-run']?.[0]).toBeDefined();
  });

  it('assert-once is idempotent — repeat effects do not duplicate nodes', () => {
    const { realm, hg } = makeRealm();
    const p = spawn(realm, 'nurse', 'nurse', 'phi');
    realm.emit(p.presenceId, { kind: 'record-vitals', patientId: 'p1', hr: 74 });
    realm.emit(p.presenceId, { kind: 'record-vitals', patientId: 'p1', hr: 78 });
    const snap = hg.now();
    // one realm node, >=1 patient node (created on first vitals), effect nodes == 2
    expect(countsByType(snap)['realm']).toBe(1);
    expect(countsByType(snap)['effect']).toBe(2);
    // membership edge per node only once
    const memberships = edgesByType(snap, 'realm-membership');
    const memberIds = new Set(memberships.flatMap((e) => e.roles['member'] ?? []));
    expect(memberIds.size).toBe(memberships.length);
  });
});
