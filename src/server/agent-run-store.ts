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

// Agent run recorder (D batch) — closes the authoring → runtime → measure loop.
//
// Every knowledge turn / agent-spec run is recorded: who ran it, which authored
// agent (packId/agentId/source), the question, the answer, citations, and any
// `evaluate_measure` scores produced during the run. The Agent authoring +
// Published pages then show this runtime signal (runs, citations, measure
// outcomes) so an operator can iterate on an agent with evidence.

import { randomUUID } from 'node:crypto';

export interface AgentRunCitation {
  sourceId: string;
  artifactId?: string;
}

export interface AgentMeasureScore {
  measureId: string;
  met: boolean;
}

export interface AgentRunRecord {
  episodeId: string;
  at: string;
  actorId: string;
  agent?: { packId: string; agentId: string; source: 'draft' | 'published'; displayName?: string };
  question: string;
  strategy: string;
  answer: string;
  citations: AgentRunCitation[];
  measureScores: AgentMeasureScore[];
}

class AgentRunStoreImpl {
  private runs: AgentRunRecord[] = [];
  private readonly maxRuns = 500;

  newEpisode(): string { return randomUUID(); }

  save(run: AgentRunRecord): AgentRunRecord {
    this.runs.unshift(run);
    if (this.runs.length > this.maxRuns) this.runs.length = this.maxRuns;
    return run;
  }

  get(episodeId: string): AgentRunRecord | undefined {
    return this.runs.find((r) => r.episodeId === episodeId);
  }

  list(opts: { agentId?: string; limit?: number } = {}): AgentRunRecord[] {
    const limit = Math.max(1, Math.min(100, opts.limit ?? 25));
    const filtered = opts.agentId ? this.runs.filter((r) => r.agent?.agentId === opts.agentId) : this.runs;
    return filtered.slice(0, limit);
  }
}

export const AgentRunStore = new AgentRunStoreImpl();
