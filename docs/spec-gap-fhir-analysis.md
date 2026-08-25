# Spec.md Deep Analysis — Gap, Enterprise Coverage, and FHIR Entity Support

> Analysis of `spec.md` against the current repo, an enterprise-feature coverage matrix,
> and a concrete design for **FHIR entity support** — every entity we have able to
> consume (and produce) FHIR data. All claims grounded in the code as of 2026-08-16.

---

## 1. Executive summary

`spec.md` is a strong population plan: it treats the healthcare app as a **realm-first typed
hypergraph** (63 node types + 27 hyperedge types, 19 admin screens). The substrate for most of
it **already exists** (`src/hypergraph/` has a schema-checked engine; the admin console has 26
wired views; identity/audit/tenancy/observability exist). What is missing is exactly what the
spec's own "honest gap list" calls out — **schema registration, the entity-record bridge, and
canned queries** — plus one thing the spec does **not** cover at all: **FHIR entity support**.

The single biggest architectural insight from this analysis: **`WorldEffect` is already the
write path of the world, and the 21 `EntityKind`s are already the read model.** FHIR support is
therefore not a new subsystem — it is two projections over existing machinery:

1. **In (consume):** FHIR `Bundle`/`Subscription` → `CanonicalEvent` → `EntityRecord` + `HyperNode`
   (extend the existing `src/adapters/fhir-lite.ts`, which today handles only 2 resource types).
2. **Out (produce):** every `EntityRecord` (and every effect) has a `toFhir()` projection so the
   whole world can be exported as FHIR R4 / fed to CDS-Hooks, FHIRcast, and EHR bridges.

Recommended priority: **(A)** register the typed hypergraph schema, **(B)** land the FHIR resource
model + full `EntityKind ↔ FHIR Resource` mapping + ingestion/export, **(C)** close the remaining
enterprise gaps (API versioning, rate limiting, webhooks, retention/anonymization, OpenAPI).

---

## 2. What `spec.md` mandates

| Area | Spec requirement |
|---|---|
| Journey | Realm-first: sign-in → realm → packs → sources → population → twins → behaviors → live → provenance. UI must enforce the order. |
| Nodes | 63 node types (22 substrate primitives + 41 healthcare domain) as `HyperNode`s against `HypergraphSchema`. |
| Edges | 27 hyperedge types (11 substrate + 16 domain) with named roles. Load-bearing: `pack-source-subscription`. |
| Screens | 19 admin screens, one per node/edge cluster, zero duplicates. |
| Missing code | `packs/healthcare-core/nodes.ts`, `packs/healthcare-core/edges.ts`, `entity-record` bridge, `src/hypergraph/queries/healthcare.ts`, `hh-admin-ui/src/routes/`. |
| Invariants | Every domain node carries `realmId`; edges bind the realm; every effect has an actor; memory has provenance; deny-by-default policy. |

The spec **does not** mention FHIR entity support, enterprise non-functional features (versioning,
rate limiting, retention, OpenAPI, webhooks), or a durable FHIR storage layer. This doc adds them.

---

## 3. What exists today (grounded gap table)

