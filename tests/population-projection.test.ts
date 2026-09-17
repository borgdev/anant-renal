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

// S3 — projecting a Synthea bundle down to what the ingest accepts.
//
// The problem being solved is a hard refusal, not a performance preference: the ingest
// caps a bundle at 500 entries and a measured Synthea patient file runs to 17,272
// (34× over), so *every* bundle in a real population is rejected outright. The
// projection is what makes the population ingestible at all.
//
// The tests therefore cover two things separately:
//   • the SIZE invariants — chunking, and the ordering invariant that keeps a patient
//     ahead of any effect that could otherwise invent one;
//   • the CLINICAL invariants — that retention keeps the newest value per analyte (so
//     the primed state is the current chart), and that nothing is dropped silently.

import { describe, expect, it } from 'vitest';

import {
  chunkResources,
  DEFAULT_MAX_MEDICATIONS,
  DEFAULT_PER_ANALYTE_HISTORY,
  projectBundle,
  RESOURCE_PROJECTION,
} from '../src/population/synthea/projection.js';
import { MAX_BUNDLE_ENTRIES } from '../src/fhir/bundle-ingest.js';
import type { Bundle, FhirResource } from '../src/fhir/types.js';

type AnyResource = Record<string, unknown>;

const patient = (id = 'pt-1'): AnyResource => ({ resourceType: 'Patient', id, gender: 'male', birthDate: '1955-03-02' });

const observation = (code: string, date: string, value: number, category = 'laboratory'): AnyResource => ({
  resourceType: 'Observation',
  id: `obs-${code}-${date}`,
  status: 'final',
  category: [{ coding: [{ code: category }] }],
  code: { coding: [{ code, display: code }] },
  effectiveDateTime: date,
  valueQuantity: { value, unit: 'x' },
});

const condition = (display: string, id = display.slice(0, 12)): AnyResource => ({
  resourceType: 'Condition',
  id: `cond-${id}`,
  code: { coding: [{ system: 'http://snomed.info/sct', code: '1', display }] },
});

const medicationRequest = (date: string): AnyResource => ({ resourceType: 'MedicationRequest', id: `mr-${date}`, authoredOn: date, status: 'active' });

function bundleOf(entries: AnyResource[], id?: string): Bundle {
  return {
    resourceType: 'Bundle',
    type: 'collection',
    ...(id !== undefined ? { id } : {}),
    entry: entries.map((resource) => ({ resource })),
  } as unknown as Bundle;
}

/** Every resource across every chunk, in order. */
function flattened(chunks: readonly Bundle[]): FhirResource[] {
  return chunks.flatMap((c) => (c.entry ?? []).map((e) => e.resource!));
}

/** A lab series: `count` HGB observations, one per day from `2026-01-01`, ascending. */
function hgbSeries(count: number): AnyResource[] {
  return Array.from({ length: count }, (_, i) => {
    const day = String((i % 28) + 1).padStart(2, '0');
    const month = String(Math.floor(i / 28) + 1).padStart(2, '0');
    return observation('718-7', `2026-${month}-${day}T00:00:00Z`, 9 + i / 100);
  });
}

/**
 * `count` observations, each a DIFFERENT analyte, so retention keeps every one.
 *
 * Using a single code here would collapse the bundle to one retained observation and
 * silently stop exercising the chunking path — which is the path under test.
 */
function distinctAnalytes(count: number): AnyResource[] {
  return Array.from({ length: count }, (_, i) =>
    observation(`code-${i}`, `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z`, 4 + i / 1000),
  );
}

