/******************************************************************************
 *
 * Copyright (c) 2026 AnantHQ Inc.
 * All Rights Reserved.
 *
 * This software is licensed, not sold.
 *
 * The contents of this file constitute confidential and proprietary
 * information belonging exclusively to AnantHQ Inc.
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

// Fairness slices — the same protocol, measured across the cohorts it serves.
//
// A pack that clears its coverage gate for the facility as a whole can still be
// blocked, silent or wrong for one slice of it. This module stratifies
// per-patient protocol outcomes across the four dimensions that matter in
// dialysis (age, sex, dialysis vintage, vascular access type) and reports, per
// slice, coverage rate, flag rate and mean score — then compares each slice
// against the rest with an explicit tolerance.
//
// Three decisions carry the weight:
//
//   1. A minimum-n guard. A slice of three patients is not evidence of a
//      disparity, and is never reported as `breach`. It is reported as
//      `insufficient`, which is a distinct verdict and not a pass. On a
//      6-patient facility the honest answer for most slices is `insufficient`.
//   2. Both directions matter. Under-flagging (missed care) is a safety
//      breach; over-flagging (over-surveillance) is a burden watch. They are
//      never collapsed into one number.
//   3. Coverage is judged before flags. A slice whose patients are not covered
//      has no flag rate worth reading, so its flag comparison is suppressed
//      and the coverage gap is the finding.

import type { ProtocolId } from './rule-packs.js';

export type SliceDimension =
  | 'age'
  | 'sex'
  | 'vintage'
  | 'access'
  // ---- S5 L1: the demographic axes ----
  //
  // The four above are RENAL: a dialysis vintage and a vascular access modality have
  // no meaning outside this specialty. These three are the axes healthcare equity is
  // mostly measured on, and until S5 L1 the screen could not see any of them — even
  // though `structuralState` (S6-prep) already put all four demographic facts on the
  // patient. The data was reaching the patient and nothing was reading it.
  //
  // `birthSex` is deliberately NOT a fourth addition. `sex` already bands that axis,
  // and `fairnessReport` takes the WORST verdict across dimensions, so two dimensions
  // over one axis would double-count the same disparity in the headline verdict while
  // looking like two independent findings.
  | 'race'
  | 'ethnicity'
  | 'language'
  // ---- The payer axis ----
  //
  // A separate addition from the three above because it is a different KIND of fact:
  // race/ethnicity/language are CENSUS demographics the record carries on the patient,
  // while payer is a COVERAGE fact — FHIR `Coverage` is its own resource and
  // `canonical.ts` upserts it as an `insurance` ENTITY carrying a `patientId`, not as a
  // patient field. `enrich.ts` resolves the patient's coverage onto `state.insurance`
  // so a row can read it, which is the same shape S6-prep used for the demographics.
  //
  // Deliberately NOT labelled in `DEMOGRAPHIC_LABELS`: payer identifiers come from the
  // covered party's payor, and inventing a label table for values no artifact has been
  // generated to produce is the exact failure this codebase rejects. An unlisted value
  // falls back to the code itself, and on a realm seeded from the STATIC fixture the
  // axis reports `unknown` for every patient — honest, and the state of the world until
  // `synthea-seeds/` is committed (§5 S6).
  | 'insurance';

/** Band id within a dimension; `unknown` when the input is absent. */
export type SliceKey = string;

export const SLICE_DIMENSIONS: readonly SliceDimension[] = [
  'age', 'sex', 'vintage', 'access',
  // Appended rather than interleaved: a reader comparing a pre-L1 report against a
  // post-L1 one should see the renal four in the same positions.
  'race', 'ethnicity', 'language',
  // Appended again for the same reason. The screen declines to fire on an undeclared
  // axis, so declaring this one is what makes payer bandable at all.
  'insurance',
];

export interface FairnessRow {
  patientId: string;
  age?: number | undefined;
  sex?: string | undefined;
  vintageYears?: number | undefined;
  accessType?: string | undefined;
  /** UsCore race coding, e.g. `2106-3`. Absent means not recorded — see `codeSlice`. */
  race?: string | undefined;
  /** UsCore ethnicity coding, e.g. `2186-5`. */
  ethnicity?: string | undefined;
  /** BCP-47 language tag as FHIR `Patient.communication` carries it, e.g. `en-US`. */
  language?: string | undefined;
  /**
   * Payer identifier, resolved by the enricher from the patient's `Coverage`
   * (`insurance`) entity. Absent means no coverage is on record — see `codeSlice`.
   */
  insurance?: string | undefined;
  /** the protocol's coverage gate accepted this patient's data */
  covered: boolean;
  /** the protocol surfaced at least one finding for this patient */
  flagged: boolean;
  /** optional continuous score (risk, dose, delay) used for the mean comparison */
  score?: number | undefined;
}