| Spec gap item | Exists today? | Evidence |
|---|---|---|
| Typed hypergraph engine (`HypergraphSchema.registerNode/registerEdge`, `validateNode/validateEdge`) | ✅ Yes | `src/hypergraph/types.ts`, `store.ts` (`assertNode/assertEdge`), `query.ts` (cyclic temporality), `versioning.ts`, `projections.ts`, `ledger.ts` (bitemporal MutationLedger) |
| **Production schema registration** (63 nodes / 27 edges) | ❌ **Absent** | `registerNode/registerEdge` called only in `tests/hypergraph.test.ts`. No `packs/*/nodes.ts` or `edges.ts` anywhere. |
| EntityRecord → hypergraph bridge | ❌ **Absent** | `src/realm/entity-graph.ts` is a standalone in-memory `Map<EntityUrn, EntityRecord>`; imports nothing from `src/hypergraph/`. |
| Canned `queries/` module for screens | ❌ **Absent** | `query.ts` + `projections.ts` are generic operators only. |
| Admin UI screens | ✅ 26 wired views | `admin-ui/index.html` (`view === '...'`): summary, agents, drafts, realm, presences, effects, perception, world-builder, experiences, rules, episodes, sentience, attributions, new, measures, assessments, lifecycle, research, learn, audit, liquid-whatif, liquid-train, liquid-score, nudge-ledger, durable, settings. Spec says 19 — we have more. |
| Server routes | ✅ Rich | `src/server/`: `admin-routes.ts` (~119 `/admin/*` handlers), `knowledge-routes.ts`, `settings-routes.ts`, `sql-routes.ts`, `app.ts` (`/health`, `/events`, `/ledger`, `/replay`, `/packs`). |
| Pack manifest | ✅ `DomainPack` | `src/control-plane/pack-registry.ts` (capabilities, requires, extends, version ranges). `healthcareCorePack` declares `temporal-hypergraph` capability but registers no node/edge. |
| Realm entity model | ✅ 21 `EntityKind`s | `src/realm/types.ts` (`facility, unit, patient, encounter, order, result, medication, staff, equipment, insurance, agent-run, presence, effect, org-node, physical-object, work-artifact, intent, plan, approval, cost-record, operator-directive`). Mutation path = `EffectReducer.emit()` → `apply()` → `EffectLedger` → `PerceptionRouter`. |
| FHIR ingestion | ⚠️ **Lite** | `src/adapters/fhir-lite.ts`: `mapFhirBundle()` → `CanonicalEvent[]` handles **only** `Encounter` + `Observation`. HL7v2/CDA/X12/HIE adapters parallel it. |
| FHIR measure evaluation | ✅ Real | `src/measures/evaluator.ts` (`MeasureEvaluator` over `cql-execution` + `cql-exec-fhir`), `src/liquid/cql.ts` (`buildLabsBundle` + `scoreLabs`), `POST /admin/measures/:id/evaluate`, agent tool `evaluate_measure`. |
| FHIR typed model / client / subscriptions | ❌ **Absent** | No `@types/fhir`, no `fhir-kit`, no outbound FHIR HTTP client, no FHIR `Subscription`/CDS-Hooks/FHIRcast. FHIR shapes are hand-rolled minimal subsets. |
| Terminology | ✅ Strong | `src/healthcare-core/terminology.ts` (`CodeSystem` enum: LOINC, SNOMED, RxNorm, ICD-10-CM, CPT, HCPCS, NDC…), `ValueSetRegistry`, USCDI v3/v4/v5 classes (`src/healthcare-core/uscdi.ts`), VSAC/UMLS/LOINC/RxNav adapters. |
| Identity & access | ✅ Strong | `src/identity/` (OIDC, SCIM `/scim/v2/*`, invites, break-glass, WorkOS), `AccessEvaluator` (RBAC+ABAC, deny-wins), `ActorContext` (`scopeIds`, `clearance`, `purposeOfUse`, `ensureScope`). |
| Audit | ✅ Strong | `PostgresEventStore.appendAudit`, `ScopedEventStore.appendAudit`, hash-chained `AuditLedger`, `/admin/audit-log`, `/admin/identity/audit`. |
| Observability | ✅ | `src/server/telemetry.ts` (spans/logs/metrics, OTel envelope), `src/control-plane/observability.ts`. |
| Backup / restore | ✅ | `SnapshotRegistry` + `/admin/snapshots/:id/restore`; realm snapshots (`realm_snapshots`). |
| Migrations | ✅ | Inline `MIGRATIONS` arrays (`src/server/sql/schema.ts`, `postgres-event-store.ts`, `spec-sync.ts`). |
| Feature flags / health / secrets | ✅ | `control-plane/feature-flags.ts`, `GET /health`, `control-plane/secrets.ts` + `knowledge/secrets.ts` + credential routes. |
| Enterprise gaps | ⚠️ | No API versioning (`/v1`), no rate limiting, no outbound webhooks, no data retention/purge/anonymization (ePHI DSAR), no OpenAPI docs, no CDS-Hooks/FHIRcast (see §4). |

