// Episode substrate — every meaningful thing that happens to an agent is
// an Episode. An Episode is a structured, hashed, replayable record of a
// perception ⟶ deliberation ⟶ choice ⟶ effect ⟶ consequence loop.
//
// Episodes are the corpus of "world play" — the raw material the Self-Model
// consumes to build a biography. They are prunable: unimportant episodes
// can be archived to save space, but the ledger of chosen effects remains
// authoritative in the EffectLedger.
//
// Design invariants:
//   1. Every Episode is content-hashed (SHA-256 over its canonical JSON).
//   2. Episodes are append-only within a session; pruning tombstones an
//      episode but never mutates it.
//   3. An Episode always references the presence, the perceived events
//      that opened it, the choice made (if any), the effect(s) emitted,
//      and the consequences (subsequent events attributable to it).
//   4. Replay = feed the perception + rng seed back to the runtime; the
//      same behavior must produce the same choice.

import { createHash, randomUUID } from 'node:crypto';
import type { AgentPresence, EmittedEffect, PerceivedEvent, WorldEffect } from './types.js';

export type EpisodeStatus = 'open' | 'closed' | 'pruned';
export type EpisodeImportance = 'trivial' | 'routine' | 'notable' | 'critical';

export interface ChoicePoint {
  presented: Array<{ optionId: string; description: string; utility: number; preferenceWeight: number; finalScore: number }>;
  chosenOptionId: string;
  rationale: string;
  rngRoll?: number; // for reproducibility
  selfModelInfluence?: number; // 0..1, how much the self-model swung the choice
}

export interface Episode {
  episodeId: string;
  presenceId: string;
  agentSpecId: string;
  role: AgentPresence['role'];
  openedAt: string; // realm time
  closedAt?: string;
  status: EpisodeStatus;
  importance: EpisodeImportance;
  localGoal: string; // situated intent, e.g. "respond to hyperkalemic K+"
  perception: PerceivedEvent[]; // what opened the episode
  choice?: ChoicePoint; // if a decision was made
  effects: WorldEffect[]; // what the agent did
  consequences: string[]; // effect-ids attributed to this episode
  hash: string;
}

function canonicalize(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(',')}]`;
  const keys = Object.keys(v as object).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

function hashEpisode(ep: Omit<Episode, 'hash'>): string {
  return createHash('sha256').update(canonicalize(ep)).digest('hex');
}

export class EpisodeStore {
  private byId = new Map<string, Episode>();
  private byPresence = new Map<string, string[]>();
  private open = new Map<string, string>(); // presenceId -> current open episodeId

  openEpisode(input: {
    presence: AgentPresence;
    localGoal: string;
    openingPerception: PerceivedEvent[];
    openedAt: string;
  }): Episode {
    const episodeId = randomUUID();
    const base: Omit<Episode, 'hash'> = {
      episodeId,
      presenceId: input.presence.presenceId,
      agentSpecId: input.presence.agentSpecId,
      role: input.presence.role,
      openedAt: input.openedAt,
      status: 'open',
      importance: 'routine',
      localGoal: input.localGoal,
      perception: input.openingPerception,
      effects: [],
      consequences: [],
    };
    const ep: Episode = { ...base, hash: hashEpisode(base) };
    this.byId.set(episodeId, ep);
    const arr = this.byPresence.get(input.presence.presenceId) ?? [];
    arr.push(episodeId);
    this.byPresence.set(input.presence.presenceId, arr);
    this.open.set(input.presence.presenceId, episodeId);
    return ep;
  }

  recordChoice(episodeId: string, choice: ChoicePoint): void {
    const ep = this.byId.get(episodeId);
    if (!ep) return;
    const updated = { ...ep, choice };
    updated.hash = hashEpisode(({ ...updated, hash: undefined } as unknown) as Omit<Episode, 'hash'>);
    this.byId.set(episodeId, updated);
  }

  recordEffect(episodeId: string, effect: WorldEffect, emitted: EmittedEffect): void {
    const ep = this.byId.get(episodeId);
    if (!ep) return;
    const updated: Episode = {
      ...ep,
      effects: [...ep.effects, effect],
      consequences: [...ep.consequences, emitted.effectId],
    };
    updated.hash = hashEpisode(({ ...updated, hash: undefined } as unknown) as Omit<Episode, 'hash'>);
    this.byId.set(episodeId, updated);
  }

  closeEpisode(episodeId: string, closedAt: string, importance: EpisodeImportance = 'routine'): void {
    const ep = this.byId.get(episodeId);
    if (!ep) return;
    const updated: Episode = { ...ep, status: 'closed', closedAt, importance };
    updated.hash = hashEpisode(({ ...updated, hash: undefined } as unknown) as Omit<Episode, 'hash'>);
    this.byId.set(episodeId, updated);
    if (this.open.get(ep.presenceId) === episodeId) this.open.delete(ep.presenceId);
  }

  currentOpenFor(presenceId: string): Episode | undefined {
    const id = this.open.get(presenceId);
    return id ? this.byId.get(id) : undefined;
  }

  get(episodeId: string): Episode | undefined { return this.byId.get(episodeId); }
  listForPresence(presenceId: string): Episode[] { return (this.byPresence.get(presenceId) ?? []).map((id) => this.byId.get(id)!).filter(Boolean); }
  all(): Episode[] { return [...this.byId.values()]; }

  // Pruning: mark low-importance episodes as 'pruned' and drop their
  // perception payloads to save memory. The ID, hash, and choice are
  // preserved for auditability.
  prune(rule: { olderThanMs: number; keepImportance: EpisodeImportance[] }): number {
    const now = Date.now();
    let pruned = 0;
    for (const ep of this.byId.values()) {
      if (ep.status !== 'closed') continue;
      if (rule.keepImportance.includes(ep.importance)) continue;
      const openedMs = Date.parse(ep.openedAt);
      if (Number.isNaN(openedMs) || now - openedMs < rule.olderThanMs) continue;
      const tombstoned: Episode = { ...ep, status: 'pruned', perception: [] };
      tombstoned.hash = hashEpisode(({ ...tombstoned, hash: undefined } as unknown) as Omit<Episode, 'hash'>);
      this.byId.set(ep.episodeId, tombstoned);
      pruned++;
    }
    return pruned;
  }

  stats() {
    const all = this.all();
    const byRole: Record<string, number> = {};
    const byImportance: Record<string, number> = {};
    for (const ep of all) {
      byRole[ep.role] = (byRole[ep.role] ?? 0) + 1;
      byImportance[ep.importance] = (byImportance[ep.importance] ?? 0) + 1;
    }
    return { total: all.length, byRole, byImportance, openNow: this.open.size };
  }
}
