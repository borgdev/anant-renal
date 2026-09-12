# HGFS Simplex Mapping — Deep Analysis

> **Purpose.** Design how the Anant Harness domain maps onto the **HGFS hypergraph**
> so every durable fact, relationship and lifecycle becomes a queryable simplex.
> **HGFS is the single system of record — Postgres is removed.** HGFS is addressed
> through four surfaces (SQL for the relational view, HGQL/REST/gRPC for the
> simplicial view) and provides user management + RBAC to reuse.
>
> **Date:** 2026-09-01 · **Scope:** all simplices we have to manage.
>
> **Supersedes:** the earlier "Postgres now, HGFS later" note in `docs/renal-swarm-mapping.md`.

---

## 1. HGFS simplex model & conventions

### 1.1 Simplex arities

HGFS exposes five simplex kinds. A simplex of arity `k` relates `k+1` participants.

| Simplex | Arity | Meaning | Best for |
|---|---|---|---|
| **vertex** | 0 | A standalone entity | Every durable entity (org, patient, episode, release, finding, submission, …) |
| **edge** | 1 | Binary relation | `patient → facility`, `episode → patient`, `finding → release` |
| **hyperedge** | n | N-way relation | Multi-approver approvals, multi-cell insight synthesis, role bindings |
| **triangle** | 2 | Ternary relation | 3-way accountability: *who decided what, where* |
| **polygon** | n | N-simplex closure | A closed-loop evidence chain, an immutable dossier, a cohort snapshot |

### 1.2 Common fields (every simplex)

- **`label`** — the *type* discriminator (we namespace as `anant.<domain>.<entity>`, e.g. `anant.episode`).
- **`external_id`** — the *business dedup key* (the harness id: episode id, release id, event id, workspace doc id). Writes are **idempotent by `(tenant, label, external_id)`**.
- **`properties`** — a **JSON** blob carrying the entity payload (mirrors the workspace `entityJson` / event `payload`).
- **delta history** — every **vertex** retains an append-only delta chain; each delta is a transition/version (state change, belief update, re-scoring). Immutable facts (events, audit, dossier) keep a single delta.
- **`X-Tenant-ID`** — every write/read is tenant-scoped (each tenant gets its own dataset / namespace; never mixed).

### 1.3 Reuse of HGFS platform services (do NOT re-model)

- **User management** — HGFS principals (users, groups, service identities) are reused as-is. The harness maps its local users/roles onto HGFS principals.
- **RBAC / "janziber-style" recab** — HGFS's relationship/attribute-based access control is reused to gate simplex reads/writes by role + scope. The harness does **not** store authorization rules in its own tables; it registers scope vertices and lets HGFS evaluate `(principal, role, scope)` against the simplicial graph.

### 1.4 Naming + tenant conventions

- Labels: `anant.<layer>.<entity>` where `<layer>` ∈ {`org`,`world`,`care`,`event`,`swarm`,`govern`,`cms`,`exec`,`pack`,`intel`,`ops`,`clinical`,`knowledge`}.
- `external_id`: bare business id (e.g. `out:ep-…`, `rel-2026.08.5`, `evt:…`, `dlq:<outboxId>`, `sub:…`). Never tenant-prefixed (tenant is a header/dataset, not part of the key).
- Where the harness already namespaces (workspace `kind`), the `label` is `anant.<kind>`; the `external_id` is the doc `id`.

### 1.5 Source of truth — HGFS **is** the store (no Postgres)

HGFS replaces Postgres entirely and is addressed through four surfaces:

- **SQL** — the relational view. The harness's existing dialect-neutral DDL
  (`src/server/sql/schema.ts` MIGRATIONS + the event-ledger DDL) runs on HGFS SQL
  unchanged, so the OLTP read/write path (events, outbox, workspace, idempotency,
  audit, patients/facilities/units) maps 1:1.
- **HGQL / REST / gRPC** — the simplicial view. Vertices, edges, hyperedges,
  triangles, polygons and **vertex delta history** are first-class; every entity
  and relationship in this doc is written/queried here.
- **RBAC + user management** — reused from HGFS (no local auth tables).

Because both views sit on the **same store**, the relational rows and the
simplices are the *same facts*: a write through SQL is immediately queryable as a
simplex, and vice versa. **SQLite remains only as a local in-memory dev/test
fallback** (`HH_STORAGE=sqlite`); production storage is HGFS.

---

## 2. The complete simplex catalog

