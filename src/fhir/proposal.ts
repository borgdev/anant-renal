/******************************************************************************
 *
 * Copyright (c) 2026 AnantHQ Inc.
 * All Rights Reserved.
 *
 * This software is licensed, not sold.
 *
 * The contents of this file constitute confidential and proprietary
 * information belonging exclusively to AnantHQ Inc.
 *
 * This source code incorporates proprietary algorithms, software architecture,
 * business logic, computational methods, optimization techniques,
 * workflows, data structures, APIs, and implementation details that are
 * protected by copyright law, patent law, trade secret law, and
 * international intellectual property treaties.
 *
 * Except as expressly permitted by a written license agreement,
 * no person or organization may:
 *
 *   • Copy or reproduce this software.
 *   • Modify or create derivative works.
 *   • Reverse engineer, decompile, or disassemble.
 *   • Benchmark or publicly disclose performance.
 *   • Redistribute, sublicense, lease, rent, or sell.
 *   • Use this software for competitive analysis.
 *   • Disclose any implementation details.
 *
 * Any unauthorized use is strictly prohibited and may result in
 * civil damages, injunctive relief, criminal prosecution,
 * and all other remedies available under applicable law.
 *
 ******************************************************************************/

/**
 * F9 — governed, expiring proposal publishing.
 *
 * D1: we PROPOSE; we never order. `intent: 'order'` is not discouraged, it is
 * impossible to construct — see `buildProposalResource`, which asserts.
 *
 * Because we propose rather than order, the hard question changes. It is no
 * longer "did the write land exactly once" (a duplicated draft is noise where a
 * duplicated order is harm). It is:
 *
 *   **is this proposal still worth a clinician's attention, and did anything
 *   happen to it?**
 *
 * An unactioned wall of machine drafts is the failure mode that gets a machine
 * switched off. So every proposal carries an EXPIRY, a concurrency cap bounds it,
 * and an expiry RETRACTS rather than deletes — a deleted draft leaves no trace
 * that we ever proposed the action.
 *
 * Four things here are guardrails rather than features, and each one is tested:
 * the intent invariant, the write allowlist, the forbidden-resource list, and
 * "no expiry window configured ⇒ refuse to publish".
 */
import type { FhirResource } from './types.js';
import { stableResourceId } from './identity.js';
import type { ConversionStrategy } from './vendor-profile.js';

/* ------------------------------------------------------------------ guardrails */

/** The ONLY intents we may emit. `order` is absent by design (D1). */
export const PROPOSAL_INTENTS = ['proposal'] as const;
export type ProposalIntent = (typeof PROPOSAL_INTENTS)[number];

/**
 * Resources we must NEVER write, even as a proposal.
 *
 * A diagnosis, a problem-list entry, an allergy or a clinical note is a
 * clinician's assertion about a patient. Generating one from a model output and
 * filing it in the chart would be putting words in a clinician's mouth, and no
 * amount of "draft" status makes that acceptable.
 */
export const FORBIDDEN_WRITE_RESOURCES: readonly string[] = [
  'Condition',
  'AllergyIntolerance',
  'DocumentReference',
  'DiagnosticReport',
  'ClinicalImpression',
  'Composition',
  'FamilyMemberHistory',
  'RelatedPerson',
  'Patient',
  'Consent',
];

/**
 * Effect kinds allowed to reach the EMR at all.
 *
 * An effect kind that is not here can only ever be `shadow` — it can be computed,
 * shown and audited, but it cannot leave the building.
 */
export const WRITE_ALLOWLIST: readonly string[] = [
  'order-lab',
  'order-med',
  'titrate-med',
  'hold-med',
  'update-care-plan',
  'schedule-followup',
  'flag-safety-event',
  'request-prior-auth',
  'record-access',
  'start-session',
  'end-session',
  'record-session-telemetry',
  'record-immunisation',
];

/** A proposal must be constructible only as a draft. Asserted, not documented. */
export class ProposalGuardrailError extends Error {
  readonly code = 'proposal-guardrail-violation';
  constructor(readonly violation: string, message: string) {
    super(message);
    this.name = 'ProposalGuardrailError';
  }
}

export interface ProposalResourceFields {
  resourceType: string;
  [key: string]: unknown;
}