**The twin/behavior gap in the spec:** `spec.md` grounds its §2.1 substrate primitives on
`src/twin/types.ts` and `src/behaviors/types.ts`, but **neither folder exists**. Twin and
behavior concepts are expressed today inside `src/realm/agent-runtime.ts` (agent runtime /
presence) and the `agent` specs in `packs/*`. Any `twin.*` / `behavior` / `experience` node
types must be derived from these existing sources, not from phantom files.

---

## 4. Enterprise feature coverage matrix

"Standard features an enterprise application would need," mapped to **Have / Partial / Gap**
with a concrete build action. Priority markers: **[P0]** required, **[P1]** expected,
**[P2]** roadmap.

| Domain | Capability | Status | Build action |
|---|---|---|---|
| **Identity & Access** | SSO (OIDC/SAML/WorkOS) | ✅ Have (`src/identity/oidc.ts`, `workos-adapter.ts`) | — |
| | SCIM provisioning | ✅ Have (`src/identity/scim.ts`, `/scim/v2/*`) | — |
| | RBAC + ABAC, deny-wins | ✅ Have (`AccessEvaluator`) | — |
| | Clearance tiers (public→restricted-phi) | ✅ Have (`ActorContext`, access + presence) | — |
| | Break-glass | ✅ Have (`identity/break-glass.ts`, `/admin/identity/break-glass/*`) | — |
| **Tenancy** | Org/facility scoping, `scopeIds` | ✅ Have (`ensureScope`, federation) | — |
| | Cross-org federation | ✅ Have (`src/realm/federation.ts`) | — |
| **Audit & compliance** | Hash-chained audit ledger | ✅ Have (`AuditLedger`, `appendAudit`) | — |
| | FHIR `AuditEvent` projection (HIPAA) | ❌ Gap | Add `session-event → AuditEvent` projection (§5.6) |
| | Data retention / purge / DSAR / de-identification | ❌ Gap | **[P1]** add `retention_policy` per realm/org + purge job + `anonymize` export |
| **Data lifecycle** | CRUD everywhere | ✅ Have (settings + sql + admin routes) | — |
| | Import (CSV/XLSX/FHIR) | ✅ Have (xlsx, `bootstrap-csv`, FHIR-lite) | Extend to full FHIR (§5) |
| | Export (CSV/JSON) | ✅ Have (`dataGrid()` export) | Add FHIR export (§5.6) |
| | Snapshots + restore | ✅ Have (`/admin/snapshots/:id/restore`) | — |
| | Schema migrations (portable SQL) | ✅ Have (`sql/schema.ts` MIGRATIONS) | Add `fhir_resources` table (§5.8) + flip default to Postgres `anant-health` (§8) |
| | Data versioning (bitemporal) | ✅ Have (`MutationLedger`, `versioning.ts`) | — |
| **API platform** | Versioned REST API | ❌ Gap (no `/v1`) | **[P0]** introduce `/api/v1/*` + keep `/admin/*` internal |
| | OpenAPI / docs generation | ❌ Gap | **[P1]** `@fastify/swagger` on the public surface |
| | Rate limiting / throttling | ❌ Gap | **[P1]** `@fastify/rate-limit` on public routes |
| | Webhooks / outbound events | ⚠️ Partial (in-process `NotificationBus`) | **[P1]** durable webhook outbox (`webhook_outbox` table + retry) |
| | Idempotency keys for writes | ⚠️ Partial (effects are idempotent by ledger) | Expose `Idempotency-Key` on POST APIs |
| **Observability** | Logs/metrics/traces | ✅ Have (`Telemetry`, OTel envelope) | — |
| | Health / readiness | ✅ Have (`GET /health`) | — |
| | Alerting / SLOs | ⚠️ Partial | **[P2]** alert rules on metrics |
| **Security** | Secrets management | ✅ Have (`control-plane/secrets.ts`, credential routes) | — |
| | Input validation | ✅ Have (zod + schema-checked hypergraph) | — |
| | ePHI classification on payloads | ✅ Have (`classification: 'phi'` in CanonicalEvent) | Extend to FHIR hydration |
| | CORS / transport | ✅ Have (`@fastify/cors`) | — |
| | Audit of credentials/keys | ✅ Have (SecretRegistry audited) | — |
| **Governance** | Knowledge sources + subscriptions | ✅ Have | — |
| | HITL approvals | ✅ Have (`/admin/realms/:id/approvals`) | — |
| | Policy predicates (deny-by-default) | ✅ Have (`policy-graph/`, `presence-scope`) | — |
| | Measure/eCQM evaluation | ✅ Have (cql-execution) | Extend via FHIR bundle breadth |
| **Interop** | FHIR R4 (typed model, client, ingestion, export) | ❌ Gap → **this doc §5** | Build `src/fhir/*` |
| | HL7 v2 / CDA / X12 / HIE | ✅ Have (lite adapters) | — |
| | CDS-Hooks / FHIRcast / FHIR Subscription | ❌ Gap | **[P1]** after §5 core |
| **UI/UX** | Admin console (26 views, TanStack grids) | ✅ Have | — |
| | Onboarding wizard | ✅ Have (`/admin/onboarding/*`) | — |
| | Notifications | ✅ Have (`/admin/notifications`) | — |
| **Reliability** | Feature flags | ✅ Have | — |
| | Schema validation at insert | ✅ Have (hypergraph) — once registered | — |