Legend — **V** vertex, **E** edge, **H** hyperedge, **T** triangle, **P** polygon.
`Δ` = vertex delta history is meaningful (state machine); `−` = append-only/immutable.

### A. Tenant, scope & identity *(reuse HGFS)*

| Label | Simplex | external_id | Key properties | Δ |
|---|---|---|---|---|
| `anant.tenant` | V | tenant id | env class (reference/demo/prod), region, retentionDays | − |
| `anant.org.scope` | V | scope id (`scope:…`) | level (enterprise→division→market→facility→unit), label, orgId | Δ |
| `anant.role.binding` | H | principal+role+scope | role, scopeId, purposeOfUse, clearance | − |
| `anant.principal` | V | HGFS user id | displayName, orgId, roles[] | Δ |

> User mgmt + RBAC are **reused from HGFS** (see §1.3). The harness only materializes `anant.org.scope` vertices (the scopePath) and `anant.role.binding` hyperedges so HGFS RBAC can evaluate scope-qualified access.

### B. Organization graph & operating model

| Label | Simplex | external_id | Key properties | Δ |
|---|---|---|---|---|
| `anant.org` | V | org id | operatingModel (provider/payer/hybrid), displayName, region, timezone, **synthetic** flag | Δ |
| `anant.org.scope` | V | scope id | level, label, facilities, patients | Δ |
| `anant.topic.plan` | V | topic-plan id | defaultOutputTopic, agentDlqTopic, entries[] | Δ |
| `anant.onboarding` | V | onboarding id | currentStep, completedSteps, gates | Δ |
| `anant.org.reports-to` | E | scope → parent scope | level delta | − |
| `anant.org.hierarchy` | P | org id | ordered scope ids (enterprise→unit) | − |
| `anant.org.release-binding` | T | (scope, release, org) | which release is active for which scope | Δ |

### C. World: realms, facilities, units, patients, presences, stations

| Label | Simplex | external_id | Key properties | Δ |
|---|---|---|---|---|
| `anant.realm` | V | realm id | mode (sim/live), counts, realmAt | Δ |
| `anant.facility` | V | facility id / CCN | kind (outpatient-dialysis…), region, capacity, synthetic | Δ |
| `anant.unit` | V | unit id | station, current state, assigned patient | Δ |
| `anant.patient` | V | patient id / urn | risk profile, modality, demographics (synthetic), pharma flags | Δ |
| `anant.presence` | V | presence id | device/sim presence, presences count | Δ |
| `anant.world.has-facility` | E | realm → facility | — | − |
| `anant.facility.has-unit` | E | facility → unit | — | − |
| `anant.unit.cares-for` | E | unit → patient | — | Δ |
| `anant.world.snapshot` | P | realm id + ts | the whole realm topology (facilities+units+patients+presences) at a point in time | − |

### D. Canonical events & ledger

| Label | Simplex | external_id | Key properties | Δ |
|---|---|---|---|---|
| `anant.event` | V | event id | type, occurredAt, scopeId, subjectId, facilityId, payload, provenance, classification | − |
| `anant.event.about` | E | event → patient | subject | − |
| `anant.event.at` | E | event → facility | facility | − |
| `anant.event.stream` | P | batch id | ordered event ids + window (from/to) — the replay batch | − |

> Events are immutable: **no delta**. `external_id = event id` makes ingest idempotent (dedup on re-delivery), which is exactly what the outbox/idempotency-key machinery needs.

### E. Swarm: cells, insights, NBAs, decisions, commands, acks

| Label | Simplex | external_id | Key properties | Δ |
|---|---|---|---|---|
| `anant.cell` | V | cell id | manifest, allowedActions, role, domain | − |
| `anant.insight` | V | insight id | cross-domain synthesis, belief, cells[], kpis | Δ |
| `anant.nba` | V | nba id | action, value, confidence (bp), approvalClass, ownerRole, scope | Δ |
| `anant.nba.decision` | V | decision id | nbaId, decision (approve/reject/escalate), actor, idempotencyKey | − |
| `anant.command` | V | command id | action, episodeId, actor, at | − |
| `anant.ack` | V | ack id | episodeId, verified, met, at | − |
| `anant.cell.emits` | E | cell → insight | contribution weight | − |
| `anant.insight.ranks` | E | insight → nba | rank | Δ |
| `anant.nba.for` | E | nba → episode | scope | − |
| `anant.insight.synthesis` | H | insight id | all contributing cell ids — cross-domain provenance | − |
| `anant.decision.trial` | T | (nba, decision, actor) | who decided what on which nba | − |

