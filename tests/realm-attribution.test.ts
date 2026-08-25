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
import { EpisodeStore, SelfModelRegistry, EffectLedger, ConsequenceAttributor, type AgentPresence, type WorldEffect } from '../src/realm/index.js';

function presence(id = 'p:test'): AgentPresence {
  return { presenceId: id, agentSpecId: 'test.spec', runId: 'r1', realmId: 'realm:test', role: 'md', clearance: 'phi', purposeOfUse: ['treatment'], location: { facilityId: 'f1', unitId: 'A' }, perceptualRange: { units: ['A'], patients: ['*'], eventTypes: ['*'] }, attention: 'active', spawnedAt: new Date().toISOString(), lastPerceivedAt: new Date().toISOString() };
}

describe('ConsequenceAttributor', () => {
  it('attributes a downstream safety event to a med action negatively', () => {
    const ledger = new EffectLedger();
    const store = new EpisodeStore();
    const sm = new SelfModelRegistry();
    const p = presence();
    sm.ensure(p);
    const attr = new ConsequenceAttributor(ledger, store, sm);

    const ep = store.openEpisode({ presence: p, localGoal: 'test', openingPerception: [], openedAt: new Date().toISOString() });
    const orderMed: WorldEffect = { kind: 'order-med', patientId: 'pt1', code: 'lisinopril', dose: '10mg', route: 'PO', frequency: 'daily' };
    const emitted = ledger.append({ presenceId: p.presenceId, agentSpecId: p.agentSpecId, realmAt: new Date().toISOString(), effect: orderMed, status: 'bound' });
    store.recordEffect(ep.episodeId, orderMed, emitted);
    store.closeEpisode(ep.episodeId, new Date().toISOString(), 'notable');
    attr.noteEpisodeClosed(ep.episodeId, Date.now());

    // Simulate a downstream safety event on the same patient.
    const safety: WorldEffect = { kind: 'flag-safety-event', patientId: 'pt1', safetyKind: 'aki', severity: 'high' };
    ledger.append({ presenceId: 'p:other', agentSpecId: 'other', realmAt: new Date().toISOString(), effect: safety, status: 'bound' });

    const attrs = attr.forEpisode(ep.episodeId);
    expect(attrs.length).toBeGreaterThan(0);
    expect(attrs.some((a) => a.consequence.outcome === 'negative')).toBe(true);
    expect(attrs.some((a) => a.ruleId === 'safety-event-after-med-action')).toBe(true);
  });

  it('shifts self-model preferences downward for the acted-on kind after negative attribution', () => {
    const ledger = new EffectLedger();
    const store = new EpisodeStore();
    const sm = new SelfModelRegistry();
    const p = presence('p:pref');
    sm.ensure(p);
    const attr = new ConsequenceAttributor(ledger, store, sm);
    const ep = store.openEpisode({ presence: p, localGoal: 'test', openingPerception: [], openedAt: new Date().toISOString() });
    const orderMed: WorldEffect = { kind: 'order-med', patientId: 'pt1', code: 'lisinopril', dose: '10mg', route: 'PO', frequency: 'daily' };
    const emitted = ledger.append({ presenceId: p.presenceId, agentSpecId: p.agentSpecId, realmAt: new Date().toISOString(), effect: orderMed, status: 'bound' });
    store.recordEffect(ep.episodeId, orderMed, emitted);
    store.closeEpisode(ep.episodeId, new Date().toISOString(), 'notable');
    attr.noteEpisodeClosed(ep.episodeId, Date.now());
    ledger.append({ presenceId: 'p:other', agentSpecId: 'other', realmAt: new Date().toISOString(), effect: { kind: 'flag-safety-event', patientId: 'pt1', safetyKind: 'aki', severity: 'critical' }, status: 'bound' });
    expect(sm.preferenceFor(p.presenceId, 'order-med')).toBeLessThan(1.0);
    expect(attr.stats().byOutcome['negative']).toBeGreaterThan(0);
  });

  it('positive attribution for schedule-followup after claim submission', () => {
    const ledger = new EffectLedger();
    const store = new EpisodeStore();
    const sm = new SelfModelRegistry();
    const p = presence('p:coder');
    sm.ensure(p);
    const attr = new ConsequenceAttributor(ledger, store, sm);
    const ep = store.openEpisode({ presence: p, localGoal: 'test', openingPerception: [], openedAt: new Date().toISOString() });
    const claim: WorldEffect = { kind: 'submit-claim', encounterId: 'e1', payerId: 'medicare', cptCodes: ['90999'], icd10Codes: ['N18.6'] };
    const emitted = ledger.append({ presenceId: p.presenceId, agentSpecId: p.agentSpecId, realmAt: new Date().toISOString(), effect: claim, status: 'bound' });
    store.recordEffect(ep.episodeId, claim, emitted);
    store.closeEpisode(ep.episodeId, new Date().toISOString(), 'routine');
    attr.noteEpisodeClosed(ep.episodeId, Date.now());
    ledger.append({ presenceId: 'p:other', agentSpecId: 'other', realmAt: new Date().toISOString(), effect: { kind: 'schedule-followup', patientId: 'pt1', when: new Date().toISOString(), resource: 'nephrologist', followupKind: 'adequacy' }, status: 'bound' });
    expect(sm.preferenceFor(p.presenceId, 'submit-claim')).toBeGreaterThan(1.0);
  });
});