describe('bundle sizing (S3)', () => {
  it('splits a bundle that exceeds the ingest ceiling into acceptable chunks', () => {
    // The measured worst case is 17,272 entries; 1,200 keeps the test fast while
    // still exercising the multi-chunk path.
    const entries = [patient(), ...distinctAnalytes(1_200)];
    const { chunks, report } = projectBundle(bundleOf(entries, 'syn-1'), { perAnalyteHistory: 1 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.entry!.length).toBeLessThanOrEqual(MAX_BUNDLE_ENTRIES);
    // Every chunk must be a `collection`: a `transaction` rolls back on any failure,
    // which would make one bad entry discard a whole patient.
    for (const chunk of chunks) expect(chunk.type).toBe('collection');
    expect(report.inputEntries).toBe(1_201);
    expect(report.outputEntries).toBe(1_201);
    expect(chunks.map((c) => c.entry!.length)).toEqual([500, 500, 201]);
  });

  it('gives every chunk a DISTINCT id', () => {
    // The ingest's idempotency ledger keys on `bundle.id`; two chunks sharing one
    // would collide as a content conflict (409) rather than dedupe.
    const chunks = chunkResources(
      Array.from({ length: 10 }, (_, i) => patient(`pt-${i}`)) as unknown as FhirResource[],
      'syn-1',
      4,
    );
    const ids = chunks.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(['syn-1-c1', 'syn-1-c2', 'syn-1-c3']);
  });

  it('is deterministic, so re-seeding the same artifact replays rather than re-applies', () => {
    const entries = [patient(), ...distinctAnalytes(900)];
    const a = projectBundle(bundleOf(entries, 'syn-1'));
    const b = projectBundle(bundleOf(entries, 'syn-1'));
    expect(a.chunks.length).toBeGreaterThan(1);
    expect(a.chunks.map((c) => c.id)).toEqual(b.chunks.map((c) => c.id));
    expect(a.chunks.map((c) => c.entry!.length)).toEqual(b.chunks.map((c) => c.entry!.length));
  });
});

describe('retention ordering (S3)', () => {
  it('keeps the Patient in the FIRST chunk', () => {
    // Not cosmetic. `record-vitals` CREATES a patient when the id is unknown, so an
    // effect that reached the realm before its patient would mint a phantom chart.
    const entries = [patient('pt-1'), ...distinctAnalytes(1_100)];
    const { chunks } = projectBundle(bundleOf(entries, 'syn-1'));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.entry![0]!.resource!.resourceType).toBe('Patient');
    // ...and in ONLY the first chunk.
    for (const chunk of chunks.slice(1)) {
      expect(chunk.entry!.some((e) => e.resource!.resourceType === 'Patient')).toBe(false);
    }
  });

  it('keeps only the newest value per analyte', () => {
    const series = hgbSeries(9);
    const newest = series[series.length - 1]!.effectiveDateTime as string;
    const { chunks } = projectBundle(bundleOf([patient(), ...series]));
    const kept = flattened(chunks).filter((r) => r.resourceType === 'Observation');
    expect(kept).toHaveLength(DEFAULT_PER_ANALYTE_HISTORY);
    expect((kept[0] as { effectiveDateTime?: string }).effectiveDateTime).toBe(newest);
  });

  it('retains history when asked, without changing which value is newest', () => {
    const series = hgbSeries(9);
    const { chunks } = projectBundle(bundleOf([patient(), ...series]), { perAnalyteHistory: 3 });
    const kept = flattened(chunks).filter((r) => r.resourceType === 'Observation') as Array<{ effectiveDateTime: string }>;
    expect(kept).toHaveLength(3);
    const dates = kept.map((k) => Date.parse(k.effectiveDateTime));
    expect([...dates].sort((a, b) => b - a)).toEqual(dates);
    expect(dates[0]).toBe(Date.parse(series[series.length - 1]!.effectiveDateTime as string));
  });

  it('treats the same code in two categories as two analytes', () => {
    // The retention key is (patient, category, code). Keying on the code alone would
    // let a laboratory measurement suppress a vital sign that happens to share it.
    const { chunks, report } = projectBundle(
      bundleOf([patient(), observation('718-7', '2026-01-01T00:00:00Z', 11, 'laboratory'), observation('718-7', '2026-01-02T00:00:00Z', 120, 'vital-signs')]),
    );
    expect(report.outputEntries).toBe(3);
    const kept = flattened(chunks).filter((r) => r.resourceType === 'Observation');
    expect(kept).toHaveLength(2);
  });

  it('records what the retention cap cost, rather than hiding it', () => {
    const { report } = projectBundle(bundleOf([patient(), ...hgbSeries(9)]));
    expect(report.retainedAway).toEqual([expect.objectContaining({ resourceType: 'Observation', count: 8 })]);
    expect(report.retainedAway[0]!.reason).toMatch(/most recent 1 per/);
  });

  it('keeps conditions in FULL — a problem list is cumulative', () => {
    // Retention applies to measurement series, not to statements of what a patient
    // has. 30 hypertension conditions must all survive.
    const conditions = Array.from({ length: 30 }, (_, i) => condition('Essential hypertension (disorder)', `h${i}`));
    const { report } = projectBundle(bundleOf([patient(), ...conditions]));
    expect(report.kept.find((k) => k.resourceType === 'Condition')!.count).toBe(30);
    expect(report.retainedAway.some((r) => r.resourceType === 'Condition')).toBe(false);
  });

  it('caps medication requests separately from observations', () => {
    const meds = Array.from({ length: 30 }, (_, i) => medicationRequest(`2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`));
    const { report } = projectBundle(bundleOf([patient(), ...meds]), { maxMedications: 5 });
    expect(report.kept.find((k) => k.resourceType === 'MedicationRequest')!.count).toBe(5);
    expect(report.retainedAway).toEqual([expect.objectContaining({ resourceType: 'MedicationRequest', count: 25 })]);
  });

  it('defaults to a single observation per analyte and a bounded medication list', () => {
    expect(DEFAULT_PER_ANALYTE_HISTORY).toBe(1);
    expect(DEFAULT_MAX_MEDICATIONS).toBe(20);
  });
});

