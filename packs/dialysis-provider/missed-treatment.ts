import type { DialysisTreatmentSession, MissedTreatmentCase } from './ontology.js';
export interface MissedTreatmentSignal { treatment: DialysisTreatmentSession; hospitalizationConfirmed: boolean; transportIssue: boolean; unresolvedContact: boolean; }
export function createMissedTreatmentCase(signal: MissedTreatmentSignal): MissedTreatmentCase | undefined {
  if (signal.treatment.status !== 'missed') return undefined;
  const reason = signal.hospitalizationConfirmed ? 'hospitalization' : signal.transportIssue ? 'transport' : signal.unresolvedContact ? 'contact-failure' : 'unknown';
  return { id: `case:${signal.treatment.id}`, treatmentId: signal.treatment.id, patientId: signal.treatment.patientId, facilityId: signal.treatment.facilityId, status: signal.hospitalizationConfirmed ? 'escalated' : 'verifying', reason, evidenceIds: [signal.treatment.id], ownerRole: 'agent' };
}
export function nextOperationalAction(caseState: MissedTreatmentCase): 'verify-source-data' | 'open-outreach' | 'escalate-nurse' | 'plan-recovery' | 'none' {
  if (caseState.status === 'identified' || caseState.status === 'verifying') return 'verify-source-data';
  if (caseState.status === 'outreach') return 'open-outreach';
  if (caseState.status === 'escalated') return 'escalate-nurse';
  if (caseState.status === 'recovery-planned') return 'plan-recovery';
  return 'none';
}
