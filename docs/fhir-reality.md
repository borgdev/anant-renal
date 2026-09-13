# FHIR — the actual state of the repo

**Date:** 2026-09-12 · **Branch:** `fhir-integration` · **Baseline:** `e240736`
**Supersedes:** the FHIR status rows in `docs/spec-gap-fhir-analysis.md` and `docs/enterprise-implementation.md`.

---

## Why this file exists

Two documents in this repo describe the FHIR layer and they **contradict each other**:

| Document | What it says | Dated |
|---|---|---|
| `docs/spec-gap-fhir-analysis.md:63` | FHIR typed model / client / subscriptions are ❌ **"Absent"** — *"No `@types/fhir`, no `fhir-kit`, no outbound FHIR HTTP client, no FHIR `Subscription`/CDS-Hooks/FHIRcast."* | 2026-08-16 |
| `docs/enterprise-implementation.md:147-202, 319-348` | Phase 2 **landed** the typed model, mappings, ingest, export, routes, durability and admin panel; Phase 5 "also landed" the client, the subscription pump and CDS Hooks | undated, claims "ALL ✅" |

**Both cannot be current.** An engineer who reads only the first concludes there is no FHIR layer and starts building one; an engineer who reads only the second concludes EMR integration is complete. Neither is true.

A third document, `spec.md`, describes a **target-state layout** (`src/fhir/mapper/` + `src/fhir/bridge/` — a directory of per-resource mappers) that was never built. The flat layout (`mapping.ts` + `canonical.ts`) won. `spec.md` is a plan, not a status report, and should be read as such.

**This file is the current record.** Where it disagrees with those documents, this one is right.

---

## What is actually built

`src/fhir/` is real and substantial — measured, not estimated:

| File | Lines | What it does |
|---|---|---|
| `types.ts` | 1044 | 62 hand-written R4 resource interfaces of the 144 in R4 (4.0.1), plus primitives, `FhirCtx`, `CODE_SYSTEMS` |
| `mapping.ts` | 1226 | `RESOURCE_TO_KIND` (52), `KIND_TO_RESOURCES` (58), the `ENTITY_FHIR` `{ hydrate, serialize }` registry |
| `canonical.ts` | 617 | FHIR resource → `WorldEffect`, structural upsert, `ingestCanonicalEvents` |
| `bundle-ingest.ts` | 380 | Bundle orchestration: `urn:uuid`/`#contained` reference resolution, structural-first ordering, **transaction atomic rollback**, batch/collection/message semantics, `dryRun`, `bundle.id` idempotency, 500-entry guard |
| `effect-map.ts` | 327 | The write path: 20 effect kinds → R4, with `meta.security` stamped |
| `fhir-bundle.ts` | 186 | `buildBundle` / `parseBundle` / reference index |
| `cds-hooks.ts` | 148 | `cdsHooksToCards` — abnormal results, med reconciliation, vitals, care gaps |
| `emulator.ts` | 151 | An in-process EHR test double + `/fhir-mock/:resourceType` |
| `subscription.ts` | 110 | `FhirSubscriptionPump.poll()` — `_lastUpdated` cursor |
| `client.ts` | ~600 | `FhirClient` — retry/backoff, rate limiting, pagination, `If-Match`/`If-None-Exist`, `$export`, `$validate` (F1.5) |
| `export.ts` | 86 | Realm → Bundle |
| `r4-inventory.ts` | 66 | The official 144-resource list for the coverage report |
| `routes.ts` | 272 | The existing HTTP surface |
| **F0/F1 additions** | | `vendor-profile.ts`, `auth.ts`, `capability.ts`, `operation-outcome.ts`, `http.ts`, `metadata.ts` |

Notably **transaction atomicity with rollback** is implemented and tested — a property many commercial FHIR integrations do not have.

## What is *not* built

- **No HL7 v2 / MLLP.** No `src/interop/`. The `*-lite` adapters in `src/adapters/` are field-level only.
- **No Bulk Data `$export` job client** in production use. `FhirClient.startExport`/`exportStatus` exist (F1.5); the route and backfill do not (plan F6).
- **No durable CDC cursor.** The pump's `since` is an in-process field.
- **No write/publish path.** `FhirClient.push` is called from nowhere; no proposal outbox (plan F9).
- **No SMART launch, no UDAP, no FHIRcast.** Backend Services auth arrived in F1.2; a launch flow is not built.
- **No vendor integration.** Zero references to Epic/Cerner/Athena before F1.1; profiles are a hypothesis until a sandbox contract test (F0.3) corrects them.
- **No CapabilityStatement discovery or publication before F0.** `GET /fhir/metadata` now exists.

## Retired

**`src/adapters/fhir-lite.ts` was deleted in F0.6.** It mapped only `Encounter` and `Observation` into the `treatment.*` canonical-event vocabulary, while `src/fhir/canonical.ts` hydrates every mapped resource type into a live realm. Two FHIR ingest paths with different fidelity is a drift bug waiting to happen — and the `-lite` one had **no production caller**, only its own test, which is now a regression guard asserting it does not come back.

---

## The three decisions that scope the work

Recorded in full in `docs/fhir-emr-integration-analysis.md` §5, and repeated here because they change what "done" means:

- **D1 — we propose, we do not order.** Every clinical action is published as FHIR `intent: 'proposal'` / `status: 'draft'`. `intent: 'order'` is never emitted. This makes per-kind **expiry and retraction P0** (an unbounded pile of machine drafts in an EMR's unsigned-orders list is a clinical hazard) and makes the outcome loop *observable* rather than trusted.
- **D2 — Epic, Cerner (Oracle Health), Athena.** Vendor differences are DATA (`VendorProfile`), not branches in the client. When a vendor cannot carry a flow we descend a recorded ladder rather than failing: `direct → Task → CDS card → CommunicationRequest → harness only`.
- **D3 — a session is a `Procedure` inside one `Encounter` per episode of care.** This makes `Encounter` continuity (gap D12) load-bearing: resolve the standing episode, and **reconcile rather than create**.

---

## The honest gap list

| # | Gap | Where it is tracked |
|---|---|---|
| A1–A8 | Connection record, contract test, auth, discovery, Bulk Data, secret storage, HTTP hardening | A1/A2/A4/A6 closed by **F0**; A3 by **F1**; A5/A7/A8 partly by F1.5, remainder **F6** |
| B1–B7 | Identity resolution, stable outbound ids, corrections, idempotency durability | **F3** |
| C1–C9 | Code fidelity: slugs emitted into RxNorm/CVX/SNOMED/LOINC | **F4** |
| D1–D13 | The renal clinical model on the wire | **F7/F8** |
| E1–E10 | Durable CDC, inbound push, reconciliation, DLQ, observability | **F5/F10/F13** |
| F1–F8 | Consent gate, uniform security labels, audit completeness | **F12** |
| G1–G8 | Conformance, `$validate`, certification ×3 vendors | **F12** |
| H1–H5 | Duplication and doc debt | H1 closed by **F0.6**; H3/H4/H5 by this file |

The single most important item on that list for *this* product: **the dialysis session does not cross the wire.** `start-session`, `end-session` and `record-access` all fall through `effectResourceType()` to `[]`. Until F7, the EMR sees a renal patient who is never dialysed.
