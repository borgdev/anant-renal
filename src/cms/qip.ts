/******************************************************************************
 * CMS QIP readiness — reads the real public CMS Dialysis Facility Compare /
 * ESRD QIP CSV datasets under `cms-data/` and derives per-measure submission
 * readiness (scored facilities / eligible facilities per measure). This is the
 * real regulatory data that backs the exec CMS control panel — no hardcoded
 * percentages or fake record counts.
 *
 * Datasets (CMS data.cms.gov — see cms-data/manifest.json, modified 2026-06-16):
 *   KTV_COMPREHENSIVE.csv      — Kt/V Comprehensive facility scores (0-10)
 *   NHSN_BSI.csv               — NHSN Bloodstream Infection ratios (score 0-10)
 *   HYPERCALCEMIA.csv          — Hypercalcemia scores (0-10)
 *   CLINICAL_DEPRESSION.csv    — Clinical Depression Screening scores (0-10)
 *   ICH_CAHPS_FACILITY.csv     — ICH CAHPS survey participation
 *   DFC_FACILITY.csv           — Dialysis Facility Compare listing (facility count)
 *   DFC_NATIONAL.csv           — national averages (Kt/V>=1.2, transfusions, …)
 *
 * When the datasets are absent (e.g. a bare prod image), the loader returns the
 * previous reference values with `source: 'reference'` so the UI stays honest
 * instead of pretending synthetic numbers are real.
 ******************************************************************************/

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export interface QipMeasureReadiness {
  measure: string;
  /** 0-100, one decimal — scored/eligible facilities. */
  complete: number;
  /** "scored / eligible" record counts from the real dataset. */
  records: string;
  owner: string;
  state: 'ready' | 'review' | 'gap';
}

export interface QipReadiness {
  asOf: string;
  source: 'real' | 'reference';
  measures: QipMeasureReadiness[];
  totals: { facilities: number; scoredByMeasure: Record<string, number> };
  national: Record<string, number | string>;
}

/** Reference values used ONLY when the real CMS datasets are not present. */
const REFERENCE_READINESS: QipMeasureReadiness[] = [
  { measure: 'Kt/V Dialysis Adequacy', complete: 98.7, records: '4,182 / 4,237', owner: 'Clinical quality', state: 'ready' },
  { measure: 'NHSN Bloodstream Infection', complete: 96.1, records: '1,204 / 1,253', owner: 'Infection prevention', state: 'review' },
  { measure: 'ICH CAHPS', complete: 92.4, records: '1,884 / 2,039', owner: 'Patient experience', state: 'review' },
  { measure: 'Clinical Depression Screening', complete: 99.2, records: '2,108 / 2,125', owner: 'Social work', state: 'ready' },
];

const CMS_DATA_DIR = process.env.CMS_DATA_DIR ?? resolve(process.cwd(), 'cms-data');

const MEASURE_FILES = [
  'KTV_COMPREHENSIVE.csv',
  'NHSN_BSI.csv',
  'HYPERCALCEMIA.csv',
  'CLINICAL_DEPRESSION.csv',
  'ICH_CAHPS_FACILITY.csv',
  'DFC_FACILITY.csv',
  'DFC_NATIONAL.csv',
  'manifest.json',
];

