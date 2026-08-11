// Protocol-compliance sub-pack — ensures every dialysis treatment follows
// the patient's prescription (blood-flow rate, dialysate composition,
// treatment length, ultrafiltration goal) and that deviations are recorded
// as deliberate events, not silent drift.

export interface TreatmentPrescription {
  readonly patientId: string;
  readonly effectiveFrom: string;
  readonly effectiveTo?: string;
  readonly bloodFlowMlMin: number;
  readonly dialysateFlowMlMin: number;
  readonly dialysateCompositionRef: string;
  readonly targetKtV: number;
  readonly treatmentLengthMinutes: number;
  readonly ultrafiltrationGoalMl: number;
  readonly anticoagulation?: string;
  readonly prescriberRef: string;
}

export interface TreatmentDelivered {
  readonly treatmentId: string;
  readonly patientId: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly bloodFlowMlMinActual: number;
  readonly dialysateFlowMlMinActual: number;
  readonly deliveredKtV?: number;
  readonly treatmentLengthMinutesActual: number;
  readonly ultrafiltrationMlActual: number;
  readonly complications: readonly string[];
}

export type ProtocolDeviationKind =
  | 'shortened-treatment'
  | 'blood-flow-below-prescription'
  | 'dialysate-flow-below-prescription'
  | 'kt-v-below-target'
  | 'uf-above-goal-plus-10pct'
  | 'complication-with-response-required';

export interface ProtocolDeviation {
  readonly treatmentId: string;
  readonly patientId: string;
  readonly deviation: ProtocolDeviationKind;
  readonly deltaValue?: number;
  readonly requiresQAPIReview: boolean;
  readonly detectedAt: string;
}

export function evaluateProtocol(rx: TreatmentPrescription, delivered: TreatmentDelivered, now: string): ProtocolDeviation[] {
  const out: ProtocolDeviation[] = [];
  const shortMin = rx.treatmentLengthMinutes - delivered.treatmentLengthMinutesActual;
  if (shortMin >= 5) out.push({ treatmentId: delivered.treatmentId, patientId: delivered.patientId, deviation: 'shortened-treatment', deltaValue: shortMin, requiresQAPIReview: shortMin >= 15, detectedAt: now });
  if (delivered.bloodFlowMlMinActual < rx.bloodFlowMlMin * 0.9) out.push({ treatmentId: delivered.treatmentId, patientId: delivered.patientId, deviation: 'blood-flow-below-prescription', deltaValue: rx.bloodFlowMlMin - delivered.bloodFlowMlMinActual, requiresQAPIReview: false, detectedAt: now });
  if (delivered.dialysateFlowMlMinActual < rx.dialysateFlowMlMin * 0.9) out.push({ treatmentId: delivered.treatmentId, patientId: delivered.patientId, deviation: 'dialysate-flow-below-prescription', deltaValue: rx.dialysateFlowMlMin - delivered.dialysateFlowMlMinActual, requiresQAPIReview: false, detectedAt: now });
  if (delivered.deliveredKtV !== undefined && delivered.deliveredKtV < rx.targetKtV) out.push({ treatmentId: delivered.treatmentId, patientId: delivered.patientId, deviation: 'kt-v-below-target', deltaValue: rx.targetKtV - delivered.deliveredKtV, requiresQAPIReview: true, detectedAt: now });
  if (delivered.ultrafiltrationMlActual > rx.ultrafiltrationGoalMl * 1.1) out.push({ treatmentId: delivered.treatmentId, patientId: delivered.patientId, deviation: 'uf-above-goal-plus-10pct', deltaValue: delivered.ultrafiltrationMlActual - rx.ultrafiltrationGoalMl, requiresQAPIReview: true, detectedAt: now });
  if (delivered.complications.length > 0) out.push({ treatmentId: delivered.treatmentId, patientId: delivered.patientId, deviation: 'complication-with-response-required', requiresQAPIReview: true, detectedAt: now });
  return out;
}
