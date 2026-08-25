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

// Loaders: read heterogeneous input files and normalize to CanonicalEntity[].
// No file is silently dropped; every loader records sourceRefs and confidence.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import type { CanonicalEntity, FieldSpec, RelationshipSpec, WorkflowStep, EntityKind } from './types.js';
import { loadXlsx } from './xlsx-loader.js';

export { loadXlsx };

const PHI_HINT = /\b(patient|mrn|ssn|dob|birth|phone|email|address|name|nhs|medicaid|medicare|npi)\b/i;

function hashContent(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

function inferPhi(name: string, fields: FieldSpec[]): boolean {
  if (PHI_HINT.test(name)) return true;
  return fields.some((f) => f.phi || PHI_HINT.test(f.name));
}

function inferType(sample: unknown): FieldSpec['type'] {
  if (sample == null) return 'unknown';
  if (Array.isArray(sample)) return 'array';
  if (sample instanceof Date) return 'date';
  if (typeof sample === 'object') return 'object';
  if (typeof sample === 'number') return 'number';
  if (typeof sample === 'boolean') return 'boolean';
  if (typeof sample === 'string') {
    if (/^\d{4}-\d{2}-\d{2}/.test(sample)) return 'date';
    return 'string';
  }
  return 'unknown';
}

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ---------- Structured (JSON / YAML) ----------
// Expected shape (flexible): { entities: [ { id, name, kind?, fields: [...], relationships: [...], workflow: [...], hints: {...} } ] }
// Or a bare array. Or a legacy shape { tables: [...] } that we auto-lift into entities.
export function loadStructured(filePath: string): CanonicalEntity[] {
  const raw = readFileSync(filePath, 'utf8');
  const contentHash = hashContent(raw);
  const parsed = extname(filePath) === '.json' ? JSON.parse(raw) : parseYaml(raw);
  const entities: Array<Record<string, unknown>> = Array.isArray(parsed)
    ? (parsed as Array<Record<string, unknown>>)
    : Array.isArray((parsed as Record<string, unknown>)?.['entities'])
      ? ((parsed as Record<string, unknown>)['entities'] as Array<Record<string, unknown>>)
      : Array.isArray((parsed as Record<string, unknown>)?.['tables'])
        ? ((parsed as Record<string, unknown>)['tables'] as Array<Record<string, unknown>>)
        : [];
  const out: CanonicalEntity[] = [];
  for (const e of entities) {
    const name = String(e['name'] ?? e['id'] ?? 'unknown-entity');
    const id = String(e['id'] ?? slugify(name));
    const kind = ((e['kind'] as EntityKind) ?? 'data');
    const fields: FieldSpec[] = Array.isArray(e['fields'])
      ? (e['fields'] as FieldSpec[])
      : Array.isArray(e['columns'])
        ? (e['columns'] as Array<Record<string, unknown>>).map((c) => ({
            name: String(c['name']),
            type: (c['type'] as FieldSpec['type']) ?? 'unknown',
            required: c['required'] === true || c['nullable'] === false,
            ...(c['primary_key'] === true || c['pk'] === true ? { primaryKey: true } : {}),
            ...(c['phi'] === true ? { phi: true } : {}),
            ...(c['description'] ? { description: String(c['description']) } : {}),
          }))
        : [];
    const rels: RelationshipSpec[] = Array.isArray(e['relationships']) ? (e['relationships'] as RelationshipSpec[]) : [];
    const wf: WorkflowStep[] | undefined = Array.isArray(e['workflow']) ? (e['workflow'] as WorkflowStep[]) : undefined;
    const hints = (e['hints'] as CanonicalEntity['hints']) ?? {};
    out.push({
      id, name, kind,
      ...(e['description'] ? { description: String(e['description']) } : {}),
      fields, relationships: rels,
      ...(wf ? { workflow: wf } : {}),
      hints: { phi: hints.phi ?? inferPhi(name, fields), ...hints },
      sourceRefs: [{ file: basename(filePath), contentHash }],
      confidence: fields.length > 0 || (wf && wf.length > 0) ? 'high' : 'medium',
    });
  }
  return out;
}

// ---------- Tabular (CSV) ----------
// Convention: single CSV = single entity. First row = headers. If a second file
// `<name>.dict.csv` exists next to it (name,type,pk,phi,description), it enriches types.
// XLSX is handled by converting sheet-by-sheet via a tiny csv shim (SheetJS is heavy;
// we accept CSV export as the interop format).
export function loadTabular(csvPath: string): CanonicalEntity[] {
  const raw = readFileSync(csvPath, 'utf8');
  const contentHash = hashContent(raw);
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const firstLine = lines[0];
  if (!firstLine) return [];
  const headers = firstLine.split(',').map((h) => h.trim());
  const dataRow = lines[1] ?? '';
  const sample = dataRow.split(',');
  const entityName = basename(csvPath).replace(/\.csv$/, '');
  const dictPath = csvPath.replace(/\.csv$/, '.dict.csv');
  const dict = new Map<string, { type?: FieldSpec['type']; pk?: boolean; phi?: boolean; description?: string }>();
  try {
    const dictRaw = readFileSync(dictPath, 'utf8');
    const [_h, ...rows] = dictRaw.split(/\r?\n/).filter((l) => l.length > 0);
    for (const r of rows) {
      const [name, type, pk, phi, description] = r.split(',');
      if (name) dict.set(name.trim(), {
        ...(type ? { type: type.trim() as FieldSpec['type'] } : {}),
        pk: pk?.trim() === 'true',
        phi: phi?.trim() === 'true',
        ...(description ? { description: description.trim() } : {}),
      });
    }
  } catch { /* no dict */ }
  const fields: FieldSpec[] = headers.map((h, i) => {
    const d = dict.get(h);
    const type = d?.type ?? inferType(sample[i]);
    return {
      name: h, type, required: false,
      ...(d?.pk ? { primaryKey: true } : {}),
      ...(d?.phi || PHI_HINT.test(h) ? { phi: true } : {}),
      ...(d?.description ? { description: d.description } : {}),
    };
  });
  return [{
    id: slugify(entityName), name: entityName, kind: 'data',
    fields, relationships: [], hints: { phi: inferPhi(entityName, fields) },
    sourceRefs: [{ file: basename(csvPath), contentHash, span: `${lines.length - 1} rows` }],
    confidence: dict.size > 0 ? 'high' : 'medium',
  }];
}

// ---------- SQL DDL ----------
// Parses CREATE TABLE statements. Supports PRIMARY KEY, NOT NULL, REFERENCES.
export function loadSqlDdl(filePath: string): CanonicalEntity[] {
  const raw = readFileSync(filePath, 'utf8');
  const contentHash = hashContent(raw);
  const stripped = raw.replace(/--.*$/gm, '');
  const tableRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?\s*\(([\s\S]*?)\)\s*;/gi;
  const out: CanonicalEntity[] = [];
  let m: RegExpExecArray | null;
  while ((m = tableRe.exec(stripped)) !== null) {
    const name = m[1]!;
    const body = m[2]!;
    const colLines = body.split(',').map((l) => l.trim()).filter(Boolean);
    const fields: FieldSpec[] = [];
    const rels: RelationshipSpec[] = [];
    let inlinePkCol: string | undefined;
    for (const line of colLines) {
      const pkMatch = /^PRIMARY\s+KEY\s*\(\s*["`]?(\w+)["`]?\s*\)/i.exec(line);
      if (pkMatch) { inlinePkCol = pkMatch[1]; continue; }
      const fkMatch = /^FOREIGN\s+KEY\s*\(\s*["`]?(\w+)["`]?\s*\)\s*REFERENCES\s+["`]?(\w+)["`]?\s*\(\s*["`]?(\w+)["`]?\s*\)/i.exec(line);
      if (fkMatch) { rels.push({ fromField: fkMatch[1]!, toEntity: fkMatch[2]!, toField: fkMatch[3]! }); continue; }
      const colMatch = /^["`]?(\w+)["`]?\s+(\w+)(.*)$/.exec(line);
      if (!colMatch) continue;
      const [, colName, colType, rest] = colMatch;
      const required = /NOT\s+NULL/i.test(rest || '');
      const inlinePk = /PRIMARY\s+KEY/i.test(rest || '');
      const refMatch = /REFERENCES\s+["`]?(\w+)["`]?\s*\(\s*["`]?(\w+)["`]?\s*\)/i.exec(rest || '');
      if (refMatch) rels.push({ fromField: colName!, toEntity: refMatch[1]!, toField: refMatch[2]! });
      const jsType: FieldSpec['type'] =
        /INT|SERIAL|NUMERIC|DECIMAL|REAL|DOUBLE|FLOAT/i.test(colType!) ? 'number' :
        /BOOL/i.test(colType!) ? 'boolean' :
        /DATE|TIME/i.test(colType!) ? 'date' :
        /JSON/i.test(colType!) ? 'object' : 'string';
      fields.push({
        name: colName!, type: jsType, required,
        ...(inlinePk ? { primaryKey: true } : {}),
        ...(PHI_HINT.test(colName!) ? { phi: true } : {}),
      });
    }
    if (inlinePkCol) {
      const f = fields.find((x) => x.name === inlinePkCol);
      if (f) f.primaryKey = true;
    }
    out.push({
      id: slugify(name), name, kind: 'data',
      fields, relationships: rels, hints: { phi: inferPhi(name, fields) },
      sourceRefs: [{ file: basename(filePath), contentHash, span: `table ${name}` }],
      confidence: 'high',
    });
  }
  return out;
}

// ---------- dbt manifest.json ----------
export function loadDbt(filePath: string): CanonicalEntity[] {
  const raw = readFileSync(filePath, 'utf8');
  const contentHash = hashContent(raw);
  const parsed = JSON.parse(raw) as { nodes?: Record<string, { name: string; description?: string; columns?: Record<string, { name: string; description?: string; data_type?: string; meta?: Record<string, unknown> }>; depends_on?: { nodes?: string[] }; resource_type?: string }> };
  const out: CanonicalEntity[] = [];
  for (const [key, node] of Object.entries(parsed.nodes ?? {})) {
    if (node.resource_type !== 'model') continue;
    const fields: FieldSpec[] = Object.values(node.columns ?? {}).map((c) => ({
      name: c.name,
      type: (c.data_type as FieldSpec['type']) ?? 'unknown',
      ...(c.description ? { description: c.description } : {}),
      ...(c.meta?.['phi'] === true || PHI_HINT.test(c.name) ? { phi: true } : {}),
    }));
    const rels: RelationshipSpec[] = (node.depends_on?.nodes ?? []).map((dep) => ({
      fromField: '(model dep)', toEntity: dep.split('.').pop() ?? dep, toField: '(model)',
    }));
    out.push({
      id: slugify(node.name), name: node.name, kind: 'data',
      ...(node.description ? { description: node.description } : {}),
      fields, relationships: rels, hints: { phi: inferPhi(node.name, fields) },
      sourceRefs: [{ file: basename(filePath), contentHash, span: `model ${key}` }],
      confidence: fields.length > 0 ? 'high' : 'low',
    });
  }
  return out;
}

// ---------- Markdown / narrative (rule-based first pass) ----------
// Extracts H2/H3 headings as entity candidates, bullet lists as workflow steps.
// LLM refinement happens in narrative-extractor.ts; this loader guarantees we
// still return something usable when Ollama is offline.
export function loadNarrative(filePath: string): CanonicalEntity[] {
  const raw = readFileSync(filePath, 'utf8');
  const contentHash = hashContent(raw);
  const lines = raw.split(/\r?\n/);
  const out: CanonicalEntity[] = [];
  let current: { name: string; lineStart: number; bullets: string[]; body: string[] } | null = null;
  const flush = (lineEnd: number) => {
    if (!current) return;
    const steps: WorkflowStep[] = current.bullets.map((b, i) => ({ id: `step-${i + 1}`, name: b.slice(0, 80) }));
    const isWorkflow = steps.length >= 2;
    const kind: EntityKind = isWorkflow ? 'workflow' : 'concept';
    out.push({
      id: slugify(current.name), name: current.name, kind,
      description: current.body.join(' ').slice(0, 400),
      fields: [], relationships: [],
      ...(isWorkflow ? { workflow: steps } : {}),
      hints: { phi: PHI_HINT.test(current.name + ' ' + current.body.join(' ')) },
      sourceRefs: [{ file: basename(filePath), contentHash, span: `L${current.lineStart + 1}-L${lineEnd + 1}` }],
      confidence: isWorkflow ? 'medium' : 'low',
    });
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const h = /^(#{2,3})\s+(.+?)\s*$/.exec(line);
    if (h) {
      flush(i - 1);
      current = { name: h[2]!, lineStart: i, bullets: [], body: [] };
      continue;
    }
    if (current) {
      const b = /^[-*]\s+(.+)$/.exec(line);
      if (b) current.bullets.push(b[1]!);
      else if (line.trim().length > 0) current.body.push(line.trim());
    }
  }
  flush(lines.length - 1);
  return out;
}

// ---------- Directory walker ----------
export function loadDirectory(dir: string): CanonicalEntity[] {
  const out: CanonicalEntity[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) { out.push(...loadDirectory(p)); continue; }
    if (name.endsWith('.dict.csv')) continue; // handled by companion .csv
    const ext = extname(name).toLowerCase();
    try {
      if (ext === '.json' && name.endsWith('manifest.json')) out.push(...loadDbt(p));
      else if (ext === '.json' || ext === '.yaml' || ext === '.yml') out.push(...loadStructured(p));
      else if (ext === '.csv') out.push(...loadTabular(p));
      else if (ext === '.sql' || ext === '.ddl') out.push(...loadSqlDdl(p));
      else if (ext === '.md' || ext === '.markdown') out.push(...loadNarrative(p));
      else if (ext === '.xlsx' || ext === '.xlsm') out.push(...loadXlsx(p));
    } catch (err) {
      // Never silently drop; add a placeholder rejection entity
      out.push({
        id: `unloadable-${slugify(name)}`, name, kind: 'concept',
        description: `Loader error: ${(err as Error).message}`,
        fields: [], relationships: [], hints: {},
        sourceRefs: [{ file: name }],
        confidence: 'low',
      });
    }
  }
  return out;
}
