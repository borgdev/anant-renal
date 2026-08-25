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

// CMS source registry — the executable "living CMS universe" contract.
//
// The chat is very clear: the platform must not ship a hand-written CMS rules
// list. Instead it ships:
//   - a source-typed registry of every CMS artifact the harness knows about;
//   - version, effective-date, applicability, and specification metadata;
//   - a change-detection surface (compare a fresh pull against the last pull);
//   - a pack-impact graph (which packs consume which sources);
//   - a measure specification structure that measure compilers target.

export type CMSProgramKind =
  | 'conditions-for-coverage'
  | 'quality-reporting'
  | 'value-based-purchasing'
  | 'payment-system'
  | 'interoperability-rule'
  | 'safety-reporting'
  | 'public-reporting'
  | 'compliance';

export type CMSApplicability =
  | { readonly setting: 'esrd-facility' }
  | { readonly setting: 'hospital-inpatient' }
  | { readonly setting: 'hospital-outpatient' }
  | { readonly setting: 'physician-practice' }
  | { readonly setting: 'skilled-nursing' }
  | { readonly setting: 'home-health' }
  | { readonly setting: 'hospice' }
  | { readonly setting: 'ambulatory-surgical' }
  | { readonly setting: 'health-plan' }
  | { readonly setting: 'multi', readonly settings: readonly string[] };

export interface CMSSource {
  readonly id: string;
  readonly title: string;
  readonly kind: CMSProgramKind;
  readonly citation: string; // e.g. "42 CFR 494", "CMS-3401-F"
  readonly url: string;
  readonly steward: string;
  readonly currentVersion: string;
  readonly effectiveFrom: string;
  readonly effectiveTo?: string;
  readonly applicability: CMSApplicability;
  readonly consumedByPacks: readonly string[]; // pack manifest ids
  readonly relatedMeasureIds?: readonly string[];
  readonly paymentConsequence?: 'reporting-only' | 'penalty' | 'incentive' | 'penalty-and-incentive';
  readonly publicReporting?: 'care-compare' | 'hospital-compare' | 'dialysis-compare' | 'none';
}

/** A single CQL-free scoring criterion for a catalog measure (LOINC observation → compare). */
export interface MeasureCriterion {
  readonly loinc: string;
  /** 'threshold' (default) compares a numeric observation; 'reported' passes when any observation with the LOINC exists. */
  readonly kind?: 'threshold' | 'reported';
  readonly comparator?: 'ge' | 'gt' | 'le' | 'lt' | 'eq';
  readonly target?: number;
  readonly unit?: string;
}

export interface CMSMeasureSpec {
  readonly id: string; // e.g. "cms:esrd-qip:vat"
  readonly title: string;
  readonly programId: string; // FK to CMSSource.id
  readonly version: string;
  readonly effectiveFrom: string;
  readonly reportingPeriod: 'monthly' | 'quarterly' | 'annually' | 'per-treatment' | 'per-encounter';
  readonly calculationMethod: 'proportion' | 'ratio' | 'continuous' | 'cohort';
  readonly denominator: {
    readonly description: string;
    readonly valueSetIds: readonly string[];
    readonly ageRange?: { readonly min?: number; readonly max?: number };
    readonly settings?: readonly string[];
  };
  readonly numerator: {
    readonly description: string;
    readonly valueSetIds: readonly string[];
    readonly timeWindowDays?: number;
  };
  readonly exclusions: readonly {
    readonly description: string;
    readonly valueSetIds: readonly string[];
  }[];
  readonly stratifications?: readonly string[];
  readonly evidenceRequirements: readonly string[];
  readonly source: {
    readonly url: string;
    readonly sha256?: string;
  };
  /** Optional structured thresholds → CQL-free "embedded" evaluation against a FHIR bundle. */
  readonly thresholds?: {
    /** 'any' (default) scores the numerator when any criterion matches; 'all' requires every one. */
    readonly mode?: 'any' | 'all';
    readonly criteria: readonly MeasureCriterion[];
  };
}

