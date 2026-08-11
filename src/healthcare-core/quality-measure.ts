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
