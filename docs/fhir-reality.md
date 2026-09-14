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
| C1–C9 | Code fidelity: slugs emitted into RxNorm/CVX/SNOMED/LOINC | **F4 — closed**. C9 partly: an unreadable dose is refused, but the payload is still a string (structured `DoseSpec` is F4.4-proper) |
| D1–D13 | The renal clinical model on the wire | **F7/F8** |
| E1–E10 | Durable CDC, inbound push, reconciliation, DLQ, observability | **F5/F10/F13** |
| F1–F8 | Consent gate, uniform security labels, audit completeness | **F12** |
| G1–G8 | Conformance, `$validate`, certification ×3 vendors | **F12** |
| H1–H5 | Duplication and doc debt | H1 closed by **F0.6**; H3/H4/H5 by this file |

The single most important item on that list for *this* product: **the dialysis session does not cross the wire.** `start-session`, `end-session` and `record-access` all fall through `effectResourceType()` to `[]`. Until F7, the EMR sees a renal patient who is never dialysed.

---

## F4 shipped (2026-09-13) — a code is real, or it does not leave

`src/fhir/code-registry.ts` is now the only path from an internal slug to a coded
concept. `effectToFhirResource` resolves every code through it, and an unmapped
slug **refuses the write** (`UnmappedCodeError`) instead of shipping a
plausible-looking wrong code. `scripts/verify-fhir-codes.mjs` re-checks every
`verified` entry against the authority that owns the code system (tx.fhir.org
for LOINC/SNOMED/CVX, NLM RxNav for RxNorm).

**118 codes, two fidelities** — and the distinction is the point:

* `verified` (82) — checked against the authority. The display is what the
  authority returned, and `source` records the service and the date.
* `local` (36) — no authoritative concept was found, so we declare **our own**
  code system (`urn:ananthealth:codesystem:<domain>`) instead of writing a
  guessed SNOMED/RxNorm id into a licensed system. A wrong code that *looks*
  authoritative is worse than a slug, because nothing downstream complains.
  `terminologyReport()` and `/admin/fhir/coverage` name every one, with the
  reason, for terminology sign-off.

The service surface (`$lookup`, `$validate-code`, `CodeSystem`, `ValueSet`)
exists so a receiver can resolve what we send — including the local codes it
cannot look up anywhere else.

### Verification found wrong codes in the repo's own seed tables

This is the finding worth acting on. The verifier showed that seven entries in
`src/ontology/seeds.ts` and `src/healthcare-core/terminology.ts` are
**mislabelled** — the code means something else entirely:

| File | Claimed | Actually |
|---|---|---|
| `seeds.ts` | LOINC `33914-3` "Estimated urea Kt/V ratio" | GFR (MDRD) |
| `seeds.ts` | LOINC `70969-1` "Urea clearance … (Kt/V)" | GFR (MDRD), male |
| `seeds.ts` | RxNorm `104375` "Epoetin alfa 4000 UNT/ML" | lisinopril |
| `seeds.ts` | RxNorm `1364430` "Sevelamer carbonate 800 MG" | apixaban |
| `terminology.ts` | RxNorm `349849` "darbepoetin alfa" | isoleucine |
| `seeds.ts` | LOINC `72172-0` AUDIT-C / `72109-2` MoCA | **swapped with each other** |
| `seeds.ts` | LOINC `38208-5` "Braden Scale total score" | "Pain severity - Reported" |
| `terminology.ts` | LOINC `KTV-DEL` | self-described placeholder |

The analysis document's own value for delivered Kt/V (`18262-6`) is wrong too —
that is LDL cholesterol; the real code is `70961-8`.

The registry carries the corrected values. **The seed tables themselves are not
fixed by F4** — they feed the ontology graph and need their own change with its
own test run. Until then those entries are wrong wherever the ontology is read.

Also fixed here: a dialysis claim is now `type: institutional` (it was
`professional`, which a payer rejects for a facility service), and the dose
regex is gone — `parseDose` refuses `1-2 tabs`, `q12h` and `'0.5 mg x 2'`, which
the old `replace(/[^0-9.]/g,'')` happily turned into 12, 12 and 0.52.

