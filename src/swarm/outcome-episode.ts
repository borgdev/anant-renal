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

export interface EpisodeCommand {
  commandId: string;
  action: WorldEffectKind;
  idempotencyKey: string;
  at: string;
  ack?: { at: string; by: string };
}

export interface OutcomeEpisode {
  episodeId: string;
  kind: string;
  subject: string;
  scopeType: ScopeType;
  state: OutcomeState;
  openedAt: string;
  transitions: EpisodeTransition[];
  evidence: EvidenceRef[];
  proposal?: CellProposal;
  approval?: EpisodeApproval;
  command?: EpisodeCommand;
  measureResult?: { measureId: string; met: boolean; at: string };
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

  open(input: { kind: string; subject: string; scopeType: ScopeType }): OutcomeEpisode {
    const episode: OutcomeEpisode = {
      episodeId: `out-${randomUUID().slice(0, 8)}`,
      kind: input.kind,
      subject: input.subject,
      scopeType: input.scopeType,
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
  getOrOpen(input: { kind: string; subject: string; scopeType: ScopeType }): OutcomeEpisode {
    const existing = [...this.episodes.values()].find(
      (e) => e.kind === input.kind && e.subject === input.subject && e.scopeType === input.scopeType
        && !['Resolved', 'Rejected', 'Escalated'].includes(e.state),
    );
    return existing ?? this.open(input);
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

  dispatchCommand(id: string, action: WorldEffectKind): OutcomeEpisode {
    const e = this.episodes.get(id);
    if (!e) throw new Error(`outcome-episode-not-found: ${id}`);
    const idempotencyKey = `out:${e.episodeId}:${action}`;
    if (this.commandKeys.has(idempotencyKey)) throw new Error('idempotency-conflict: command already dispatched');
    this.commandKeys.add(idempotencyKey);
    e.command = { commandId: `cmd-${randomUUID().slice(0, 8)}`, action, idempotencyKey, at: new Date().toISOString() };
    this.commit(e);
    return e;
  }

  acknowledge(id: string, by: string): OutcomeEpisode {
    const e = this.episodes.get(id);
    if (!e) throw new Error(`outcome-episode-not-found: ${id}`);
    if (e.command) e.command.ack = { at: new Date().toISOString(), by };
    return this.move(id, 'Verifying', by, 'acknowledgements arrive');
  }

  verify(id: string, measureResult: { measureId: string; met: boolean }, by = 'measure-evaluator'): OutcomeEpisode {
    const e = this.episodes.get(id);
    if (!e) throw new Error(`outcome-episode-not-found: ${id}`);
    e.measureResult = { ...measureResult, at: new Date().toISOString() };
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