---

## 5. FHIR entity support — the core ask

> **Goal:** every entity the harness has can **consume** FHIR data (hydrate from FHIR resources)
> and **produce** FHIR data (export / interoperate). FHIR is treated as the **exchange format**,
> not a new truth store — the realm's `EntityRecord` + `HyperNode` remain the source of truth.

### 5.1 Principles

1. **FHIR is a projection, not a duplicate store.** The realm engine stays authoritative; FHIR
   enters through `CanonicalEvent` (same seam `fhir-lite.ts`, `hl7v2-lite.ts`, `cda-lite.ts` use)
   and exits through a `toFhir()` serializer per entity.
2. **Effects are the FHIR write path.** Every `WorldEffect` kind already models a clinical
   mutation; FHIR export is a deterministic projection of effects onto resources (see 5.3).
3. **Codes are never free-text.** All FHIR `CodeableConcept`/`Coding` values resolve through the
   existing `CodeSystem` enum + `ValueSetRegistry` (LOINC/SNOMED/RxNorm/ICD-10/CPT).
4. **PHI is stamped end-to-end.** Hydrated FHIR payloads keep `classification: 'phi'` on the
   `CanonicalEvent` and ride existing `ActorContext.clearance` + `ensureScope` gates.
5. **Identifiers bridge worlds.** Each entity keeps its FHIR `id` + a system identifier
   (MRN / NPI / OID) alongside its internal URN; the mapping is stored on the node.

### 5.2 FHIR resource model

Add a **typed, dependency-light R4 model** (no need to adopt `@types/fhir` wholesale; we already
hand-roll subsets — the goal is a *complete-for-our-entities* model):

```
src/fhir/
  types.ts          # R4 resource interfaces we consume/produce (Patient, Encounter, Observation,
                    #   ServiceRequest, MedicationRequest, Medication, Practitioner, PractitionerRole,
                    #   Organization, Location, Device, Coverage, Claim, ExplanationOfBenefit,
                    #   CarePlan, Task, DocumentReference, Communication, CommunicationRequest,
                    #   Measure, Library, ValueSet, AuditEvent, Provenance, Bundle, Subscription)
  fhir-bundle.ts    # parse/serialize Bundle, resolve references (Reference → id), paging
  client.ts         # outbound FHIR client (read/search/push) for twin-mode EHR bridge + tests
  subscription.ts   # FHIR Subscription / change-data-capture → CanonicalEvent pump
  mapping/          # one file per entity: hydrate (resource → CanonicalEvent) + serialize (entity → resource)
  routes.ts         # /api/v1/fhir/{entity}/{id} as R4, /api/v1/fhir/$export, subscription webhook
```