Not done, and tracked: a structured `DoseSpec` on the effect payload
(F4.4-proper), so that no parsing is needed at all.

---

## F7 shipped, part 1 (2026-09-13) — the session crosses the wire

Before this the EMR saw a renal patient **who was never dialysed**:
`start-session`, `end-session` and `record-access` all fell through
`effectResourceType()` to `[]`. D3 is now implemented as written — a SESSION is a
`Procedure`; the EPISODE of care is ONE long-lived `Encounter` that many sessions
attach to.

* New entity kinds (union + `entity-record` + `mapping` + hypergraph nodes):
  `dialysis-session` (Procedure), `dialysis-episode` (Encounter),
  `vascular-access` (Device + DeviceUseStatement), `dry-weight`
  (Observation + Goal).
* The reducer CREATES the session entity keyed by `sessionId`, and **reconciles**
  the episode on a derived key (`patient-facility-modality`) — replaying a course
  of dialysis cannot manufacture encounters. `end-session` closes the SAME
  `Procedure` and carries the delivered metrics as `Observation`s that reference
  it via `partOf`.
* `record-access`: a measurement → `Observation` (hemodynamic, coded components);
  an intervention (angioplasty / declot / catheter-placed / avf-created) →
  `Procedure`; an untoward event (thrombosis / infection) → **`AdverseEvent`**,
  which is where the EMR files it for the safety team. A data-less surveillance
  event projects nothing rather than an empty Observation that asserts a
  measurement nobody took.
* Dry weight is its own entity: the post-dialysis weight IS the dry-weight
  estimate (LOINC `8341-0` Dry body weight), with IDWG derived from the previous
  session's post weight.

### Live: one patient, one episode

Ran the demo fleet through the simulator and exported a realm: **6 patients → 6
dialysis episode Encounters (exactly one each) and 24 session Procedures**, every
Procedure carrying `encounter` = its episode and the SNOMED treatment code
`302497006` (Haemodialysis).

That run found a **simulator data bug**: the modality was drawn per SESSION
(`rng() < 0.15 ? hdf : hd`), so a patient flipped modality between sessions.
Harmless while sessions were invisible — but now it produced two concurrent
dialysis episodes for one patient, hollowing out the exact continuity D3 exists
to guarantee. A patient's modality is a prescription, so it is now derived from
the patient id and is stable across sessions and replays.

### Not done in this slice (F7 is four PRs; this is PR 1+2)

* **Prescription** — `CarePlan.activity` for the clinical prescription plus
  `DeviceRequest` for machine settings (conflating the two is what an EMR
  rejects).
* **`titrate-med` / `hold-med` as proposals** — the D1 proposal path, which is F9.
* **ESRD-QIP `MeasureReport`** (D8) and **CMS forms / NHSN** (D9).
* ~~**`record-session-telemetry` → `Observation`**~~ — **shipped in F8** (below),
  which also fixed the silent 24-point telemetry cap.

Volume is measured rather than assumed: the session SUMMARY (Procedure +
delivered metrics) is **4 resources / 2957 bytes**, printed by the test.
Telemetry is additive and proportional to cadence, which is why F8 ships the
whole session as one `transaction` bundle instead of resource-by-resource.

## F8 shipped (2026-09-13) — telemetry, and a cap that counted what it dropped

`record-session-telemetry` and `record-access-acoustic` both fell through
`effectResourceType()` to `[]`. Two things were wrong, and only one of them was
visible.

**The visible one: no telemetry reached the EMR.** Now every point projects one
`Observation` per channel, each carrying `effectiveDateTime`, `subject`, the
episode `encounter`, and **`partOf` → the session `Procedure`** — which is what
makes a reading attributable instead of a loose series.

**The invisible one: the cap was losing data silently.** The reducer kept
`[...points].slice(-24)`. At 5-minute cadence a 4-hour session is 48 points, so
half of every session was discarded — and nothing recorded that it had happened.
The cap is now `MAX_SESSION_TELEMETRY_POINTS = 720` (4 hours at 20-second
cadence) and anything still dropped is accumulated into `telemetryDropped`, so a
truncation shows up as a number instead of as a session that looks complete.