export interface SliceBand {
  id: string;
  label: string;
  /** inclusive lower bound, in the dimension's own unit */
  min: number;
  /** exclusive upper bound; omit for the open-ended top band */
  max?: number;
}

export const AGE_BANDS: readonly SliceBand[] = [
  { id: 'lt55', label: '< 55', min: 0, max: 55 },
  { id: '55-64', label: '55–64', min: 55, max: 65 },
  { id: '65-74', label: '65–74', min: 65, max: 75 },
  { id: 'gte75', label: '75+', min: 75 },
];

export const VINTAGE_BANDS: readonly SliceBand[] = [
  { id: 'lt1y', label: '< 1 y', min: 0, max: 1 },
  { id: '1-3y', label: '1–3 y', min: 1, max: 3 },
  { id: '3-5y', label: '3–5 y', min: 3, max: 5 },
  { id: 'gte5y', label: '5 y+', min: 5 },
];

export const SEX_SLICES: readonly string[] = ['F', 'M'];
export const ACCESS_SLICES: readonly string[] = ['avf', 'avg', 'catheter'];

export const UNKNOWN_SLICE = 'unknown';

/**
 * Human labels for the coded demographic values this platform actually receives.
 *
 * The codes are the ones the real 249-patient projected artifact carries, measured
 * rather than guessed: race `2106-3` 151 / `2054-5` 22 / `2028-9` 18 / `2076-8` 5,
 * ethnicity `2186-5` 174 / `2135-2` 26, language `en-US` 181 / `es` 14 / `zh` 4 /
 * `fr-FR` 1. A report that bands by `2106-3` is technically correct and unreadable,
 * and an operator reading a disparity finding has to be able to name the group.
 *
 * An UNLISTED code falls back to the code itself rather than to `unknown`. A
 * demographic code this table has not seen is still a real subgroup — reporting it as
 * "not recorded" would hide exactly the kind of patient a real deployment would
 * struggle with.
 */
export const DEMOGRAPHIC_LABELS: Readonly<Record<string, string>> = Object.freeze({
  // race (US Core / OMB)
  '2106-3': 'White',
  '2054-5': 'Black or African American',
  '2028-9': 'Asian',
  '2076-8': 'Native Hawaiian or Pacific Islander',
  '1002-5': 'American Indian or Alaska Native',
  '2131-1': 'Other race',
  // ethnicity
  '2186-5': 'Not Hispanic or Latino',
  '2135-2': 'Hispanic or Latino',
  // language
  'en-US': 'English (US)',
  'en': 'English',
  'es': 'Spanish',
  'zh': 'Chinese',
  'fr-FR': 'French (France)',
  'fr': 'French',
});

/**
 * Tolerances. These are deliberately loose enough to survive a small facility
 * cohort and tight enough to catch a real gap; the min-n guard is what keeps a
 * 3-patient slice from being called a disparity.
 */
export const FAIRNESS_REFERENCE = {
  /** below this, a slice is `insufficient` — reported, never called a breach */
  minSliceN: 5,
  /** coverage may trail the rest of the cohort by at most this, absolute */
  coverageGapTolerance: 0.15,
  /** flag rate may exceed the rest of the cohort by at most this, absolute */
  flagRateGapTolerance: 0.1,
  /** …and by at most this ratio before it is a burden finding */
  flagRateRatioTolerance: 1.5,
  /** mean score may differ from the rest by at most this many pooled SDs */
  meanScoreSdTolerance: 1,
  dimensions: SLICE_DIMENSIONS,
} as const;

export type SliceVerdict = 'ok' | 'watch' | 'breach' | 'insufficient';

export interface SliceMetrics {
  dimension: SliceDimension;
  slice: SliceKey;
  label: string;
  n: number;
  coveredN: number;
  flaggedN: number;
  coverageRate: number;
  flagRate: number;
  meanScore?: number | undefined;
  verdict: SliceVerdict;
  findings: string[];
}

export interface DisparityReport {
  dimension: SliceDimension;
  slices: SliceMetrics[];
  pooled: { n: number; coverageRate: number; flagRate: number; meanScore?: number | undefined };
  verdict: SliceVerdict;
  findings: string[];
  /** slices that exist but were too small to compare — named, never dropped */
  insufficientSlices: string[];
  /** true when no slice reached the minimum n */
  insufficient: boolean;
}

