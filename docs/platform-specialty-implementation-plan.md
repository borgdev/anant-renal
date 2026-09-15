# Platform-first specialty implementation plan

## Objective

Establish the shared healthcare platform as the reusable delivery layer, and keep Renal as the first specialty pack rather than the whole product. The platform will own common organization, identity, event, data, policy, release, and UI primitives; each specialty will plug in its own ontology, workflows, measures, and frontline experience.

This plan is intentionally structured so the team can execute in phases, track status, and scale to additional specialties without rewriting the system.

---

## Core design decision

The product must be built as:

- Platform core
  - identity and access
  - organization hierarchy
  - events and integrations
  - FHIR/EMR contracts
  - durable workspace and config
  - policy, release, and observability
  - shared UI shell and admin flows

- Specialty pack
  - renal ontology
  - renal workflows
  - renal measures and quality logic
  - renal UI lens and dashboards
  - specialty-specific KPIs and operational flows

This keeps the platform reusable across care settings such as primary care, oncology, home health, infusion, payer clinical management, and more.

---

## Phase 0 — Platform baseline and contracts

Status: **complete**

### Goal

Freeze the common platform contracts before building any new specialty-specific behavior.

### Scope

- Shared platform admin routes
- durable platform config
- common organization model
- role and console model
- integration registry for Kafka/FHIR/CMS
- shared release and onboarding gates
- package registry and pack activation contract
- generic front-end shell for admin and exec experiences

### Deliverables

- [x] Platform organization model is stable and reusable
- [x] Platform onboarding gates are durable and test-backed
- [x] FHIR integration contract is validated and protected by fail-closed rules
- [x] Kafka integration contract remains durable and testable
- [x] Pack registry can list installed packs and active lens
- [x] Shared admin UI shell is usable across specialties

### Exit criteria

- a new specialty can install a pack without changing platform contracts
- the core platform is not custom to Renal
- the same organization, identity, and integration model works for a second specialty pack

**Implemented by:** `src/control-plane/pack-contract.ts` (the written boundary, the
conformance ladder, the pack allowlist, the literal-secret guard), served at
`/admin/platform/contracts` and `/admin/platform/packs/conformance`, rendered in
the Configuration studio. `tests/platform-contract.test.ts` (27 tests).

---

## Phase 1 — Shared platform hardening

Status: **complete**

### Goal

Lock in security, config durability, and operational behavior before specialty expansion.

### Scope

- secret references and secret provider contract
- auth policies and per-role permissions
- platform-level observability and traceability
- policy, red-team, and release gates
- integration health summaries and DLQ visibility
- configuration versioning and release propagation

### Deliverables

- [x] No literal secrets in config or UI payloads
- [x] Platform config is versioned and auditable
- [x] Integration health status is visible in admin operators and ops views
- [x] DLQ / replay / dead-letter recovery flow is documented and tested
- [x] Release gate and rollback path are validated end-to-end
- [x] Core admin and exec UIs are generic and not renal-specific

### Exit criteria

- platform health can be managed without specialty knowledge
- a new pack can be activated without editing core admin logic
- policy enforcement works across all packs consistently

**Implemented by:** `src/control-plane/platform-hardening.ts` (domain-blind, pure),
served at `/admin/platform/hardening`, rendered in the Platform admin console. Two
findings are worth calling out because they are properties, not features:

- **`write-policy-safety` is fail-closed.** When a pack binds an external write
  effect kind and *no* vendor is sandbox-certified, the check is `fail`, not
  `warn`. It reads the real durable certification records (`certifiedVendors()`),
  so the seam is live rather than a hardcoded empty list.
- **Atomic writes.** `SourceRegistry` and `SecretRegistry` persist by
  temp-file-plus-`rename`, and the two rebuildable knowledge caches are read
  tolerantly. In-place truncation plus parallel readers was corrupting a 26 KB
  registry mid-write and breaking boot; the caches are runtime state and are no
  longer tracked.

**Operational note:** `.harness/knowledge/` is entirely runtime-derived — the
registry caches are rebuilt from the pack catalog on each boot, the per-source
trees are written by the sync jobs, and the secret store holds credentials. The
code is tracked; the state never is.

---

## Phase 2 — EMR certification and actual vendor validation

Status: **harness complete — sandbox blocked on external vendor lead time**

### Goal

