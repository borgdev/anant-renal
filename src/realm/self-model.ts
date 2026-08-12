// Self-Model — the agent's biography. Aggregates episodes into a live
// self-understanding. Stats are always fresh; narrative is generated
// on-demand (or at milestones).
//
// The self-model modulates future choices via preference weights. When
// an agent has repeatedly regretted a certain kind of choice (e.g. an
// order later flagged as a safety event), its preference weight for that
// kind of choice decreases. Conversely, choices that led to good
// consequences are reinforced.
//
// This is the substrate of "know thyself": the agent literally observes
// what it has done, weighs the outcomes, and adjusts.

import type { AgentPresence } from './types.js';
import type { Episode, EpisodeStore } from './episode.js';

export interface SelfModelStats {
  presenceId: string;
  agentSpecId: string;
  role: AgentPresence['role'];
  episodes: { total: number; open: number; closed: number; pruned: number };
  choices: { total: number; deterministic: number; deliberated: number };
  effects: { total: number; byKind: Record<string, number> };
  competence: { score: number; sample: number }; // 0..1, based on consequence quality
  preferences: Record<string, number>; // effect.kind -> weight in [0.1, 2.0]
  milestonesReached: string[];
  lastUpdated: string;
}

export interface Narrative {
  presenceId: string;
  generatedAt: string;
  paragraphs: string[]; // one paragraph per epoch / theme
  generatedBy: 'template' | 'llm';
}

export interface NarrativeAdapter {
  generate(input: { stats: SelfModelStats; episodes: Episode[]; recentAttributions?: Array<{ ruleId: string; outcome: 'positive' | 'neutral' | 'negative'; kind: string }> }): Promise<string[]> | string[];
}

const DEFAULT_PREF = 1.0;
const PREF_FLOOR = 0.1;
const PREF_CEIL = 2.0;

export interface Consequence {
  effectId: string;
  kind: string;
  outcome: 'positive' | 'neutral' | 'negative';
  weight: number; // 0..1 how strongly it should reshape preferences
}

export class SelfModelRegistry {
  private byPresence = new Map<string, SelfModelStats>();
  private preferences = new Map<string, Map<string, number>>(); // presenceId -> effectKind -> weight

  ensure(presence: AgentPresence): SelfModelStats {
    let sm = this.byPresence.get(presence.presenceId);
    if (!sm) {
      sm = {
        presenceId: presence.presenceId,
        agentSpecId: presence.agentSpecId,
        role: presence.role,
        episodes: { total: 0, open: 0, closed: 0, pruned: 0 },
        choices: { total: 0, deterministic: 0, deliberated: 0 },
        effects: { total: 0, byKind: {} },
        competence: { score: 0.5, sample: 0 },
        preferences: {},
        milestonesReached: [],
        lastUpdated: new Date().toISOString(),
      };
      this.byPresence.set(presence.presenceId, sm);
      this.preferences.set(presence.presenceId, new Map());
    }
    return sm;
  }

  refresh(presence: AgentPresence, store: EpisodeStore): SelfModelStats {
    const sm = this.ensure(presence);
    const eps = store.listForPresence(presence.presenceId);
    sm.episodes.total = eps.length;
    sm.episodes.open = eps.filter((e) => e.status === 'open').length;
    sm.episodes.closed = eps.filter((e) => e.status === 'closed').length;
    sm.episodes.pruned = eps.filter((e) => e.status === 'pruned').length;
    sm.choices.total = 0; sm.choices.deterministic = 0; sm.choices.deliberated = 0;
    sm.effects.total = 0; sm.effects.byKind = {};
    for (const ep of eps) {
      if (ep.choice) {
        sm.choices.total++;
        if (ep.choice.presented.length > 1) sm.choices.deliberated++;
        else sm.choices.deterministic++;
      }
      for (const eff of ep.effects) {
        sm.effects.total++;
        sm.effects.byKind[eff.kind] = (sm.effects.byKind[eff.kind] ?? 0) + 1;
      }
    }
    sm.preferences = Object.fromEntries(this.preferences.get(presence.presenceId) ?? new Map());
    // Milestones
    const ms = new Set(sm.milestonesReached);
    if (sm.episodes.total >= 1 && !ms.has('first-episode')) ms.add('first-episode');
    if (sm.episodes.total >= 10 && !ms.has('ten-episodes')) ms.add('ten-episodes');
    if (sm.episodes.total >= 100 && !ms.has('hundred-episodes')) ms.add('hundred-episodes');
    if (sm.choices.deliberated >= 1 && !ms.has('first-deliberation')) ms.add('first-deliberation');
    if (sm.choices.deliberated >= 5 && !ms.has('practiced-deliberator')) ms.add('practiced-deliberator');
    sm.milestonesReached = [...ms];
    sm.lastUpdated = new Date().toISOString();
    return sm;
  }