/**
 * THE single constructor for a proposal payload.
 *
 * Every proposal goes through here, so `intent: 'proposal'` + `status: 'draft'`
 * cannot be forgotten at a call site, and a forbidden resource cannot be built
 * by accident.
 */
export function buildProposalResource(fields: ProposalResourceFields): FhirResource {
  if (FORBIDDEN_WRITE_RESOURCES.includes(fields.resourceType)) {
    throw new ProposalGuardrailError(
      `forbidden-resource:${fields.resourceType}`,
      `${fields.resourceType} is not something the harness may write — it is a clinician's own assertion about a patient`,
    );
  }
  const intent = fields['intent'];
  if (intent !== undefined && !(PROPOSAL_INTENTS as readonly unknown[]).includes(intent)) {
    throw new ProposalGuardrailError(
      `forbidden-intent:${String(intent)}`,
      `intent must be one of ${PROPOSAL_INTENTS.join(', ')} — we propose, we do not order (D1)`,
    );
  }
  const status = fields['status'];
  if (status !== undefined && status !== 'draft') {
    throw new ProposalGuardrailError(
      `forbidden-status:${String(status)}`,
      `a proposal is always status 'draft' (got ${String(status)})`,
    );
  }
  return { ...fields, intent: 'proposal', status: 'draft' } as unknown as FhirResource;
}

/* --------------------------------------------------------------------- expiry */

/**
 * Per-effect-kind expiry, in MINUTES.
 *
 * A critical-potassium suggestion is worth a shift; a care-plan change can live
 * for days. A kind that is absent from this table **cannot be published** — a
 * proposal with no expiry is a proposal that will still be sitting in an
 * unsigned-orders list in six months, which is worse than not proposing at all.
 */
export const PROPOSAL_EXPIRY_MINUTES: Readonly<Record<string, number>> = {
  'order-lab': 12 * 60,
  'order-med': 12 * 60,
  'titrate-med': 12 * 60,
  'hold-med': 4 * 60,
  'flag-safety-event': 24 * 60,
  'record-session-telemetry': 60,
  'start-session': 60,
  'end-session': 8 * 60,
  'record-access': 24 * 60,
  'record-immunisation': 72 * 60,
  'schedule-followup': 7 * 24 * 60,
  'update-care-plan': 7 * 24 * 60,
  'request-prior-auth': 7 * 24 * 60,
};

/** `undefined` means "no window configured", which is a refusal, not a default. */
export function expiryMinutesFor(effectKind: string): number | undefined {
  return PROPOSAL_EXPIRY_MINUTES[effectKind];
}

/* ---------------------------------------------------------------- the record */

export type ProposalLifecycle =
  | 'created'
  | 'published'
  | 'surfaced'
  | 'accepted'
  | 'rejected'
  | 'expired'
  | 'superseded'
  /**
   * An OPERATOR withdrew it. Deliberately distinct from `expired`: expiry means
   * nobody acted in time, while a retraction means someone decided it should not
   * stand. Folding them together would make an operator's judgement look like
   * clinician disinterest in the adoption statistic.
   */
  | 'retracted'
  /**
   * Not in the plan's original list, added because a refusal has to be
   * RECORDED: "refused and why" is the only evidence that a safety gate held.
   */
  | 'refused';

export type ProposalPolicy = 'shadow' | 'bound';
export type DegradationRung = 'direct' | 'task' | 'cds-card' | 'communication' | 'harness-only';

/** Lifecycles that still occupy a concurrency slot. */
export const OPEN_PROPOSAL_LIFECYCLES: readonly ProposalLifecycle[] = ['created', 'published', 'surfaced'];

export interface FhirProposal {
  id: string;
  connectionId: string;
  realmId: string;
  effectId: string;
  effectKind: string;
  /** The patient this is ABOUT — the key for the concurrency cap and the action key. */
  patientId: string;
  resourceType: string;
  /** Serialized resource as sent (or as it would have been sent). */
  resourceJson: Record<string, unknown>;
  resourceId?: string;
  intent: ProposalIntent;
  status: 'draft';
  /** Ours, stable: how we find this again — and how F10 finds a conversion. */
  identifierSystem: string;
  identifierValue: string;
  policy: ProposalPolicy;
  lifecycle: ProposalLifecycle;
  degradation: DegradationRung;
  degradationReason?: string;
  /** ISO. Mandatory — see `expiryMinutesFor`. */
  expiresAt: string;
  attempts: number;
  nextAttemptAt?: string;
  lastError?: string;
  retractedAt?: string;
  retractionReason?: string;
  /** How we learned it was actioned (F10). `null` = we do not know yet. */
  convertedAt?: string;
  convertedEvidenceJson?: Record<string, unknown>;
  refusedReason?: string;
  issues: Array<{ code: string; diagnostics: string }>;
  createdAt: string;
  updatedAt: string;
}