### 5.3 Full `EntityKind ↔ FHIR Resource` mapping (all 21 + substrate)

Every row defines how the entity **consumes** (hydrate from) and **produces** (serialize to) FHIR.

| EntityKind (node) | Primary FHIR resource(s) | Profile | Identifier(s) | Direction | Notes |
|---|---|---|---|---|---|
| `facility` | `Organization` (+ `Location` for site) | US Core Organization | NPI, OID | both | `facilityKind` → `Organization.type`; address → `Organization.address` |
| `unit` | `Location` | US Core Location | — | both | `unitKind` → `Location.physicalType`; `partOf` → facility Location |
| `patient` | `Patient` | US Core Patient | MRN (`urn:mrn`), FHIR id | both | demographics from `Patient.name/gender/birthDate`; `phiClearanceLevel` → meta.security |
| `encounter` | `Encounter` | US Core Encounter | — | both | `class/type/period`; `dispositionKind` → `hospitalization.dischargeDisposition` (already partially in `fhir-lite`) |
| `order` | `ServiceRequest`; `MedicationRequest` when kind=med | US Core ServiceRequest / MedicationRequest | — | both | `orderKind` selects resource; `priority`, `code` (LOINC/RxNorm), `requester` |
| `result` | `Observation` | US Core Observation Lab | — | both | `code/value/unit/interpretation/referenceRange`; already in `fhir-lite` as `lab.result-arrived` |
| `medication` | `MedicationRequest` + `Medication` | US Core MedicationRequest | — | both | `dose/route/frequency`; `heldAt` → `status=on-hold`; `titrationHistory` → `dosageInstruction` |
| `staff` | `Practitioner` + `PractitionerRole` | US Core Practitioner | NPI, license | both | `licenseNumber/State` → `Practitioner.qualification`; `role` + `unitAssignment` → `PractitionerRole.code/location` |
| `equipment` | `Device` (chair/vent/monitor/pump/IoT) | US Core Device | serial | both | `state` → `Device.status`/`availabilityStatus`; `assignedPatient` → `Device.patient` |
| `insurance` | `Coverage` (+ `Organization` payer, `ExplanationOfBenefit`) | US Core Coverage | policyNumber | both | `planName/policyNumber/effectiveStart/End`; `priorAuths` → `Claim` |
| `org-node` | `Organization` / `OrganizationAffiliation` / `PractitionerRole` / `HealthcareService` | US Core | — | both | by `nodeKind`: dept→Organization(partOf), team→Affiliation, role→PractitionerRole |
| `physical-object` | `Device` / `DeviceDefinition` / `Location` (room-resource) | US Core Device | serial | both | chair/station/machine/cart/room |
| `work-artifact` | `Task` (ticket/task/approval); `DocumentReference` (document); `Communication` (call) | US Core Task | — | both | `status/priority`; `subjectRef` → `Task.for` |
| `intent` | `Task` (root) | US Core Task | — | out (produce) | operator/agent goal; consumes via referenced entities |
| `plan` | `CarePlan` (+ activities → Task/ServiceRequest) | US Core CarePlan | — | out | decomposed plan-graph → CarePlan.activity |
| `approval` | `Task` (approval) + `Provenance` | US Core Task | — | out | HITL suspension → Task with requester/approver |
| `cost-record` | `MeasureReport` + `ExplanationOfBenefit` | QI-Core MeasureReport | — | out | `qualityScore/costUsd/deltaVsBaseline` → MeasureReport.group |
| `operator-directive` | `CommunicationRequest` + `Provenance` | — | — | out | NL directive → CommunicationRequest.payload |
| `agent-run` | `Provenance` / `OperationOutcome` (container) | — | — | out | derived; consumes via effects; no standalone clinical resource |
| `presence` | — (derived from `PractitionerRole` + `Location` scope) | — | — | derived | agent's body in realm; not a FHIR resource itself |
| `effect` | **the FHIR write path** (see below) | — | — | out | every effect kind projects to resource writes |
| `measure` | `Measure` | QI-Core Measure | cmsId | both | `StoredMeasure` already "subset of FHIR R4 Measure" |
| `measure-library` | `Library` | QI-Core Library | — | both | CQL/ELM attached |
| `value-set` | `ValueSet` | — | oid | both | `ValueSetRegistry` already feeds CodeService |
| `knowledge-source/artifact` | (sources may be `fhir-json`); EHR bridge uses `Subscription` | — | — | in | subscription endpoint hydrates realm |
| `session-event` | `AuditEvent` + `Provenance` | HIPAA AuditEvent | — | out | compliance projection of the Merkle ledger |