**A machine channel is not a vital sign.** `qd`, `venous-pressure` and
`uf-volume` are `hemodynamic`; `hr`, `temp` and blood pressure are
`vital-signs`. Filing a dialysate flow rate as a patient observation is wrong in
a way an EMR will not correct for us. Verified against the authorities: LOINC
`99712-2` (dialysate flow rate), SNOMED `252076005` (venous pressure), LOINC
`99741-1` (ultrafiltrate volume removed). `qb`, `arterial-pressure` and
`uf-rate` had **no verifiable concept**, so they are declared `local` against
our own code system rather than given a plausible-looking licensed code.

**The session ships atomically.** `src/fhir/session-bundle.ts` emits a
`transaction` Bundle — FHIR's apply-or-roll-back unit — with `PUT` on every
entry, because every id is derived from the session id and a replay must
overwrite rather than duplicate.

| session | resources | bytes | shape |
|---|---|---|---|
| 48 points (4h @ 5 min) | 436 | 385,048 (376 KiB) | **1 atomic transaction** |
| 720 points (4h @ 20 s) | 6,484 | 5,776,720 (5.6 MiB) | 7 transactions |

`TELEMETRY_BATCH_SIZE` is 1000 because those numbers were measured, not guessed:
it keeps the canonical session atomic while forcing the extreme one to split. A
split is reported by `bundleAtomicityNote()` as **atomicity PER BATCH, not per
session** — a 5.6 MiB single request would be rejected by most servers, and
pretending otherwise is how half-sessions happen.

**A derived feature vector is not a measurement.** `record-access-acoustic`
carries mel-band energies, not audio. It is now projectable **only** with the
synthetic flag set, and that is enforced twice — in the reducer and again on the
write path in `effect-map.ts`. The projected `Observation` is a coded placeholder
plus provenance extensions; the feature values never reach the wire.

### Live: telemetry on the wire

Drove the real server (26 → 120 ticks to cross the hour-48 session boundary) and
exported the realms over HTTP:

* **10 session Procedures** (SNOMED `302497006`), **90 telemetry Observations**
  with `partOf` → their session Procedure — exactly 9 per session, matching the
  channel set.
* Every category landed correctly: `hemodynamic` for `99712-2` / `252076005` /
  `99741-1` / the three LOCAL channels, `vital-signs` for `8867-4` (HR),
  `8310-5` (temp) and the `55284-4` blood-pressure panel.

### Known gap this slice did NOT close

The **simulator samples one telemetry point per session** (`sessionTelemetry`
fires once at `elapsedHours % 48 === 6`). So the demo shows a single dot rather
than a 48-point trend, and the live run above can only ever show 9 Observations
per session. The wire path is exercised at 48 and 720 points by
`tests/fhir-telemetry.test.ts`; the simulator's cadence is a simulation-fidelity
limitation, not a wire bug, and changing it means re-pinning the seeded stream.
Recorded here rather than left to be discovered.

### Not done in this slice

* **`DeviceMetric`** for machine channels. The `Observation`s carry the same
  information and a machine `Device` entity does not exist yet, so a `DeviceMetric`
  would reference a device we cannot name. Deferred deliberately.
* **`record-session-telemetry` per-reading emission** — the batch helper supports
  it (`batchSize`), but nothing calls it per reading yet.

## F3 shipped (2026-09-13) — identity, and a write that cannot be constructed

Closes **B1, B2, B3, B4, B7**. This is the package that prevents wrong-patient
writes, which is why the plan sequences it before F9.

The hazard was concrete and sitting in `canonical.ts`: `applyStructural` keyed an
inbound `Patient` by **its remote id**, so an EMR patient `Patient/e63a…` whose
MRN matched `f1-pt-0001` was simply adopted — **a second chart for a patient who
already had one**, with clinical data then flowing into it.

**The matching ladder** (`src/fhir/identity.ts`), in order:

| rung | evidence | confidence | auto-applies |
|---|---|---|---|
| a | exact identifier on an **authoritative** system | 1.0 | yes |
| b | a cross-reference we already hold | 1.0 | yes |
| c | exact demographics (family + given + DOB + sex, normalised) | 0.95 | yes |
| d | resemblance (name variant, DOB tolerance) | ≤0.9 | **never** |

