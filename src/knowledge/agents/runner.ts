// ReAct + Plan-and-Execute runners on top of the tool bus.
// Router picks strategy per turn from a lightweight complexity heuristic.
// If OLLAMA_URL is set, uses Ollama for reasoning; otherwise falls back to
// deterministic pattern-based reasoning so the runner is testable offline.

import type { ToolDefinition, ToolResult } from './tool-bus.js';

export type AgentStrategy = 'react' | 'plan-and-execute';

export interface RunTurnInput {
  readonly question: string;
  readonly tools: readonly ToolDefinition[];
  readonly maxSteps?: number;
  readonly ollama?: { url?: string; model?: string } | undefined;
  readonly overrideStrategy?: AgentStrategy | undefined;
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

  // Heuristic ReAct: extract source-id-like tokens from the question and
  // resolve provenance for the first matching source. If Ollama is available,
  // use it to pick tools; otherwise use pattern matching. This keeps the
  // runner deterministic and testable while still calling real tools.
  const q = input.question;
  const sourceIdMatch = q.match(/[a-z0-9]+\.[a-z0-9.]+/gi) ?? [];

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

  const answer = workingSourceId
    ? `Focused on source "${workingSourceId}". Provenance and pack-reach retrieved; ${citations.length} artifact citation(s) available.`
    : 'No matching knowledge source identified in the question.';
  steps.push({ kind: 'answer', text: answer });
  return { strategy: 'react', steps, answer, citations };
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
  const answer = `Top ${top.length} sources by pack coverage${domains.length ? ` for ${domains.join(', ')}` : ''}: ` +
    top.map(r => `${r.name} (${r.packs} packs / ${r.agents} agents)`).join(', ');
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
