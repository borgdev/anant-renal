/******************************************************************************
 * Outcome episodes — durable coordination of evidence → proposal → approval →
 * command → acknowledgement → verified result.
 *
 * This wraps the existing effect → HITL → idempotent-command → ack → measure
 * loop in the spec's state machine (Observed … Resolved/Escalated/Reopened).
 * Deterministic transitions; every transition is recorded for the dossier.
 ******************************************************************************/

import { createHash, randomUUID } from 'node:crypto';
import { belief, discount, frameOf, fuse, plausibility, singleton, uncertainty, type Mass } from '../evidence/dempster.js';
import { reliabilityBySource, type ReviewStatus } from '../evidence/reliability.js';
import type { CellProposal } from './insight.js';
import type { ApprovalClass, EvidenceRef, ScopeType, WorldEffectKind } from './types.js';

export type OutcomeState =
  | 'Observed' | 'Watching' | 'Understood' | 'Proposed' | 'Blocked'
  | 'AwaitingApproval' | 'Coordinating' | 'Verifying'
  | 'Resolved' | 'Escalated' | 'Rejected' | 'Reopened';

export interface EpisodeTransition {
  from: OutcomeState;
  to: OutcomeState;
  at: string;
  by: string;
  note?: string;
}

export interface EpisodeApproval {
  approvalId: string;
  decision: 'approved' | 'rejected';
  approver: string;
  at: string;
  approvalClass: ApprovalClass;
}

/**
 * What a command actually DOES in the patient's record.
 *
 * Without this, a dispatched command was a verb with no amount: the episode said
 * `titrate-med` and the recommended dose never left the recommendation. The draft
 * is authored by the PACK (it owns the clinical reasoning) and carried through the
 * proposal, so neither the console nor the dispatcher invents a dose.
 */
export interface EpisodeOrder {
  /** The governed effect to emit (`order-med`, `order-lab`, …). */
  effect: WorldEffectKind;
  /** The effect's own payload — `order-med` needs code/dose/route/frequency. */
  payload: Record<string, unknown>;
}

export interface EpisodeCommand {
  commandId: string;
  action: WorldEffectKind;
  idempotencyKey: string;
  at: string;
  ack?: { at: string; by: string };
  /** The order this command places, when the pack drafted one. */
  order?: EpisodeOrder;
  /** Where it was dispatched (set once the effect is in the ledger). */
  dispatched?: { effectId: string; orderUrn?: string; realmId: string; presenceId: string; at: string; replayed?: boolean };
}

export interface OutcomeEpisode {
  episodeId: string;
  kind: string;
  subject: string;
  scopeType: ScopeType;
  /** The realm the subject lives in. A patient id is only unique WITHIN a realm,
   *  so a dispatch that cannot name its realm fails closed rather than guessing. */
  realmId?: string;
  state: OutcomeState;
  openedAt: string;
  transitions: EpisodeTransition[];
  evidence: EvidenceRef[];
  proposal?: CellProposal;
  approval?: EpisodeApproval;
  command?: EpisodeCommand;
  /**
   * What verified the outcome.
   *
   * `measure` is the cohort-level contract (a CMS/eCQM measure result).
   * `patient-outcome` is THIS patient's own response — forecast vs observed. The
   * two answer different questions, and a clinician acting on one patient needs the
   * second: a measure can move at facility level while this patient goes the other way.
   */
  measureResult?: {
    measureId: string;
    met: boolean;
    at: string;
    kind?: 'measure' | 'patient-outcome';
    detail?: string;
  };
  /** P2/P4 — DST evidence-fusion readout (recomputed on addEvidence). */
  evidenceFusion?: EpisodeEvidenceFusion;
  /** P2 — advisory evidence strength vs the resolve gate. */
  evidenceStatus?: 'corroborated' | 'weak' | 'contested';
  dossierHash: string;
}

export interface EpisodeEvidenceFusion {
  belief: number;
  plausibility: number;
  uncertainty: number;
  conflictMass: number;
  /** P4 — the fused mass vector keyed by focal element (decomposable). */
  massVector: Record<string, number>;
  /** P4 — per-source masses (weight before discount, alpha = reliability). */
  sources: { sourceId: string; contentType: string; weight: number; alpha: number }[];
}

/** P2 — resolve requires this commitment (not just plausibility). */
export const DST_RESOLVE_BELIEF_GATE = 0.55;
/** P2 — contested when fused conflict mass reaches this. */
export const DST_EPISODE_K_GATE = 0.3;
/** P2 — escalate when a single evidence object's harm plausibility exceeds this. */
export const DST_EPISODE_HARM_PL_GATE = 0.6;