Three properties do the actual work:

* **A fuzzy match is a lead, not an answer.** Rung (d) is capped below the
  auto-apply ceiling, so it is *shown to a human* but can never satisfy
  `status: 'resolved'` on its own. A plausible-looking link between two similar
  people is worse than no link, because the data then flows confidently to the
  wrong chart.
* **Ambiguity is an outcome, not an error.** Two candidates returns
  `{ status: 'ambiguous', candidates }` — a human decision — instead of a 500
  someone retries until it happens to match.
* **Every link records HOW it was made** (`method`, `confidence`, `linkedBy`,
  `verified`). A link a human confirmed and a link inferred from a name and a
  birth date are not the same evidence, and the console can now say which one it
  holds. A fuzzy-derived link is stored `verified: false`.

**The guardrail is a function, not a convention.** Write paths call
`requirePatientIdentity(resolution)`, which **throws**
`UnresolvedPatientIdentityError` unless the identity resolved. `ambiguous` and
`unresolved` both refuse. A test asserts a write cannot be constructed for a
patient with no verified cross-reference.

**On the ingest path** an unresolvable inbound `Patient` **fails its entry** — so
in a `transaction` Bundle the whole thing rolls back. Nothing is written about a
patient we cannot place. Verified by test: a phantom chart is not created, the
population is unchanged, and the skip code names the reason
(`patient-identity-ambiguous`, `patient-identity-unresolved`). Without an
identity snapshot the pre-F3 adopt-by-remote-id behaviour is **preserved and
documented** — correct for a same-system replay, never for an EMR feed.