export const PROPOSAL_IDENTIFIER_SYSTEM = 'urn:ananthealth:proposal';

export interface ProposalStore {
  listProposals(filter?: ProposalFilter): Promise<FhirProposal[]>;
  saveProposal(proposal: FhirProposal): Promise<FhirProposal>;
}

export interface ProposalFilter {
  realmId?: string;
  connectionId?: string;
  lifecycle?: ProposalLifecycle;
  effectKind?: string;
  patientId?: string;
}

/**
 * The outbound seam. Injectable so a test can assert a `shadow` proposal makes
 * ZERO calls, and so a failure can be injected deterministically.
 */
export interface ProposalTransport {
  send(input: { resource: FhirResource; resourceId: string }): Promise<
    | { ok: true; status: number }
    | { ok: false; status?: number; error: string; retryable: boolean }
  >;
}

/* ----------------------------------------------------------------- preflight */

export interface ProposalPreflight {
  /** F3 — a verified cross-reference, not merely a resolvable patient. */
  identityVerified: boolean;
  /** F4 — every code resolved through the registry. */
  codesValidated: boolean;
  /** F4.4 — a structured dose where the resource carries one. */
  doseStructured?: boolean;
  /** A blocking safety issue (e.g. a DetectedIssue) vetoes the proposal. */
  blockingDetectedIssue?: string;
  /** F12 — consent permits this purpose. */
  consentPermits?: boolean;
  /** Class B/C actions need a recorded approval. */
  approvalRecorded?: boolean;
}

export interface ProposalVendorCapabilities {
  supportsWrite: boolean;
  supportsProvenance: boolean;
  supportsIfMatch?: boolean;
  /** The vendor accepts CDS Hooks but not FHIR writes (the common case). */
  supportsCdsHooks?: boolean;
}

export interface PublishProposalInput {
  realmId: string;
  connectionId: string;
  effectId: string;
  effectKind: string;
  patientId: string;
  resource: FhirResource;
  preflight: ProposalPreflight;
  /** `off` refuses; `shadow` records without sending; `bound` publishes. */
  policy: ProposalPolicy | 'off';
  vendor: ProposalVendorCapabilities;
  /** Open-proposal ceiling per (patient, effect kind). */
  maxOpenPerPatientPerKind?: number;
  now?: string;
}

export type PublishOutcomeKind = 'published' | 'shadow' | 'degraded' | 'refused' | 'duplicate';

export interface PublishOutcome {
  kind: PublishOutcomeKind;
  proposal: FhirProposal;
  reason?: string;
  issues: Array<{ code: string; diagnostics: string }>;
}

export const DEFAULT_MAX_OPEN_PROPOSALS_PER_PATIENT_PER_KIND = 2;
export const PROPOSAL_MAX_ATTEMPTS = 5;

function iso(base: string, addMinutes: number): string {
  return new Date(Date.parse(base) + addMinutes * 60_000).toISOString();
}

/** The preflight gates, in the order they are reported. Fail closed on each. */
export function preflightFailures(input: Pick<PublishProposalInput, 'preflight' | 'resource'>): string[] {
  const failures: string[] = [];
  if (!input.preflight.identityVerified) failures.push('patient-identity-not-verified');
  if (!input.preflight.codesValidated) failures.push('codes-not-validated');
  if (input.preflight.doseStructured === false) failures.push('dose-not-structured');
  if (input.preflight.blockingDetectedIssue) failures.push(`blocking-detected-issue:${input.preflight.blockingDetectedIssue}`);
  if (input.preflight.consentPermits === false) failures.push('consent-does-not-permit-purpose');
  if (input.preflight.approvalRecorded === false) failures.push('approval-not-recorded');
  return failures;
}

/**
 * Which rung of the degradation ladder this vendor forces us onto.
 *
 * Asked of the vendor profile rather than assumed, and the REASON is recorded on
 * the row: an operator has to be able to see why their suggestion is not a
 * first-class proposal in the chart.
 */