Move from internal simulation and contract checks to actual EMR certification with real vendor sandbox and live capability validation.

### Scope

- Epic sandbox validation
- Cerner sandbox validation
- Athena sandbox validation
- Capability negotiation against actual vendor responses
- auth and token behavior verification
- proposal behavior and conversion observation under real vendor conditions
- vendor-specific degradation handling
- consent, safety, and FHIR conformance testing

### Deliverables

- [ ] Epic sandbox connectivity and capability report complete
- [ ] Cerner sandbox connectivity and capability report complete
- [ ] Athena sandbox connectivity and capability report complete
- [x] Capability mismatch cases are documented and handled by degradation ladder
- [x] Proposal conversion is observable and reconciled
- [x] FHIR conformance + safety checklist passes per vendor
- [ ] EMR runbook is approved by ops + clinical safety

### Exit criteria

- actual vendor sandbox results are captured in a conformance matrix
- no production route depends on unproven vendor behavior
- certification evidence is stored as part of the platform deployment record

### What is built

The gate that cannot be waived is the one that matters here, so it was built first:

- **`src/fhir/conformance-double.ts`** — a server that answers like a real EMR. It
  verifies a genuine RS384 SMART assertion (algorithm, signature, `iss`/`sub`/`aud`/`exp`),
  enforces the profile's required headers, serves a CapabilityStatement that
  declares only what the vendor declares, and returns **405** on a `create` the
  vendor does not advertise. A double is only useful if it can say no.
- **`src/fhir/vendor-certification.ts`** — the verdict, kept pure. `sandbox` is
  the only mode that can produce `certified`; a `double` run caps at
  `harness-verified`. `sandboxCertifiedVendors()` excludes harness-verified by
  construction, and it is what Phase 1's write check consumes.
- **`src/server/certification-routes.ts`** — `/admin/platform/certification`
  (matrix, one row per certifiable vendor, absences included), `/:vendor`
  (history, newest first), `/:vendor/run`. A `sandbox` run without a saved
  connection returns **409 `no-sandbox-connection`** rather than quietly probing
  the double.
- **Platform → Vendor certification** in the operator console, with a double
  probe per vendor and the essential-blocked flows surfaced as blockers.

