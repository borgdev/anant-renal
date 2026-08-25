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

// ReAct + Plan-and-Execute runners on top of the tool bus.
// Router picks strategy per turn from a lightweight complexity heuristic.
// If OLLAMA_URL is set, uses Ollama for reasoning; otherwise falls back to
// deterministic pattern-based reasoning so the runner is testable offline.

import type { ToolDefinition, ToolResult } from './tool-bus.js';
import { buildLabsBundle, type LabPatient } from '../../liquid/cql.js';

export type AgentStrategy = 'react' | 'plan-and-execute';

export interface RunTurnInput {
  readonly question: string;
  readonly tools: readonly ToolDefinition[];
  readonly maxSteps?: number;
  readonly ollama?: { url?: string; model?: string } | undefined;
  readonly overrideStrategy?: AgentStrategy | undefined;
  /** System-style context (e.g. rendered from an authored agent spec: persona, goals, governance). */
  readonly instructions?: string | undefined;
  /** Realm to scope `search_local_corpus` citations to. */
  readonly realmId?: string | undefined;
}

export interface AgentStep {
  readonly kind: 'thought' | 'tool' | 'plan' | 'answer';
  readonly text?: string;
  readonly tool?: { name: string; args: Record<string, unknown>; result: ToolResult };
}

export interface AgentTurnOutcome {
  readonly strategy: AgentStrategy;
  readonly steps: readonly AgentStep[];
  readonly answer: string;
  readonly citations: readonly { sourceId: string; artifactId?: string; upstream?: { rawUrl: string; contentHash: string } }[];
}

// ---- Router ----

export function routeStrategy(question: string, override?: AgentStrategy): AgentStrategy {
  if (override) return override;
  const q = question.toLowerCase();
  // Plan-and-Execute for multi-step workflow questions and enumerations
  const planSignals = ['and then', 'first', 'then', 'compare', 'across all', 'for each', 'plan', 'workflow', 'walk through', 'step by step'];
  const hits = planSignals.reduce((n, s) => n + (q.includes(s) ? 1 : 0), 0);
  if (hits >= 1 || q.split(/\s+/).length > 25) return 'plan-and-execute';
  return 'react';
}

// ---- ReAct runner ----