export interface OutcomeEpisodeOptions {
  /** P2 — enable belief-driven transition gates (verify → escalate on unmet/worst-case harm). */
  dstGates?: boolean;
}

export const VALID_TRANSITIONS: Record<OutcomeState, OutcomeState[]> = {
  Observed: ['Understood', 'Watching'],
  Watching: ['Understood'],
  Understood: ['Proposed'],
  Proposed: ['Blocked', 'AwaitingApproval'],
  Blocked: ['Observed'],
  AwaitingApproval: ['Coordinating', 'Rejected'],
  Coordinating: ['Verifying'],
  Verifying: ['Resolved', 'Escalated'],
  Resolved: ['Reopened'],
  Escalated: ['AwaitingApproval'],
  Rejected: ['Observed'],
  Reopened: ['Understood'],
};

export function canTransition(from: OutcomeState, to: OutcomeState): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export function computeDossierHash(e: OutcomeEpisode): string {
  return createHash('sha256').update(JSON.stringify({
    id: e.episodeId, kind: e.kind, subject: e.subject, state: e.state,
    evidence: e.evidence, evidenceFusion: e.evidenceFusion, proposal: e.proposal?.proposalId, approval: e.approval?.decision,
    command: e.command?.commandId, measure: e.measureResult,
  })).digest('hex');
}

/**
 * A pack may state its order ONCE, on the proposal payload, and have the command
 * pick it up. Two places to author an order is one place too many — the second one
 * drifts, and the version that drifts is the one nobody reads.
 */
export function orderFromProposal(proposal: CellProposal | undefined): EpisodeOrder | undefined {
  const draft = (proposal?.payload as { order?: unknown } | undefined)?.order;
  if (!draft || typeof draft !== 'object') return undefined;
  const candidate = draft as { effect?: unknown; payload?: unknown };
  if (typeof candidate.effect !== 'string') return undefined;
  const payload = candidate.payload;
  return {
    effect: candidate.effect as WorldEffectKind,
    payload: payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {},
  };
}

/** The governed action the pack's proposal performs (`payload.action`). */
export function actionFromProposal(proposal: CellProposal | undefined): WorldEffectKind | undefined {
  const action = (proposal?.payload as { action?: unknown } | undefined)?.action;
  return typeof action === 'string' ? (action as WorldEffectKind) : undefined;
}

/** The realm a proposal belongs to. The clinical bridge stamps every finding with
 *  one, which is how an episode opened from it knows where its order belongs. */
export function realmIdFromProposal(proposal: CellProposal | undefined): string | undefined {
  const realmId = (proposal?.payload as { realmId?: unknown } | undefined)?.realmId;
  return typeof realmId === 'string' && realmId.length > 0 ? realmId : undefined;
}

function contentTypeWeight(t: string | undefined): number {
  switch (t) {
    case 'fact': return 0.7;
    case 'event': return 0.5;
    case 'object': return 0.5;
    case 'signal': return 0.4;
    default: return 0.45;
  }
}

/** P2/P4 — fuse an episode's evidence into a belief interval over {verified}. */
export function fuseEpisodeEvidence(
  evidence: EvidenceRef[],
  reviews?: Record<string, ReviewStatus>,
): EpisodeEvidenceFusion {
  const srcMasses: Mass[] = [];
  const sources: EpisodeEvidenceFusion['sources'] = [];
  for (const e of evidence) {
    const weight = contentTypeWeight(e.contentType);
    const alpha = reliabilityBySource(e.sourceId, reviews?.[e.sourceId]);
    srcMasses.push(discount(singleton('verified', weight), alpha));
    sources.push({ sourceId: e.sourceId, contentType: e.contentType, weight, alpha });
  }
  if (srcMasses.length === 0) {
    return { belief: 0, plausibility: 0, uncertainty: 0, conflictMass: 0, massVector: {}, sources: [] };
  }
  const frame = new Set(['verified', '__other__']);
  const { mass, k, degenerate } = fuse(srcMasses);
  const b = belief(mass, frame, new Set(['verified']));
  const pl = plausibility(mass, frame, new Set(['verified']));
  return {
    belief: Math.round(b * 1000) / 1000,
    plausibility: Math.round(pl * 1000) / 1000,
    uncertainty: Math.round((pl - b) * 1000) / 1000,
    conflictMass: degenerate ? 1 : Math.round(k * 1000) / 1000,
    massVector: Object.fromEntries([...mass.entries()].map(([kk, v]) => [kk, Math.round(v * 1000) / 1000])),
    sources,
  };
}

