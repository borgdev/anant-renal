/******************************************************************************
 * Bounded-cell manifest registry — the 12 renal cells.
 *
 * Each cell is a declarative contract: which canonical events it consumes,
 * which signals it produces, and — critically — the ALLOWED ACTIONS ONLY set
 * (a subset of WorldEffect kinds), its approval class, eval gate, and kill
 * switch. This is the "bounded intelligence" boundary from the spec. The
 * observerRef points at the existing observer/agent code each cell is built on.
 ******************************************************************************/

import type { ApprovalClass, WorldEffectKind } from './types.js';

export interface CellManifest {
  id: string;
  version: string;
  displayName: string;
  domain: 'patient-care' | 'operations' | 'business' | 'quality' | 'regulatory' | 'assets';
  owner: string;
  consumes: string[];
  produces: string[];
  /** Allowed actions only — the ONLY WorldEffect kinds this cell may emit. */
  allowedActions: WorldEffectKind[];
  approvalClass: ApprovalClass;
  /** Eval gate — minimum confidence/quality threshold (0..1). */
  evalGate: number;
  killSwitch: boolean;
  rollback: boolean;
  /** Pointer to the existing observer / agent / rules this cell is built on. */
  observerRef: string;
}

export const SWARM_CELLS: CellManifest[] = [
  {
    id: 'treatment-continuity', version: '1.0.0', displayName: 'Treatment continuity',
    domain: 'patient-care', owner: 'Patient & care',
    consumes: ['adt.discharge', 'treatment.scheduled', 'treatment.missed', 'treatment.completed', 'transport.issue', 'facility.staffing-change'],
    produces: ['continuity.risk', 'continuity.proposal'],
    allowedActions: ['schedule-followup', 'notify-staff', 'flag-safety-event', 'open-ticket'],
    approvalClass: 'B', evalGate: 0.92, killSwitch: false, rollback: true,
    observerRef: 'src/realm/rules.ts + packs/dialysis-deep/agents/discharge-transition-summary.yaml',
  },
  {
    id: 'hospital-transition', version: '1.0.0', displayName: 'Hospital transition',
    domain: 'patient-care', owner: 'Patient & care',
    consumes: ['hospitalization.admitted', 'hospitalization.discharged', 'hospitalization.transfer'],
    produces: ['transition.risk', 'transition.proposal'],
    allowedActions: ['schedule-followup', 'notify-staff', 'flag-safety-event'],
    approvalClass: 'B', evalGate: 0.9, killSwitch: false, rollback: true,
    observerRef: 'src/realm/ambient.ts LabMaturationProcess + discharge-transition-summary',
  },
  {
    id: 'assessment-intelligence', version: '1.0.0', displayName: 'Assessment intelligence',
    domain: 'patient-care', owner: 'Assessment Intelligence',
    consumes: ['assessment.response', 'vital.observed'],
    produces: ['fact-candidate', 'assessment.insight'],
    allowedActions: ['record-assessment', 'flag-safety-event', 'notify-staff'],
    approvalClass: 'C', evalGate: 0.95, killSwitch: false, rollback: true,
    observerRef: 'src/assessments/library.ts + packs/dialysis-deep/agents/depression-screening-pv.yaml',
  },
  {
    id: 'facility-capacity', version: '1.0.0', displayName: 'Facility capacity',
    domain: 'operations', owner: 'Facility Operations',
    consumes: ['schedule.changed', 'treatment.completed', 'treatment.missed', 'physical-object'],
    produces: ['capacity.fact', 'capacity.proposal'],
    allowedActions: ['assign-object', 'release-object', 'open-ticket'],
    approvalClass: 'B', evalGate: 0.93, killSwitch: false, rollback: true,
    observerRef: 'src/realm/entity-graph.ts physical-object + packs/ed-throughput',
  },
  {
    id: 'access-surveillance', version: '1.0.0', displayName: 'Access surveillance',
    domain: 'operations', owner: 'Facility Operations',
    consumes: ['treatment.missed', 'treatment.shortened', 'transport.issue', 'schedule.changed'],
    produces: ['access.observation', 'access.proposal'],
    allowedActions: ['flag-safety-event', 'notify-staff', 'open-ticket'],
    approvalClass: 'B', evalGate: 0.9, killSwitch: false, rollback: true,
    observerRef: 'src/realm/rules.ts + packs/dialysis-deep/agents/ambulance-transport-scheduler.yaml',
  },
  {
    id: 'cms-readiness', version: '1.0.0', displayName: 'CMS readiness',
    domain: 'regulatory', owner: 'CMS Operations',
    consumes: ['coverage.active', 'coverage.inactive', 'lab.result-arrived', 'claim.submitted'],
    produces: ['measure.gap', 'measure.ready'],
    allowedActions: ['submit-claim', 'request-prior-auth', 'submit-intent', 'flag-safety-event'],
    approvalClass: 'D', evalGate: 0.99, killSwitch: false, rollback: true,
    observerRef: 'src/measures/evaluator.ts + packs/dialysis-deep/agents/esrd-2728-submit.yaml',
  },
  {
    id: 'workforce-resilience', version: '1.0.0', displayName: 'Workforce resilience',
    domain: 'operations', owner: 'Facility Operations',
    consumes: ['facility.staffing-change', 'schedule.changed'],
    produces: ['staffing.exposure', 'coverage.proposal'],
    allowedActions: ['open-ticket', 'notify-staff', 'escalate'],
    approvalClass: 'B', evalGate: 0.92, killSwitch: false, rollback: true,
    observerRef: 'src/realm/org-graph.ts staff + src/realm/operator-seat.ts',
  },
  {
    id: 'growth-demand', version: '1.0.0', displayName: 'Growth and demand',
    domain: 'business', owner: 'Executive Outcomes',
    consumes: ['coverage.inquiry', 'coverage.active', 'contact.attempted'],
    produces: ['demand.signal', 'demand.proposal'],
    allowedActions: ['submit-intent', 'notify-staff', 'open-ticket'],
    approvalClass: 'B', evalGate: 0.88, killSwitch: false, rollback: true,
    observerRef: 'packs/payer + packs/revenue-cycle',
  },
  {
    id: 'clinical-quality', version: '1.0.0', displayName: 'Clinical quality',
    domain: 'quality', owner: 'Quality Director',
    consumes: ['vital.observed', 'lab.result-arrived', 'condition.recorded', 'protocol.deviation'],
    produces: ['quality.variation', 'evidence-brief'],
    allowedActions: ['flag-safety-event', 'record-assessment', 'update-care-plan', 'notify-staff'],
    approvalClass: 'C', evalGate: 0.95, killSwitch: false, rollback: true,
    observerRef: 'src/liquid/trajectory.ts TrajectoryAmbientProcess + packs/dialysis-deep/agents/anemia-management.yaml',
  },
  {
    id: 'experience-equity', version: '1.0.0', displayName: 'Experience and equity',
    domain: 'quality', owner: 'Quality Director',
    consumes: ['assessment.response', 'contact.attempted', 'contact.failed'],
    produces: ['barrier.cluster', 'experience.theme'],
    allowedActions: ['notify-staff', 'schedule-followup', 'record-agent-thought'],
    approvalClass: 'B', evalGate: 0.9, killSwitch: false, rollback: true,
    observerRef: 'packs/dialysis-deep/agents/health-equity-plan.yaml + bereavement-outreach.yaml',
  },
  {
    id: 'revenue-cycle', version: '1.0.0', displayName: 'Revenue cycle',
    domain: 'business', owner: 'Finance & growth',
    consumes: ['claim.submitted', 'claim.denied', 'claim.remittance', 'coverage.inquiry'],
    produces: ['clean-claim.risk', 'claim.evidence'],
    allowedActions: ['submit-claim', 'request-prior-auth', 'open-ticket', 'escalate'],
    approvalClass: 'B', evalGate: 0.97, killSwitch: false, rollback: true,
    observerRef: 'src/realm/billing.ts + src/realm/cost-ledger.ts + packs/revenue-cycle',
  },
  {
    id: 'asset-reliability', version: '1.0.0', displayName: 'Asset reliability',
    domain: 'assets', owner: 'Biomed Director',
    consumes: ['device.observation', 'maintenance.due'],
    produces: ['asset.risk', 'maintenance.proposal'],
    allowedActions: ['mark-object-state', 'open-ticket', 'notify-staff'],
    approvalClass: 'B', evalGate: 0.93, killSwitch: false, rollback: true,
    observerRef: 'src/healthcare-core/device-gateway.ts + packs/dialysis-deep/agents/biomed-preventive-maintenance.yaml',
  },
];

export function cellById(id: string): CellManifest | undefined {
  return SWARM_CELLS.find((c) => c.id === id);
}

export function cellsByDomain(domain: CellManifest['domain']): CellManifest[] {
  return SWARM_CELLS.filter((c) => c.domain === domain);
}

/** True if the cell may emit the given action kind. */
export function cellAllows(cellId: string, kind: WorldEffectKind): boolean {
  const cell = cellById(cellId);
  return !!cell && cell.allowedActions.includes(kind) && !cell.killSwitch;
}

/** cellId → allowed action kinds, for callers that rank candidates against their
 *  own manifests (the protocol packs) instead of the renal `SWARM_CELLS`. */
export function cellAllowlist(cells: CellManifest[]): Record<string, WorldEffectKind[]> {
  return Object.fromEntries(cells.map((c) => [c.id, c.killSwitch ? [] : c.allowedActions]));
}
