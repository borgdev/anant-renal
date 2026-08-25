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

// Quality measures are the CMS-facing lens. They compute a numerator and
// denominator (or a continuous score) from a dataset, plus the evidence ids
// used, so post-hoc audit can reproduce exactly what was counted.

export interface QualityMeasureResult {
  score?: number;
  numerator?: number;
  denominator?: number;
  evidenceIds: readonly string[];
  calculatedAt: string;
}

export interface QualityMeasure<Dataset = unknown> {
  id: string;
  authority: string;
  version: string;
  description: string;
  evaluate(dataset: Dataset): QualityMeasureResult;
}

export class MeasureCatalog<Dataset = unknown> {
  private readonly measures = new Map<string, QualityMeasure<Dataset>>();

  register(measure: QualityMeasure<Dataset>): void {
    if (this.measures.has(measure.id)) throw new Error(`Measure already registered: ${measure.id}`);
    this.measures.set(measure.id, measure);
  }

  resolve(id: string): QualityMeasure<Dataset> {
    const m = this.measures.get(id);
    if (!m) throw new Error(`Unknown measure: ${id}`);
    return m;
  }

  evaluateAll(dataset: Dataset): Array<{ id: string; result: QualityMeasureResult }> {
    return [...this.measures.values()].map((m) => ({ id: m.id, result: m.evaluate(dataset) }));
  }
}