/** P2 — advisory readout of evidence strength against the resolve/contested gates. */
export function evidenceStatusFor(fusion: EpisodeEvidenceFusion | undefined): OutcomeEpisode['evidenceStatus'] {
  if (!fusion || fusion.sources.length === 0) return undefined;
  if (fusion.conflictMass >= DST_EPISODE_K_GATE) return 'contested';
  if (fusion.belief >= DST_RESOLVE_BELIEF_GATE) return 'corroborated';
  return 'weak';
}

export class OutcomeEpisodeCoordinator {
  private episodes = new Map<string, OutcomeEpisode>();
  private commandKeys = new Set<string>();
  constructor(private readonly opts: OutcomeEpisodeOptions = {}) {}

  open(input: { kind: string; subject: string; scopeType: ScopeType; realmId?: string }): OutcomeEpisode {
    const episode: OutcomeEpisode = {
      episodeId: `out-${randomUUID().slice(0, 8)}`,
      kind: input.kind,
      subject: input.subject,
      scopeType: input.scopeType,
      ...(input.realmId !== undefined ? { realmId: input.realmId } : {}),
      state: 'Observed',
      openedAt: new Date().toISOString(),
      transitions: [{ from: 'Observed', to: 'Observed', at: new Date().toISOString(), by: 'harness' }],
      evidence: [],
      dossierHash: '',
    };
    episode.dossierHash = computeDossierHash(episode);
    this.episodes.set(episode.episodeId, episode);
    this.commit(episode);
    return episode;
  }

  get(id: string): OutcomeEpisode | undefined { return this.episodes.get(id); }
  list(): OutcomeEpisode[] { return [...this.episodes.values()].sort((a, b) => a.openedAt.localeCompare(b.openedAt)); }
  /** Clear all in-memory episodes (demo cleanup / hard reset). */
  protected clear(): void { this.episodes.clear(); }

  /** Remove one episode from the in-memory map (payer reset / targeted cleanup).
   *  The durable row is dropped via the commitRemove hook. */
  remove(id: string): boolean {
    const existed = this.episodes.delete(id);
    if (existed) this.commitRemove(id);
    return existed;
  }

  /** Return the existing open episode for (kind, subject, scopeType) or open one —
   * gives episodes a STABLE identity across polls instead of churning on each read. */
  getOrOpen(input: { kind: string; subject: string; scopeType: ScopeType; realmId?: string }): OutcomeEpisode {
    const existing = [...this.episodes.values()].find(
      (e) => e.kind === input.kind && e.subject === input.subject && e.scopeType === input.scopeType
        && !['Resolved', 'Rejected', 'Escalated'].includes(e.state),
    );
    if (existing) {
      // A later call that KNOWS the realm fills in an episode opened without one.
      if (existing.realmId === undefined && input.realmId !== undefined) {
        existing.realmId = input.realmId;
        this.commit(existing);
      }
      return existing;
    }
    return this.open(input);
  }

  /** Restore a previously-persisted episode (durability hydrate). */
  import(e: OutcomeEpisode): void {
    this.episodes.set(e.episodeId, e);
    if (e.command) this.commandKeys.add(e.command.idempotencyKey);
  }

  /** Durability hook — subclasses persist each mutation (default: no-op). */
  protected commit(_e: OutcomeEpisode): void { /* subclass hook */ }

  /** Durability hook — subclasses drop the persisted row (default: no-op). */
  protected commitRemove(_id: string): void { /* subclass hook */ }

  private move(id: string, to: OutcomeState, by: string, note?: string): OutcomeEpisode {
    const e = this.episodes.get(id);
    if (!e) throw new Error(`outcome-episode-not-found: ${id}`);
    if (!canTransition(e.state, to)) throw new Error(`invalid-outcome-transition: ${e.state} -> ${to}`);
    e.transitions.push({ from: e.state, to, at: new Date().toISOString(), by, ...(note ? { note } : {}) });
    e.state = to;
    e.dossierHash = computeDossierHash(e);
    this.commit(e);
    return e;
  }

  addEvidence(id: string, evidence: EvidenceRef[], sufficient: boolean, reviews?: Record<string, ReviewStatus>): OutcomeEpisode {
    const e = this.episodes.get(id);
    if (!e) throw new Error(`outcome-episode-not-found: ${id}`);
    e.evidence.push(...evidence);
    e.evidenceFusion = fuseEpisodeEvidence(e.evidence, reviews);
    const status = evidenceStatusFor(e.evidenceFusion);
    if (status !== undefined) e.evidenceStatus = status;
    const to = sufficient ? 'Understood' : 'Watching';
    return this.move(id, to, 'evidence', sufficient ? 'evidence sufficient' : 'evidence incomplete');
  }