describe('projection filtering and reporting (S3)', () => {
  it('the kept counts agree with what is actually IN the chunks', () => {
    // A report that corroborates its own bug is worse than no report. The first version
    // of `projectBundle` incremented `kept` for a Condition and then `continue`d without
    // pushing it into any output array — so `problemList`, the one piece of state the
    // engine never overwrites, would have been empty for every patient while the report
    // claimed thousands of conditions kept. This reconciles report against contents,
    // which is the invariant that made the defect impossible to miss.
    const bundle = bundleOf([
      patient(),
      condition('End-stage renal disease (disorder)', 'r1'),
      condition('Medication review due (situation)', 'a1'),
      ...hgbSeries(3),
    ]);
    const { chunks, report } = projectBundle(bundle);

    const actual = new Map<string, number>();
    for (const r of flattened(chunks)) actual.set(r.resourceType, (actual.get(r.resourceType) ?? 0) + 1);

    for (const row of report.kept) {
      expect(actual.get(row.resourceType) ?? 0, `${row.resourceType}: reported ${row.count} kept`).toBe(row.count);
    }
    expect(report.outputEntries).toBe(flattened(chunks).length);
    expect(chunks.flatMap((c) => c.entry ?? [])).toHaveLength(report.outputEntries);
  });

  it('carries a recognised condition through to a chunk', () => {
    // The problem list is what makes a Synthea patient clinically non-empty: it shapes
    // the event vector for the patient's whole life in the realm, unlike `labs`, which
    // the engine overwrites on the next tick.
    const { chunks } = projectBundle(bundleOf([patient(), condition('End-stage renal disease (disorder)', 'r1')]));
    const conditions = flattened(chunks).filter((r) => r.resourceType === 'Condition');
    expect(conditions).toHaveLength(1);
    expect((conditions[0] as { code?: { coding?: Array<{ display?: string }> } }).code?.coding?.[0]?.display).toBe('End-stage renal disease (disorder)');
    // Same chunk as the patient, and the patient first — so the structural pass always
    // has a chart to attach the condition to.
    const first = chunks[0]!.entry!.map((e) => e.resource!.resourceType);
    expect(first).toEqual(['Patient', 'Condition']);
  });

  it('drops conditions that match no problem-vocabulary rule', () => {
    const { chunks, report } = projectBundle(
      bundleOf([patient(), condition('End-stage renal disease (disorder)'), condition('Medication review due (situation)')]),
    );
    expect(flattened(chunks).filter((r) => r.resourceType === 'Condition')).toHaveLength(1);
    expect(report.filteredOut).toEqual([expect.objectContaining({ resourceType: 'Condition', count: 1 })]);
    expect(report.filteredOut[0]!.reason).toMatch(/problem-vocabulary/);
  });

  it('records a reason for every excluded resource type it does handle', () => {
    const excluded = RESOURCE_PROJECTION.filter((r) => r.keep === 'never').map((r) => r.resourceType);
    const { report } = projectBundle(
      bundleOf([patient(), ...excluded.map((resourceType, i) => ({ resourceType, id: `x${i}` }))]),
    );
    for (const type of excluded) {
      const row = report.dropped.find((d) => d.resourceType === type);
      expect(row, `${type} should be reported as dropped`).toBeDefined();
      expect(row!.reason.length, `${type} needs a stated reason`).toBeGreaterThan(20);
    }
  });

  it('reports an UNRECOGNISED resource type rather than ignoring it', () => {
    // A resource type with no rule at all is the case that would let a new Synthea
    // module vanish without trace, so it gets its own reason rather than a silent skip.
    const { report } = projectBundle(bundleOf([patient(), { resourceType: 'NutritionOrder', id: 'n1' }]));
    const row = report.dropped.find((d) => d.resourceType === 'NutritionOrder');
    expect(row).toBeDefined();
    expect(row!.reason).toMatch(/no projection rule/);
  });

  it('drops a measurement filed under a non-clinical category', () => {
    const { chunks, report } = projectBundle(bundleOf([patient(), observation('72166-2', '2026-01-01T00:00:00Z', 1, 'survey')]));
    expect(flattened(chunks).filter((r) => r.resourceType === 'Observation')).toHaveLength(0);
    expect(report.filteredOut.some((f) => /survey/.test(f.reason))).toBe(true);
  });

  it('drops a dated resource with no usable date rather than guessing one', () => {
    const undated = { resourceType: 'Observation', id: 'o1', category: [{ coding: [{ code: 'laboratory' }] }], code: { coding: [{ code: '2823-3' }] } };
    const { report } = projectBundle(bundleOf([patient(), undated]));
    expect(report.filteredOut.some((f) => /no effectiveDateTime/.test(f.reason))).toBe(true);
  });

  it('applies an age bound only when one is asked for', () => {
    const old = observation('2823-3', '2020-01-01T00:00:00Z', 4.1);
    const recent = observation('2823-3', '2026-05-30T00:00:00Z', 5.2);

    const unbounded = projectBundle(bundleOf([patient(), old, recent]));
    expect(unbounded.report.maxAgeDays).toBeNull();
    expect(unbounded.report.outputEntries).toBe(2);

    // A window is NOT the default, and deliberately so: the measurement showed a
    // 90-day window empties 86% of the population. It is available, not applied.
    const bounded = projectBundle(bundleOf([patient(), old, recent]), { maxAgeDays: 90, referenceAt: new Date('2026-06-01T00:00:00Z') });
    expect(bounded.report.maxAgeDays).toBe(90);
    // Both observations share a code, so they are one group; the age bound removes the
    // 2020 one and retention keeps the remaining 2026 one.
    expect(bounded.report.outputEntries).toBe(2);
    expect(bounded.report.filteredOut.some((f) => /age bound/.test(f.reason))).toBe(true);
  });

  it('declares a projection rule for every resource type it claims to handle', () => {
    const types = RESOURCE_PROJECTION.map((r) => r.resourceType);
    expect(new Set(types).size).toBe(types.length);
    for (const rule of RESOURCE_PROJECTION) {
      expect(rule.reason.length, `${rule.resourceType} needs a stated reason`).toBeGreaterThan(10);
    }
  });

  it('handles an empty bundle', () => {
    const { chunks, report } = projectBundle(bundleOf([]));
    expect(chunks).toHaveLength(0);
    expect(report.inputEntries).toBe(0);
    expect(report.outputEntries).toBe(0);
  });

  it('handles a bundle with no entry array', () => {
    const { chunks, report } = projectBundle({ resourceType: 'Bundle', type: 'collection' } as unknown as Bundle);
    expect(chunks).toHaveLength(0);
    expect(report.inputEntries).toBe(0);
  });
});
