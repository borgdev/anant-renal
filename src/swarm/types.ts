/******************************************************************************
 * Swarm Intelligence — shared types.
 *
 * The "swarm" is a bounded-intelligence layer over the existing realm engine:
 * each cell is a manifest that pairs an existing observer/agent with an
 * allowlist of WorldEffect actions. Cells publish typed proposals; the harness
 * aggregates them into swarm insights (consensus/conflict/abstention), ranks
 * next-best actions (NBAs), and coordinates outcome episodes that wrap the
 * existing effect → HITL → command → acknowledgement → measure-verify loop.
 ******************************************************************************/

/** Approval classes (spec plane 4): A=read-only, B=operator, C=authorized-role, D=dual/source-system. */
export type ApprovalClass = 'A' | 'B' | 'C' | 'D';

/** A review/authorization posture for a swarm insight. */
export type ReviewKind = 'none' | 'operator' | 'clinical' | 'data-owner' | 'dual';

/** Scope of a subject — the topology ladder from the spec. */
export type ScopeType = 'enterprise' | 'division' | 'region' | 'market' | 'facility' | 'patient';

/** The set of WorldEffect kind literals a cell may emit (subset of the realm union). */
export type WorldEffectKind =
  | 'admit-patient' | 'transfer-patient' | 'discharge-patient'
  | 'order-lab' | 'result-lab' | 'order-med' | 'administer-med' | 'hold-med' | 'titrate-med'
  | 'record-vitals' | 'record-assessment' | 'update-care-plan' | 'schedule-followup'
  | 'notify-staff' | 'flag-safety-event' | 'submit-claim' | 'request-prior-auth'
  | 'record-agent-thought'
  | 'assign-object' | 'release-object' | 'mark-object-state'
  | 'open-ticket' | 'update-ticket' | 'close-ticket' | 'escalate'
  | 'submit-intent' | 'advance-plan' | 'approve-effect' | 'operator-directive';

/** A reference to an immutable evidence object (raw pointer + hash). */
export interface EvidenceRef {
  sourceId: string;
  contentType: string;
  hash?: string;
  span?: string; // exact supporting content / citation span
}