**Why a double can never certify a vendor:** we wrote both ends of that
conversation. If a double run could set `certified`, then a `bound` write path —
which writes to a patient's chart — would go live on the strength of our own test
server. That invariant is enforced in `buildVendorCertification` and asserted
end-to-end in `tests/certification-routes.test.ts` ("records the run durably, and
the double still does not certify the vendor"). Total: 28 tests across
`tests/vendor-certification.test.ts` and `tests/certification-routes.test.ts`.

### Finding that needs a product decision

**Athena cannot be certified for the episode-Encounter write.** Running Athena
through the harness produces `verdict: failed` with
`essentialBlocked: ['episode-encounter-write']`: Athena's FHIR surface declares
no `create`, so discovery confirms the episode Encounter cannot be opened. This
is not a harness limitation, and it is not a degraded path — it is a genuine
incompatibility between D3's session/episode model and Athena's read-oriented API.

One of two things has to be decided, and the plan cannot proceed on this vendor
without it:

1. **Declare the episode Encounter non-essential for read-only vendors.** Then the
   episode lives in our own records, the vendor carries observations and results,
   and the degradation ladder handles the rest. This is a real product position,
   not a workaround, and it should be written down as one.
2. **Accept that an Athena deployment cannot carry the session/episode model over
   FHIR**, and scope Athena customers to a narrower offering.

Option 1 is the smaller commitment and unlocks a read-first integration now.
Option 2 is the more honest answer if the episode Encounter is load-bearing for
clinical safety in a dialysis session.

### Blocked on

Epic, Cerner, and Athena sandbox credentials and connectivity. Those carry
external lead time (marketplace enrolment, app registration, endpoint
provisioning) and no amount of local work substitutes for them. The harness above
is what makes those runs cheap once access lands: each vendor is one saved
connection plus one `mode: 'sandbox'` call, and the results land in the same
durable matrix. Until then every vendor honestly reads `harness-verified` or
`not-run` — never `certified`.

---

## Phase 3 — Specialty pack contract model

Status: **contract enforced — manifest is the authoring surface, resolution is checked**

### Goal

Define the exact contract a specialty pack must implement so new clinical domains can be added as plugins instead of custom products.

### Scope

- pack manifest format
- org scope and specialty taxonomy
- domain ontology structure
- workflow reducer contract
- data model contract
- UI lens contract
- measure and policy contract
- permission model for specialty workflows

### Deliverables

- [x] Pack manifest schema is complete
- [x] Pack dependency model is defined
- [x] Specialty ontology can be loaded without platform changes
- [ ] Specialty UI lens can render in generic shell
- [x] Specialty workflows can register events, measures, and policies
- [ ] Shared release validation recognizes pack-level rules and gates

### Exit criteria

- a new specialty can be introduced through pack registration only
- Renal is no longer a special-case code path in the platform shell
- pack-level onboarding is self-contained and reusable

### What is built

Phase 0 wrote the boundary down. This slice makes a declaration **checkable**,
because before it the specialty sections were declared and never read: a pack
could name an ontology it did not ship and still report as conformant.

- **`src/control-plane/pack-manifest.ts`** — parses `packs/*/manifest.yaml` into
  the registry shape, normalising the on-disk snake_case, and resolves every
  artifact the manifest *names* against `packs/<id>/`. A declaration that cannot
  be resolved is a **blocking issue**, not an aspiration. It also compares the
  manifest to the TypeScript descriptor (`manifestDrift`).
- **`src/control-plane/pack-resources.ts`** — resolves the manifests as a SET and
  enforces the five invariants that only exist across packs: **concept
  collisions**, **orphan event subscriptions**, **one-sided cross-pack
  workflows**, **unbacked CMS measures**, and a **lens shadowing platform
  navigation**. A shared canonical event type is a note, never a failure — two
  specialties reacting to one platform fact is the point of a canonical plane.
- **The contract consumes resolution** (`validateSpecialtyPack` gains a
  `resource-resolution` check and a `manifest-drift` warning), so an unresolvable
  surface is `nonconformant` and refuses **activation** rather than surfacing as
  a runtime `Cannot find module` in a specialty the platform already agreed to
  host.
- **Surface**: `GET /admin/platform/packs/:id/resources` (the declared surface,
  resolved), the conformance matrix carries resource totals, and the flagship
  Pack registry in Configuration studio renders each pack's declared surface,
  its resolution, and any drift.

### What this found — three defects, all real

1. **`packs/revenue-cycle/manifest.yaml` was not valid YAML.** It carried
   `facility_kinds:\n    - *` — an empty alias no parser accepts. Nothing had
   ever parsed that file. A manifest is the artifact a second specialty arrives
   through, so "it does not parse" is not a documentation nit.
2. **`packs/payer` had two contradicting identities.** The manifest advertised
   `0.1.0` with four capabilities; `index.ts` shipped `0.2.0` with seven. Both
   were "the manifest", and whichever a reader opened was the truth they got.
3. **`packs/dialysis-provider` declared a CMS authority that could never
   match.** The manifest listed `esrd-qip` where the runtime resolves
   `cms:esrd:qip`, alongside a stale version (`0.2.0` vs `0.3.0`), 8 capabilities
   against 13, and 3 controls against 7. A measure bound to `esrd-qip` bound to
   nothing.

All three are fixed by bringing the manifests **to the runtime descriptor** —
the descriptor is what the registry resolves, so weakening it to match a stale
manifest would have been the wrong direction. Drift is now **zero** for every
installed pack, and the drift check is the guard that keeps it there.

### The honest state of the installed set

Live: **16 packs installed — 1 substrate, 2 conformant, 13 partial, 0
nonconformant.** `dialysis-provider` (12 ontology concepts, 14 event contracts,
4 workflows, 1 CMS-bound measure, the `renal` lens) and `payer` (6 concepts, 10
event contracts, 4 workflows, 1 measure, the `payer` lens) declare all five
sections. `ckd-navigation` declares four and no measures, so it is honestly
`partial`. The other twelve declare no specialty surface at all — they are
dependencies that load, not specialties that arrive through registration. That
is the remaining work, and the matrix now says so in numbers instead of by
omission.

### Not built yet, and named so it is not mistaken for done

- **The manifest is not yet the source of truth.** The runtime resolves the
  TypeScript descriptor; the manifest is parsed, resolved and compared, but
  nothing loads a pack *from* its manifest. Making it authoritative is the next
  step, and the drift check is what makes that step safe to take.
- **The lens is terminology, not navigation.** A lens declares its identity and
  its terminology; it does not yet add navigation the shell renders, and the
  manifests deliberately declare no `nav` rather than inventing ids for a UI that
  does not exist. Deliverable 4 in the list above.
- **Release validation does not yet read pack-level gates** (deliverable 6): a
  release containing a nonconformant pack should not validate, and today it can.
  That is the next slice.

---

## Phase 4 — Renal pack v1 as the first pack

Status: planned

### Goal

Turn Renal from a hard-coded product into the first fully working specialty pack on the shared platform.

### Scope

- renal ontology and domain model
- dialysis session + episode model
- renal access and treatment workflows
- renal measures and quality logic
- renal dashboards, queue views, and operator UI
- renal policy and safety checks
- renal pack config and default activation logic

### Deliverables

- [ ] Renal pack manifest and activation are functional
- [ ] Renal-specific clinical data is isolated behind the pack contract
- [ ] Renal events route through shared platform events and DLQ handling
- [ ] Renal dashboards render in the generic platform shell
- [ ] Quality and outcome flows work through common release and audit infrastructure
- [ ] Renal pack passes the same platform validation gates as other packs

### Exit criteria

- Renal works as a pack, not as a product-specific code branch
- Renal can be enabled/disabled without affecting other domains
- the core platform remains reusable for non-renal specialties

---

## Phase 5 — Second specialty expansion

Status: planned

### Goal

Prove the platform can support a second specialty using the same pack model.

### Suggested candidates

- primary care
- oncology
- home health
- infusion provider
- care management
- payer clinical management

### Scope

- select second specialty
- map its core workflows to the pack contract
- implement the new domain pack using shared platform primitives
- validate release, admin, and UI behavior
- confirm no core platform changes are required

### Deliverables

- [ ] one additional specialty pack successfully installed
- [ ] domain-specific workflows run on shared platform primitives
- [ ] UI and admin patterns are reusable
- [ ] platform contract remains stable after the second pack

### Exit criteria

- adding a second specialty requires pack package work, not core architecture changes
- the platform is clearly generalized beyond Renal

---

## Phase 6 — Platform maturity and multi-specialty scale

Status: planned

### Goal

Prepare the platform for multi-specialty runtime scale and governance.

### Scope

- multi-pack rollout governance
- domain-specific policy composition
- cross-specialty events and measure sharing where appropriate
- cost and performance budgets
- governance and enterprise rollout roadmap
- audit and assurance across multiple packs

### Deliverables

- [ ] multi-pack runtime model is proven
- [ ] cross-domain governance is documented
- [ ] platform-level deployment and support model is ready
- [ ] specialty onboarding flow is measurable and repeatable

### Exit criteria

- new specialties can be onboarded using standard operating procedures
- platform administration and release process remain central and consistent

---

## Tracking structure for implementation

Each phase should be tracked with the following fields:

- Phase ID
- Goal
- Workstream
- Backend changes
- Frontend changes
- Data and contract changes
- Validation/test gate
- Risk / blocker
- Status

Suggested workstream buckets:

- Platform foundation
- FHIR / EMR integration
- Identity and access
- Event and broker flow
- UI and experience
- Knowledge and measurement
- Specialty pack model
- Release and governance

---

## Recommended execution order

1. Phase 0 — platform baseline and contracts
2. Phase 1 — shared platform hardening
3. Phase 2 — EMR certification and vendor validation
4. Phase 3 — specialty pack contract model
5. Phase 4 — Renal pack v1 on the platform
6. Phase 5 — second specialty expansion
7. Phase 6 — platform maturity and scale

This keeps the architecture honest: first stabilize the shared platform, then prove the model with Renal, then scale to more specialties.

---

## Immediate next milestones

The next concrete milestones for this repo are:

- complete the shared platform contract review
- finalize the specialty pack manifest contract
- implement the pack registry + activation flow as a real platform capability
- keep Renal as the first pack, not the entire product
- run EMR sandbox certification before enabling live vendor write paths

---

## Decision summary

The product should be built as a platform with a reusable core and installable specialty packs. Renal is the first demonstrated pack, not the platform boundary itself.

The project should not branch into separate product codebases per specialty. Instead, the platform remains shared and each specialty is added through its own pack contract and experience lens.
