// The four answers a human can give a ranked action — and the one place their
// rules live.
//
// A ranked action reaches a clinician through more than one door (the protocol
// page, the swarm admin route, My Work). If each door validated `deferred` and
// `handed-off` for itself, the surfaces would disagree about what a valid
// deferral is, and one of them would eventually record a deferral with no time
// on it — an action that is neither done nor declined and simply vanishes.
// So the validation and the episode consequence live HERE, and every route
// calls in.
//
// The four answers:
//   approved    — act on it. Advances the outcome episode toward an order.
//   dismissed   — no, and here is why. The only signal that tunes the ranking.
//   deferred    — not now, at this stated time. The action stays real.
//   handed-off  — not mine, theirs. The action stays real, elsewhere.
//
// Only `approved` touches the clinical state. The other three are statements
// about the human, not about the patient, so they must not open or advance an
// episode.
import type { PersistentOutcomeCoordinator } from './durable-coordinator.js';
import type { SwarmWorkspaceStore, NbaDecision } from './workspace.js';
import type { ApprovalClass, ScopeType } from './types.js';

export type RankedDecision = 'approved' | 'dismissed' | 'deferred' | 'handed-off';

/** What every door must be able to say about the action it is deciding. */
export interface RankedActionRef {
  nbaId: string;
  title: string;
  subject: string;
  scopeType: ScopeType;
  evidenceCount: number;
  expectedOutcome: number;
  /** Evidence objects behind the action. Empty is allowed — a signal row is used. */
  evidence: Array<{ sourceId: string; contentType: string }>;
  /** Approval class the episode opens with. Defaults to B when the door cannot know. */
  approvalClass?: ApprovalClass;
  /** Cells that own the action; the first one gets the proposal. */
  cells?: string[];
  protocol?: string;
  conflictMass?: number;
}

export interface RankedDecisionInput {
  decision: RankedDecision;
  approver: string;
  /** Required on a dismissal. */
  reason?: string;
  /** Required on a deferral: ISO instant it comes back. */
  deferUntil?: string;
  /** Required on a handoff. */
  handedTo?: string;
  /** Console the recipient works in, so the item lands in their queue. */
  handedToConsole?: string;
  /** Injectable clock, so "in the past" is testable without sleeping. */
  nowMs?: number;
}

export interface RankedDecisionRejection {
  status: 400;
  error: string;
  detail: string;
}

/**
 * Why this answer is not acceptable — or `null` when it is.
 *
 * Each rule exists because the alternative is a queue that lies: an unexplained
 * dismissal teaches the ranking nothing, a timeless deferral is a silent
 * dismissal, and a handoff to nobody puts the action in no queue at all.
 */
export function validateRankedDecision(input: RankedDecisionInput): RankedDecisionRejection | null {
  // Trimming happens HERE, not at each call site: a handoff to "   " is a handoff to
  // nobody, and a caller that forgets to trim would record work with no owner.
  const reason = input.reason?.trim();
  const handedTo = input.handedTo?.trim();
  const deferUntil = input.deferUntil?.trim();
  if (input.decision === 'dismissed' && !reason) {
    return { status: 400, error: 'reason-required', detail: 'a dismissal must say why, or the ranking learns nothing' };
  }
  if (input.decision === 'deferred') {
    const until = deferUntil === undefined ? Number.NaN : Date.parse(deferUntil);
    if (!Number.isFinite(until)) {
      return { status: 400, error: 'defer-until-required', detail: 'a deferral must name when it comes back (ISO instant)' };
    }
    if (until <= (input.nowMs ?? Date.now())) {
      return { status: 400, error: 'defer-until-in-the-past', detail: 'deferring to a time that has passed hides the action' };
    }
  }
  if (input.decision === 'handed-off' && !handedTo) {
    return { status: 400, error: 'handed-to-required', detail: 'a handoff must name who owns it next' };
  }
  return null;
}

/** Narrow an untrusted body value to a decision. Anything unknown is an approval name only. */
export function asRankedDecision(raw: unknown): RankedDecision {
  return raw === 'dismissed' || raw === 'deferred' || raw === 'handed-off' ? raw : 'approved';
}

/**
 * Record the human's answer. Approval also opens/advances the outcome episode,
 * because approving is the only answer that asks the world to change; the
 * clinical state is left untouched by the other three.
 */
export async function decideRankedAction(input: {
  ws: SwarmWorkspaceStore;
  coord: PersistentOutcomeCoordinator;
  nba: RankedActionRef;
  answer: RankedDecisionInput;
}): Promise<{ decision: NbaDecision; episodeId?: string }> {
  const { ws, coord, nba, answer } = input;
  // Normalised once, so what is compared and what is stored can never differ.
  const reason = answer.reason?.trim();
  const deferUntil = answer.deferUntil?.trim();
  const handedTo = answer.handedTo?.trim();
  let episodeId: string | undefined;
  if (answer.decision === 'approved') {
    const ep = coord.getOrOpen({ kind: 'continuity.proposal', subject: nba.subject, scopeType: nba.scopeType });
    const evidence = nba.evidence.length > 0
      ? nba.evidence
      : [{ sourceId: 'signal:continuity.proposal', contentType: 'signal' }];
    try {
      coord.addEvidence(ep.episodeId, evidence.map((e) => ({ sourceId: e.sourceId, contentType: e.contentType })), true);
      coord.propose(ep.episodeId, {
        proposalId: `prop-${ep.episodeId}`,
        cellId: nba.cells?.[0] ?? 'treatment-continuity',
        kind: 'continuity.proposal',
        subject: nba.subject,
        scopeType: nba.scopeType,
        option: 'human-authorized plan',
        recommendation: nba.title,
        allowed: true,
        evidence: evidence.map((e) => ({ sourceId: e.sourceId, contentType: e.contentType })),
        producedAt: new Date().toISOString(),
        payload: { expectedOutcome: nba.expectedOutcome },
      }, true);
      coord.requestApproval(ep.episodeId, nba.approvalClass ?? 'B');
    } catch {
      // Already advanced — this is a replay, not a failure.
    }
    episodeId = ep.episodeId;
  }
  const decision = await ws.recordNbaDecision({
    nbaId: nba.nbaId, title: nba.title, subject: nba.subject, scopeType: nba.scopeType,
    decision: answer.decision, approver: answer.approver,
    evidenceCount: nba.evidenceCount, expectedOutcome: nba.expectedOutcome,
    ...(episodeId !== undefined ? { episodeId } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(deferUntil !== undefined ? { deferUntil } : {}),
    ...(handedTo !== undefined ? { handedTo } : {}),
    ...(answer.handedToConsole !== undefined ? { handedToConsole: answer.handedToConsole } : {}),
    ...(nba.protocol !== undefined ? { protocol: nba.protocol } : {}),
    ...(nba.conflictMass !== undefined ? { conflictMass: nba.conflictMass } : {}),
  });
  await ws.addSwarmAudit({
    actor: answer.approver,
    action: `nba.${answer.decision}`,
    entityType: 'next-best-action',
    entityId: nba.nbaId,
    decision: answer.decision,
    detail: reason ? `${nba.title} — ${reason}` : nba.title,
  });
  return { decision, ...(episodeId !== undefined ? { episodeId } : {}) };
}