export function degradationFor(vendor: ProposalVendorCapabilities): { rung: DegradationRung; reason?: string } {
  if (vendor.supportsWrite) return { rung: 'direct' };
  if (vendor.supportsCdsHooks) return { rung: 'cds-card', reason: 'vendor exposes CDS Hooks but not a FHIR write scope' };
  return { rung: 'harness-only', reason: 'vendor exposes neither a write scope nor CDS Hooks — the proposal stays in the harness work queue' };
}

export type ProposalConversionStatus = 'accepted' | 'rejected' | 'expired' | 'unknown';

export interface ProposalConversionOutcome {
  status: ProposalConversionStatus;
  reason: string;
  evidence?: {
    matchedId?: string;
    matchedIdentifier?: string;
    matchedSystem?: string;
    resourceType?: string;
  };
}

/**
 * Decide whether a published proposal was actually converted, without guessing
 * when the vendor offers no observable correlation path.
 */
export function detectProposalConversion(
  proposal: Pick<FhirProposal, 'identifierSystem' | 'identifierValue' | 'expiresAt' | 'resourceType'>,
  resources: readonly Record<string, unknown>[],
  strategy: ConversionStrategy,
  now: string = new Date().toISOString(),
): ProposalConversionOutcome {
  if (strategy === 'none') {
    return {
      status: 'unknown',
      reason: 'conversion is not observable for this vendor profile; outcome is recorded as unknown, not rejected',
    };
  }

  if (Date.parse(proposal.expiresAt) <= Date.parse(now)) {
    return {
      status: 'expired',
      reason: 'proposal has expired before conversion was observed',
    };
  }

  if (strategy === 'identifier-search') {
    for (const resource of resources) {
      const resourceType = typeof resource.resourceType === 'string' ? resource.resourceType : undefined;
      const id = typeof resource.id === 'string' ? resource.id : undefined;
      const identifier = Array.isArray(resource.identifier) ? resource.identifier : [];
      const matches = identifier.some((entry) => {
        const system = typeof (entry as { system?: unknown })?.system === 'string' ? (entry as { system?: string }).system : undefined;
        const value = typeof (entry as { value?: unknown })?.value === 'string' ? (entry as { value?: string }).value : undefined;
        return system === proposal.identifierSystem && value === proposal.identifierValue;
      });

      if (matches) {
        // `id` and `resourceType` are absent on resources the EMR returned
        // without them, and the evidence block is optional per field — so only
        // assert the fields we actually observed rather than emitting explicit
        // `undefined`s into a record that is read as evidence.
        return {
          status: 'accepted',
          reason: 'matching proposal identifier found on an EMR resource',
          evidence: {
            ...(id !== undefined ? { matchedId: id } : {}),
            matchedIdentifier: proposal.identifierValue,
            matchedSystem: proposal.identifierSystem,
            ...(resourceType !== undefined ? { resourceType } : {}),
          },
        };
      }
    }

    return {
      status: 'unknown',
      reason: 'proposal was published, but the identifier-based conversion was not observed yet',
    };
  }

  if (strategy === 'task-status') {
    return {
      status: 'unknown',
      reason: 'task-based conversion tracking is not implemented yet; the vendor is not a verified observable path',
    };
  }

  if (strategy === 'reference-back') {
    return {
      status: 'unknown',
      reason: 'reference-back conversion tracking is not implemented yet; this pathway remains unobservable',
    };
  }

  return {
    status: 'unknown',
    reason: 'conversion outcome is not observable with the configured vendor strategy',
  };
}

/* -------------------------------------------------------------- the publisher */

