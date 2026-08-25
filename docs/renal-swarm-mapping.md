# Renal Swarm Intelligence — Codebase Mapping

> The `healthcare-harness` implementation, mapped to the **Renal Swarm Intelligence**
> reference architecture (governed agentic outcome harness, renal-care vertical).
> This is the working document that grounds every abstract concept in the spec to a
> concrete file, module, or admin view we already have — so "swarm cells", "next-best
> actions", "outcome episodes" and "assurance gates" are recognized as **observers and
> actions that already exist**, not greenfield agents.
>
> North-star spec: `#attachment` "Renal Swarm Intelligence — Product-grade reference
> architecture · 2026–2039". Companion docs: `spec.md`, `docs/enterprise-implementation.md`.

---

## 0. The reframe (read this first)

The current harness is the **admin / data / mapping / engine layer**:

> ingest → map (FHIR/HL7v2/CSV) → observe (LFC/LTC liquid + rules + agents) → guard
> (policy + HITL + access) → act (`WorldEffect`) → verify (CQL measures)

The Renal Swarm "cells/agents" are **not new agents**. They are **bounded observer →
allowed-action pairs** over the same enterprise state, which we already have as first-class
primitives:

| Renal Swarm concept | Our primitive | Code |
|---|---|---|
| Bounded cell (observer) | `AmbientProcess` (`onTick` / `onEffect`) | `src/realm/ambient.ts` |
| Bounded cell (rules/experiences) | `RulesEngine` → `Experience` | `src/realm/rules.ts` |
| Bounded cell (persona/tool loop) | `AgentSpec` + agent runtime | `src/agents/`, `src/realm/agent-runtime.ts` |
| Allowed actions only | `WorldEffect` kind subset | `src/realm/effect-reducer.ts` |
| Approval class / no autonomous action | `hitlGates`, policy, access | `src/realm/hitl.ts`, `src/realm/policy.ts`, `src/server/auth/` |
| Eval gate | liquid eval + CQL measure evaluator + HITL | `src/liquid/`, `src/measures/evaluator.ts` |
| Kill switch | manifest flag + gate | (new `src/swarm/` cell manifest) |
| Canonical event | `CanonicalEvent` + provenance | `src/healthcare-core/events.ts`, `src/server/event-broker.ts` |
| Evidence / provenance graph | temporal hypergraph + audit + attribution | `src/hypergraph/`, `src/server/audit.ts`, `src/realm/attribution.ts` |

**Consequence:** the delta to "Renal Swarm" is **additive + declarative** — a cell-manifest
registry, an insight/NBA aggregation layer, and an outcome-episode state machine wrapping
what already works — plus the executive cockpit surface. No rewrite of the engine.

---

## 1. What exists today (inventory, code-grounded)

### 1.1 Event & adapter plane (spec plane 1) — ✅ strong

| Spec | Code | Status |
|---|---|---|
| Event broker port | `EventBroker` (`src/server/event-broker.ts`) | ✅ |
| Drivers | `InProcess` · **Kafka** · redis-streams · bullmq · rabbitmq · nats · sqs-sns · pubsub · event-hubs (`src/server/*-event-broker.ts`) | ✅ 9 drivers |
| Transactional outbox | `SqlEventOutbox` (`src/server/event-outbox.ts`), `event_outbox` table | ✅ |
| Replay | `OutboxPublisher.replay` (`event-outbox.ts`), `/admin/broker/replay` | ✅ |
| DLQ / dead-letter | broker `deadLetter` + outbox dead | ✅ |
| Idempotency | broker dedup-by-event-id; `IdempotencyRegistry` (`src/server/idempotency.ts`) | ✅ |
| Canonical events | `CanonicalEvent` + `Provenance` (`src/healthcare-core/events.ts`) | ✅ (bitemporal partial: `occurredAt` valid vs `observedAt`/`ingestedAt` recorded) |
| Adapters | FHIR-lite, HL7v2-lite, CSV, XLSX (`src/adapters/`); FHIR bundle ingest (transaction/batch/message, urn:uuid, rollback) (`src/fhir/`) | ✅ |
| Realm → broker bridge | `RealmEventBridge` (`src/server/realm-event-bridge.ts`) | ✅ |
| Kafka bridge (hosted HTTPS worker) | ❌ not present — `services/kafka-bridge` is a deployable to build | ⬜ gap |