  propose(id: string, proposal: CellProposal, policyOk: boolean): OutcomeEpisode {
    const e = this.episodes.get(id);
    if (!e) throw new Error(`outcome-episode-not-found: ${id}`);
    e.proposal = proposal;
    this.move(id, 'Proposed', `cell:${proposal.cellId}`, 'cells converge');
    if (!policyOk) this.move(id, 'Blocked', 'policy', 'policy or assurance fails');
    return this.episodes.get(id)!;
  }

  requestApproval(id: string, approvalClass: ApprovalClass): OutcomeEpisode {
    return this.move(id, 'AwaitingApproval', 'harness', `human required · class ${approvalClass}`);
  }

  decide(id: string, decision: 'approved' | 'rejected', approver: string, approvalClass: ApprovalClass): OutcomeEpisode {
    const e = this.episodes.get(id);
    if (!e) throw new Error(`outcome-episode-not-found: ${id}`);
    e.approval = { approvalId: `appr-${randomUUID().slice(0, 8)}`, decision, approver, at: new Date().toISOString(), approvalClass };
    return this.move(id, decision === 'approved' ? 'Coordinating' : 'Rejected', approver, decision === 'approved' ? 'approved command' : 'human rejects');
  }

  dispatchCommand(id: string, action: WorldEffectKind, opts: { order?: EpisodeOrder; realmId?: string } = {}): OutcomeEpisode {
    const e = this.episodes.get(id);
    if (!e) throw new Error(`outcome-episode-not-found: ${id}`);
    const idempotencyKey = `out:${e.episodeId}:${action}`;
    if (this.commandKeys.has(idempotencyKey)) throw new Error('idempotency-conflict: command already dispatched');
    this.commandKeys.add(idempotencyKey);
    // Prefer the draft the pack authored; fall back to the proposal's, so a pack
    // that states its order once (on the proposal) does not have to state it twice.
    const drafted = opts.order ?? orderFromProposal(e.proposal);
    e.command = {
      commandId: `cmd-${randomUUID().slice(0, 8)}`,
      action,
      idempotencyKey,
      at: new Date().toISOString(),
      ...(drafted !== undefined ? { order: drafted } : {}),
    };
    if (opts.realmId !== undefined) e.realmId = opts.realmId;
    this.commit(e);
    return e;
  }

  /** Record where the command landed in the patient's record (called by the dispatcher). */
  recordDispatch(id: string, dispatched: NonNullable<EpisodeCommand['dispatched']>): OutcomeEpisode {
    const e = this.episodes.get(id);
    if (!e) throw new Error(`outcome-episode-not-found: ${id}`);
    if (!e.command) throw new Error(`no-command-to-record: ${id}`);
    e.command.dispatched = dispatched;
    this.commit(e);
    return e;
  }

  acknowledge(id: string, by: string): OutcomeEpisode {
    const e = this.episodes.get(id);
    if (!e) throw new Error(`outcome-episode-not-found: ${id}`);
    if (e.command) e.command.ack = { at: new Date().toISOString(), by };
    return this.move(id, 'Verifying', by, 'acknowledgements arrive');
  }

  verify(
    id: string,
    measureResult: { measureId: string; met: boolean; kind?: 'measure' | 'patient-outcome'; detail?: string },
    by = 'measure-evaluator',
  ): OutcomeEpisode {
    const e = this.episodes.get(id);
    if (!e) throw new Error(`outcome-episode-not-found: ${id}`);
    e.measureResult = {
      measureId: measureResult.measureId,
      met: measureResult.met,
      at: new Date().toISOString(),
      ...(measureResult.kind !== undefined ? { kind: measureResult.kind } : {}),
      ...(measureResult.detail !== undefined ? { detail: measureResult.detail } : {}),
    };
    // P2 — with dstGates an unmet outcome escalates (never resolves on a failed measure).
    if (this.opts.dstGates && !measureResult.met) {
      return this.move(id, 'Escalated', by, 'outcome not met — escalated');
    }
    // P2 — a met measure is authoritative, but weak fused evidence is flagged.
    const weak = this.opts.dstGates && e.evidenceFusion !== undefined && e.evidenceFusion.belief < DST_RESOLVE_BELIEF_GATE;
    return this.move(id, 'Resolved', by, weak
      ? `outcome observed — weak evidence (Bel ${e.evidenceFusion!.belief})`
      : measureResult.met ? 'outcome observed' : 'outcome not met');
  }

  escalate(id: string, reason: string): OutcomeEpisode {
    return this.move(id, 'Escalated', 'harness', reason || 'timeout or adverse evidence');
  }

  reopen(id: string, reason: string): OutcomeEpisode {
    return this.move(id, 'Reopened', 'harness', reason || 'late correction');
  }
}
