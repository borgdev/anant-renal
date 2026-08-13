// XLSX loader for the entity compiler.
//
// Conventions (all optional \u2014 sensible defaults if none present):
//
// 1. Each data sheet becomes one CanonicalEntity. Sheet name = entity name.
//    First row = column headers, subsequent rows = data samples (used to infer
//    types when no dictionary is provided).
//
// 2. Reserved sheet `_dictionary` (case-insensitive): a global data-dictionary
//    across all sheets. Columns:
//      sheet, name, type, pk, phi, description, required, ref_sheet, ref_column
//    Rows override / augment the type inference from the data sheet.
//
// 3. Reserved sheet `_entities` (case-insensitive): declares metadata per
//    sheet-entity. Columns:
//      sheet, kind, description, phi, purpose_of_use, hitl, facility_kind
//    Missing sheets default to kind=data with inferred phi.
//
// 4. Reserved sheet `_workflows` (case-insensitive): each row = a workflow step.
//    Columns: workflow_id, workflow_name, step_id, step_name, role, requires_hitl, description
//    Grouped by workflow_id/workflow_name, then emitted as a single
//    workflow-kind CanonicalEntity so the classifier -> procedure-runner path
//    fires for each workflow.
//
// Sheets whose name starts with `_` are treated as metadata and never emitted
// directly as entities.
//
// All source refs preserve `sheet` and `row` info so an operator can trace
// every generated agent back to a specific cell range in the workbook.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import * as XLSX from 'xlsx';
import type { CanonicalEntity, FieldSpec, RelationshipSpec, WorkflowStep, EntityHints } from './types.js';

const PHI_HINT = /\b(patient|mrn|ssn|dob|birth|phone|email|address|name|nhs|medicaid|medicare|npi)\b/i;

function hashContent(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function truthy(v: unknown): boolean {
  if (v === true) return true;
  if (typeof v === 'string') return /^(true|yes|y|1|x)$/i.test(v.trim());
  if (typeof v === 'number') return v !== 0;
  return false;
}

function inferType(sample: unknown): FieldSpec['type'] {
  if (sample == null || sample === '') return 'unknown';
  if (Array.isArray(sample)) return 'array';
  if (sample instanceof Date) return 'date';
  if (typeof sample === 'object') return 'object';
  if (typeof sample === 'number') return 'number';
  if (typeof sample === 'boolean') return 'boolean';
  if (typeof sample === 'string') {
    if (/^\d{4}-\d{2}-\d{2}/.test(sample)) return 'date';
    if (/^-?\d+(\.\d+)?$/.test(sample)) return 'number';
    if (/^(true|false)$/i.test(sample)) return 'boolean';
    return 'string';
  }
  return 'unknown';
}

interface DictRow {
  sheet: string | undefined;
  name: string | undefined;
  type: FieldSpec['type'] | undefined;
  pk: boolean;
  phi: boolean;
  description: string | undefined;
  required: boolean;
  ref_sheet: string | undefined;
  ref_column: string | undefined;
}

interface EntityMetaRow {
  sheet: string;
  kind: CanonicalEntity['kind'] | undefined;
  description: string | undefined;
  phi: boolean | undefined;
  purpose_of_use: string | undefined;
  hitl: boolean | undefined;
  facility_kind: string | undefined;
}

interface WorkflowRow {
  workflow_id: string | undefined;
  workflow_name: string | undefined;
  step_id: string | undefined;
  step_name: string | undefined;
  role: string | undefined;
  requires_hitl: boolean;
  description: string | undefined;
}

function normalizeKey(k: string): string {
  return k.toLowerCase().replace(/[\s.-]+/g, '_').trim();
}

function normalizeRow<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[normalizeKey(k)] = v;
  return out as T;
}

function findSheet(wb: XLSX.WorkBook, name: string): XLSX.WorkSheet | undefined {
  const match = wb.SheetNames.find((s) => s.toLowerCase() === name.toLowerCase());
  return match ? wb.Sheets[match] : undefined;
}

