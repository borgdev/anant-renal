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

// A minimal, honest slice of ESRD Quality Incentive Program measures. These
// are intentionally simplified (real QIP specs are highly detailed); the
// point here is to prove the measure contract: (dataset) -> {num, den, evidence}.

import type { QualityMeasure, QualityMeasureResult } from '../../../src/healthcare-core/quality-measure.js';
import type { DialysisTreatmentSession, DialysisLabResult } from '../ontology.js';

export interface DialysisMeasureDataset {
  treatments: readonly DialysisTreatmentSession[];
  labs: readonly DialysisLabResult[];
  facilityId: string;
  windowFrom: string;
  windowTo: string;
}

/** Kt/V >= 1.2 among adult in-center HD patients. */
export const ktvAdequacyMeasure: QualityMeasure<DialysisMeasureDataset> = {
  id: 'esrd-qip.ktv-adequacy',
  authority: 'CMS',
  version: '2026.1',
  description: 'Proportion of eligible treatments with delivered Kt/V >= 1.2',
  evaluate(dataset): QualityMeasureResult {
    const eligible = dataset.treatments.filter((t) => t.status === 'completed' && t.ktvDelivered !== undefined);
    const meeting = eligible.filter((t) => (t.ktvDelivered ?? 0) >= 1.2);
    const result: QualityMeasureResult = {
      numerator: meeting.length,
      denominator: eligible.length,
      evidenceIds: eligible.map((t) => t.id),
      calculatedAt: new Date().toISOString(),
    };
    if (eligible.length > 0) result.score = meeting.length / eligible.length;
    return result;
  },
};

/** Missed-treatment ratio: missed / scheduled over the window. */
export const missedTreatmentRatioMeasure: QualityMeasure<DialysisMeasureDataset> = {
  id: 'esrd-qip.missed-treatment-ratio',
  authority: 'CMS',
  version: '2026.1',
  description: 'Ratio of missed to scheduled treatments (lower is better)',
  evaluate(dataset): QualityMeasureResult {
    const scheduled = dataset.treatments.filter((t) => t.status !== 'cancelled');
    const missed = scheduled.filter((t) => t.status === 'missed');
    const result: QualityMeasureResult = {
      numerator: missed.length,
      denominator: scheduled.length,
      evidenceIds: missed.map((t) => t.id),
      calculatedAt: new Date().toISOString(),
    };
    if (scheduled.length > 0) result.score = missed.length / scheduled.length;
    return result;
  },
};

/** Hemoglobin between 10-12 g/dL — anemia management proxy. */
export const anemiaManagementMeasure: QualityMeasure<DialysisMeasureDataset> = {
  id: 'esrd-qip.anemia-management',
  authority: 'CMS',
  version: '2026.1',
  description: 'Proportion of hemoglobin readings in 10-12 g/dL band',
  evaluate(dataset): QualityMeasureResult {
    const hgb = dataset.labs.filter((l) => l.loinc === '718-7');
    const inBand = hgb.filter((l) => l.value >= 10 && l.value <= 12);
    const result: QualityMeasureResult = {
      numerator: inBand.length,
      denominator: hgb.length,
      evidenceIds: hgb.map((l) => l.id),
      calculatedAt: new Date().toISOString(),
    };
    if (hgb.length > 0) result.score = inBand.length / hgb.length;
    return result;
  },
};

export const dialysisMeasures = [ktvAdequacyMeasure, missedTreatmentRatioMeasure, anemiaManagementMeasure] as const;
