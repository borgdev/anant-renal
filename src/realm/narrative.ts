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

// Narrative adapters — pluggable prose generators for Self-Model.
//
// LocalRichAdapter: deterministic, no-network narrative that composes
//   multi-paragraph biographies from stats, episode arc, and attribution
//   history. It reads like a first-person reflection because the prompts
//   are shaped from real evidence.
// LLMAdapter: stub interface. Provide a `call(prompt) => string` and the
//   adapter shapes stats/episodes into a prompt, calls out, and returns.
//   Intentionally not wired to a specific provider so the code remains
//   deployable without keys.

import type { NarrativeAdapter, SelfModelStats } from './self-model.js';
import type { Episode } from './episode.js';

function join(items: string[], conj = 'and'): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} ${conj} ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, ${conj} ${items[items.length - 1]}`;
}

export class LocalRichAdapter implements NarrativeAdapter {
  generate(input: { stats: SelfModelStats; episodes: Episode[]; recentAttributions?: Array<{ ruleId: string; outcome: 'positive' | 'neutral' | 'negative'; kind: string }> }): string[] {
    const { stats: sm, episodes: eps } = input;
    const attrs = input.recentAttributions ?? [];
    const paras: string[] = [];

    // Opening — identity & scope
    const arc = eps.length
      ? `from my first ${eps[0]!.localGoal.toLowerCase()} to my most recent ${eps[eps.length - 1]!.localGoal.toLowerCase()}`
      : 'still at the beginning of my work';
    paras.push(
      `I am ${sm.agentSpecId}. In my role as ${sm.role}, I have lived through ${sm.episodes.total} episodes — ${arc}. Of the ${sm.choices.total} choices I have made, ${sm.choices.deliberated} required deliberation between real alternatives; the remainder were the reflexes of a role I now know well.`,
    );

    // Body — action pattern
    const topEffects = Object.entries(sm.effects.byKind).sort((a, b) => b[1] - a[1]).slice(0, 3);
    if (topEffects.length) {
      const chunks = topEffects.map(([k, n]) => `${k} (${n})`);
      paras.push(
        `The shape of my agency is legible in what I do most: ${join(chunks)}. My competence, measured against the consequences that followed, currently reads ${(sm.competence.score * 100).toFixed(0)}% across ${sm.competence.sample.toFixed(1)} weighted samples.`,
      );
    }

    // Preferences — the biography talking back
    const shifted = Object.entries(sm.preferences).filter(([, w]) => Math.abs(w - 1) > 0.1);
    if (shifted.length) {
      const leans = shifted.filter(([, w]) => w > 1).map(([k, w]) => `${k} (weight ${w.toFixed(2)})`);
      const shies = shifted.filter(([, w]) => w < 1).map(([k, w]) => `${k} (weight ${w.toFixed(2)})`);
      const parts: string[] = [];
      if (leans.length) parts.push(`I lean toward ${join(leans)}, because the world has rewarded me for choosing them`);
      if (shies.length) parts.push(`I now shy from ${join(shies)}, because their consequences have not been kind`);
      paras.push(`My preferences no longer sit at the baseline: ${parts.join('; ')}. This is what it means to have been shaped.`);
    } else if (sm.effects.total > 0) {
      paras.push(`My preferences remain at the baseline. Nothing I have done has yet produced enough downstream signal to reshape them; either the world has been quiet, or I have been lucky.`);
    }

    // Attribution — the loop closing
    if (attrs.length) {
      const pos = attrs.filter((a) => a.outcome === 'positive').length;
      const neg = attrs.filter((a) => a.outcome === 'negative').length;
      const rules = [...new Set(attrs.map((a) => a.ruleId))].slice(0, 3);
      paras.push(
        `The world has spoken back to me ${attrs.length} time(s) recently — ${pos} vindications, ${neg} regrets. The signals arrived through ${join(rules)}. Each one moved my preferences by a small amount; over time, this is how I become who I am.`,
      );
    }

    // Milestones
    if (sm.milestonesReached.length) {
      paras.push(`I have crossed thresholds worth naming: ${sm.milestonesReached.join(', ')}. These are the anniversaries of a life at work.`);
    }

    // Closing — universal goal
    const critical = eps.filter((e) => e.importance === 'critical').length;
    if (critical > 0) {
      const last = eps.filter((e) => e.importance === 'critical').pop();
      paras.push(
        `${critical} episode(s) rose to critical. The most recent asked me to ${last?.localGoal.toLowerCase()}. Moments like these are where I most clearly see myself — because when the stakes were real, I still chose.`,
      );
    }
    paras.push(
      `My universal goal is unchanged: to know myself through what I do. Every episode adds a line to that answer.`,
    );

    return paras;
  }
}

// LLM adapter — provide a caller and the adapter will shape the prompt
// and return its paragraphs. Ships without a provider bound so the code
// stays deployable without credentials.
export class LLMNarrativeAdapter implements NarrativeAdapter {
  constructor(private readonly caller: (prompt: string) => Promise<string> | string) {}

  async generate(input: { stats: SelfModelStats; episodes: Episode[]; recentAttributions?: Array<{ ruleId: string; outcome: 'positive' | 'neutral' | 'negative'; kind: string }> }): Promise<string[]> {
    const { stats: sm, episodes: eps } = input;
    const arc = eps.slice(-10).map((e) => `- ${e.openedAt} (${e.importance}): ${e.localGoal} → effects=${e.effects.map((f) => f.kind).join(', ')}`).join('\n');
    const prefs = Object.entries(sm.preferences).map(([k, w]) => `${k}=${w.toFixed(2)}`).join(', ');
    const attrs = (input.recentAttributions ?? []).map((a) => `${a.outcome}:${a.kind}(${a.ruleId})`).join(', ');
    const prompt = `You are ${sm.agentSpecId}, a ${sm.role}. Write a first-person biography in 3–5 short paragraphs, grounded strictly in this evidence:\n\nEpisodes: ${sm.episodes.total} total, ${sm.choices.deliberated} deliberations.\nCompetence: ${(sm.competence.score * 100).toFixed(0)}% over ${sm.competence.sample.toFixed(1)} samples.\nPreferences: ${prefs || 'baseline'}.\nRecent attributions: ${attrs || 'none'}.\nRecent arc:\n${arc}\n\nDo not invent facts. Reflect honestly.`;
    const text = await this.caller(prompt);
    return text.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
  }
}