export interface CMSChangeDetection {
  readonly sourceId: string;
  readonly detectedAt: string;
  readonly previousVersion: string;
  readonly newVersion: string;
  readonly changeSummary: string;
  readonly impactedPacks: readonly string[];
  readonly impactedMeasures: readonly string[];
  readonly action: 'informational' | 'pack-review-required' | 'measure-recompile-required' | 'urgent';
}

export class CMSSourceRegistry {
  private readonly sources = new Map<string, CMSSource>();
  private readonly measures = new Map<string, CMSMeasureSpec>();
  private readonly changes: CMSChangeDetection[] = [];

  registerSource(source: CMSSource): void {
    this.sources.set(source.id, source);
  }

  registerMeasure(spec: CMSMeasureSpec): void {
    this.measures.set(spec.id, spec);
  }

  listSources(): readonly CMSSource[] {
    return Array.from(this.sources.values());
  }

  listMeasures(): readonly CMSMeasureSpec[] {
    return Array.from(this.measures.values());
  }

  measuresForSource(sourceId: string): readonly CMSMeasureSpec[] {
    return this.listMeasures().filter((m) => m.programId === sourceId);
  }

  packsConsuming(sourceId: string): readonly string[] {
    const s = this.sources.get(sourceId);
    return s?.consumedByPacks ?? [];
  }

  /**
   * Register that a fresh pull of a source changed. Produces a change-detection
   * record with the impacted packs + measures so the pack-review loop can act.
   */
  recordChange(input: {
    sourceId: string;
    newVersion: string;
    changeSummary: string;
    detectedAt?: string;
  }): CMSChangeDetection {
    const source = this.sources.get(input.sourceId);
    if (!source) throw new Error(`Unknown CMS source: ${input.sourceId}`);
    const impactedMeasures = this.measuresForSource(input.sourceId).map((m) => m.id);
    const action: CMSChangeDetection['action'] =
      impactedMeasures.length > 0 ? 'measure-recompile-required' : 'pack-review-required';
    const change: CMSChangeDetection = {
      sourceId: input.sourceId,
      detectedAt: input.detectedAt ?? new Date().toISOString(),
      previousVersion: source.currentVersion,
      newVersion: input.newVersion,
      changeSummary: input.changeSummary,
      impactedPacks: source.consumedByPacks,
      impactedMeasures,
      action,
    };
    this.changes.push(change);
    this.sources.set(source.id, { ...source, currentVersion: input.newVersion });
    return change;
  }

  listChanges(): readonly CMSChangeDetection[] {
    return this.changes;
  }
}

/**
 * Seed source registry entries the harness ships with. These are metadata
 * only — no clinical rules are hard-coded. Full text of each source arrives
 * through the document-ingestion pipeline; measure specs arrive via
 * measure-compiler runs against those documents.
 */