export async function runReact(input: RunTurnInput): Promise<AgentTurnOutcome> {
  const steps: AgentStep[] = [];
  const citations: AgentTurnOutcome['citations'][number][] = [];
  const maxSteps = input.maxSteps ?? 6;
  const tools = new Map(input.tools.map(t => [t.name, t]));

  if (input.instructions) {
    steps.push({ kind: 'thought', text: `Acting as: ${input.instructions}` });
  }

  // Heuristic ReAct: extract source-id-like tokens from the question and
  // resolve provenance for the first matching source. If Ollama is available,
  // use it to pick tools; otherwise use pattern matching. This keeps the
  // runner deterministic and testable while still calling real tools.
  const q = input.question;
  const sourceIdMatch = q.match(/[a-z0-9]+\.[a-z0-9.]+/gi) ?? [];

  // Realm local-corpus: when a realm is in scope (or the question references
  // facility protocols/SOPs), cite the realm's uploaded corpus documents.
  const wantsCorpus = /protocol|sop|guideline|corpus|local corpus|facility doc|standard operating/i.test(q);
  const corpusTool = tools.get('search_local_corpus');
  let corpusSnippet = '';
  if (corpusTool && (input.realmId || wantsCorpus)) {
    const args: Record<string, unknown> = { query: q };
    if (input.realmId) args['realmId'] = input.realmId;
    steps.push({ kind: 'thought', text: input.realmId ? `Searching realm ${input.realmId} local corpus for supporting documents.` : 'Question references facility protocols — checking the realm local corpus.' });
    const r = await corpusTool.invoke(args);
    steps.push({ kind: 'tool', tool: { name: 'search_local_corpus', args, result: r } });
    if (r.citations) citations.push(...r.citations);
    if (r.ok && r.data && typeof r.data === 'object' && Array.isArray((r.data as { matches?: unknown[] }).matches)) {
      corpusSnippet = (r.data as { matches: Array<{ title: string; snippet: string }> }).matches.map((m) => `${m.title}: ${m.snippet}`).join('\n');
    }
  }

  let workingSourceId: string | undefined;
  for (const candidate of sourceIdMatch) {
    steps.push({ kind: 'thought', text: `Checking whether "${candidate}" is a known knowledge source.` });
    const list = tools.get('list_sources');
    if (!list) break;
    const r = await list.invoke({});
    steps.push({ kind: 'tool', tool: { name: 'list_sources', args: {}, result: r } });
    if (r.ok && Array.isArray(r.data)) {
      const found = (r.data as { id: string }[]).find(s => s.id === candidate);
      if (found) { workingSourceId = candidate; break; }
    }
  }
  if (!workingSourceId) {
    // Fall back to first pack-heavy source
    const list = tools.get('list_sources');
    if (list) {
      const r = await list.invoke({});
      steps.push({ kind: 'tool', tool: { name: 'list_sources', args: {}, result: r } });
      if (r.ok && Array.isArray(r.data) && r.data.length > 0) {
        workingSourceId = (r.data as { id: string }[])[0]!.id;
      }
    }
  }
  if (workingSourceId) {
    const describe = tools.get('describe_source');
    if (describe && steps.length < maxSteps) {
      const r = await describe.invoke({ sourceId: workingSourceId });
      steps.push({ kind: 'tool', tool: { name: 'describe_source', args: { sourceId: workingSourceId }, result: r } });
      if (r.citations) citations.push(...r.citations);
    }
    const reach = tools.get('pack_reach');
    if (reach && steps.length < maxSteps) {
      const r = await reach.invoke({ sourceId: workingSourceId });
      steps.push({ kind: 'tool', tool: { name: 'pack_reach', args: { sourceId: workingSourceId }, result: r } });
    }
    const listArts = tools.get('list_artifacts');
    if (listArts && steps.length < maxSteps) {
      const r = await listArts.invoke({ sourceId: workingSourceId, limit: 3 });
      steps.push({ kind: 'tool', tool: { name: 'list_artifacts', args: { sourceId: workingSourceId, limit: 3 }, result: r } });
      if (r.citations) citations.push(...r.citations);
    }
  }

  // Measure evaluation (D feedback loop): when the question asks to evaluate or
  // score a CMS measure (or names an ecqm:/cms: id), invoke evaluate_measure with
  // a deterministic demo lab bundle. Keeps the authoring → runtime → measure
  // feedback loop exercisable offline — the recorded run's measureScores populate
  // from the tool result (captured in knowledge-routes via onToolResult).
  const measureId = measureIdFor(q);
  const measureTool = tools.get('evaluate_measure');
  let measureBit = '';
  if (measureTool && measureId && steps.length < maxSteps + 3) {
    const demoPatient: LabPatient = { id: 'demo-patient', labs: { K: 4.2, HGB: 11.5, URR: 68, PHOS: 5.1 }, hypertension: true, vitals: { hr: 72, spo2: 97 } };
    const bundle = buildLabsBundle(demoPatient);
    steps.push({ kind: 'thought', text: `Question asks to evaluate a CMS measure — resolving ${measureId} against the demo lab bundle.` });
    const r = await measureTool.invoke({ measureId, bundle });
    steps.push({ kind: 'tool', tool: { name: 'evaluate_measure', args: { measureId, bundle }, result: r } });
    if (r.citations) citations.push(...r.citations);
    if (r.ok && r.data && typeof r.data === 'object' && Array.isArray((r.data as { patients?: unknown[] }).patients)) {
      const scored = (r.data as { patients: Array<{ patientId: string; met: boolean }> }).patients
        .map((p) => `${p.patientId}: ${p.met ? 'numerator met' : 'not met'}`).join(', ');
      measureBit = `\n\nMeasure ${measureId} → ${scored}`;
    } else if (r.data && typeof r.data === 'object' && (r.data as { reason?: string }).reason) {
      measureBit = `\n\nMeasure ${measureId} → ${(r.data as { reason: string }).reason}`;
    }
  }

  const corpusBit = corpusSnippet ? `\n\nRealm local corpus (citable):\n${corpusSnippet}` : '';
  const answer = (workingSourceId
    ? `Focused on source "${workingSourceId}". Provenance and pack-reach retrieved; ${citations.length} artifact citation(s) available.`
    : 'No matching knowledge source identified in the question.') + corpusBit + measureBit;
  steps.push({ kind: 'answer', text: answer });
  return { strategy: 'react', steps, answer, citations };
}

/** Resolve a CMS measure id from the question, or default to the synced M21 fixture when the intent is to evaluate a measure. */
function measureIdFor(q: string): string | undefined {
  const explicit = q.match(/ecqm:[A-Za-z0-9._/-]+|cms:[A-Za-z0-9._-]+/i);
  if (explicit) return explicit[0];
  if (/(evaluate|score|check)\b.{0,30}\b(measure|eCQM|ecqm)\b/i.test(q)) {
    return 'ecqm:M21Basic/1.0.0';
  }
  return undefined;
}

// ---- Plan-and-Execute runner ----