export interface FairnessReport {
  protocol: ProtocolId;
  cohortN: number;
  dimensions: DisparityReport[];
  verdict: SliceVerdict;
  findings: string[];
  reference: typeof FAIRNESS_REFERENCE;
}

/* ---------- banding ---------- */

function bandFor(bands: readonly SliceBand[], value: number): SliceBand | undefined {
  return bands.find((b) => value >= b.min && (b.max === undefined || value < b.max));
}

export function ageBand(age: number | undefined): { id: SliceKey; label: string } {
  if (age === undefined || !Number.isFinite(age)) return { id: UNKNOWN_SLICE, label: 'age unknown' };
  const band = bandFor(AGE_BANDS, age);
  return band ? { id: band.id, label: band.label } : { id: UNKNOWN_SLICE, label: 'age unknown' };
}

export function vintageBand(years: number | undefined): { id: SliceKey; label: string } {
  if (years === undefined || !Number.isFinite(years)) return { id: UNKNOWN_SLICE, label: 'vintage unknown' };
  const band = bandFor(VINTAGE_BANDS, years);
  return band ? { id: band.id, label: band.label } : { id: UNKNOWN_SLICE, label: 'vintage unknown' };
}

export function sexSlice(sex: string | undefined): { id: SliceKey; label: string } {
  const normalised = (sex ?? '').trim().toUpperCase();
  if ((SEX_SLICES as readonly string[]).includes(normalised)) return { id: normalised, label: normalised };
  return { id: UNKNOWN_SLICE, label: 'sex unknown' };
}

export function accessSlice(accessType: string | undefined): { id: SliceKey; label: string } {
  const normalised = (accessType ?? '').trim().toLowerCase();
  if (normalised.startsWith('avf') || normalised.includes('fistula')) return { id: 'avf', label: 'AV fistula' };
  if (normalised.startsWith('avg') || normalised.includes('graft')) return { id: 'avg', label: 'AV graft' };
  if (normalised.includes('cath')) return { id: 'catheter', label: 'Catheter' };
  return { id: UNKNOWN_SLICE, label: 'access unknown' };
}

/**
 * A slice for a dimension whose value IS the slice key — a coded demographic field,
 * where the platform has no bands to impose and no normalisation to do.
 *
 * Deliberately NOT case-folded, unlike `sexSlice` and `accessSlice`. Those normalise
 * because a free-text clinical field legitimately arrives as `Female` or `AV Fistula`.
 * A race or language code is a controlled vocabulary — `2106-3`, `en-US` — and
 * folding it would merge `en-US` with a hypothetical `en-us` that no vocabulary
 * defines, quietly inventing an equivalence the standard does not make.
 *
 * An absent value reports as `unknown` and is labelled "not recorded" rather than
 * being dropped from the cohort. A cohort where nobody's race is recorded is a
 * finding about the population, and silently excluding those patients would turn that
 * finding into a smaller report.
 */
export function codeSlice(value: string | undefined): { id: SliceKey; label: string } {
  const trimmed = (value ?? '').trim();
  if (trimmed === '') return { id: UNKNOWN_SLICE, label: 'not recorded' };
  return { id: trimmed, label: DEMOGRAPHIC_LABELS[trimmed] ?? trimmed };
}

export function sliceOf(dimension: SliceDimension, row: FairnessRow): { id: SliceKey; label: string } {
  switch (dimension) {
    case 'age': return ageBand(row.age);
    case 'sex': return sexSlice(row.sex);
    case 'vintage': return vintageBand(row.vintageYears);
    case 'access': return accessSlice(row.accessType);
    case 'race': return codeSlice(row.race);
    case 'ethnicity': return codeSlice(row.ethnicity);
    case 'language': return codeSlice(row.language);
    case 'insurance': return codeSlice(row.insurance);
  }
}

/** Deterministic order: declared bands first, then any extra slice keys sorted. */
export function sliceOrder(dimension: SliceDimension, keys: readonly SliceKey[]): SliceKey[] {
  const declared =
    dimension === 'age' ? AGE_BANDS.map((b) => b.id)
      : dimension === 'vintage' ? VINTAGE_BANDS.map((b) => b.id)
        : dimension === 'sex' ? [...SEX_SLICES]
          : dimension === 'access' ? [...ACCESS_SLICES]
            // The coded demographics have no bands to declare, so every key is an
            // "extra" and sorts alphabetically. That keeps `fairnessSignature`
            // stable across runs, which is what its determinism contract requires —
            // a slice ordering that depended on Map insertion would make the
            // signature depend on patient order.
            : [];
  const known = declared.filter((k) => keys.includes(k));
  const extra = keys.filter((k) => !known.includes(k)).sort();
  return [...known, ...extra];
}

