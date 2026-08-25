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

// M20n agent runtime — ReAct + Plan-and-Execute router with tool bus.
// Uses a real knowledge layer bootstrapped against a temp store; no mocks.

import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapKnowledgeLayer, type KnowledgeLayer } from '../src/knowledge/index.js';
import { buildKnowledgeToolBus } from '../src/knowledge/agents/tool-bus.js';
import { routeStrategy, runAgentTurn, runReact, runPlanAndExecute } from '../src/knowledge/agents/runner.js';

let layer: KnowledgeLayer;
beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'hh-agent-'));
  layer = bootstrapKnowledgeLayer({ storeDir: dir });
});

describe('M20n knowledge agent router', () => {
  it('picks plan-and-execute for multi-step questions', () => {
    expect(routeStrategy('First list all sources, then find which ones cover CKD')).toBe('plan-and-execute');
    expect(routeStrategy('compare kidney and diabetes source coverage')).toBe('plan-and-execute');
  });
  it('picks react for short lookups', () => {
    expect(routeStrategy('describe openfda.drug.enforcement')).toBe('react');
  });
  it('honors explicit override', () => {
    expect(routeStrategy('anything', 'plan-and-execute')).toBe('plan-and-execute');
  });
});

describe('M20n tool bus', () => {
  it('exposes six knowledge tools', () => {
    const tools = buildKnowledgeToolBus({ layer, actorId: 't', episodeId: 'e', bus: undefined });
    const names = new Set(tools.map(t => t.name));
    for (const n of ['list_sources', 'describe_source', 'sync_source', 'list_artifacts', 'trace_provenance', 'pack_reach']) {
      expect(names.has(n)).toBe(true);
    }
  });
  it('list_sources returns real registry data', async () => {
    const [tool] = buildKnowledgeToolBus({ layer, actorId: 't', episodeId: 'e', bus: undefined });
    const r = await tool!.invoke({});
    expect(r.ok).toBe(true);
    expect(Array.isArray(r.data)).toBe(true);
    expect((r.data as unknown[]).length).toBeGreaterThan(10);
  });
});

describe('M20n react runner', () => {
  it('describes a source by id present in question', async () => {
    const tools = buildKnowledgeToolBus({ layer, actorId: 't', episodeId: 'e', bus: undefined });
    const outcome = await runReact({ question: 'give me nlm.rxnorm details', tools });
    expect(outcome.strategy).toBe('react');
    const toolNames = outcome.steps.filter(s => s.kind === 'tool').map(s => s.tool!.name);
    expect(toolNames).toContain('describe_source');
    expect(toolNames).toContain('pack_reach');
  });
});

describe('M20n plan-and-execute runner', () => {
  it('enumerates sources and ranks by pack coverage', async () => {
    const tools = buildKnowledgeToolBus({ layer, actorId: 't', episodeId: 'e', bus: undefined });
    const outcome = await runPlanAndExecute({ question: 'For each source, compare pack coverage across kidney workflows', tools });
    expect(outcome.strategy).toBe('plan-and-execute');
    expect(outcome.steps[0]!.kind).toBe('plan');
    expect(outcome.answer).toContain('Top');
  });
});

describe('M20n runAgentTurn', () => {
  it('routes automatically and returns answer + citations', async () => {
    const tools = buildKnowledgeToolBus({ layer, actorId: 't', episodeId: 'e', bus: undefined });
    const outcome = await runAgentTurn({ question: 'describe nlm.pubmed', tools });
    expect(outcome.answer).toBeTruthy();
    expect(Array.isArray(outcome.citations)).toBe(true);
  });
});
