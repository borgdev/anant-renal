# FHIR EMR write allowlist

This is the operational companion to the code-level guardrail in [src/fhir/proposal.ts](src/fhir/proposal.ts). It summarizes which effect kinds are permitted to cross the EMR boundary, and which are intentionally blocked.

## 1. Safety rule

An effect kind that is not on the allowlist may be computed, surfaced, and audited inside the harness, but it must never be written to the EMR. This is a fail-closed rule.

## 2. Allowed effect kinds

The current allowlist is:

- `order-lab`
- `order-med`
- `titrate-med`
- `hold-med`
- `update-care-plan`
- `schedule-followup`
- `flag-safety-event`
- `request-prior-auth`
- `record-access`
- `start-session`
- `end-session`
- `record-session-telemetry`
- `record-immunisation`

These are the only kinds that may ever be dispatched as a proposal on an EMR connection.

## 3. Forbidden resources

The following resource types are explicitly forbidden for any direct write path:

- `Condition`
- `AllergyIntolerance`
- `DocumentReference`
- `DiagnosticReport`
- `ClinicalImpression`
- `Composition`
- `FamilyMemberHistory`
- `RelatedPerson`
- `Patient`
- `Consent`

These are clinician-authored or governance-sensitive records. The platform may surface them, but it must not generate or insert them as synthetic EMR content.

## 4. Proposal rules

Every proposal must satisfy all of the following:

- use `intent: 'proposal'`
- use `status: 'draft'`
- have a configured expiry window
- be reviewed against the patient identity and terminology checks
- be restricted by the active write policy (`off`, `shadow`, `bound`)
- satisfy the per-patient concurrency guard on open proposals

If a proposal cannot satisfy these rules, it is refused and recorded, rather than written.

## 5. Operational use

- `off`: the effect never reaches the EMR
- `shadow`: the effect stays in the harness for review and auditing
- `bound`: the effect is dispatched under the live EMR policy with explicit human sign-off

Any effect kind not on the allowlist should remain `shadow` or `off` at all times.

## 6. Review and sign-off

This allowlist is a clinical and compliance artifact as much as a code artifact. It should be reviewed when:

- a new effect kind is introduced
- a vendor profile changes materially
- a clinical workflow expands into direct EMR actions
- a failed or degraded proposal pattern reveals a gap in the gate

## 7. Implementation reference

The runtime enforcement is in [src/fhir/proposal.ts](src/fhir/proposal.ts), especially:

- `PROPOSAL_INTENTS`
- `FORBIDDEN_WRITE_RESOURCES`
- `WRITE_ALLOWLIST`
- `buildProposalResource`
- `expiryMinutesFor`

This document is the human-readable form of that fail-closed policy.
