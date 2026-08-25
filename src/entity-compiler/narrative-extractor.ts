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

// Optional Ollama-backed refiner: takes rule-based CanonicalEntities from
// loadNarrative() and asks Ollama (JSON mode, temp=0) to enrich them with
// structured fields, workflow steps, and hints. Deterministic and cited.

import type { CanonicalEntity } from './types.js';

export interface ExtractorConfig {
  url?: string;   // e.g. http://localhost:11434
  model?: string; // e.g. "llama3.2:3b"
  timeoutMs?: number;
}

const SYSTEM = `You are a healthcare entity extractor. Given a candidate entity
(name, description, and any bullet list), return STRICT JSON:
{
  "kind": "data" | "workflow" | "concept",
  "fields": [{ "name": "...", "type": "string|number|boolean|date|object|array", "phi": bool, "description": "..." }],
  "workflow": [{ "id": "step-1", "name": "...", "role": "...", "requiresHitl": bool }],
  "hints": { "phi": bool, "purposeOfUse": ["treatment"|"operations"|"compliance"|"research"], "hitl": bool }
}
Be conservative. If unsure, omit the field. No prose, JSON only.`;

async function ollamaJson(cfg: ExtractorConfig, prompt: string): Promise<unknown> {
  const url = cfg.url ?? process.env['OLLAMA_URL'];
  const model = cfg.model ?? process.env['OLLAMA_MODEL'] ?? 'llama3.2:3b';
  if (!url) throw new Error('ollama-not-configured');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 30_000);
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model, prompt, system: SYSTEM,
        format: 'json', stream: false,
        options: { temperature: 0, seed: 42 },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`ollama-http-${res.status}`);
    const body = (await res.json()) as { response: string };
    return JSON.parse(body.response);
  } finally { clearTimeout(t); }
}

/** Enrich rule-based entities with LLM extraction when Ollama is available.
 *  Silently returns entities unchanged if Ollama is not configured or fails. */
export async function enrichWithOllama(
  entities: CanonicalEntity[],
  cfg: ExtractorConfig = {},
): Promise<{ enriched: CanonicalEntity[]; enrichedCount: number; skipped: number }> {
  let enrichedCount = 0;
  let skipped = 0;
  const url = cfg.url ?? process.env['OLLAMA_URL'];
  if (!url) return { enriched: entities, enrichedCount: 0, skipped: entities.length };
  const out: CanonicalEntity[] = [];
  for (const e of entities) {
    // Only enrich low-confidence narrative entities; leave structured/SQL alone.
    if (e.confidence === 'high' || (e.fields.length > 0 && (!e.workflow || e.workflow.length > 0))) {
      out.push(e); skipped++; continue;
    }
    const prompt = `Entity name: ${e.name}\nDescription: ${e.description ?? ''}\nSteps (if any): ${(e.workflow ?? []).map((w) => w.name).join(' | ')}`;
    try {
      const raw = await ollamaJson(cfg, prompt) as {
        kind?: CanonicalEntity['kind'];
        fields?: CanonicalEntity['fields'];
        workflow?: CanonicalEntity['workflow'];
        hints?: CanonicalEntity['hints'];
      };
      const merged: CanonicalEntity = {
        ...e,
        kind: raw.kind ?? e.kind,
        fields: Array.isArray(raw.fields) && raw.fields.length ? raw.fields : e.fields,
        ...(Array.isArray(raw.workflow) && raw.workflow.length ? { workflow: raw.workflow } : e.workflow ? { workflow: e.workflow } : {}),
        hints: { ...e.hints, ...(raw.hints ?? {}) },
        confidence: 'medium',
      };
      out.push(merged);
      enrichedCount++;
    } catch {
      out.push(e); skipped++;
    }
  }
  return { enriched: out, enrichedCount, skipped };
}
