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

import { describe, it, expect } from 'vitest';
import { Realm, AgentRealmRuntime, populateFacility, type WorldEffect } from '../src/realm/index.js';
import type { AgentSpec } from '../src/agents/spec.js';

function spec(id: string, role: string): AgentSpec {
  return {
    id, displayName: id, version: '1.0.0', packId: 'test', scope: 'facility',
    labels: { role }, persona: { style: 'clinical' },
    inputs: { events: [], entities: [] }, outputs: { effects: [] },
    governance: { clearanceRequired: 'phi', purposesOfUse: ['treatment'], authorizedEffects: [], boundEffects: [], phiAccess: 'full' },
    citations: [], sources: [],
  } as unknown as AgentSpec;
}

describe('Peer perception', () => {
  it('a pharmacist hold-med produces a presence-acted experience the nurse perceives and records', () => {
    const realm = new Realm({ id: 'realm:peer', mode: 'sim' });
    populateFacility(realm, { facilityId: 'f1', kind: 'dialysis', name: 'Test', units: ['A'], patientCount: 1 });
    const runtime = new AgentRealmRuntime(realm);
    const nurse = runtime.spawn(spec('test.nurse.rn', 'nurse'), { facilityId: 'f1', unitId: 'A' });
    const md = runtime.spawn(spec('test.md.rounding', 'md'), { facilityId: 'f1', unitId: 'A' });
    const pharm = runtime.spawn(spec('test.pharmacist.rx', 'pharmacist'), { facilityId: 'f1', unitId: 'A' });
    const patientId = realm.graph.listKind('patient')[0]!.id;
    // Seed a med with the MD (pharmacist role isn't authorized to order-med)
    realm.emit(md.presence.presenceId, { kind: 'order-med', patientId, code: 'lisinopril', dose: '10mg', route: 'PO', frequency: 'daily' } as WorldEffect);
    const meds = realm.graph.listKind('medication');
    expect(meds.length).toBeGreaterThan(0);
    const medOrderId = meds[meds.length - 1]!.id;
    realm.emit(pharm.presence.presenceId, { kind: 'hold-med', patientId, medOrderId, reason: 'safety review' } as WorldEffect);
    // The nurse's ledger should now show a record-agent-thought recorded via peer-awareness.
    const nurseThoughts = realm.ledger.listByPresence(nurse.presence.presenceId).filter((e) => e.effect.kind === 'record-agent-thought');
    expect(nurseThoughts.length).toBeGreaterThan(0);
    expect((nurseThoughts[0]!.effect as { note: string }).note).toContain('[coord]');
  });

  it('a safety event by one monitor prompts corroborating notify from the peer safety monitor', () => {
    const realm = new Realm({ id: 'realm:peer2', mode: 'sim' });
    populateFacility(realm, { facilityId: 'f1', kind: 'dialysis', name: 'Test', units: ['A'], patientCount: 1 });
    const runtime = new AgentRealmRuntime(realm);
    // Use nurse role for safety monitors so they can both flag safety events and notify
    const s1 = runtime.spawn(spec('test.safety.risk-monitor.a', 'nurse'), { facilityId: 'f1', unitId: 'A' });
    const s2 = runtime.spawn(spec('test.safety.risk-monitor.b', 'nurse'), { facilityId: 'f1', unitId: 'A' });
    const patientId = realm.graph.listKind('patient')[0]!.id;
    realm.emit(s1.presence.presenceId, { kind: 'flag-safety-event', patientId, safetyKind: 'aki', severity: 'high' } as WorldEffect);
    const s2Notifies = realm.ledger.listByPresence(s2.presence.presenceId).filter((e) => e.effect.kind === 'notify-staff');
    expect(s2Notifies.length).toBeGreaterThan(0);
  });
});