export const seedCMSSources: readonly CMSSource[] = Object.freeze([
  {
    id: 'cms:esrd:cfc:494',
    title: 'ESRD Conditions for Coverage (42 CFR Part 494)',
    kind: 'conditions-for-coverage',
    citation: '42 CFR Part 494',
    url: 'https://www.ecfr.gov/current/title-42/chapter-IV/subchapter-G/part-494',
    steward: 'CMS',
    currentVersion: '2026-01',
    effectiveFrom: '2008-10-14',
    applicability: { setting: 'esrd-facility' },
    consumedByPacks: ['dialysis-provider'],
    paymentConsequence: 'penalty',
    publicReporting: 'dialysis-compare',
  },
  {
    id: 'cms:esrd:qip',
    title: 'ESRD Quality Incentive Program',
    kind: 'value-based-purchasing',
    citation: '42 CFR 413.177',
    url: 'https://www.cms.gov/medicare/quality/esrd',
    steward: 'CMS',
    currentVersion: 'PY-2027',
    effectiveFrom: '2027-01-01',
    applicability: { setting: 'esrd-facility' },
    consumedByPacks: ['dialysis-provider'],
    paymentConsequence: 'penalty',
    publicReporting: 'dialysis-compare',
  },
  {
    id: 'cms:esrd:pps',
    title: 'ESRD Prospective Payment System',
    kind: 'payment-system',
    citation: '42 CFR 413.230',
    url: 'https://www.cms.gov/medicare/payment/prospective-payment-systems/end-stage-renal-disease',
    steward: 'CMS',
    currentVersion: 'CY-2026',
    effectiveFrom: '2026-01-01',
    applicability: { setting: 'esrd-facility' },
    consumedByPacks: ['dialysis-provider'],
    paymentConsequence: 'incentive',
  },
  {
    id: 'cms:0057-f',
    title: 'CMS-0057-F Advancing Interoperability and Prior Authorization',
    kind: 'interoperability-rule',
    citation: 'CMS-0057-F',
    url: 'https://www.federalregister.gov/documents/2024/02/08/2024-00895',
    steward: 'CMS',
    currentVersion: '2024-final',
    effectiveFrom: '2027-01-01',
    applicability: { setting: 'health-plan' },
    consumedByPacks: ['payer'],
    paymentConsequence: 'reporting-only',
  },
  {
    id: 'cms:promoting-interoperability',
    title: 'Medicare Promoting Interoperability',
    kind: 'quality-reporting',
    citation: '42 CFR 495',
    url: 'https://www.cms.gov/medicare/regulations-guidance/promoting-interoperability-programs',
    steward: 'CMS',
    currentVersion: '2026',
    effectiveFrom: '2026-01-01',
    applicability: { setting: 'hospital-inpatient' },
    consumedByPacks: [],
    paymentConsequence: 'penalty-and-incentive',
  },
  {
    id: 'cms:mips',
    title: 'Merit-based Incentive Payment System',
    kind: 'value-based-purchasing',
    citation: '42 CFR 414 Subpart O',
    url: 'https://qpp.cms.gov/mips/overview',
    steward: 'CMS',
    currentVersion: 'PY-2026',
    effectiveFrom: '2026-01-01',
    applicability: { setting: 'physician-practice' },
    consumedByPacks: [],
    paymentConsequence: 'penalty-and-incentive',
  },
  {
    id: 'cms:hospital-vbp',
    title: 'Hospital Value-Based Purchasing Program',
    kind: 'value-based-purchasing',
    citation: '42 CFR 412 Subpart Q',
    url: 'https://www.cms.gov/medicare/quality/value-based-programs/hospital-value-based-purchasing',
    steward: 'CMS',
    currentVersion: 'FY-2026',
    effectiveFrom: '2025-10-01',
    applicability: { setting: 'hospital-inpatient' },
    consumedByPacks: [],
    paymentConsequence: 'penalty-and-incentive',
  },
  {
    id: 'cms:iqr',
    title: 'Hospital Inpatient Quality Reporting',
    kind: 'quality-reporting',
    citation: '42 CFR 412.140',
    url: 'https://www.cms.gov/medicare/quality/initiatives/hospital-quality-initiative/hospital-inpatient-quality-reporting-program',
    steward: 'CMS',
    currentVersion: 'FY-2026',
    effectiveFrom: '2025-10-01',
    applicability: { setting: 'hospital-inpatient' },
    consumedByPacks: [],
    paymentConsequence: 'penalty',
    publicReporting: 'care-compare',
  },
  {
    id: 'cms:nhsn-linkage',
    title: 'CDC NHSN reporting linkage (for CMS quality programs)',
    kind: 'safety-reporting',
    citation: 'NHSN Dialysis Event Module',
    url: 'https://www.cdc.gov/nhsn/dialysis',
    steward: 'CDC',
    currentVersion: '2026',
    effectiveFrom: '2026-01-01',
    applicability: { setting: 'esrd-facility' },
    consumedByPacks: ['dialysis-provider'],
    paymentConsequence: 'reporting-only',
  },
]);

// Re-export the full measure catalog + factory.
export { ALL_CMS_MEASURES, ESRD_QIP_MEASURES, HOSPITAL_IQR_MEASURES, HOSPITAL_VBP_MEASURES, MIPS_MEASURES, PI_HOSPITAL_MEASURES, NHSN_MEASURES, CMS_0057_F_MEASURES } from './cms-measure-catalog.js';