**Effect → FHIR write mapping (the write path):**

| Effect kind | Produces FHIR |
|---|---|
| `admit-patient` / discharge / transfer | `Encounter` (status: in-progress / finished / moved) + `Location.hierarchy` |
| `order-lab` / `order-imaging` / `order-procedure` / referral | `ServiceRequest` |
| `order-med` | `MedicationRequest` |
| `result-lab` | `Observation` |
| `record-vitals` | `Observation` (vitals) |
| `record-assessment` | `Observation` (questionnaire) |
| `update-care-plan` | `CarePlan` |
| `submit-claim` | `Claim` |
| `request-prior-auth` | `Claim` (pre-auth) |
| `flag-safety-event` | `Flag` / `Observation` |
| `create-work-artifact` | `Task` |
| `operator-directive` | `CommunicationRequest` |

### 5.4 The consumption contract (how entities "consume FHIR")

Every entity gets a pair of pure functions:

```ts
// Hydrate: FHIR resource(s) → canonical events the realm already understands.
hydrate(resource: FhirResource, ctx: FhirCtx): CanonicalEvent[]
// Serialize: current entity record (+ hypernode) → FHIR resource(s).
serialize(rec: EntityRecord, ctx: FhirCtx): FhirResource | FhirResource[]
```

Registration lives on the entity's node schema so the hypergraph and the FHIR layer stay in sync:

```ts
// proposed — packs/healthcare-core/fhir.ts
export const ENTITY_FHIR: Record<EntityKind, { resource: string[]; hydrate; serialize }> = { ... }
```

This is what "all entities can consume FHIR data" means concretely: a `patient` consumes a
`Patient` resource; a `facility` consumes an `Organization`; a `work-artifact` consumes a
`Task`; an `effect` *is* the producer of resource writes. Entities without a direct clinical
resource (`agent-run`, `presence`, `intent`, `approval`, `cost-record`, `operator-directive`)
consume FHIR transitively (through the entities they reference) and produce FHIR where a
standard exists (Task / CarePlan / MeasureReport / AuditEvent / Provenance).

### 5.5 Ingestion pipeline (inbound)

```
FHIR server / EHR   ──►  Subscription push or poll   ──►  src/fhir/subscription.ts
        │                                                    │
        ▼                                                    ▼
  FHIR Bundle  ──►  src/fhir/mapping/*.hydrate()  ──►  CanonicalEvent[]  (classification:'phi')
                                                          │
                                          src/adapters (same seam as hl7v2/cda/x12)
                                                          ▼
                                          EffectReducer → EntityRecord patch + HyperNode upsert
```

- Extend `mapFhirBundle` (today: 2 resource types) → dispatch by `resourceType` through the
  `ENTITY_FHIR` hydrate table (today: all 21 kinds).
- Store the raw resource + its provenance on the node (`fhirJson`, `fhirSourceId`, `fhirVersion`)
  so nothing is lost and re-syncs are idempotent (`fhirVersion`/`lastUpdated` compare).

### 5.6 Export / interop (outbound)

- `GET /api/v1/fhir/{kind}/{id}` → serialized R4 resource (drill into any entity as FHIR).
- `GET /api/v1/fhir/$export` (grouped by patient/realm) → `Bundle` — powers EHR export, audits,
  and the admin "export this realm as FHIR" button.
- `POST /api/v1/fhir/cds-hooks` (P1): CDS-Hooks `{prefetch, context, hook}` → evaluated
  `cql-execution` → `cards` (reuses `MeasureEvaluator`).
