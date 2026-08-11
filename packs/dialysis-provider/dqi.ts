import type { DataQualityFinding } from '../../src/healthcare-core.js';
import type { DialysisTreatmentSession } from './ontology.js';
export function validateTreatment(session: DialysisTreatmentSession): DataQualityFinding[] {
  const findings: DataQualityFinding[] = [];
  if (!session.patientId) findings.push({ ruleId: 'dialysis.patient-id-required', severity: 'critical', entityId: session.id, message: 'Treatment has no patient identifier', evidence: { session } });
  if (!session.facilityId) findings.push({ ruleId: 'dialysis.facility-id-required', severity: 'critical', entityId: session.id, message: 'Treatment has no facility identifier', evidence: { session } });
  if (session.status === 'completed' && !session.completedAt) findings.push({ ruleId: 'dialysis.completed-at-required', severity: 'error', entityId: session.id, message: 'Completed treatment has no completion timestamp', evidence: { session } });
  if (session.status === 'missed' && session.completedAt) findings.push({ ruleId: 'dialysis.missed-treatment-conflict', severity: 'error', entityId: session.id, message: 'Missed treatment has a completion timestamp', evidence: { session } });
  return findings;
}
