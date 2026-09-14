# FHIR EMR integration runbook

This runbook covers onboarding, validation, live cutover, and incident response for a FHIR EMR connection. It complements the implementation plan in [docs/fhir-emr-integration-plan.md](docs/fhir-emr-integration-plan.md), and it is written for operators who did not author the integration code.

## 1. Scope and safety model

- The bridge is proposal-first: we publish proposals with `intent: 'proposal'` and `status: 'draft'`.
- We never emit `intent: 'order'`.
- Every proposal has an expiry window and a retraction path.
- No effect kind is permitted to reach the EMR unless it is on the write allowlist and explicitly enabled as `shadow` or `bound`.
- A connection is not considered ready until capability discovery, credential validation, and a live probe pass.

## 2. Pre-flight checklist

Before a sandbox or live EMR is enabled:

1. Confirm vendor profile and auth model:
   - Epic: SMART Backend Services
   - Cerner: SMART Backend Services
   - Athena: OAuth2 delegated flow, not backend services
   - Generic: no auth / emulator public paths
2. Confirm the base URL and token endpoint.
3. Verify the secret is bound by name, never pasted inline.
4. Confirm the resource scope and write policy.
5. Confirm patient identity and terminology mapping.
6. Confirm the target realm and PHI clearance are explicitly assigned.

## 3. Onboarding flow

### Step 1: create the connection

- Configure the connection in the FHIR integration admin surface.
- Use a binding reference such as `binding:EMR_CLIENT_KEY`, not a cleartext secret.
- Save a human label such as `Riverbend · Epic accept`.

### Step 2: run the contract test

The live contract test must:

- fetch the server `CapabilityStatement`
- resolve auth credentials
- perform a live read probe on a first in-scope resource type
- negotiate required flows against the profile and live discovery
- return a capability report with any degradation or unavailable flows

If the server exposes no `CapabilityStatement`, the test fails. Do not continue to a live cutover.

### Step 3: review the capability report

Review these before enabling any write path:

- essential flows available vs. unavailable
- proposal degradation rung
- profile accuracy mismatch between vendor profile and live discovery
- any unsupported write surface that will force a `shadow` only path

If a proposal route is degraded, record the rung and the reason that the vendor cannot honour `intent: 'proposal'` directly.

### Step 4: backfill and validate

- Perform a bulk export or initial backfill if an EMR population must be hydrated.
- Validate a small sample of patient, encounter, lab, procedure, medication, and care-plan data.
- Confirm that observation timestamps and resource IDs are stable and replay-safe.

### Step 5: shadow mode

Until human sign-off is complete:

- keep writes in `shadow` mode
- preserve outbox records
- reconcile the generated FHIR resources to the inbound/integration workspace
- review failed writes, duplicates, and any identity ambiguity

### Step 6: clinical sign-off

A clinician or designated clinical approver signs off on:

- the actual proposal kinds allowed to cross the boundary
- the synthetic policy for each write kind
- the EMR-specific patient and encounter mapping
- any vendor-specific constraints or degradation that affect decision support

Only after sign-off can an effect kind be moved to `bound`.

### Step 7: cutover per kind

Cutover is per effect kind, not all-or-nothing.

- `off`: no write to the EMR
- `shadow`: keep in the harness, do not dispatch
- `bound`: dispatch to the live bidirectional EMR path

Do not move a kind to `bound` if its protocol or conversion pathway is not proven.

## 4. Operations and health checks

Monitor the following per connection:

- connection status
- last successful poll per resource type
- poll lag: now minus newest `_lastUpdated` observed
- throughput and error rate
- consecutive failures and recovery
- cursor position and backoff state
- DLQ depth and stale outbox rows
- proposal acceptance vs. conversion observation

Use the existing alert rules and event tables for monitoring of:

- stalled cursor
- failure streak beyond threshold
- ack rate drop
- DLQ growth
- lag breach

## 5. Incident procedures

### Stalled cursor

1. Confirm the scheduler is still running.
2. Check the last successful poll timestamp and last cursor position.
3. Examine the last error for the resource type and connection.
4. Validate network and auth health.
5. If needed, pause the connection, review the backoff state, then restart the scheduler.
6. Verify resumed polling does not reprocess already-applied versions.

### Rejected writes

1. Check the write policy and allowlist.
2. Confirm the resource type is allowed and the effect kind is enabled.
3. Verify patient identity binding and terminology validation.
4. Check whether the vendor rejected the write because of a profile or capability contract mismatch.
5. Preserve the failure in the outbox or DLQ and record the reason for operational follow-up.

### Duplicate detection

- Deduplicate by resource type + ID + version or content hash.
- Treat duplicate inbound messages as idempotent no-op events.
- Preserve an audit trail of the duplicate rather than silently overwriting.

### DLQ drain

1. Identify the queue entry and root cause.
2. Confirm the payload, auth, and policy are valid.
3. Re-enqueue only after manual review and a fresh idempotency check.
4. Record the resolution in the audit trail.

### Emergency rollback: bound → shadow

If a live write path becomes unsafe:

1. switch the affected effect kinds from `bound` to `shadow`
2. stop new dispatches to that vendor path
3. keep the outbox and audit trail intact for investigation
4. review the last accepted and rejected proposals before re-enabling anything

This rollback is operationally safe because it preserves the evidence while stopping new outbound writes.

## 6. Exit criteria

A connection is ready for full operational use when:

- contract test passes and returns a capability report
- no essential flow is unavailable
- any degraded flow is explicitly acknowledged and documented
- a live read probe succeeds
- the connection can backfill a small but representative dataset
- shadow mode is stable with zero unexpected writes
- the operator has reviewed the allowlist and signed off on `bound` cutover
- alerting is live for cursor, lag, and DLQ symptoms

## 7. Related artifacts

- [docs/fhir-emr-integration-plan.md](docs/fhir-emr-integration-plan.md)
- [docs/fhir-reality.md](docs/fhir-reality.md)
- [src/fhir/proposal.ts](src/fhir/proposal.ts)
- [src/fhir/capability.ts](src/fhir/capability.ts)
- [src/server/alerts.ts](src/server/alerts.ts)