### F. Outcome episodes — *delta-rich core*

| Label | Simplex | external_id | Key properties | Δ |
|---|---|---|---|---|
| `anant.episode` | V | episode id (`out:…`) | kind, subjectId, facilityId, scope, **state** (Coordinating/Verifying/Resolved), approvalClass, measures, source lineage | **Δ** |
| `anant.episode.about` | E | episode → patient | — | − |
| `anant.episode.at` | E | episode → facility | — | − |
| `anant.episode.for` | E | episode → measure | measureId | − |
| `anant.episode.approvals` | H | episode id | all approver/actor ids (multi-approval episodes) | Δ |
| `anant.episode.trial` | T | (episode, actor/role, facility) | who acted where on this episode | − |
| `anant.care.loop` | P | episode id | closed loop: events → insight → nba → decision → command → ack → verify(met) → Resolved | − |

> **Delta semantics:** each transition `opened → Coordinating → (command) → acknowledged → Verifying → verify(met) → Resolved` is a vertex **delta** on `anant.episode`. HGFS can then answer *"what is the full lifecycle trace of episode X?"* and *"which episodes touched facility F in scope S under the current config release?"* by replaying deltas.

### G. Configuration releases — *delta-rich, immutable dossier*

| Label | Simplex | external_id | Key properties | Δ |
|---|---|---|---|---|
| `anant.release` | V | release id | version, **status** (draft/validated/approved/canary/active/rolledback/superseded/failed), gates, canaryScopes, canaryResult | **Δ** |
| `anant.release.gate` | T | (release, gate, finding) | gate name (Schema/Green/Red/Integration/Promotion), passed, observed | Δ |
| `anant.release.approval` | H | release id | all approvers (dual Class-D style) | Δ |
| `anant.release.dossier` | P | release id | immutable: contentHash, approvals[], gates[], findingsBlocking, canary result, runtimeHealth | − |
| `anant.release.rollback` | E | release → superseded release | — | − |

### H. Assurance findings & green/red runs — *delta-rich*

| Label | Simplex | external_id | Key properties | Δ |
|---|---|---|---|---|
| `anant.finding` | V | finding id | severity, **status** (open→assigned→remediating→retest-…→independently-reviewed→closed), disposition, owner, remediation, retestRunId, reviewedBy, evidenceHash, releaseId | **Δ** |
| `anant.green.run` | V | run id | 8 gate results | − |
| `anant.red.run` | V | run id | scenario results vs live policy | − |
| `anant.finding.blocks` | E | finding → release | blocking severity | Δ |
| `anant.finding.on` | E | finding → scenario | rt-00x | − |
| `anant.finding.trial` | T | (finding, release, scenario) | how the finding surfaced | − |

### I. CMS / EQRS submissions (Journey K) — *delta-rich*

| Label | Simplex | external_id | Key properties | Δ |
|---|---|---|---|---|
| `anant.submission` | V | submission id | measureId, **status** (draft/validated/approved/submitted/reconciled/rejected), resultsIncluded, manifestHash, evidenceWindow, approvals[], transmissionBlocked, receipt | **Δ** |
| `anant.submission.measure` | E | submission → measure | — | − |
| `anant.submission.approvals` | H | submission id | dual Class-D approvers | Δ |
| `anant.submission.gate` | T | (submission, connector, credentials) | certified connector + credentials present? | Δ |
| `anant.submission.dossier` | P | submission id | contentHash + evidenceWindow + approvals + checks + receipt | − |

### J. Delegations & executive outcomes (Journey N) — *delta-rich*

| Label | Simplex | external_id | Key properties | Δ |
|---|---|---|---|---|
| `anant.delegation` | V | delegation id | title, reason, owner, sla, **status** (open/in-progress/done), outcome{verified,value,note}, delegatedBy, doneAt | **Δ** |
| `anant.delegation.sponsor` | E | delegation → user | sponsor | − |
| `anant.delegation.owner` | E | delegation → user | owner | − |
| `anant.delegation.trial` | T | (delegation, sponsor, owner) | accountability triple | − |
| `anant.outcome.rollup` | V | period | verifiedEpisodes, byKind, realizedValue, met | Δ |
| `anant.value.ledger` | P | period id | verified delegations + resolved episodes + realized value | − |

### K. Pack registry & activation

