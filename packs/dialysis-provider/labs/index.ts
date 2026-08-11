// Labs sub-pack: prioritized review of dialysis-relevant labs (Kt/V, hgb,
// phosphorus, calcium, PTH, albumin). Rule-based severity is deliberately
// conservative — the harness never turns a lab into a clinical recommendation.

import type { DialysisLabResult } from '../ontology.js';

export type LabSignificance = 'critical' | 'urgent' | 'routine' | 'informational';

export interface LabReviewItem {
  labId: string;
  patientId: string;
  loinc: string;
  significance: LabSignificance;
  reason: string;
  observedAt: string;
}

interface LabBand {
  loinc: string;
  name: string;
  criticalLow?: number;
  urgentLow?: number;
  urgentHigh?: number;
  criticalHigh?: number;
}

// Adult in-center HD reference bands. Facility-specific overrides can be
// swapped in via the pack's future configuration hook.
const BANDS: readonly LabBand[] = [
  { loinc: '718-7', name: 'hemoglobin g/dL', criticalLow: 8, urgentLow: 10, urgentHigh: 12, criticalHigh: 13 },
  { loinc: '2823-3', name: 'potassium mmol/L', criticalLow: 3, urgentLow: 3.5, urgentHigh: 5.5, criticalHigh: 6.5 },
  { loinc: '2777-1', name: 'phosphorus mg/dL', urgentLow: 3.5, urgentHigh: 5.5, criticalHigh: 8 },
  { loinc: '2885-2', name: 'albumin g/dL', criticalLow: 2.5, urgentLow: 3.5 },
  { loinc: 'KTV-DEL', name: 'delivered Kt/V', urgentLow: 1.2, criticalLow: 1.0 },
];

export function assessLab(lab: DialysisLabResult): LabReviewItem {
  const band = BANDS.find((b) => b.loinc === lab.loinc);
  if (!band) {
    return { labId: lab.id, patientId: lab.patientId, loinc: lab.loinc, significance: 'informational', reason: 'No band registered for LOINC', observedAt: lab.observedAt };
  }
  if (band.criticalLow !== undefined && lab.value < band.criticalLow) {
    return { labId: lab.id, patientId: lab.patientId, loinc: lab.loinc, significance: 'critical', reason: `${band.name} below critical low ${band.criticalLow}`, observedAt: lab.observedAt };
  }
  if (band.criticalHigh !== undefined && lab.value > band.criticalHigh) {
    return { labId: lab.id, patientId: lab.patientId, loinc: lab.loinc, significance: 'critical', reason: `${band.name} above critical high ${band.criticalHigh}`, observedAt: lab.observedAt };
  }
  if (band.urgentLow !== undefined && lab.value < band.urgentLow) {
    return { labId: lab.id, patientId: lab.patientId, loinc: lab.loinc, significance: 'urgent', reason: `${band.name} below urgent low ${band.urgentLow}`, observedAt: lab.observedAt };
  }
  if (band.urgentHigh !== undefined && lab.value > band.urgentHigh) {
    return { labId: lab.id, patientId: lab.patientId, loinc: lab.loinc, significance: 'urgent', reason: `${band.name} above urgent high ${band.urgentHigh}`, observedAt: lab.observedAt };
  }
  return { labId: lab.id, patientId: lab.patientId, loinc: lab.loinc, significance: 'routine', reason: `${band.name} within band`, observedAt: lab.observedAt };
}

export function prioritizeQueue(items: readonly LabReviewItem[]): LabReviewItem[] {
  const rank: Record<LabSignificance, number> = { critical: 0, urgent: 1, routine: 2, informational: 3 };
  return [...items].sort((a, b) => rank[a.significance] - rank[b.significance] || a.observedAt.localeCompare(b.observedAt));
}