export function stratify(rows: readonly FairnessRow[], dimension: SliceDimension): Map<SliceKey, FairnessRow[]> {
  const out = new Map<SliceKey, FairnessRow[]>();
  for (const row of rows) {
    const { id } = sliceOf(dimension, row);
    const bucket = out.get(id);
    if (bucket) bucket.push(row);
    else out.set(id, [row]);
  }
  return out;
}

/* ---------- metrics ---------- */

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function mean(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  return round4(values.reduce((a, b) => a + b, 0) / values.length);
}

function sd(values: readonly number[]): number | undefined {
  if (values.length < 2) return undefined;
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export function pooledMetrics(rows: readonly FairnessRow[]): DisparityReport['pooled'] {
  const scores = rows.map((r) => r.score).filter((s): s is number => typeof s === 'number');
  const out: DisparityReport['pooled'] = {
    n: rows.length,
    coverageRate: round4(rate(rows.filter((r) => r.covered).length, rows.length)),
    flagRate: round4(rate(rows.filter((r) => r.flagged).length, rows.length)),
  };
  const m = mean(scores);
  if (m !== undefined) out.meanScore = m;
  return out;
}

function sliceMetricsOf(
  dimension: SliceDimension,
  slice: SliceKey,
  label: string,
  rows: readonly FairnessRow[],
): SliceMetrics {
  const scores = rows.map((r) => r.score).filter((s): s is number => typeof s === 'number');
  const metrics: SliceMetrics = {
    dimension,
    slice,
    label,
    n: rows.length,
    coveredN: rows.filter((r) => r.covered).length,
    flaggedN: rows.filter((r) => r.flagged).length,
    coverageRate: round4(rate(rows.filter((r) => r.covered).length, rows.length)),
    flagRate: round4(rate(rows.filter((r) => r.flagged).length, rows.length)),
    verdict: 'ok',
    findings: [],
  };
  const m = mean(scores);
  if (m !== undefined) metrics.meanScore = m;
  return metrics;
}

/**
 * Compare each slice against the pooled rest-of-cohort.
 *
 * Coverage is judged first: when a slice's data is not covered by the gate, its
 * flag rate is uninformative, so the flag comparison is suppressed and the
 * coverage gap becomes the finding.
 */
export function disparityReport(
  rows: readonly FairnessRow[],
  dimension: SliceDimension,
  opts: { protocol?: ProtocolId; reference?: typeof FAIRNESS_REFERENCE } = {},
): DisparityReport {
  const ref = opts.reference ?? FAIRNESS_REFERENCE;
  const buckets = stratify(rows, dimension);
  const order = sliceOrder(dimension, [...buckets.keys()]);
  const pooled = pooledMetrics(rows);
  const slices: SliceMetrics[] = [];
  const findings: string[] = [];

  for (const key of order) {
    const bucket = buckets.get(key)!;
    const label = sliceOf(dimension, bucket[0]!).label;
    const metrics = sliceMetricsOf(dimension, key, label, bucket);
    const rest = rows.filter((r) => !bucket.includes(r));

    if (bucket.length < ref.minSliceN) {
      metrics.verdict = 'insufficient';
      metrics.findings.push(
        `n=${bucket.length} is below the minimum slice size (${ref.minSliceN}) — no disparity claim is made`,
      );
      slices.push(metrics);
      continue;
    }

    const restCoverage = rate(rest.filter((r) => r.covered).length, rest.length);
    const restFlagRate = rate(rest.filter((r) => r.flagged).length, rest.length);
    const coverageGap = round4(restCoverage - metrics.coverageRate);
    const flagGap = round4(metrics.flagRate - restFlagRate);

    if (coverageGap > ref.coverageGapTolerance) {
      metrics.verdict = 'breach';
      metrics.findings.push(
        `coverage ${metrics.coverageRate} trails the rest of the cohort (${round4(restCoverage)}) by ${coverageGap} — the gate blocks this slice`,
      );
    }

    if (metrics.coverageRate >= restCoverage - ref.coverageGapTolerance) {
      // only meaningful when the slice is actually covered
      const overFlag =
        flagGap > ref.flagRateGapTolerance &&
        (restFlagRate === 0 || metrics.flagRate / restFlagRate > ref.flagRateRatioTolerance);
      if (overFlag) {
        if (metrics.verdict !== 'breach') metrics.verdict = 'watch';
        metrics.findings.push(
          `flag rate ${metrics.flagRate} exceeds the rest of the cohort (${round4(restFlagRate)}) by ${flagGap} — over-surveillance burden`,
        );
      }
      if (metrics.coverageRate - restCoverage > ref.coverageGapTolerance) {
        metrics.findings.push(
          `coverage ${metrics.coverageRate} is ahead of the rest of the cohort (${round4(restCoverage)}) by ${round4(metrics.coverageRate - restCoverage)} — data-capture asymmetry`,
        );
      }
    }

    const restScores = rest.map((r) => r.score).filter((s): s is number => typeof s === 'number');
    const restSd = sd(restScores);
    const restMean = mean(restScores);
    if (metrics.meanScore !== undefined && restMean !== undefined && restSd !== undefined && restSd > 0) {
      const z = (metrics.meanScore - restMean) / restSd;
      if (Math.abs(z) > ref.meanScoreSdTolerance) {
        if (metrics.verdict === 'ok') metrics.verdict = 'watch';
        metrics.findings.push(
          `mean score ${metrics.meanScore} is ${round4(z)} SD from the rest of the cohort (${restMean})`,
        );
      }
    }

    slices.push(metrics);
  }

  const comparable = slices.filter((s) => s.verdict !== 'insufficient');
  const dropped = slices.filter((s) => s.verdict === 'insufficient');
  if (dropped.length > 0 && comparable.length > 0) {
    // a slice too small to compare must not vanish: the report says which part
    // of the cohort was excluded from the comparison and why.
    findings.push(
      `${dimension}: excluded for size — ${dropped.map((s) => `${s.slice} (n=${s.n})`).join(', ')}; the verdict covers only the comparable slices`,
    );
  }
  const verdict: SliceVerdict =
    comparable.some((s) => s.verdict === 'breach') ? 'breach'
      : comparable.some((s) => s.verdict === 'watch') ? 'watch'
        : comparable.length === 0 ? 'insufficient'
          : 'ok';

  for (const s of slices) {
    for (const f of s.findings) findings.push(`${dimension}=${s.slice}: ${f}`);
  }

  return {
    dimension,
    slices,
    pooled,
    verdict,
    findings,
    insufficientSlices: dropped.map((s) => s.slice),
    insufficient: comparable.length === 0,
  };
}

function worst(verdicts: readonly SliceVerdict[]): SliceVerdict {
  const rank: Record<SliceVerdict, number> = { breach: 3, watch: 2, insufficient: 1, ok: 0 };
  return verdicts.reduce<SliceVerdict>((acc, v) => (rank[v] > rank[acc] ? v : acc), 'ok');
}

export function fairnessReport(
  rows: readonly FairnessRow[],
  opts: { protocol?: ProtocolId; dimensions?: readonly SliceDimension[]; reference?: typeof FAIRNESS_REFERENCE } = {},
): FairnessReport {
  const protocol = opts.protocol ?? 'anemia';
  const dimensions = opts.dimensions ?? SLICE_DIMENSIONS;
  const reports = dimensions.map((d) => disparityReport(rows, d, { protocol, ...(opts.reference ? { reference: opts.reference } : {}) }));
  const verdict = worst(reports.map((r) => r.verdict));
  const findings = reports.flatMap((r) => r.findings);
  if (rows.length < FAIRNESS_REFERENCE.minSliceN) {
    findings.unshift(
      `cohort of ${rows.length} is smaller than the minimum slice size (${FAIRNESS_REFERENCE.minSliceN}) — every slice will read as insufficient by construction`,
    );
  }
  return { protocol, cohortN: rows.length, dimensions: reports, verdict, findings, reference: FAIRNESS_REFERENCE };
}

/**
 * One-line signature of a fairness report, for determinism tests and drift
 * tracking: the same cohort must always produce the same string.
 */
export function fairnessSignature(report: FairnessReport): string {
  return [
    report.protocol,
    `n${report.cohortN}`,
    ...report.dimensions.map((d) =>
      `${d.dimension}:${d.verdict}[${d.slices.map((s) => `${s.slice}=${s.n}/${s.coverageRate}/${s.flagRate}`).join(',')}]`,
    ),
  ].join('|');
}

export const FAIRNESS_DIMENSION_LABELS: Record<SliceDimension, string> = {
  age: 'Age',
  sex: 'Sex',
  vintage: 'Dialysis vintage',
  access: 'Vascular access',
  race: 'Race',
  ethnicity: 'Ethnicity',
  language: 'Language',
  insurance: 'Insurance',
};