| Label | Simplex | external_id | Key properties | Δ |
|---|---|---|---|---|
| `anant.pack` | V | pack id | version, extends[], appliesTo, capabilities[], cmsUniverse[], requiredControls[], lens | − |
| `anant.pack.activation` | V | pack id | active, at, by | Δ |
| `anant.pack.extends` | E | pack → base pack | versionRange | − |
| `anant.pack.lens` | E | pack → org lens | lens (provider/payer/hybrid) | Δ |
| `anant.pack.catalog` | H | catalog id | all installed pack ids | − |

### L. Canvases / notes / what-if (Journey O)

| Label | Simplex | external_id | Key properties | Δ |
|---|---|---|---|---|
| `anant.canvas` | V | canvas id | title, version, notes[], citations | Δ |
| `anant.note` | V | note id | body, by, citation (e.g. `what-if:threshold=0.65`) | Δ |
| `anant.note.on` | E | note → canvas | — | − |
| `anant.canvas.bound` | H | canvas id | bound graph node ids | − |
| `anant.what-if` | P | canvas id + threshold | isolated replay: episodesSurfaced, reviewsRequired, estimatedValue, treatmentsProtected | − |

### M. DLQ / bridge / outbox — *delta-rich*

| Label | Simplex | external_id | Key properties | Δ |
|---|---|---|---|---|
| `anant.dlq.incident` | V | outboxId | topic, partitionKey, idempotencyKey, incident, state | **Δ** |
| `anant.dlq.remediation` | V | remediation id | outboxId, owner, status (acknowledged/replayed), reason, replayId | Δ |
| `anant.dlq.topic` | E | incident → topic | — | − |
| `anant.replay.trial` | T | (incident, outbox row, broker) | idempotent replay (original business key) | − |

### N. Clinical: measures, results, labs, cases (ui + clinical)

| Label | Simplex | external_id | Key properties | Δ |
|---|---|---|---|---|
| `anant.measure` | V | measure id | program, authority, effective window, value-set | − |
| `anant.measure.result` | V | measure+period+facility | **score, numerator, denominator**, period, facilityId | **Δ** |
| `anant.lab` | V | lab id | loinc, value, unit, patientId, observedAt | Δ |
| `anant.lab.review` | V | lab id | prioritized queue position, flags | Δ |
| `anant.case` | V | case id | patientId, facilityId, **status**, reason | **Δ** |
| `anant.measure.evaluated-for` | T | (measure, facility, period) | reporting trial | Δ |
| `anant.case.about` | E | case → patient | — | − |

### O. Knowledge, authority & audit

| Label | Simplex | external_id | Key properties | Δ |
|---|---|---|---|---|
| `anant.knowledge.note` | V | note id | body, comments, sourceIds | Δ |
| `anant.authority.source` | V | source id | title, authority, status, effectiveFrom, refresh | Δ |
| `anant.policy` | V | policy id | defaultDecision, thresholds (bp), externalWrites | Δ |
| `anant.audit` | V | audit entry id | sequence, action, actorId, scopeId, traceId, payload, **hash** | − |
| `anant.audit.chain` | P | audit head | ordered entry ids + prev-hash linkage (hash-chained ledger) | − |
| `anant.audit.actor` | E | audit → principal | actor | − |

---

## 3. Relationship topology — the shapes we manage

### 3.1 Edges (binary)

| Edge label | A → B | Meaning |
|---|---|---|
| `anant.org.reports-to` | scope → parent scope | org hierarchy |
| `anant.world.has-facility` / `anant.facility.has-unit` / `anant.unit.cares-for` | realm→facility→unit→patient | world containment + care |
| `anant.event.about` / `anant.event.at` | event → patient / facility | event attribution |
| `anant.cell.emits` → insight → nba → episode | chain | swarm provenance |
| `anant.episode.about/at/for` | episode → patient/facility/measure | episode attribution |
| `anant.finding.blocks` / `anant.finding.on` | finding → release / scenario | assurance linkage |
| `anant.submission.measure` | submission → measure | submission subject |
| `anant.delegation.sponsor/owner` | delegation → user | delegation accountability |
| `anant.pack.extends` | pack → base pack | pack dependency |
| `anant.dlq.topic`, `anant.note.on`, `anant.audit.actor` | … | misc |

### 3.2 Hyperedges (n-way)