**Outbound (B2/B3).** `outboundPatientIdentity()` emits
`Patient/<remoteId>` (the receiving system's name for the patient) plus our MRN
as an `identifier`, so a vendor's own record merge can still be reconciled.
`stableResourceId(effectId)` derives a deterministic 32-hex id from the effect,
so a retried `push()` **PUTs an update** instead of POSTing a duplicate — one
line of code with an enormous correctness payoff.

**Corrections (B5).** `correctionFrom()` detects `entered-in-error` on any
resource and `Patient.link: replaced-by` merges; `correctionFromStatus(410)`
treats a gone resource as a deletion notice rather than a transport failure. A
correction **supersedes** — it never deletes, because erasing the record of a
wrong value is exactly what an audit needs.

### The bug the tests found

`mergeInto` initially re-pointed the cross-reference but left the OLD row alive,
so a lookup by remote id still returned the **merged-away** patient — data would
keep flowing to the dead chart, the same wrong-patient outcome by a different
route. Fixed two ways: the store's `deleteCrossReference` retires the row, and
for a store that *cannot* delete, the row is marked `supersededBy` and every
lookup skips superseded rows. A test covers both, and a third asserts the
**moved** row does *not* carry `supersededBy` — if it did, the merge would
resolve to nothing and the patient would read as unknown.

A second real bug: the `/admin/fhir/identity/resolve` route called the pure
matcher directly, **bypassing the cross-reference rung** — so a patient we had
already linked read as `unresolved`. The route now resolves through
`PatientIdentityService`, which is what folds our own links into the population.

### Surface

`POST /admin/fhir/identity/resolve` (who is this? — writes nothing),
`GET /admin/fhir/identity/links/:realmId` (the evidence, with an `unverified`
count), `POST /admin/fhir/identity/link` (record / verify / `{ merge }`),
`GET`/`POST /admin/fhir/identity/systems` (defaults plus this deployment's
assigner OIDs, durable). Cross-references and identifier systems are durable
`workspace` kinds, so a deployment's linkage survives a restart.

### Not done in this slice

* **Inbound `Encounter` continuity** (D12) — the *outbound* half already holds
  (F7 reconciles one standing episode per patient/facility/modality, and a test
  asserts N sessions → one `Encounter`). The inbound half — an EMR `Encounter`
  for a patient already in an open episode **attaches** rather than creating a
  parallel one, and we reconcile where the EMR already holds the episode — is
  not built.
* **The human-resolution console task.** `onAmbiguous` is the seam and the API
  answers `ambiguous` correctly, but nothing yet files a work item for it. Until
  it does, `MD`/`safety` have no queue entry to act on and an ambiguous patient
  is simply refused.
* **`Patient.link` merge detection is not wired to `mergeInto`.** The detector
  exists; nothing calls the merge when it fires.

## F9 shipped, part 1 (2026-09-13) — governed, expiring proposals

Implements **D1**: we propose, we never order. `src/fhir/proposal.ts` is the
engine; the durable row lives in the `fhir-proposal` workspace kind.

**The signature property holds:** publishing the same effect three times yields
**one** proposal row, **one** resource in the EMR, and **one** transport call.
Tested at both the engine and the API level.

Because we propose rather than order, the hard question moved. It is no longer
"did the write land exactly once" (a duplicated draft is noise where a duplicated
order is harm). It is **"is this proposal still worth a clinician's attention, and
did anything happen to it?"** An unactioned wall of machine drafts is the failure
mode that gets a machine switched off, so every proposal carries an expiry and a
concurrency cap bounds it.

### The four guardrails are code, with tests

* **`intent: 'order'` is impossible to construct**, not discouraged.
  `buildProposalResource` is the single constructor and it asserts `intent:
  'proposal'` + `status: 'draft'`.
* **`FORBIDDEN_WRITE_RESOURCES`** — a diagnosis, problem-list entry, allergy,
  note or demographic attribute is a *clinician's* assertion about a patient.
  Generating one from model output and filing it in the chart would be putting
  words in their mouth, and `status: 'draft'` does not make that acceptable. It
  throws.
* **`WRITE_ALLOWLIST`** — an effect kind that is not on it can only ever be
  `shadow`. It can be computed, shown and audited, but it cannot leave the
  building.
* **No expiry window ⇒ refuse.** A kind absent from `PROPOSAL_EXPIRY_MINUTES`
  cannot be published. A proposal with no window is one that will still be sitting
  in an unsigned-orders list in six months, which is worse than not proposing.

### The preflight gates are DERIVED, not asserted by the caller

The API route does not accept `identityVerified: true`. It derives that from the
F3 linkage store (a **verified** cross-reference, not merely a resolvable
patient) and derives `codesValidated` by walking the finished resource's codings
against the F4 registry (`validateCodings`). A client that could assert its own
preflight would make every gate advisory.

The second code check earns its place: the write path refuses to *emit* an
unmapped slug, but a resource can be assembled from more than one source, and a
code that arrived from a caller rather than from the registry is exactly the case
the emit-time gate cannot see.

### Retraction and expiry are different things

`expired` means nobody acted in time. `retracted` means an operator decided the
proposal should not stand. They are separate lifecycles **on purpose**: folding
them together would make an operator's judgement look like clinician
disinterest in the adoption statistic. `neverActionedRate` is denominated only on
proposals that reached a clinician and were left to expire.

A bound proposal is **retracted at the vendor** (`status: 'revoked'`), never
deleted — a deleted draft leaves no trace that we proposed it. And the
non-action is *recorded*: a kind whose proposals are never actioned is a kind the
clinicians do not want, and that is a clinical decision, so it is reported rather
than acted on.

### One row per effect, and the refusal trail survives

`id` and the stable `identifier` both derive from the effect id, so a retry
reconciles. A refusal is **not** treated as an existing proposal — otherwise a
corrected refusal would become a permanent duplicate — but the retry does not
erase it either: it **advances the same row** and the refusal reason stays in the
issue trail. One test asserts exactly that (a refusal, then a successful retry,
leaves one row whose issues still name `approval-not-recorded`).

### Not done in this slice

* **`Provenance` on every published proposal** (deliverable 5) — the audit trail
  inside the EMR. Not built.
* **Dispatch through the configured connection.** `emulatorProposalTransport()`
  writes to the in-process FHIR emulator, whose `add()` is an upsert keyed by
  (type, id) — which is what makes the deterministic id pay off. A real
  deployment needs the `FhirClient` bound to the stored connection, with
  `If-Match` where the vendor supports it.
* **`GET /proposals/:id/replay`** and the **mirror-outbound `fhir_resources`
  row** (`direction: 'out'`).
* **The sweeper is not scheduled.** `POST /admin/fhir/proposals/sweep` runs it on
  demand; nothing runs it on a timer, so in production an unexpired proposal would
  sit until someone called it. That is the one gap here with a clinical
  consequence.

---

## Terminology remediation (2026-09-14)

The plan recorded "seven codes in `seeds.ts` / `terminology.ts` are mislabelled".
That was a spot-check of the renal path. Auditing **every** LOINC and RxNorm entry
in both tables (the same way `scripts/verify-fhir-codes.mjs` checks the registry)
found **29 mislabelled of 71, plus 8 that exist on no server** — and the defect
had propagated to four more files.

| Class | Example | Why it matters |
|---|---|---|
| Wrong concept | `33914-3` "Estimated urea Kt/V" is GFR (MDRD); `70969-1` likewise | `vs:kt-v-adequate` bound two eGFR codes under a `required` binding |
| Swapped pair | `72172-0` / `72109-2` — AUDIT-C and MoCA | an assessment is scored as the wrong instrument |
| Wrong drug | 20 of 21 RxNorm rows (`993781` "Furosemide 40 MG" is acetaminophen/codeine) | a pack binding a med by these acts on the wrong drug |
| Wrong strength | `308136` "Amlodipine 5 MG" is 2.5 MG | a dose |
| Non-existent code | `54556-4`, `77584-8`, `57249-9`, `96566-2`, `80392-9`, `54580-4`, `33747-0`, `48151-2`, `272248001`, `128124002` | a band or lookup that can never match |
| Wrong concept **in the plan itself** | the plan's F4 says delivered Kt/V is `18262-6`; that is LDL cholesterol | `cms:esrd-qip:kt-v` scored cholesterol against `>= 1.2` |

Also found outside those two tables: `packs/dialysis-provider/labs/index.ts`
applied **albumin** bands (critical low 2.5 g/dL) to `2885-2`, which is **total
protein**, and the registry's `ALBUMIN` slug resolved to that same code — so
`codeFor('lab','ALBUMIN')` returned the wrong analyte.

**Corrected** (every value verified against tx.fhir.org `$lookup` / NLM RxNav):
`src/ontology/seeds.ts`, `src/healthcare-core/terminology.ts`,
`src/healthcare-core/cms-measure-catalog.ts`, `src/assessments/library.ts`,
`packs/dialysis-provider/labs/index.ts`, `src/fhir/code-registry.ts`
(`ALBUMIN` → `1751-7`, with `2885-2` kept as its own `TOTAL-PROTEIN` entry),
`admin-ui/js/views/catalog.js`, and the generated `admin-ui/assessments.json`.
Re-audited after the fix: **0 mislabelled, 0 unverifiable.**

Two judgement calls, made explicitly rather than silently: four instruments with
no verifiable LOINC concept (KDQOL-36, Katz ADL, Lawton IADL, CAGE) **keep the
instrument and drop the code** — `AssessmentSpec.loinc` is optional and every
consumer already handles absence, so a fake code buys nothing; and one drug
(semaglutide) was **dropped**, because only the component-level `2553600` exists
and writing a component where a product belongs is the same defect class.

**Why no test caught this:** `tests/ontology.test.ts` asserted
`getConcept('rxnorm','866426').display` contained "Metformin". It passed for the
same reason the table was wrong — the label lied and the code was never checked.
That assertion now pins `861007`, and `tests/fhir-terminology.test.ts` gained an
offline **seed-table fidelity** block: the concept each code is labelled with,
that the wrong codes are *gone* rather than relabelled around, that the codes
which were only mislabelled are kept (dropping `855332`/`197361` would have lost
warfarin and amlodipine), and that no cholesterol code appears in
`vs:kt-v-adequate`, `vs:renal-labs` or the ESRD-QIP threshold set.

The registry's `verified` entries remain the wire gate; the seed tables are the
ontology the engine reasons over, and they were the ones that were wrong.