- `session-event → AuditEvent/Provenance` projection for HIPAA audit trails.
- Admin UI: add a **FHIR** panel — "Ingest bundle", "EHR bridge status" (twin mode), per-entity
  "View as FHIR", and a "Realm → FHIR export" action.

### 5.7 Terminology + profiles

- Resolve every FHIR `Coding` through `src/healthcare-core/terminology.ts` (`CodeSystem`) +
  `ValueSetRegistry`; unknown system → `unresolved` (same pattern as `value-set.source`).
- Map entity kinds to US Core / QI-Core / USCDI profiles via the existing
  `src/healthcare-core/uscdi.ts` (USCDI v3/v4/v5 classes already bound to profile URLs).

### 5.8 Durable storage + PHI

- Add a portable table to `src/server/sql/schema.ts`:

```sql
CREATE TABLE IF NOT EXISTS fhir_resources (
  id TEXT PRIMARY KEY,             -- internal URN
  realm_id TEXT NOT NULL,
  entity_kind TEXT NOT NULL,       -- EntityKind
  resource_type TEXT NOT NULL,     -- Patient / Observation / ...
  fhir_id TEXT,                    -- upstream FHIR id
  version_id TEXT,                 -- upstream versionId / lastUpdated for idempotent re-sync
  resource_json TEXT NOT NULL,     -- raw R4 resource (already PHI-classified)
  source_id TEXT,                  -- provenance: adapter/source
  ingested_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fhir_resources_realm ON fhir_resources (realm_id, entity_kind);
```

- PHI: resources carry `classification:'phi'` through ingestion; reads go through
  `ensureScope` + `ActorContext.clearance`; the admin FHIR views hide fields below the
  actor's clearance (SSN, MRN masked unless `restricted-phi`).

### 5.9 What to build (files, grounded in repo patterns)

| # | File | Contents |
|---|---|---|
| 1 | `src/fhir/types.ts` | typed R4 interfaces for the resources in §5.2 |
| 2 | `src/fhir/fhir-bundle.ts` | Bundle parse/serialize + reference resolution |
| 3 | `src/fhir/client.ts` | outbound FHIR HTTP client (read/search/push; injected base + auth) |
| 4 | `src/fhir/mapping/{entity}.ts` | `hydrate` + `serialize` per entity (§5.3) |
| 5 | `src/fhir/subscription.ts` | Subscription/CDC → `CanonicalEvent` pump |
| 6 | `src/fhir/routes.ts` | `/api/v1/fhir/*`, `$export`, CDS-Hooks (registered in `app.ts` like `settings-routes`) |
| 7 | `src/server/sql/schema.ts` | add `fhir_resources` + index |
| 8 | `src/fhir/index.ts` | `ENTITY_FHIR` registry, exports |
| 9 | `admin-ui` | FHIR panel + "view as FHIR" + export buttons |
| 10 | `tests/fhir-*.test.ts` | hydrate/serialize round-trips for every entity; idempotent re-sync |

---

## 6. Phased build plan

