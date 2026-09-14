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

Status: in progress / foundation complete

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

- [ ] Platform organization model is stable and reusable
- [ ] Platform onboarding gates are durable and test-backed
- [ ] FHIR integration contract is validated and protected by fail-closed rules
- [ ] Kafka integration contract remains durable and testable
- [ ] Pack registry can list installed packs and active lens
- [ ] Shared admin UI shell is usable across specialties

### Exit criteria

- a new specialty can install a pack without changing platform contracts
- the core platform is not custom to Renal
- the same organization, identity, and integration model works for a second specialty pack

---

## Phase 1 — Shared platform hardening

Status: planned

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

- [ ] No literal secrets in config or UI payloads
- [ ] Platform config is versioned and auditable
- [ ] Integration health status is visible in admin operators and ops views
- [ ] DLQ / replay / dead-letter recovery flow is documented and tested
- [ ] Release gate and rollback path are validated end-to-end
- [ ] Core admin and exec UIs are generic and not renal-specific

### Exit criteria

- platform health can be managed without specialty knowledge
- a new pack can be activated without editing core admin logic
- policy enforcement works across all packs consistently

---

## Phase 2 — EMR certification and actual vendor validation

Status: planned

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
- [ ] Capability mismatch cases are documented and handled by degradation ladder
- [ ] Proposal conversion is observable and reconciled
- [ ] FHIR conformance + safety checklist passes per vendor
- [ ] EMR runbook is approved by ops + clinical safety

### Exit criteria

- actual vendor sandbox results are captured in a conformance matrix
- no production route depends on unproven vendor behavior
- certification evidence is stored as part of the platform deployment record

---

## Phase 3 — Specialty pack contract model

Status: planned

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

- [ ] Pack manifest schema is complete
- [ ] Pack dependency model is defined
- [ ] Specialty ontology can be loaded without platform changes
- [ ] Specialty UI lens can render in generic shell
- [ ] Specialty workflows can register events, measures, and policies
- [ ] Shared release validation recognizes pack-level rules and gates

### Exit criteria

- a new specialty can be introduced through pack registration only
- Renal is no longer a special-case code path in the platform shell
- pack-level onboarding is self-contained and reusable

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