| Hyperedge | Participants | Use |
|---|---|---|
| `anant.role.binding` | (principal, role, scope) | RBAC — reused from HGFS |
| `anant.insight.synthesis` | (insight, cell₁…cellₙ) | cross-domain insight provenance |
| `anant.episode.approvals` | (episode, actor₁…actorₙ) | multi-approval episodes |
| `anant.release.approval` | (release, approver₁…approverₙ) | release approvals |
| `anant.submission.approvals` | (submission, approver₁, approver₂) | dual Class-D approval |
| `anant.pack.catalog` | (catalog, pack₁…packₙ) | installed pack set |
| `anant.canvas.bound` | (canvas, node₁…nodeₙ) | canvas-bound graph nodes |

### 3.3 Triangles (ternary — 3-way accountability/attribution)

| Triangle | (a, b, c) | Meaning |
|---|---|---|
| `anant.org.release-binding` | (scope, release, org) | which release governs which scope |
| `anant.decision.trial` | (nba, decision, actor) | who decided what on which nba |
| `anant.episode.trial` | (episode, actor/role, facility) | who acted where on an episode |
| `anant.release.gate` | (release, gate, finding) | gate outcome with blocking evidence |
| `anant.finding.trial` | (finding, release, scenario) | how a finding surfaced |
| `anant.submission.gate` | (submission, connector, credentials) | transmission gate |
| `anant.delegation.trial` | (delegation, sponsor, owner) | delegation accountability |
| `anant.measure.evaluated-for` | (measure, facility, period) | reporting trial |
| `anant.replay.trial` | (incident, outbox row, broker) | idempotent replay |

### 3.4 Polygons (n-simplex closures — evidence/cohort snapshots)

| Polygon | Closed set | Meaning |
|---|---|---|
| `anant.org.hierarchy` | scope chain | the org hierarchy as a polygon |
| `anant.world.snapshot` | realm topology | point-in-time world state |
| `anant.event.stream` | ordered batch | the replay batch (input set) |
| `anant.care.loop` | events→insight→nba→decision→command→ack→verify | the closed loop (audit/replay package) |
| `anant.release.dossier` | approvals+gates+findings+canary | immutable release evidence |
| `anant.submission.dossier` | evidence window + approvals + checks + receipt | immutable submission evidence |
| `anant.value.ledger` | verified delegations + resolved episodes | realized value for a period |
| `anant.what-if` | isolated replay at a threshold | cited simulation |
| `anant.audit.chain` | ordered entries + prev-hash | tamper-evident audit chain |

---

## 4. Delta-history matrix (which vertices are delta-rich)

A **vertex delta** records one state transition; HGFS keeps the append-only history so the harness never loses the "why/how it got here".

| Vertex | Deltas recorded |
|---|---|
| `anant.episode` | opened → Coordinating → command → acknowledged → Verifying → verify(met) → Resolved |
| `anant.release` | draft → validated → approved → canary → active / rolledback / superseded / failed |
| `anant.finding` | open → assigned → remediating → retest-passed/failed → independently-reviewed → closed (+ disposition) |
| `anant.submission` | draft → validated → approved (1st/2nd Class-D) → submitted → reconciled / rejected (+ receipt) |
| `anant.delegation` | open → in-progress → done (+ verified outcome) |
| `anant.dlq.incident` | incident → acknowledged → replayed → cleared |
| `anant.pack.activation` | inactive → active → deactivated |
| `anant.measure.result` | per reporting period re-score (numerator/denominator/score) |
| `anant.case` | status transitions (missed → reviewed → resolved) |
| `anant.insight` / `anant.nba` | belief / confidence updates |

**Append-only (no meaningful delta):** `anant.event`, `anant.audit`, `anant.release.dossier`, `anant.submission.dossier`, `anant.command`, `anant.ack`, `anant.nba.decision`.

---

## 5. Running on HGFS — storage replacement (Postgres removed)

HGFS is the **only** production store. The harness has two clean seams for this.

### 5.1 Storage seams

1. **`SqlStore` (durable workspace, outbox, audit_events, patients/facilities/units, idempotency).**
   `src/server/sql/sql-store.ts` is **dialect-agnostic** over the `SqlDb` interface
   (`dialect`, `run`, `all`, `exec`). Today `buildSqlDb()` returns `SqliteSqlDb` or
   `PostgresSqlDb` from `HH_STORAGE`. Add **`HgfsSqlDb implements SqlDb`** that
   forwards `run/all/exec` to HGFS **SQL** (via REST or gRPC) and set
   `HH_STORAGE=hgfs`. Every `MIGRATIONS` statement and every store method runs on
   HGFS unchanged — this is the whole durable config layer (workspace kinds,
   releases, findings, submissions, delegations, packs, DLQ, topics, org, …).