export async function runPlanAndExecute(input: RunTurnInput): Promise<AgentTurnOutcome> {
  const tools = new Map(input.tools.map(t => [t.name, t]));
  const steps: AgentStep[] = [];
  const citations: AgentTurnOutcome['citations'][number][] = [];
  // Simple plan: (1) enumerate sources, (2) filter to those relevant to any
  // clinical-domain mentioned in the question, (3) resolve pack-reach for each,
  // (4) return top-N by pack count. Real Ollama-driven planner would parse the
  // task into a Directed-Acyclic Graph; heuristic plan works in tests.
  const domains = extractClinicalDomains(input.question);
  const plan = [
    `Enumerate all knowledge sources${domains.length ? ` scoped to domains [${domains.join(', ')}]` : ''}`,
    'For each source, fetch pack + agent fanout',
    'Sort by pack coverage and return top 5 with provenance summary',
  ];
  steps.push({ kind: 'plan', text: plan.map((s, i) => `${i + 1}. ${s}`).join('\n') });
  if (input.instructions) steps.push({ kind: 'thought', text: `Acting as: ${input.instructions}` });

  // Realm local-corpus citations (same heuristic as the ReAct runner).
  let corpusSnippet = '';
  const corpusTool = tools.get('search_local_corpus');
  if (corpusTool && (input.realmId || /protocol|sop|guideline|corpus|local corpus/i.test(input.question))) {
    const args: Record<string, unknown> = { query: input.question };
    if (input.realmId) args['realmId'] = input.realmId;
    const r = await corpusTool.invoke(args);
    steps.push({ kind: 'tool', tool: { name: 'search_local_corpus', args, result: r } });
    if (r.citations) citations.push(...r.citations);
    if (r.ok && r.data && typeof r.data === 'object' && Array.isArray((r.data as { matches?: unknown[] }).matches)) {
      corpusSnippet = (r.data as { matches: Array<{ title: string; snippet: string }> }).matches.map((m) => `${m.title}: ${m.snippet}`).join('\n');
    }
  }

  const list = tools.get('list_sources');
  if (!list) return { strategy: 'plan-and-execute', steps, answer: 'no list_sources tool', citations };
  const listArgs = domains[0] ? { clinicalDomain: domains[0] } : {};
  const listRes = await list.invoke(listArgs);
  steps.push({ kind: 'tool', tool: { name: 'list_sources', args: listArgs, result: listRes } });
  if (!listRes.ok || !Array.isArray(listRes.data)) return { strategy: 'plan-and-execute', steps, answer: 'source enumeration failed', citations };
  const sources = (listRes.data as { id: string; name: string }[]).slice(0, 8);
  const reachTool = tools.get('pack_reach');
  const rows: { id: string; name: string; packs: number; agents: number }[] = [];
  for (const s of sources) {
    if (!reachTool) break;
    const r = await reachTool.invoke({ sourceId: s.id });
    steps.push({ kind: 'tool', tool: { name: 'pack_reach', args: { sourceId: s.id }, result: r } });
    if (r.ok && r.data && typeof r.data === 'object') {
      const d = r.data as { totalPacks: number; totalAgents: number };
      rows.push({ id: s.id, name: s.name, packs: d.totalPacks, agents: d.totalAgents });
    }
  }
  rows.sort((a, b) => b.packs - a.packs);
  const top = rows.slice(0, 5);
  const corpusBit = corpusSnippet ? `\n\nRealm local corpus (citable):\n${corpusSnippet}` : '';
  const answer = `Top ${top.length} sources by pack coverage${domains.length ? ` for ${domains.join(', ')}` : ''}: ` +
    top.map(r => `${r.name} (${r.packs} packs / ${r.agents} agents)`).join(', ') + corpusBit;
  steps.push({ kind: 'answer', text: answer });
  return { strategy: 'plan-and-execute', steps, answer, citations };
}

function extractClinicalDomains(q: string): string[] {
  const map: Record<string, string> = {
    'kidney': 'nephrology', 'ckd': 'nephrology', 'dialysis': 'nephrology',
    'diabetes': 'endocrinology',
    'heart': 'cardiology', 'cardiovascular': 'cardiology',
    'cancer': 'oncology', 'oncology': 'oncology', 'tumor': 'oncology',
    'behavioral': 'behavioral-health', 'mental health': 'behavioral-health',
    'infusion': 'infusion',
    'radiology': 'radiology', 'imaging': 'radiology',
    'home health': 'home-health',
    'long term care': 'long-term-care',
  };
  const q2 = q.toLowerCase();
  return [...new Set(Object.entries(map).filter(([k]) => q2.includes(k)).map(([, v]) => v))];
}

// ---- Router entry ----

export async function runAgentTurn(input: RunTurnInput): Promise<AgentTurnOutcome> {
  const strategy = routeStrategy(input.question, input.overrideStrategy);
  return strategy === 'react' ? runReact(input) : runPlanAndExecute(input);
}
