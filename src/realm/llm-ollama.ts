// M13.D — Ollama LLM adapters
//
// Local-first LLM integration. Talks to a running Ollama server via HTTP.
// If OLLAMA_URL is not set, adapters are constructed in a "disabled" state
// and will throw when called — callers should feature-flag on `isEnabled()`.
//
// Two adapters:
//   - OllamaPlannerAdapter: implements LLMPlannerAdapter
//   - OllamaOperatorAdapter: implements OperatorLLMAdapter
//
// Both use JSON-mode prompts with strict schemas and fall back to throwing on
// malformed output. The deterministic template planner + regex parser remain
// as tier-1; LLM is tier-2 fallback.

import type { Intent, LLMPlannerAdapter, PlanStep } from './planner.js';
import type { OperatorLLMAdapter, OperatorDirective, OperatorVerb } from './operator-seat.js';

export interface OllamaConfig {
  url?: string; // e.g. "http://localhost:11434"
  model?: string; // e.g. "llama3.2:3b"
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

async function ollamaGenerate(cfg: OllamaConfig, prompt: string, system: string): Promise<string> {
  const url = cfg.url ?? process.env['OLLAMA_URL'];
  const model = cfg.model ?? process.env['OLLAMA_MODEL'] ?? 'llama3.2:3b';
  if (!url) throw new Error('ollama-not-configured: set OLLAMA_URL or cfg.url');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt, system, format: 'json', stream: false }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`ollama-http-${res.status}: ${await res.text().catch(() => '')}`);
    const body = (await res.json()) as { response: string };
    return body.response;
  } finally { clearTimeout(t); }
}

export class OllamaPlannerAdapter implements LLMPlannerAdapter {
  readonly id = 'ollama-planner';
  constructor(private readonly cfg: OllamaConfig = {}) {}
  isEnabled(): boolean { return Boolean(this.cfg.url ?? process.env['OLLAMA_URL']); }

  async plan(intent: Intent, worldSummary: string): Promise<PlanStep[]> {
    const system = `You are a healthcare operations planner. Given an operator intent and a world summary,
produce a JSON PlanGraph as an array of steps. Each step has: id (s1..sN), label (short),
ownerRole (one of md, nurse, pharmacist, coder, auditor, facilities-tech, tech, admin),
effectHint (optional: {kind, params}), dependsOn (optional: array of step ids), status: "pending".
Return ONLY the JSON array, no prose. Prefer 2-5 steps. If a step is a hand-off with no effect, omit effectHint.`;
    const prompt = `Intent kind: ${intent.intentKind}\nSubject: ${intent.subjectRef ?? '(none)'}\nDescription: ${intent.description}\nPriority: ${intent.priority}\nWorld summary:\n${worldSummary}`;
    const raw = await ollamaGenerate(this.cfg, prompt, system);
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new Error(`ollama-planner-invalid-json: ${raw.slice(0, 200)}`); }
    if (!Array.isArray(parsed)) {
      // Some models wrap in { steps: [...] }
      if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { steps?: unknown[] }).steps)) {
        parsed = (parsed as { steps: unknown[] }).steps;
      } else throw new Error('ollama-planner-not-array');
    }
    const steps = (parsed as PlanStep[]).map((s, i) => ({
      id: s.id || `s${i + 1}`,
      label: s.label || `step ${i + 1}`,
      ownerRole: s.ownerRole || 'admin',
      ...(s.effectHint ? { effectHint: s.effectHint } : {}),
      ...(s.dependsOn ? { dependsOn: s.dependsOn } : {}),
      status: 'pending' as const,
    }));
    if (steps.length === 0) throw new Error('ollama-planner-empty-plan');
    return steps;
  }
}

const OP_VERBS: OperatorVerb[] = ['spawn', 'nudge-preference', 'add-rule', 'submit-intent', 'explain'];

export class OllamaOperatorAdapter implements OperatorLLMAdapter {
  readonly id = 'ollama-operator';
  constructor(private readonly cfg: OllamaConfig = {}) {}
  isEnabled(): boolean { return Boolean(this.cfg.url ?? process.env['OLLAMA_URL']); }

  async parse(text: string): Promise<OperatorDirective | undefined> {
    const system = `You are a healthcare operations command parser. Given a natural-language directive,
return a JSON object: {"verb": <one of ${OP_VERBS.join('|')}>, "payload": {...}, "targetRef": <optional string>}.
Payloads by verb:
  - spawn: {role, unitId?}
  - nudge-preference: {presenceId, effectKind, delta} (delta positive = toward, negative = away)
  - add-rule: {rule}
  - submit-intent: {intentKind, subjectRef?, description, priority?}
  - explain: {presenceId}
If the input does not match any verb, return {"verb":"unknown"}.
Return ONLY JSON.`;
    const raw = await ollamaGenerate(this.cfg, text, system);
    let parsed: { verb?: string; payload?: Record<string, unknown>; targetRef?: string };
    try { parsed = JSON.parse(raw); } catch { return undefined; }
    if (!parsed.verb || parsed.verb === 'unknown') return undefined;
    if (!OP_VERBS.includes(parsed.verb as OperatorVerb)) return undefined;
    const directive: OperatorDirective = {
      verb: parsed.verb as OperatorVerb,
      payload: parsed.payload ?? {},
      originalText: text,
      reasoning: `Parsed by ${this.id}`,
      confidence: 0.7,
      ...(parsed.targetRef ? { targetRef: parsed.targetRef } : {}),
    };
    return directive;
  }
}