**Phase A — Populate the hypergraph (the spec's own gap list).** [P0]
- `packs/healthcare-core/nodes.ts` + `edges.ts` registering the 21 domain kinds (+ substrate
  nodes derived from real sources — note `src/twin`/`src/behaviors` don't exist; derive from
  `agent-runtime.ts` + agent specs). `src/realm/entity-record.ts` bridge so
  `EffectReducer.apply()` also upserts `HyperNode`/`HyperEdge`. Canned queries
  `src/hypergraph/queries/healthcare.ts` backing the admin screens.
- Gate: `hypergraph.test.ts`-style validation runs against production registrations; invariant
  tests (realmId required, effect-attribution, no cross-realm edges).

**Phase B — FHIR entity support (this doc §5).** [P0]
- `src/fhir/*` typed model, hydrate/serialize for all 21 kinds, `fhir_resources` table,
  `mapFhirBundle` extension (2 → 21 resource types), export routes, admin FHIR panel.
- Gate: round-trip tests per entity; a synthetic FHIR `Bundle` (patients + encounters +
  observations + orders + meds) hydrates a realm and exports byte-stable.

**Phase C — Enterprise hardening (§4 gaps).** [P1]
- `/api/v1/*` public surface + `@fastify/swagger` + `@fastify/rate-limit`; webhook outbox;
  retention/purge/anonymize jobs; `AuditEvent` projection; flip the `SqlStore` default to
  Postgres `anant-health` (§8).

**Phase D — Interop extras.** [P2]
- CDS-Hooks + FHIRcast + Subscription webhook; alerting/SLOs.

---

## 7. Decisions / open questions

1. **Truth store:** FHIR as projection (recommended) vs. FHIR as source-of-truth (would invert
   the realm engine). Recommended: projection, keep `EntityRecord` authoritative.
2. **Typed FHIR:** adopt `@types/fhir`/`fhir-kit` vs. keep hand-rolled `src/fhir/types.ts`.
   Recommended: hand-rolled for the ~20 resources we use (consistent with existing `fhir-lite`
   + `StoredMeasure` philosophy; avoids a heavy dep).
3. **Twin/behavior grounding:** spec references missing `src/twin`/`src/behaviors` — derive
   substrate node types from `agent-runtime.ts` + packs, and update `spec.md` §2.1 accordingly.
4. **Effect → FHIR fidelity:** effects are deterministic but some carry no FHIR-typed payload
   today; the mapping table (§5.3) is the contract to add payload fields where needed.
5. **Where FHIR lives:** new `src/fhir/` module (recommended) vs. extending `src/adapters/`.
   Recommended: `src/fhir/` for the model + client; keep `mapFhirBundle` dispatch in adapters.

---

## 8. SQLite → Postgres migration (local `anant-health`) — [P0]

**Why move off SQLite:** the `SqlDb` seam keeps SQLite for local/dev/tests, but production and
multi-realm concurrency need Postgres — and the FHIR layer (§5.8) plus enterprise features
(retention, webhook outbox, audit projections) add writes that want a real server. The design
already makes this a **zero-code swap**: the store writes only portable SQL (`?` placeholders,
TEXT/REAL columns); `PostgresSqlDb` rewrites `?` → `$1..$n`; nothing in `SqlStore` changes.

**Target (local dev):**

| | |
|---|---|
| Host / port | `localhost:5432` (native Postgres, accepting connections) |
| Database | `anant-health` |
| User / password | `postgres` / `postgres` |
| DSN | `postgres://postgres:postgres@localhost:5432/anant-health` |
| Env | `HH_STORAGE=postgres` + `HH_DATABASE_URL=postgres://postgres:postgres@localhost:5432/anant-health` |

**Done + verified (2026-08-16):**
1. `CREATE DATABASE "anant-health"` on `localhost:5432` (confirmed via `pg_database`).
2. `HH_STORAGE=postgres HH_DATABASE_URL='postgres://postgres:postgres@localhost:5432/anant-health'`
   → `openSqlStore()` → `applyMigrations()` applied all portable migrations; a
   `saveFacility` / `listFacilities` / `deleteFacility` round-trip succeeded with
   `dialect=postgres`.

**Run the dev profile against Postgres:**

```bash
HH_STORAGE=postgres HH_DATABASE_URL='postgres://postgres:postgres@localhost:5432/anant-health' npm run dev
```

Tests keep SQLite (`NODE_ENV=test` → `:memory:`), so the suite stays hermetic and fast.

**Notes / decisions**
- The dev event store (`src/server/dev.ts`) uses in-memory + InProcessJobBus independently of
  `SqlStore`; flipping `SqlStore` to Postgres does not change that. Production bootstrap already
  requires Postgres + Redis.
- Keep `HH_STORAGE=sqlite` as the zero-config default; add `HH_STORAGE=postgres` in env for the
  persistent `anant-health` path (documented in `.env.example`).
- The `fhir_resources` table (§5.8) and future webhook/retention tables are appended to the same
  portable `MIGRATIONS` array and land in both dialects automatically.
