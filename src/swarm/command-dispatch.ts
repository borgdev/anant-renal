/**
 * The dispatch seam: an APPROVED outcome episode becomes a real order in the
 * patient's record.
 *
 * Before this existed, `dispatchCommand(id, 'titrate-med')` recorded a verb and
 * stopped. The episode went to *Coordinating*, the console showed a signed
 * decision, and **nothing reached the chart** — no order, no lab, no dose. Every
 * clinical action in the platform ended at the same place.
 *
 * Three properties this seam is responsible for, in order of importance:
 *
 *  1. **One approval, not two.** The episode's Class-C decision IS the human
 *     approval. The effect is emitted with `preApproved`, so the realm's HITL gate
 *     does not raise a second pending approval for an order a clinician already
 *     signed. Role authority is still enforced — an approval authorizes a dose,
 *     never a capability.
 *  2. **At-most-once, proven from the ledger.** A dispatch is keyed by the
 *     episode command's `idempotencyKey`. A retry asks the LEDGER whether that key
 *     already produced an effect, so a replay returns the original order instead of
 *     placing a second one. Replay-safety cannot depend on a caller remembering.
 *  3. **Fail closed.** No order draft, no realm, a realm that does not exist, a
 *     rejected effect — each throws a typed `DispatchError` and leaves the ledger
 *     untouched. Inventing a dose is never an option, so the pack must state one.
 */

import type { Realm } from '../realm/realm.js';
import type { EmittedEffect, WorldEffect } from '../realm/types.js';
import type { OutcomeEpisode, OutcomeEpisodeCoordinator, EpisodeOrder } from './outcome-episode.js';
import { actionFromProposal, orderFromProposal, realmIdFromProposal } from './outcome-episode.js';
import type { WorldEffectKind } from './types.js';

/**
 * What the pack's own proposal says the command should be.
 *
 * Routes use this so a client never has to name the action or the dose: the pack
 * authored both, and re-stating them at the call site is how the two drift apart.
 */
export interface DerivedCommand {
  action?: WorldEffectKind;
  order?: EpisodeOrder;
  realmId?: string;
}

export function commandFromEpisode(episode: OutcomeEpisode | undefined): DerivedCommand {
  const proposal = episode?.proposal;
  return {
    ...(actionFromProposal(proposal) !== undefined ? { action: actionFromProposal(proposal)! } : {}),
    ...(orderFromProposal(proposal) !== undefined ? { order: orderFromProposal(proposal)! } : {}),
    ...(realmIdFromProposal(proposal) !== undefined ? { realmId: realmIdFromProposal(proposal)! } : {}),
  };
}

export interface DispatchApprovedInput {
  coordinator: OutcomeEpisodeCoordinator;
  episodeId: string;
  /** Resolve a realm by id (injected so tests can supply a registry). */
  realmOf: (realmId: string) => Realm | undefined;
  /** Override the episode's realm. A patient id is only unique within a realm. */
  realmId?: string;
  /** Reuse an existing acting presence instead of the episode's dispatcher presence. */
  presenceId?: string;
  /** Who signs. Defaults to the recorded approver. */
  approvedBy?: string;
}

export interface DispatchApprovedResult {
  episodeId: string;
  effectId: string;
  effectKind: WorldEffectKind;
  realmId: string;
  presenceId: string;
  status: 'shadow' | 'bound';
  /** The single entity the order created (medication / order). */
  orderUrn?: string;
  /** True when the ledger already held this command's effect — nothing new written. */
  replayed: boolean;
}

/** A refusal the caller can act on. Every code means "the ledger was not touched". */
export class DispatchError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'DispatchError';
  }
}

/** An order effect produces exactly one mutation, so the first urn is the order. */
function orderUrnFrom(effect: EmittedEffect): string | undefined {
  const first = effect.mutations?.[0]?.urn;
  return first === undefined ? undefined : String(first);
}