### 1.2 Canonical evidence fabric (spec plane 2) — ✅ strong / ⚠️ partial

| Spec | Code | Status |
|---|---|---|
| Temporal hypergraph | `HypergraphStore` (`src/hypergraph/`) | ✅ |
| Typed nodes + edges (healthcare) | 41 node schemas, 17 domain edges (`packs/healthcare-core/nodes.ts`, `edges.ts`, `hypergraph.ts`) | ✅ |
| Evidence / provenance | SHA-256 content hashes; knowledge provenance to raw URL + commit; effect attribution (`src/realm/attribution.ts`) | ✅ |
| Knowledge substrate | 15 live adapters, 36 canonical sources, sync engine, credentials, scheduler (`src/knowledge/`) | ✅ |
| Analytical marts (population/facility/regulatory) | ❌ no named mart module | ⬜ gap |
| Bitemporal projections (current+historical) | realm clock + snapshots; not a first-class projection | ⚠️ |

### 1.3 Bounded intelligence runtime (spec plane 3) — ⚠️ partial (reframe applies)

| Spec cell | Our observer/agent | Allowed actions (`WorldEffect` subset) |
|---|---|---|
| Treatment continuity | `discharge-transition-summary`, `ambulance-transport-scheduler`, RulesEngine | `schedule-followup`, `notify-staff`, `flag-safety-event`, `open-ticket` |
| Hospital transition | `hospitalization.*` events, `LabMaturationProcess` | `schedule-followup`, `notify-staff`, `flag-safety-event` |
| Assessment intelligence | `assessments/` library, `record-assessment`, `depression-screening`, `exit-site-infection-tracker` | `record-assessment`, `flag-safety-event`, `notify-staff` |
| Facility capacity | `physical-object` (chair/machine), `assign/release-object`, `ed-throughput` pack | `assign-object`, `release-object`, `open-ticket`, `schedule` |
| Access surveillance | `ambulance-transport-scheduler`, RulesEngine (access) | `flag-safety-event`, `notify-staff`, `open-ticket` |
| CMS readiness | `esrd-2728/2744/2746-submit`, `esrd-qip-scorecard`, `Measures` CQL evaluator | `submit-claim`, `request-prior-auth`, `submit-intent`, `flag-safety-event` |
| Workforce resilience | `facility.staffing-change`, org-graph/staff, `operator-seat` | `open-ticket`, `notify-staff`, `escalate` |
| Growth & demand | `coverage.inquiry/active`, `payer` + `revenue-cycle` packs | `submit-intent`, `notify-staff`, `open-ticket` |
| Clinical quality | `anemia-management`, `avf-maturation-monitor`, `TrajectoryAmbientProcess`, measures | `flag-safety-event`, `record-assessment`, `update-care-plan`, `notify-staff` |
| Experience & equity | `health-equity-plan`, `bereavement-outreach`, `assessment.response` | `notify-staff`, `schedule-followup`, `record-agent-thought` |
| Revenue cycle | `submit-claim`, `request-prior-auth`, `payer`, `billing`/`cost-ledger` | `submit-claim`, `request-prior-auth`, `open-ticket`, `escalate` |
| Asset reliability | `biomed-preventive-maintenance`, `device-gateway`, `mark-object-state` | `mark-object-state`, `open-ticket`, `notify-staff` |

LFC/LTC engine (the "mechanics"): `TrajectoryAmbientProcess` (`src/liquid/trajectory.ts`)
consumes realm effects + patient state into an **event-feature vector**, runs **CfC / LTC**
(`modelKind: 'cfc' | 'ltc'`), supports `biasPatient()` nudges, `stepWithEvents()` events, and
`makeRegimeRule()` regime detection. This is the **event-integrated core the user referenced**.

### 1.4 Outcome coordination (spec plane 4) — ⚠️ partial

| Spec | Code | Status |
|---|---|---|
| Episode substrate (agent loop) | `Episode` (SHA-256, perception→choice→effect→consequence) (`src/realm/episode.ts`) | ✅ (agent-loop, not outcome-episode) |
| HITL approvals | `HITLGate` → suspend/approve/reject (`src/realm/hitl.ts`) | ✅ |
| Federation / cross-agent | `src/realm/federation.ts` | ✅ (no consensus aggregation) |
| Nudge deliver → observe | `NudgeLedger` (`src/realm/nudges.ts`) | ✅ (a close-the-loop) |
| Counterfactual rehearsal + gates | `src/realm/counterfactual.ts` + promote gates | ✅ |
| Outcome-episode state machine | ❌ `Observed→…→Resolved` not present | ⬜ gap |
| A/B/C/D action-class routing | ❌ (clearance/purposeOfUse exist; no 4-class routing table) | ⬜ gap |
| Command idempotency → ack → verify | job-bus idempotency + `approve-effect` + nudge observe | ⚠️ partial |
| Outcome dossier generation | ❌ | ⬜ gap |