2. **`PostgresEventStore` (canonical event ledger, mutation ledger, audit chain,
   agent runs, metering).** `src/server/postgres-event-store.ts` is Postgres-specific
   (`pg` Pool, `__schema__.*` DDL). Swap it for **`HgfsEventStore`** implementing
   the same interface over HGFS (same DDL via HGFS SQL, or the simplicial event
   API). `buildApp(deps.store)` and the routes that read `store` do not change.

### 5.2 What goes away

- `docker-compose.yml` `anant-health-postgres` service + `anant-health-pgdata` volume.
- `HH_DATABASE_URL` / `HH_DATABASE_SCHEMA` env + the `pg` `Pool` in `bootstrap.ts`.
- `HH_STORAGE=postgres` branch in `src/server/sql/index.ts` (kept only as `sqlite` dev fallback).
- `PostgresSqlDb` (or re-pointed to HGFS SQL) and `PostgresEventStore` (replaced by `HgfsEventStore`).

### 5.3 New config

- `HH_HGFS_URL` (REST/gRPC endpoint), `HH_HGFS_TENANT` (`X-Tenant-ID`), HGFS credentials,
  and `HH_STORAGE=hgfs` / `HH_EVENTSTORE=hgfs`.
- `docker-compose.yml` `anant-health-hgfs` service (the HGFS substrate) in place of postgres.

### 5.4 Simplex write path (on top of the store)

Every mutation also upserts the corresponding simplex (or emits a **delta**) via
HGFS REST/gRPC, idempotent by `(X-Tenant-ID, label, external_id)`:

- vertex/edge/hyperedge/triangle/polygon upsert on transition (episode/finding/
  release/submission/delegation), immutable upsert for facts (event/audit/dossier).
- `external_id` = business id → outbox retries + replay cannot duplicate
  (matches the existing `idempotency_key`/`row:<id>` semantics).

### 5.5 RBAC reuse

Register `anant.org.scope` vertices + `anant.role.binding` hyperedges; HGFS RBAC
evaluates scope-qualified reads (facility operators see only their facility's
episodes/triangles). No local authorization tables.

### 5.6 Read patterns (HGQL)

- *Accountability:* `anant.episode.trial` — who approved what, where.
- *Traceability:* replay `anant.episode` deltas or traverse `anant.care.loop`.
- *Impact:* `anant.finding.blocks` → all releases; `anant.pack.extends` → affected packs.
- *Lineage:* `anant.insight.synthesis` + `anant.event.stream` → source-to-outcome.
- *Audit:* `anant.audit.chain` polygon → tamper-evident verification.

### 5.7 Migration order

1. `HgfsSqlDb` behind `HH_STORAGE=hgfs` → durable workspace/outbox/audit on HGFS SQL.
2. `HgfsEventStore` → canonical events/ledger on HGFS.
3. Simplex projector (write path) → vertices/edges/hyperedges/triangles/polygons + deltas.
4. RBAC wiring (scopes + role bindings) → gate reads.
5. Drop Postgres: compose, env, pool, postgres-only adapters.
6. Backfill projector replays any existing SQLite/Postgres data idempotently by `external_id`.

---

## 6. Open questions / decisions

1. **Vertex vs. event-only:** should every canonical event be a vertex, or only *resolved facts* (episodes, findings, measure results)? Recommend **vertex per event** for traceability but with no delta (cheap, append-only).
2. **Polygon immutability:** dossiers / care loops / audit chains should be **write-once** (no mutation) — confirm HGFS supports immutable polygon deltas or a `sealed` property.
3. **Delta retention:** episodes/findings/submissions can accumulate many deltas; define retention/pruning (keep full for active, compact to terminal after N periods).
4. **Tenant dataset layout:** one HGFS dataset per tenant (`X-Tenant-ID`) vs a shared dataset with a tenant property. Prefer per-tenant dataset for isolation + RBAC.
5. **Who owns the mapping** (harness entity → simplex) so the projector stays in sync as workspace kinds grow.
6. **SQL dialect on HGFS:** confirm HGFS SQL accepts the dialect-neutral DDL as-is (TEXT PKs, ISO timestamps, JSON-as-TEXT) or whether `HgfsSqlDb` must translate `?`→`$n` placeholders (we already have `rewritePlaceholders` for this).
7. **gRPC vs REST for the simplex writer:** pick the transport for the write path (gRPC for throughput, REST for simplicity) — `@grpc/grpc-js` is already in the dependency tree.