export class ProposalPublisher {
  constructor(
    private readonly store: ProposalStore,
    private readonly transport: ProposalTransport,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /** Stable id + identifier derived from the EFFECT, so a retry reconciles. */
  private identityOf(effectId: string): { id: string; identifierValue: string } {
    const digest = stableResourceId(effectId);
    return { id: `prop-${digest}`, identifierValue: digest };
  }

  async publish(input: PublishProposalInput): Promise<PublishOutcome> {
    const at = input.now ?? this.now();
    const { id, identifierValue } = this.identityOf(input.effectId);
    const existing = await this.store.listProposals({});
    const sameEffect = existing.filter((p) => p.effectId === input.effectId && p.connectionId === input.connectionId);
    // A REFUSED row is not a live proposal — it is the record of a gate holding.
    // Excluding it here is what lets the same effect be published again once the
    // cause is fixed (an approval recorded, a code registered); including it
    // would turn a corrected refusal into a permanent duplicate.
    const already = sameEffect.find((p) => p.lifecycle !== 'refused');
    /**
     * One row per (effect, connection): a refusal that is later corrected ADVANCES
     * that row rather than replacing it, so the record that a gate once held
     * survives in the issue trail instead of being overwritten.
     */
    const priorIssues = sameEffect.flatMap((p) => p.issues);
    const priorAttempts = sameEffect.reduce((n, p) => Math.max(n, p.attempts), 0);

    // IDEMPOTENCY, before anything else: publishing the same effect again returns
    // the row we already hold. The signature test publishes three times and
    // asserts ONE proposal.
    if (already) {
      return { kind: 'duplicate', proposal: already, reason: 'the same effect already has a proposal for this connection', issues: [] };
    }

    const issues: Array<{ code: string; diagnostics: string }> = [];
    const note = (code: string, diagnostics: string): void => {
      issues.push({ code, diagnostics });
    };
    /**
     * Refuse, carrying EVERY gate that held rather than only the first.
     *
     * Returning on the first failure drip-feeds the caller: an operator told
     * "no EMR connection is configured", who configures one, is then told "the
     * identity is not verified" — and so on, one re-run per gate. The record is
     * meant to hold the whole reason a write did not happen. Order is still the
     * gate order, so `refusedReason` remains the primary cause.
     */
    const refuseAll = async (): Promise<PublishOutcome> => {
      const primary = issues[0]!;
      const proposal = await this.record({
        input, id, identifierValue, at,
        lifecycle: 'refused', policy: input.policy === 'off' ? 'shadow' : input.policy,
        degradation: 'harness-only', issues, priorIssues, priorAttempts, refusedReason: primary.code,
      });
      return { kind: 'refused', proposal, reason: primary.diagnostics, issues };
    };

    // (1) policy gate — `off` refuses and records why.
    if (input.policy === 'off') note('write-policy-off', `write policy for ${input.effectKind} is off`);
    // (2) the write allowlist — an off-allowlist kind can only ever be a shadow.
    if (!WRITE_ALLOWLIST.includes(input.effectKind) && input.policy === 'bound') {
      note('effect-kind-not-on-write-allowlist', `${input.effectKind} may not be written to an EMR`);
    }
    // (3) fail-closed expiry — no window means we cannot promise to clean up.
    const windowMinutes = expiryMinutesFor(input.effectKind);
    if (windowMinutes === undefined) {
      note('no-expiry-window-configured', `${input.effectKind} has no expiry window, so a proposal could never be retired`);
    }
    // (4) the resource must be a legal proposal payload.
    if (FORBIDDEN_WRITE_RESOURCES.includes(input.resource.resourceType)) {
      note('forbidden-resource', `${input.resource.resourceType} is not something the harness may write`);
    }
    // (5) clinical preflight gates.
    const failures = preflightFailures(input);
    if (failures.length > 0) {
      for (const code of failures) note(code, `preflight refused: ${failures.join(', ')}`);
    }
    // (6) concurrency cap — the guardrail against an unsigned-orders wall.
    const cap = input.maxOpenPerPatientPerKind ?? DEFAULT_MAX_OPEN_PROPOSALS_PER_PATIENT_PER_KIND;
    const open = existing.filter(
      (p) =>
        p.patientId === input.patientId &&
        p.effectKind === input.effectKind &&
        OPEN_PROPOSAL_LIFECYCLES.includes(p.lifecycle),
    );
    if (open.length >= cap) {
      note('concurrency-cap-reached', `${open.length} open proposal(s) for ${input.patientId}/${input.effectKind} (cap ${cap})`);
    }
    if (issues.length > 0) return refuseAll();

    const degradation = degradationFor(input.vendor);

    // SHADOW: fully formed, recorded, and NEVER sent. A shadow proposal is how we
    // measure agreement before anyone lets us write to a chart.
    if (input.policy === 'shadow') {
      const proposal = await this.record({
        input, id, identifierValue, at, lifecycle: 'created', policy: 'shadow',
        degradation: degradation.rung, ...(degradation.reason ? { degradationReason: degradation.reason } : {}),
        issues, priorIssues, priorAttempts,
      });
      return { kind: 'shadow', proposal, issues };
    }

    // BOUND: publish down the ladder.
    const proposal = await this.record({
      input, id, identifierValue, at, lifecycle: 'created', policy: 'bound',
      degradation: degradation.rung, ...(degradation.reason ? { degradationReason: degradation.reason } : {}),
      issues, priorIssues, priorAttempts,
    });

    if (degradation.rung !== 'direct') {
      // The rung is recorded and the row is NOT published — we do not have a
      // channel that can carry it. The harness work queue is the last rung.
      const degraded = await this.store.saveProposal({ ...proposal, lifecycle: 'surfaced', updatedAt: at });
      return { kind: 'degraded', proposal: degraded, ...(degradation.reason ? { reason: degradation.reason } : {}), issues };
    }

    return this.dispatch(proposal, input.resource, at, issues);
  }

  /** Send a proposal that is bound for a vendor that can take it. */
  private async dispatch(
    proposal: FhirProposal,
    resource: FhirResource,
    at: string,
    issues: Array<{ code: string; diagnostics: string }>,
  ): Promise<PublishOutcome> {
    const attempt = proposal.attempts + 1;
    const result = await this.transport.send({ resource, resourceId: proposal.resourceId ?? proposal.id });
    if (result.ok) {
      const published = await this.store.saveProposal({
        ...proposal, lifecycle: 'published', status: 'draft', attempts: attempt, updatedAt: at,
        ...(proposal.resourceId ? {} : { resourceId: proposal.resourceId ?? proposal.id }),
      });
      return { kind: 'published', proposal: published, issues };
    }

    const exhausted = attempt >= PROPOSAL_MAX_ATTEMPTS;
    issues.push({ code: exhausted ? 'delivery-exhausted' : 'delivery-failed', diagnostics: result.error });
    const failed = await this.store.saveProposal({
      ...proposal,
      lifecycle: exhausted ? 'refused' : 'created',
      attempts: attempt,
      lastError: result.error,
      ...(exhausted || !result.retryable ? {} : { nextAttemptAt: iso(at, Math.min(60, attempt * 5)) }),
      updatedAt: at,
      issues,
      ...(exhausted ? { refusedReason: 'delivery-exhausted' } : {}),
    });
    return { kind: 'refused', proposal: failed, reason: result.error, issues };
  }

  private async record(args: {
    input: PublishProposalInput;
    id: string;
    identifierValue: string;
    at: string;
    lifecycle: ProposalLifecycle;
    policy: ProposalPolicy;
    degradation: DegradationRung;
    degradationReason?: string;
    issues: Array<{ code: string; diagnostics: string }>;
    /** Issue trail from earlier attempts on this same effect. */
    priorIssues?: Array<{ code: string; diagnostics: string }>;
    priorAttempts?: number;
    refusedReason?: string;
  }): Promise<FhirProposal> {
    const { input, id, identifierValue, at } = args;
    const windowMinutes = expiryMinutesFor(input.effectKind) ?? 0;
    const seen = new Set<string>();
    const issues = [...(args.priorIssues ?? []), ...args.issues].filter((i) => {
      const key = `${i.code}|${i.diagnostics}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return this.store.saveProposal({
      id,
      connectionId: input.connectionId,
      realmId: input.realmId,
      effectId: input.effectId,
      effectKind: input.effectKind,
      patientId: input.patientId,
      resourceType: input.resource.resourceType,
      resourceJson: input.resource as unknown as Record<string, unknown>,
      resourceId: (input.resource as { id?: string }).id ?? id,
      intent: 'proposal',
      status: 'draft',
      identifierSystem: PROPOSAL_IDENTIFIER_SYSTEM,
      identifierValue,
      policy: args.policy,
      lifecycle: args.lifecycle,
      degradation: args.degradation,
      ...(args.degradationReason ? { degradationReason: args.degradationReason } : {}),
      expiresAt: iso(at, windowMinutes),
      attempts: args.priorAttempts ?? 0,
      issues,
      ...(args.refusedReason ? { refusedReason: args.refusedReason } : {}),
      createdAt: at,
      updatedAt: at,
    });
  }

  /* ------------------------------------------------------- the expiry sweeper */

  /**
   * Retire every open proposal past its window.
   *
   * A bound proposal is RETRACTED at the vendor (`status: 'revoked'`), never
   * deleted — a deleted draft leaves no trace that we proposed it. And the
   * non-action is RECORDED: a kind whose proposals are never actioned is a kind
   * the clinicians do not want, and that belongs in an adoption view rather than
   * being quietly discarded.
   *
   * THE RULE THAT MATTERS: a proposal that is already out there is only expired
   * once the retraction has SUCCEEDED. Marking it expired on a failed retraction
   * would stop us looking at it while the stale draft sits in the EMR forever —
   * which is exactly the failure this package exists to prevent. A failed
   * retraction keeps the row open and retries on the next sweep.
   */
  async sweepExpired(at = this.now()): Promise<{
    expired: number;
    retracted: number;
    deferred: number;
    proposals: FhirProposal[];
    deferredProposals: FhirProposal[];
  }> {
    const open = (await this.store.listProposals({})).filter((p) => OPEN_PROPOSAL_LIFECYCLES.includes(p.lifecycle));
    const due = open.filter((p) => Date.parse(p.expiresAt) <= Date.parse(at));
    const out: FhirProposal[] = [];
    const deferred: FhirProposal[] = [];
    let retracted = 0;

    for (const proposal of due) {
      if (proposal.policy === 'bound' && proposal.lifecycle === 'published') {
        const result = await this.transport.send({
          resource: { ...proposal.resourceJson, id: proposal.resourceId, status: 'revoked' } as unknown as FhirResource,
          resourceId: proposal.resourceId ?? proposal.id,
        });
        if (!result.ok) {
          deferred.push(
            await this.store.saveProposal({
              ...proposal,
              lastError: result.error,
              retractionReason: `retraction-failed:${result.error}`,
              updatedAt: at,
            }),
          );
          continue;
        }
        retracted += 1;
      }
      out.push(
        await this.store.saveProposal({
          ...proposal,
          lifecycle: 'expired',
          retractedAt: at,
          retractionReason: proposal.retractionReason ?? 'expired',
          updatedAt: at,
        }),
      );
    }
    return { expired: out.length, retracted, deferred: deferred.length, proposals: out, deferredProposals: deferred };
  }
}

/* ------------------------------------------------------------------ adoption */

export interface ProposalKindStats {
  effectKind: string;
  total: number;
  published: number;
  accepted: number;
  expired: number;
  retracted: number;
  refused: number;
  /** Of the proposals that actually reached a clinician, how many were ignored. */
  neverActionedRate: number;
}

/**
 * Per-kind adoption. The `neverActionedRate` is the number that decides whether
 * a kind should keep proposing at all — it is deliberately reported rather than
 * acted on, because the decision is a clinical one.
 */
export function proposalStats(proposals: readonly FhirProposal[]): {
  total: number;
  byLifecycle: Record<string, number>;
  byKind: ProposalKindStats[];
} {
  const byLifecycle: Record<string, number> = {};
  for (const p of proposals) byLifecycle[p.lifecycle] = (byLifecycle[p.lifecycle] ?? 0) + 1;

  const kinds = new Map<string, ProposalKindStats>();
  for (const p of proposals) {
    const entry = kinds.get(p.effectKind) ?? {
      effectKind: p.effectKind, total: 0, published: 0, accepted: 0, expired: 0, retracted: 0, refused: 0, neverActionedRate: 0,
    };
    entry.total += 1;
    if (p.lifecycle === 'published' || p.lifecycle === 'surfaced') entry.published += 1;
    if (p.lifecycle === 'accepted') entry.accepted += 1;
    if (p.lifecycle === 'expired') entry.expired += 1;
    if (p.lifecycle === 'retracted') entry.retracted += 1;
    if (p.lifecycle === 'refused') entry.refused += 1;
    kinds.set(p.effectKind, entry);
  }
  for (const entry of kinds.values()) {
    // Denominatated on proposals that REACHED someone and were left to expire. A
    // refused proposal was never offered, and a retracted one was withdrawn by
    // an operator — neither is evidence of clinician disinterest.
    const offered = entry.published + entry.accepted + entry.expired;
    entry.neverActionedRate = offered === 0 ? 0 : Number((entry.expired / offered).toFixed(4));
  }
  return {
    total: proposals.length,
    byLifecycle,
    byKind: [...kinds.values()].sort((a, b) => b.neverActionedRate - a.neverActionedRate),
  };
}