/** Read an XLSX workbook and produce one CanonicalEntity per data sheet,
 *  plus any workflow entities declared in the reserved `_workflows` sheet. */
export function loadXlsx(filePath: string): CanonicalEntity[] {
  const buf = readFileSync(filePath);
  const contentHash = hashContent(buf);
  // cellDates=true so Excel date cells become JS Date objects (not serial numbers)
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });

  // Parse metadata sheets first
  const dictRows: DictRow[] = [];
  const dictSheet = findSheet(wb, '_dictionary');
  if (dictSheet) {
    const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(dictSheet, { defval: null });
    for (const r of raw) {
      const n = normalizeRow<Record<string, unknown>>(r);
      dictRows.push({
        sheet: n['sheet'] ? String(n['sheet']) : undefined,
        name: n['name'] ? String(n['name']) : undefined,
        type: n['type'] ? String(n['type']).toLowerCase() as FieldSpec['type'] : undefined,
        pk: truthy(n['pk']),
        phi: truthy(n['phi']),
        description: n['description'] ? String(n['description']) : undefined,
        required: truthy(n['required']),
        ref_sheet: n['ref_sheet'] ? String(n['ref_sheet']) : undefined,
        ref_column: n['ref_column'] ? String(n['ref_column']) : undefined,
      });
    }
  }

  const entityMeta = new Map<string, EntityMetaRow>();
  const metaSheet = findSheet(wb, '_entities');
  if (metaSheet) {
    const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(metaSheet, { defval: null });
    for (const r of raw) {
      const n = normalizeRow<Record<string, unknown>>(r);
      const sheet = n['sheet'] ? String(n['sheet']) : '';
      if (!sheet) continue;
      entityMeta.set(sheet.toLowerCase(), {
        sheet,
        kind: n['kind'] ? String(n['kind']).toLowerCase() as CanonicalEntity['kind'] : undefined,
        description: n['description'] ? String(n['description']) : undefined,
        phi: n['phi'] != null ? truthy(n['phi']) : undefined,
        purpose_of_use: n['purpose_of_use'] ? String(n['purpose_of_use']) : undefined,
        hitl: n['hitl'] != null ? truthy(n['hitl']) : undefined,
        facility_kind: n['facility_kind'] ? String(n['facility_kind']) : undefined,
      });
    }
  }

  const workflowRows: WorkflowRow[] = [];
  const wfSheet = findSheet(wb, '_workflows');
  if (wfSheet) {
    const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(wfSheet, { defval: null });
    for (const r of raw) {
      const n = normalizeRow<Record<string, unknown>>(r);
      workflowRows.push({
        workflow_id: n['workflow_id'] ? String(n['workflow_id']) : undefined,
        workflow_name: n['workflow_name'] ? String(n['workflow_name']) : undefined,
        step_id: n['step_id'] ? String(n['step_id']) : undefined,
        step_name: n['step_name'] ? String(n['step_name']) : undefined,
        role: n['role'] ? String(n['role']) : undefined,
        requires_hitl: truthy(n['requires_hitl']),
        description: n['description'] ? String(n['description']) : undefined,
      });
    }
  }

  const out: CanonicalEntity[] = [];
  const bookFile = basename(filePath);

  // ---------- Data sheets ----------
  for (const sheetName of wb.SheetNames) {
    if (sheetName.startsWith('_')) continue; // metadata sheet
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: null });
    // Preserve column order from the first row's header even when a cell is null.
    // sheet_to_json drops null-only columns, so also read header row via range.
    const headers: string[] = [];
    const range = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : null;
    if (range) {
      for (let c = range.s.c; c <= range.e.c; c++) {
        const addr = XLSX.utils.encode_cell({ r: range.s.r, c });
        const cell = ws[addr];
        if (cell && cell.v != null && String(cell.v).trim().length > 0) headers.push(String(cell.v));
      }
    }
    if (headers.length === 0 && rows.length > 0) headers.push(...Object.keys(rows[0]!));

    // Build field specs from headers + first sample row + dictionary overrides
    const sample = rows[0] ?? {};
    const meta = entityMeta.get(sheetName.toLowerCase());
    const sheetDict = dictRows.filter((d) => !d.sheet || d.sheet.toLowerCase() === sheetName.toLowerCase());
    const dictByName = new Map<string, DictRow>();
    for (const d of sheetDict) if (d.name) dictByName.set(d.name.toLowerCase(), d);

    const fields: FieldSpec[] = [];
    const rels: RelationshipSpec[] = [];
    for (const h of headers) {
      const d = dictByName.get(h.toLowerCase());
      const inferredType = inferType(sample[h]);
      const type = d?.type ?? inferredType;
      const phi = d?.phi === true || PHI_HINT.test(h);
      fields.push({
        name: h,
        type,
        required: d?.required ?? false,
        ...(d?.pk ? { primaryKey: true } : {}),
        ...(phi ? { phi: true } : {}),
        ...(d?.description ? { description: d.description } : {}),
      });
      if (d?.ref_sheet && d?.ref_column) {
        rels.push({ fromField: h, toEntity: slugify(d.ref_sheet), toField: d.ref_column });
      }
    }

    const purposeOfUseList = meta?.purpose_of_use
      ? (meta.purpose_of_use.split(/[,;\s]+/).filter(Boolean) as NonNullable<EntityHints['purposeOfUse']>)
      : undefined;
    const hints: EntityHints = {
      phi: meta?.phi ?? (fields.some((f) => f.phi) || PHI_HINT.test(sheetName)),
      ...(meta?.hitl != null ? { hitl: meta.hitl } : {}),
      ...(meta?.facility_kind ? { facilityKind: meta.facility_kind } : {}),
      ...(purposeOfUseList ? { purposeOfUse: purposeOfUseList } : {}),
    };

    const confidence: CanonicalEntity['confidence'] = dictByName.size > 0 || meta ? 'high' : (fields.length > 0 ? 'medium' : 'low');

    out.push({
      id: slugify(sheetName),
      name: sheetName,
      kind: meta?.kind ?? 'data',
      ...(meta?.description ? { description: meta.description } : {}),
      fields,
      relationships: rels,
      hints,
      sourceRefs: [{
        file: bookFile,
        span: `sheet '${sheetName}' \u00b7 ${rows.length} rows \u00b7 ${headers.length} cols`,
        contentHash,
      }],
      confidence,
    });
  }

  // ---------- Workflow entities from _workflows sheet ----------
  if (workflowRows.length > 0) {
    const groups = new Map<string, { id: string; name: string; steps: WorkflowStep[]; rows: number }>();
    for (const r of workflowRows) {
      const key = r.workflow_id ?? r.workflow_name;
      if (!key) continue;
      const gid = r.workflow_id ?? slugify(r.workflow_name ?? key);
      const gname = r.workflow_name ?? r.workflow_id ?? key;
      let g = groups.get(gid);
      if (!g) {
        g = { id: gid, name: gname, steps: [], rows: 0 };
        groups.set(gid, g);
      }
      if (r.step_id || r.step_name) {
        const step: WorkflowStep = {
          id: r.step_id ?? `step-${g.steps.length + 1}`,
          name: r.step_name ?? r.step_id ?? `step-${g.steps.length + 1}`,
          ...(r.role ? { role: r.role } : {}),
          ...(r.requires_hitl ? { requiresHitl: true } : {}),
          ...(r.description ? { description: r.description } : {}),
        };
        g.steps.push(step);
      }
      g.rows++;
    }
    for (const g of groups.values()) {
      out.push({
        id: slugify(g.id),
        name: g.name,
        kind: 'workflow',
        fields: [],
        relationships: [],
        workflow: g.steps,
        hints: { phi: PHI_HINT.test(g.name), hitl: g.steps.some((s) => s.requiresHitl) },
        sourceRefs: [{ file: bookFile, span: `sheet '_workflows' \u00b7 ${g.rows} rows \u00b7 workflow '${g.id}'`, contentHash }],
        confidence: g.steps.length >= 2 ? 'high' : 'medium',
      });
    }
  }

  return out;
}
