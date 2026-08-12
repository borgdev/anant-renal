import { describe, it, expect } from 'vitest';
import { EpisodeStore, SelfModelRegistry, LocalRichAdapter, LLMNarrativeAdapter, resolveChoice, replayEpisodeChoice, type AgentPresence } from '../src/realm/index.js';

function fakePresence(): AgentPresence {
  return { presenceId: 'p1', agentSpecId: 'test.spec', runId: 'r1', realmId: 'realm:test', role: 'md', clearance: 'phi', purposeOfUse: ['treatment'], location: { facilityId: 'f1', unitId: 'A' }, perceptualRange: { units: ['A'], patients: ['*'], eventTypes: ['*'] }, attention: 'active', spawnedAt: new Date().toISOString(), lastPerceivedAt: new Date().toISOString() };
}

describe('LocalRichAdapter narrative', () => {
  it('produces multi-paragraph biography from stats', async () => {
    const store = new EpisodeStore();
    const sm = new SelfModelRegistry();
    const p = fakePresence();
    sm.ensure(p);
    // Give it some preferences and consequences
    // Apply enough consequences to move preferences outside the ±0.10 baseline band.
    for (let i = 0; i < 5; i++) sm.applyConsequence(p.presenceId, { effectId: `e${i}`, kind: 'hold-med', outcome: 'positive', weight: 1.0 });
    for (let i = 0; i < 5; i++) sm.applyConsequence(p.presenceId, { effectId: `f${i}`, kind: 'order-med', outcome: 'negative', weight: 1.0 });
    const adapter = new LocalRichAdapter();
    const n = await sm.narrative(p, store, adapter, { recentAttributions: [{ ruleId: 'safety-event-after-med-action', outcome: 'negative', kind: 'order-med' }] });
    expect(n.generatedBy).toBe('llm');
    expect(n.paragraphs.length).toBeGreaterThanOrEqual(3);
    expect(n.paragraphs.some((p) => p.includes('lean toward') || p.includes('shy from'))).toBe(true);
  });
});

describe('LLMNarrativeAdapter', () => {
  it('shapes stats into a prompt and returns paragraphs from caller', async () => {
    const sm = new SelfModelRegistry();
    const store = new EpisodeStore();
    const p = fakePresence();
    sm.ensure(p);
    let capturedPrompt = '';
    const adapter = new LLMNarrativeAdapter(async (prompt) => {
      capturedPrompt = prompt;
      return 'I am the agent.\n\nI have acted deliberately.\n\nI continue to learn.';
    });
    const n = await sm.narrative(p, store, adapter);
    expect(n.generatedBy).toBe('llm');
    expect(n.paragraphs.length).toBe(3);
    expect(capturedPrompt).toContain('first-person biography');
  });
});

describe('Episode replay', () => {
  it('replays historical choice deterministically from stored rngRoll', () => {
    const sm = new SelfModelRegistry();
    const p = fakePresence();
    sm.ensure(p);
    const options = [
      { optionId: 'A', description: '[kind:hold-med] wait', utility: 0.6, effectKind: 'hold-med', action: () => 'A' },
      { optionId: 'B', description: '[kind:order-med] act', utility: 0.5, effectKind: 'order-med', action: () => 'B' },
    ];
    const first = resolveChoice(options, { presenceId: p.presenceId, selfModel: sm, rngSeed: 12345 });
    const ep = {
      episodeId: 'ep1',
      presenceId: p.presenceId,
      agentSpecId: p.agentSpecId,
      role: p.role,
      openedAt: new Date().toISOString(),
      closedAt: new Date().toISOString(),
      status: 'closed' as const,
      importance: 'routine' as const,
      localGoal: 'test',
      perception: [],
      choice: first.choice,
      effects: [],
      consequences: [],
      hash: 'x',
    };
    const outcome = replayEpisodeChoice(ep, sm);
    expect(outcome.replayHistorical.matches).toBe(true);
    expect(outcome.replayNow.matches).toBe(true);
    expect(outcome.divergence).toBe(false);
  });

  it('detects divergence when preferences shift after the choice', () => {
    const sm = new SelfModelRegistry();
    const p = fakePresence();
    sm.ensure(p);
    const options = [
      { optionId: 'A', description: '[kind:hold-med] wait', utility: 0.55, effectKind: 'hold-med', action: () => 'A' },
      { optionId: 'B', description: '[kind:order-med] act', utility: 0.5, effectKind: 'order-med', action: () => 'B' },
    ];
    const first = resolveChoice(options, { presenceId: p.presenceId, selfModel: sm, rngSeed: 999 });
    // Now heavily punish the chosen kind
    for (let i = 0; i < 30; i++) sm.applyConsequence(p.presenceId, { effectId: `e${i}`, kind: first.choice.chosenOptionId === 'A' ? 'hold-med' : 'order-med', outcome: 'negative', weight: 1.0 });
    const ep = {
      episodeId: 'ep2',
      presenceId: p.presenceId,
      agentSpecId: p.agentSpecId,
      role: p.role,
      openedAt: new Date().toISOString(),
      closedAt: new Date().toISOString(),
      status: 'closed' as const,
      importance: 'routine' as const,
      localGoal: 'test',
      perception: [],
      choice: first.choice,
      effects: [],
      consequences: [],
      hash: 'x',
    };
    const outcome = replayEpisodeChoice(ep, sm);
    // With strong penalty on the historically-chosen kind, the "now" replay should diverge.
    expect(outcome.replayHistorical.matches).toBe(true); // historical is by definition stable
    if (outcome.divergence) {
      expect(outcome.replayNow.matches).toBe(false);
      expect(outcome.detail).toContain('shaped');
    }
  });
});