### 1.5 Cockpits (spec plane 5) — admin UI has 36 views (`admin-ui/index.html` NAV)

| Spec cockpit | Existing admin views | Status |
|---|---|---|
| **Swarm Control** (flagship) | Hypergraph, Command center (SSE wall), Broker, Counterfactual, federation | ❌ needs NBA/insight/event-feed surface |
| **Outcome Command** | Episodes, Realm detail, Nudge ledger | ❌ needs outcome-episode queue |
| **Patient Intelligence** | Realm patient detail, What-If, FHIR entity read, Hypergraph | ⚠️ |
| **Facility Operations** | Realm, Presences, Effects, org graph, Durable | ⚠️ |
| **Assessment Intelligence** | Assessments catalog, Realm assessments | ⚠️ (no fact-review surface) |
| **CMS Operations** | Measures catalog, coverage, evaluate, sync, dry-run | ✅ strong |
| **AI Assurance** | Liquid training, Score labs, Enterprise, Audit, Compliance | ⚠️ |
| **Executive Outcomes** | Dashboard (summary), billing rollup | ⚠️ (swarm KPIs missing) |
| **Configuration Studio** | Settings (master data), Users, Packs, Drafts, Realm builder | ⚠️ (no release mgmt) |
| **Shared Intelligence** | Hypergraph SVG browser | ⚠️ (no Three.js canvas) |

### 1.6 Assurance & governance (spec plane 6) — ✅ strong / ⚠️

| Spec | Code | Status |
|---|---|---|
| Hash-chained audit | `src/server/audit.ts`, SHA-256 audit chain | ✅ |
| RBAC + ABAC + scope | `AccessEvaluator` (`src/server/auth/`), `access.ts` | ✅ |
| Break glass | `src/control-plane/break-glass.ts` | ✅ |
| Secrets w/ audit | `src/control-plane/secrets.ts` | ✅ |
| Observability | spans/metrics/SLOs (`src/control-plane/observability.ts`, `telemetry.ts`) | ✅ |
| Alerts / retention / compliance / webhooks | `src/server/{alerts,retention,webhooks}.ts`, `/admin/compliance` | ✅ |
| Green/red team as a **release gate** | ❌ tests exist (gold-set parity, conformance) but not a runtime gate | ⬜ gap |

---

## 2. The six durable primitives — status

| # | Primitive | Code | Status |
|---|---|---|---|
| 1 | Canonical events + evidence | `CanonicalEvent`, provenance, hashes | ✅ (unify envelope: `valid_time`/`recorded_time`/`correlation_id`/`causation_id` on every event) |
| 2 | Topology + typed relations | hypergraph nodes/edges; org-graph | ⚠️ (add enterprise→division→region→market→facility layer; D1 projection) |
| 3 | Swarm insights | ❌ (need consensus/conflict/abstention over cell outputs) | ⬜ gap |
| 4 | Next-best actions (NBA) | ❌ (need ranker over candidate actions) | ⬜ gap |
| 5 | Outcome episodes | ⚠️ (episode.ts + HITL + nudges exist; no state machine/dossier) | ⬜ gap |
| 6 | Configuration releases | ❌ (need versioned pins: org/adapters/agents/policies/measures) | ⬜ gap |

---

## 3. Storage path — Postgres now, HGFS later

- **Now:** one Postgres for everything.
  - Events/ledger/audit/FHIR mirror → `PostgresEventStore` (`src/server/postgres-event-store.ts`) — already the prod event store in `bootstrap.ts`.
  - Snapshots, master data, outbox, idempotency, nudges, counterfactuals, FHIR mirror → `SqlStore` (`src/server/sql/`) — set **`HH_STORAGE=postgres`** (currently default `sqlite`; Docker sets `sqlite`). One config change.
  - Hypergraph → persist `HypergraphStore` to Postgres tables (currently in-memory/materialized).