/** A stable per-episode presence, so retries do not litter the realm with actors. */
function actingPresenceId(realm: Realm, episode: OutcomeEpisode): string {
  const agentSpecId = `episode-dispatch:${episode.episodeId}`;
  const existing = realm.presences.list().find((p) => p.agentSpecId === agentSpecId);
  if (existing) return existing.presenceId;
  const patientId = episode.subject.startsWith('patient:') ? episode.subject.slice('patient:'.length) : undefined;
  const patient = patientId ? realm.graph.get(realm.graph.urnFor('patient', patientId)) : undefined;
  const state = (patient?.state ?? {}) as { facilityId?: string; unitId?: string };
  const facilityId = state.facilityId ?? realm.graph.listKind('facility')[0]?.id ?? 'unknown';
  const unitId = state.unitId ?? realm.graph.listKind('unit')[0]?.id;
  const presence = realm.spawnPresence({
    agentSpecId,
    runId: `dispatch-${episode.episodeId}`,
    // The ordering clinician's role. Authority is checked by the reducer, so a role
    // that may not perform the effect is rejected even though a human approved it.
    role: 'md',
    clearance: 'restricted-phi',
    purposeOfUse: ['treatment'],
    location: unitId ? { facilityId, unitId } : { facilityId },
  });
  return presence.presenceId;
}

export function dispatchApprovedEpisode(input: DispatchApprovedInput): DispatchApprovedResult {
  const episode = input.coordinator.get(input.episodeId);
  if (!episode) throw new DispatchError('outcome-episode-not-found', input.episodeId);
  if (episode.state !== 'Coordinating') {
    throw new DispatchError(
      'episode-not-approved',
      `episode is ${episode.state}; only an approved (Coordinating) episode may place an order`,
    );
  }
  const command = episode.command;
  if (!command) throw new DispatchError('no-command', 'the episode has no command to dispatch');
  const order = command.order;
  if (!order) {
    throw new DispatchError(
      'no-order-draft',
      `command '${command.action}' carries no order draft — refusing to invent a dose for it`,
    );
  }
  const realmId = input.realmId ?? episode.realmId ?? realmIdFromProposal(episode.proposal);
  if (!realmId) {
    throw new DispatchError('episode-realm-unknown', 'the episode does not name its realm, and a patient id is only unique within one');
  }
  const realm = input.realmOf(realmId);
  if (!realm) throw new DispatchError('realm-not-found', realmId);

  // At-most-once: the ledger is the record of what was already placed.
  const existing = realm.ledger.findByApprovalKey(command.idempotencyKey);
  if (existing) {
    const orderUrn = orderUrnFrom(existing);
    input.coordinator.recordDispatch(episode.episodeId, {
      effectId: existing.effectId,
      realmId,
      presenceId: existing.presenceId,
      at: existing.emittedAt,
      replayed: true,
      ...(orderUrn !== undefined ? { orderUrn } : {}),
    });
    return {
      episodeId: episode.episodeId,
      effectId: existing.effectId,
      effectKind: order.effect,
      realmId,
      presenceId: existing.presenceId,
      status: existing.status === 'bound' ? 'bound' : 'shadow',
      ...(orderUrn !== undefined ? { orderUrn } : {}),
      replayed: true,
    };
  }

  const presenceId = input.presenceId ?? actingPresenceId(realm, episode);
  const approvedBy = input.approvedBy ?? episode.approval?.approver ?? 'unknown-approver';
  const effect = { kind: order.effect, ...order.payload } as WorldEffect;

  let emitted: EmittedEffect;
  try {
    emitted = realm.emit(presenceId, effect, {
      preApproved: {
        approvalId: episode.approval?.approvalId ?? `appr-${episode.episodeId}`,
        approvedBy,
        idempotencyKey: command.idempotencyKey,
        episodeId: episode.episodeId,
      },
    });
  } catch (thrown) {
    // The reducer throws for a missing target (e.g. titrate-med with no order).
    // Nothing was applied, so the caller can correct the draft and retry.
    throw new DispatchError('effect-not-applied', thrown instanceof Error ? thrown.message : String(thrown));
  }
  if (emitted.status === 'rejected') {
    throw new DispatchError('effect-rejected', emitted.rejection ?? 'the realm refused the effect');
  }

  const orderUrn = orderUrnFrom(emitted);
  input.coordinator.recordDispatch(episode.episodeId, {
    effectId: emitted.effectId,
    realmId,
    presenceId,
    at: emitted.emittedAt,
    ...(orderUrn !== undefined ? { orderUrn } : {}),
  });

  return {
    episodeId: episode.episodeId,
    effectId: emitted.effectId,
    effectKind: order.effect,
    realmId,
    presenceId,
    status: emitted.status === 'bound' ? 'bound' : 'shadow',
    ...(orderUrn !== undefined ? { orderUrn } : {}),
    replayed: false,
  };
}