  applyConsequence(presenceId: string, c: Consequence): void {
    const prefs = this.preferences.get(presenceId) ?? new Map<string, number>();
    const current = prefs.get(c.kind) ?? DEFAULT_PREF;
    const delta = c.outcome === 'positive' ? +0.1 * c.weight : c.outcome === 'negative' ? -0.1 * c.weight : 0;
    const next = Math.min(PREF_CEIL, Math.max(PREF_FLOOR, current + delta));
    prefs.set(c.kind, next);
    this.preferences.set(presenceId, prefs);
    // Update competence rolling average
    const sm = this.byPresence.get(presenceId);
    if (sm) {
      const outcomeScore = c.outcome === 'positive' ? 1 : c.outcome === 'negative' ? 0 : 0.5;
      const n = sm.competence.sample;
      sm.competence.score = (sm.competence.score * n + outcomeScore * c.weight) / (n + c.weight);
      sm.competence.sample = n + c.weight;
    }
  }

  preferenceFor(presenceId: string, effectKind: string): number {
    return this.preferences.get(presenceId)?.get(effectKind) ?? DEFAULT_PREF;
  }

  get(presenceId: string): SelfModelStats | undefined { return this.byPresence.get(presenceId); }
  list(): SelfModelStats[] { return [...this.byPresence.values()]; }

  // On-demand narrative. Template-based by default; pass a NarrativeAdapter
  // to swap in richer prose (LLM, retrieval-augmented, etc.).
  async narrative(presence: AgentPresence, store: EpisodeStore, adapter?: NarrativeAdapter, extras?: { recentAttributions?: Array<{ ruleId: string; outcome: 'positive' | 'neutral' | 'negative'; kind: string }> }): Promise<Narrative> {
    const sm = this.refresh(presence, store);
    if (adapter) {
      const eps = store.listForPresence(presence.presenceId).filter((e) => e.status !== 'pruned');
      const paragraphs = await adapter.generate({ stats: sm, episodes: eps, ...(extras?.recentAttributions ? { recentAttributions: extras.recentAttributions } : {}) });
      return { presenceId: presence.presenceId, generatedAt: new Date().toISOString(), paragraphs, generatedBy: 'llm' };
    }
    return this.narrativeTemplate(presence, store);
  }

  narrativeTemplate(presence: AgentPresence, store: EpisodeStore): Narrative {
    const sm = this.refresh(presence, store);
    const eps = store.listForPresence(presence.presenceId).filter((e) => e.status !== 'pruned');
    const paragraphs: string[] = [];
    paragraphs.push(
      `I am ${presence.agentSpecId}, serving as ${presence.role} in ${presence.location.facilityId}` +
      (presence.location.unitId ? `/${presence.location.unitId}` : '') +
      `. Across ${sm.episodes.total} episodes I have made ${sm.choices.total} choices — ${sm.choices.deliberated} of which involved deliberation between alternatives.`,
    );
    const topEffect = Object.entries(sm.effects.byKind).sort((a, b) => b[1] - a[1])[0];
    if (topEffect) paragraphs.push(`My most frequent action is \`${topEffect[0]}\` (${topEffect[1]}×). My competence sits at ${(sm.competence.score * 100).toFixed(0)}% based on ${sm.competence.sample.toFixed(1)} weighted samples.`);
    const critical = eps.filter((e) => e.importance === 'critical');
    if (critical.length) paragraphs.push(`${critical.length} episode(s) were critical. The most recent local goal: "${critical[critical.length - 1]?.localGoal}".`);
    const strongPrefs = Object.entries(sm.preferences).filter(([, w]) => Math.abs(w - DEFAULT_PREF) > 0.15);
    if (strongPrefs.length) {
      const shifts = strongPrefs.map(([k, w]) => `${w > DEFAULT_PREF ? 'lean toward' : 'shy from'} \`${k}\` (${w.toFixed(2)})`).join('; ');
      paragraphs.push(`My biography has shaped my preferences: I ${shifts}.`);
    } else {
      paragraphs.push(`My preferences remain at baseline — I have not yet accumulated enough consequence signal to reshape them.`);
    }
    if (sm.milestonesReached.length) paragraphs.push(`Milestones reached: ${sm.milestonesReached.join(', ')}.`);
    return { presenceId: presence.presenceId, generatedAt: new Date().toISOString(), paragraphs, generatedBy: 'template' };
  }
}