- **Later:** HGFS as the hypergraph substrate — back `HypergraphStore` + canonical evidence with HGFS. Migration target, after the swarm layer is implemented.

---

## 4. The delta (what we build next) — `src/swarm/`

Additive, declarative, reusing observers/actions/measures/HITL:

1. **Cell manifest registry** — `src/swarm/cells.ts`
   `{ id, version, owner, consumes: string[] /* canonical events */, produces: string[], allowedActions: WorldEffectKind[], approvalClass: 'A'|'B'|'C'|'D', evalGate: number, killSwitch: boolean, rollback: boolean, observerRef: string }`
   — declares the 12 renal cells over existing observers/agents + allowed effect subsets.
2. **Proposal + swarm insight** — `src/swarm/insight.ts`
   Collect cell outputs (Experiences/risks/proposals) → `{ cells[], consensus, conflict[], abstention[], evidenceCount }` (the 96% / 94% / 99% convergence), reusing effect ledger + `attribution.ts`.
3. **NBA ranker** — `src/swarm/nba.ts`
   `score = f(outcome, urgency, value, evidence, consensus, policy, cost, risk)` → durable ranked list (advisory; server re-checks role/scope/approval before a command).
4. **Outcome-episode state machine** — `src/swarm/outcome-episode.ts`
   `Observed→Understood→Proposed→Blocked/AwaitingApproval→Coordinating→Verifying→Resolved/Escalated→Reopened`, wrapping the existing effect → HITL → command (idempotent) → ack (nudge observe / `approve-effect`) → measure-verify loop, and emitting an outcome dossier.
5. **Configuration release + authority registry** — `src/swarm/release.ts`
   Versioned pins over org/adapters/agents/policies/measures with effective windows; authority registry over CMS/CDC/USRDS sources (extends knowledge source registry).
6. **Executive cockpits** — `admin-ui`:
   - **Swarm Control** — wrap Hypergraph + Command center + Broker + Counterfactual, plus NBA list, swarm-insight/consensus cards, live event feed.
   - **Executive Outcomes** — rollup KPIs (treatments kept, capacity opportunity, CMS readiness, value at risk) as in the prototype's Swarm Control header.
   - Re-taxonomize the 36 views under the doc's 10 cockpits.

---

## 5. Roadmap

| # | Milestone | Deliverable | Exit evidence |
|---|---|---|---|
| M-S0 | **Postgres consolidation** | `HH_STORAGE=postgres` in prod/Docker; persist hypergraph | event store + SqlStore round-trip; `/health` green |
| M-S1 | **Swarm core** | `src/swarm/`: cell manifests (12 cells) → insights → NBA → outcome-episode state machine; config release + authority registry (light) | prototype boundary: 12 cells · 5 insights · 4 ranked NBAs · 1 retained conflict · approved NBA → idempotent command → ack → measure |
| M-S2 | **Executive cockpits** | Swarm Control + Executive Outcomes in `admin-ui`; re-taxonomy 36 views → 10 cockpits | NBA/consensus/event-feed render live; executive rollup KPIs |
| M-S3 | **Kafka bridge + assurance gate** | `src/server/kafka-bridge.ts` (lease → integrity/tenant validate → idempotent publish → receipts/incidents; `bridge_leases` + `bridge_receipts` tables) + `src/swarm/release.ts` green/red-team gate (`/admin/swarm/release-gate`); Release gate + Kafka bridge cockpits in `admin-ui` | bridge consumes canonical topics → validate → outbox lease → idempotent publish → receipts (✅ M-S3 COMPLETE) |
| M-S4 | **HGFS migration** | back `HypergraphStore` + evidence with HGFS | replay across versions reproducible (2039 continuity) |

---

## 6. Acceptance target (from the spec's "current executable reference boundary")

> 11 canonical replay events integrity-checked and persisted · 12 deterministic bounded
> cells execute from manifests · independent proposals become 5 swarm insights, 4 ranked
> NBAs, 1 retained capacity conflict · role/org-scope/action-class re-checked on the server ·
> an approved NBA becomes an idempotent command + leased Kafka-outbox row · an
> acknowledgement closes the episode and calculates a measure result · policy and facility
> "what-if" runs replay persisted evidence without changing runtime state · topology
> projected into D1 · shared notes keep version/comment history · model registry, drift,
> traces, cost, incidents, red-team runs and dry-run submission packages persisted.

This is the definition of done for the S1–S2 milestone pair.
