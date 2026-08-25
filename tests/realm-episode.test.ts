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

// Tests for the Episode / SelfModel / Choice / Rules substrate.

import { describe, it, expect } from 'vitest';
import { Realm, resolveChoice, EpisodeStore, SelfModelRegistry } from '../src/realm/index.js';
import type { AgentPresence, Option } from '../src/realm/index.js';

function fakePresence(over: Partial<AgentPresence> = {}): AgentPresence {
  return {
    presenceId: 'p1', realmId: 'r', agentSpecId: 'agent-a', runId: 'run-1',
    role: 'md', clearance: 'phi', purposeOfUse: ['treatment'],
    location: { facilityId: 'DVC' },
    perceptualRange: { units: ['*'], patients: ['*'], eventTypes: ['*'] },
    spawnedAt: new Date().toISOString(),
    ...over,
  } as AgentPresence;
}

describe('Episode substrate', () => {
  it('opens, records effect, closes, and hashes deterministically', () => {
    const store = new EpisodeStore();
    const p = fakePresence();
    const ep = store.openEpisode({ presence: p, localGoal: 'test', openingPerception: [], openedAt: '2026-01-01T00:00:00Z' });
    expect(ep.status).toBe('open');
    expect(ep.hash).toMatch(/^[0-9a-f]{64}$/);
    store.recordEffect(ep.episodeId, { kind: 'record-agent-thought', note: 'hi' }, { effectId: 'e1', presenceId: p.presenceId, agentSpecId: p.agentSpecId, emittedAt: 'x', realmAt: 'x', effect: { kind: 'record-agent-thought', note: 'hi' }, status: 'shadow' });
    store.closeEpisode(ep.episodeId, '2026-01-01T00:01:00Z', 'critical');
    const closed = store.get(ep.episodeId)!;
    expect(closed.status).toBe('closed');
    expect(closed.importance).toBe('critical');
    expect(closed.effects).toHaveLength(1);
    expect(closed.consequences).toContain('e1');
    expect(closed.hash).not.toBe(ep.hash);
  });

  it('prunes old low-importance episodes but retains critical ones', () => {
    const store = new EpisodeStore();
    const p = fakePresence();
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const e1 = store.openEpisode({ presence: p, localGoal: 'a', openingPerception: [], openedAt: old });
    store.closeEpisode(e1.episodeId, old, 'routine');
    const e2 = store.openEpisode({ presence: p, localGoal: 'b', openingPerception: [], openedAt: old });
    store.closeEpisode(e2.episodeId, old, 'critical');
    const pruned = store.prune({ olderThanMs: 7 * 24 * 60 * 60 * 1000, keepImportance: ['critical'] });
    expect(pruned).toBe(1);
    expect(store.get(e1.episodeId)!.status).toBe('pruned');
    expect(store.get(e2.episodeId)!.status).toBe('closed');
  });
});

describe('SelfModel', () => {
  it('tracks episode / choice / effect counts and computes competence + preferences', () => {
    const store = new EpisodeStore();
    const sm = new SelfModelRegistry();
    const p = fakePresence();
    sm.ensure(p);
    const ep = store.openEpisode({ presence: p, localGoal: 't', openingPerception: [], openedAt: 'x' });
    store.recordEffect(ep.episodeId, { kind: 'order-lab', patientId: 'p1', code: 'K', priority: 'stat' }, { effectId: 'e1', presenceId: p.presenceId, agentSpecId: p.agentSpecId, emittedAt: 'x', realmAt: 'x', effect: { kind: 'order-lab', patientId: 'p1', code: 'K', priority: 'stat' }, status: 'shadow' });
    store.closeEpisode(ep.episodeId, 'x', 'routine');
    const s = sm.refresh(p, store);
    expect(s.episodes.total).toBe(1);
    expect(s.effects.byKind['order-lab']).toBe(1);
    // Apply a positive consequence, preference should rise
    sm.applyConsequence(p.presenceId, { effectId: 'e1', kind: 'order-lab', outcome: 'positive', weight: 1 });
    expect(sm.preferenceFor(p.presenceId, 'order-lab')).toBeGreaterThan(1);
    sm.applyConsequence(p.presenceId, { effectId: 'e2', kind: 'order-lab', outcome: 'negative', weight: 1 });
    expect(sm.preferenceFor(p.presenceId, 'order-lab')).toBeLessThanOrEqual(1.05);
  });

  it('produces an on-demand narrative', () => {
    const store = new EpisodeStore();
    const sm = new SelfModelRegistry();
    const p = fakePresence();
    sm.ensure(p);
    const n = sm.narrativeTemplate(p, store);
    expect(n.paragraphs.length).toBeGreaterThan(0);
    expect(n.generatedBy).toBe('template');
  });
});

describe('ChoicePoint resolver', () => {
  it('records alternatives, preference weights, and rng roll', () => {
    const sm = new SelfModelRegistry();
    const p = fakePresence();
    sm.ensure(p);
    const options: Array<Option<string>> = [
      { optionId: 'a', description: 'hold', utility: 0.9, effectKind: 'hold-med', action: 'A' },
      { optionId: 'b', description: 'notify', utility: 0.7, effectKind: 'notify-staff', action: 'B' },
    ];
    const { choice, action } = resolveChoice(options, { presenceId: p.presenceId, selfModel: sm, rngSeed: 42 });
    expect(action === 'A' || action === 'B').toBe(true);
    expect(choice.presented).toHaveLength(2);
    expect(choice.presented[0]?.finalScore).toBeGreaterThan(0);
    expect(choice.rngRoll).toBeGreaterThanOrEqual(0);
    // Same seed → same action
    const r2 = resolveChoice(options, { presenceId: p.presenceId, selfModel: sm, rngSeed: 42 });
    expect(r2.action).toBe(action);
  });

  it('self-model preference shifts winner', () => {
    const sm = new SelfModelRegistry();
    const p = fakePresence();
    sm.ensure(p);
    // Punish hold-med hard
    for (let i = 0; i < 20; i++) sm.applyConsequence(p.presenceId, { effectId: `e${i}`, kind: 'hold-med', outcome: 'negative', weight: 1 });
    const options: Array<Option<string>> = [
      { optionId: 'a', description: 'hold', utility: 0.9, effectKind: 'hold-med', action: 'A' },
      { optionId: 'b', description: 'notify', utility: 0.7, effectKind: 'notify-staff', action: 'B' },
    ];
    const { action } = resolveChoice(options, { presenceId: p.presenceId, selfModel: sm, rngSeed: 1 });
    // With floor-preference for hold-med, notify should win despite lower utility
    expect(action).toBe('B');
  });
});

describe('Realm with rules', () => {
  it('produces experiences from effects and routes them to perception', () => {
    const realm = new Realm({ id: 'rules-realm', mode: 'sim' });
    let saw = 0;
    const presence = realm.spawnPresence({ realmId: realm.id, agentSpecId: 'obs', runId: 'r1', role: 'auditor', clearance: 'phi', purposeOfUse: ['compliance'], location: { facilityId: 'DVC' }, perceptualRange: { units: ['*'], patients: ['*'], eventTypes: ['*'] } });
    realm.subscribe(presence.presenceId, (e) => { if (e.kind.startsWith('experience.')) saw++; });
    realm.emit(presence.presenceId, { kind: 'discharge-patient', patientId: 'pt1', disposition: 'home' });
    expect(saw).toBeGreaterThanOrEqual(1);
    const exps = realm.rules.history();
    expect(exps.some((e) => e.kind === 'ready-to-bill')).toBe(true);
  });
});