/** Minimal RFC-4180-ish CSV parser (handles quoted fields with commas + escaped quotes). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    if (row.some((c) => c.trim() !== '')) rows.push(row);
  }
  return rows;
}

function readRows(filename: string): string[][] | null {
  const path = resolve(CMS_DATA_DIR, filename);
  if (!existsSync(path)) return null;
  return parseCsv(readFileSync(path, 'utf8'));
}

function colIndex(headers: string[], name: string): number {
  return headers.findIndex((h) => h.trim().toLowerCase() === name.trim().toLowerCase());
}

function isScore(v: string | undefined): boolean {
  const t = (v ?? '').trim().toLowerCase();
  if (t === '' || t === '-' || t === 'no score' || t === 'n/a') return false;
  return Number.isFinite(Number(t));
}

function stateFor(complete: number): 'ready' | 'review' | 'gap' {
  if (complete >= 95) return 'ready';
  if (complete >= 85) return 'review';
  return 'gap';
}

function measureFrom(rows: string[][] | null, scoreHeader: string): { total: number; scored: number } {
  if (!rows || rows.length < 2) return { total: 0, scored: 0 };
  const headers = (rows[0] ?? []).map((h) => h.trim());
  const idx = colIndex(headers, scoreHeader);
  if (idx < 0) return { total: 0, scored: 0 };
  const data = rows.slice(1);
  let scored = 0;
  for (const r of data) if (isScore(r[idx])) scored += 1;
  return { total: data.length, scored };
}

function cahpsFrom(rows: string[][] | null): { total: number; scored: number } {
  if (!rows || rows.length < 2) return { total: 0, scored: 0 };
  // This dataset's header line is a single quoted cell containing the real
  // comma-separated column names (unlike the per-field quoted CSVs) — split it.
  const headerCell = (rows[0] ?? [''])[0] ?? '';
  const headers = headerCell.includes(',')
    ? headerCell.split(',').map((h) => h.trim())
    : (rows[0] ?? []).map((h) => h.trim());
  const idx = colIndex(headers, 'ICH-CAHPS data availability code');
  if (idx < 0) return { total: 0, scored: 0 };
  const data = rows.slice(1);
  let scored = 0;
  for (const r of data) {
    const v = (r[idx] ?? '').trim();
    if (v !== '' && v.toUpperCase() !== '102') scored += 1; // 102 = no survey data
  }
  return { total: data.length, scored };
}

function nationalFrom(rows: string[][] | null): Record<string, number | string> {
  if (!rows || rows.length < 2) return {};
  const headers = (rows[0] ?? []).map((h) => h.trim());
  const vals = rows[1] ?? [];
  const out: Record<string, number | string> = {};
  headers.forEach((h, i) => {
    const v = (vals[i] ?? '').trim();
    if (v === '') return;
    const n = Number(v);
    out[h] = Number.isFinite(n) ? n : v;
  });
  return out;
}

function maxMtime(): number {
  let max = 0;
  for (const f of MEASURE_FILES) {
    const p = resolve(CMS_DATA_DIR, f);
    if (existsSync(p)) max = Math.max(max, statSync(p).mtimeMs);
  }
  return max;
}

let cache: { mtimeMs: number; data: QipReadiness } | null = null;

/** Load + derive CMS QIP readiness, cached by dataset mtime. */
export function loadQipReadiness(): QipReadiness {
  if (!existsSync(resolve(CMS_DATA_DIR, 'manifest.json'))) {
    return { asOf: 'reference', source: 'reference', measures: REFERENCE_READINESS, totals: { facilities: 0, scoredByMeasure: {} }, national: {} };
  }
  const mtimeMs = maxMtime();
  if (cache && cache.mtimeMs === mtimeMs) return cache.data;

  const ktv = measureFrom(readRows('KTV_COMPREHENSIVE.csv'), 'Kt/V Measure Score');
  const bsi = measureFrom(readRows('NHSN_BSI.csv'), 'NHSN BSI Measure Score');
  const hca = measureFrom(readRows('HYPERCALCEMIA.csv'), 'Hypercalcemia Measure Score');
  const dep = measureFrom(readRows('CLINICAL_DEPRESSION.csv'), 'Clinical Depression Measure Score');
  const cahps = cahpsFrom(readRows('ICH_CAHPS_FACILITY.csv'));
  const facilityRows = readRows('DFC_FACILITY.csv');
  const national = nationalFrom(readRows('DFC_NATIONAL.csv'));

  const measures: QipMeasureReadiness[] = [
    {
      measure: 'Kt/V Dialysis Adequacy', owner: 'Clinical quality',
      complete: ktv.total ? Math.round((ktv.scored / ktv.total) * 1000) / 10 : 0,
      records: `${ktv.scored.toLocaleString()} / ${ktv.total.toLocaleString()}`, state: stateFor(ktv.total ? (ktv.scored / ktv.total) * 100 : 0),
    },
    {
      measure: 'NHSN Bloodstream Infection', owner: 'Infection prevention',
      complete: bsi.total ? Math.round((bsi.scored / bsi.total) * 1000) / 10 : 0,
      records: `${bsi.scored.toLocaleString()} / ${bsi.total.toLocaleString()}`, state: stateFor(bsi.total ? (bsi.scored / bsi.total) * 100 : 0),
    },
    {
      measure: 'Hypercalcemia', owner: 'Clinical quality',
      complete: hca.total ? Math.round((hca.scored / hca.total) * 1000) / 10 : 0,
      records: `${hca.scored.toLocaleString()} / ${hca.total.toLocaleString()}`, state: stateFor(hca.total ? (hca.scored / hca.total) * 100 : 0),
    },
    {
      measure: 'Clinical Depression Screening', owner: 'Social work',
      complete: dep.total ? Math.round((dep.scored / dep.total) * 1000) / 10 : 0,
      records: `${dep.scored.toLocaleString()} / ${dep.total.toLocaleString()}`, state: stateFor(dep.total ? (dep.scored / dep.total) * 100 : 0),
    },
    {
      measure: 'ICH CAHPS', owner: 'Patient experience',
      complete: cahps.total ? Math.round((cahps.scored / cahps.total) * 1000) / 10 : 0,
      records: `${cahps.scored.toLocaleString()} / ${cahps.total.toLocaleString()}`, state: stateFor(cahps.total ? (cahps.scored / cahps.total) * 100 : 0),
    },
  ];

  let asOf = '2026-06-16';
  try {
    const manifest = JSON.parse(readFileSync(resolve(CMS_DATA_DIR, 'manifest.json'), 'utf8')) as Array<{ modified_date?: string }>;
    const dates = manifest.map((d) => d.modified_date ?? '').filter(Boolean).sort();
    if (dates.length) asOf = dates[dates.length - 1]!;
  } catch { /* keep default */ }

  const scoredByMeasure: Record<string, number> = {
    'Kt/V Dialysis Adequacy': ktv.scored,
    'NHSN Bloodstream Infection': bsi.scored,
    Hypercalcemia: hca.scored,
    'Clinical Depression Screening': dep.scored,
    'ICH CAHPS': cahps.scored,
  };

  const data: QipReadiness = {
    asOf,
    source: 'real',
    measures,
    totals: { facilities: facilityRows ? Math.max(0, facilityRows.length - 1) : 0, scoredByMeasure },
    national,
  };
  cache = { mtimeMs, data };
  return data;
}
