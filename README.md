# Healthcare Harness

> **Every agent is a digital twin of a persona. Every persona lives inside a realm. Behavior is rehearsed across a population of twins before it lands on a real human.**

The harness is not an EMR, not a chart, not a bolt-on assistant. It is a **governed agentic substrate** in which a patient, their clinicians, their household, their payer, and their operators all exist as first-class agent twins — each with their own perception, policy, and voice. When we design a nudge for one, the whole realm reacts, and we get to watch it play out in simulation before it plays out in a life.

CareCentra nudges a person. We nudge a person *and* everyone around them, with every step measured, cited, and replayable.

---

## The bet

Healthcare-scale behavior change fails when it is aimed at a single node in a graph the tooling cannot see. The realm is the thing that has to move. So we built:

- A **persona-twin model** where each agent carries its own context (role, clearance, tools, policy, memory) and inhabits a shared world.
- A **realm** that ticks time, routes perception, records every effect, and lets us fork counterfactuals cheaply.
- A **knowledge substrate** that keeps the realm honest: every claim ties back to a CMS/FHIR/openFDA/RxNorm source with a SHA-256 hash, a commit, and a raw URL.
- A **measure evaluator** that runs real CQL over real FHIR bundles so a nudge's clinical effect is not asserted — it is scored.
- A **policy graph** so the same agent behaves differently in Tennessee, in an audit, at 3am, or during a break-glass — because the world around it has changed.

None of this is a stub. The invariant we hold above everything else is **no mocks in the path**. If a component claims a real network, real hash, real evaluator, real policy — the tests reach for the real thing.

---

## What is shipped today (M0 → M21, verified)

**263 tests passing across 42 files. TypeScript strict, no stubs, no seed data in production paths.**

| Milestone | Ships |
|---|---|
| **M1** | Ontology, patient lifecycle, assessments (PHQ-9, GAD-7, KDQOL-36, MoCA, Braden, Morse, FRAIL, SDOH-5, ADL, IADL, MNA-SF, CAM, AUDIT-C), agent runtime, full CMS measure catalog |
| **M2** | 20 flagship agents across care settings and lifecycle stages |
| **M3** | Ops manuals ingestion pipeline + starter policy templates |
| **M4** | Clinical research + pharma pipeline (ClinicalTrials.gov, DailyMed, openFDA, FAERS, PubMed, RxNav) |
| **M5** | Deep vertical packs — dialysis (60 agents), primary care (50), urgent care (40) |
| **M6** | Admin API + UI shell + Testcontainers integration |
| **M7** | Agent authoring workflow — draft → review → publish + operator console |
| **M8** | **Realm** substrate — worlds agents inhabit + operator view |
| **M9 + M10** | Agents inhabit, choose, and know themselves (self-model, choice, policy) |
| **M11** | Consequence attribution, rich narrative, SSE stream, peer perception, replay |
| **M12** | Operator layer — org graph, physical objects, tickets, planner, HITL, cost ledger, operator seat |
| **M13** | PlanRunner, federation, policy runtime, Ollama LLM adapters, counterfactual harness, metered billing |
| **M14** | Plan timeline, counterfactual studio, governance ledger, notifications, org billing rollup, LLM adapter registry, snapshot/restore |
| **M15–M18** | Vertical packs (240 agents), onboarding, identity (SSO, SCIM, break-glass), self-serve admin |
| **M19** | Entity-pack compiler — convert traditional entity packs into governed `AgentSpec`s. Native XLSX loader (SheetJS) |
| **M20** | **Knowledge substrate** — pack↔source hypergraph, 15 live adapters (CMS, openFDA, RxNorm, MedlinePlus, ClinicalTrials, cqframework, +9), sync engine, credentials framework, scheduler. 36 canonical sources. Admin UI: universal Knowledge browser, Learn hub, Realm Local Corpus tab. ReAct + Plan-and-Execute agent router with 6-tool bus |
| **M21** | **Real CQL evaluator end-to-end.** `cql-execution` + `cql-exec-fhir` wired to `MeasureEvaluator`. Disk loader hydrates `StoredMeasure` / `StoredLibrary` from `.harness/measures/`, base64-decodes ELM, extracts value-set and code-system refs. `POST /admin/measures/:id/evaluate` route + `evaluate_measure` agent tool. Test proves a hypertensive patient lands in the numerator; a hypertensive pregnant patient lands in denominator-exclusion with `met=null` |

### The stack, bottom-up

```
┌────────────────────────────────────────────────────────────────┐
│  5. Lived experiences (packs — dialysis, PC, urgent care, …)   │
├────────────────────────────────────────────────────────────────┤
│  4. Realms & world model (facility, presence, perception,      │
│     policy, choice, counterfactual, replay, federation)        │
├────────────────────────────────────────────────────────────────┤
│  3. Agent runtime (ReAct + Plan-and-Execute, shared tool bus,  │
│     effect ledger, HITL approvals, cost ledger, billing)       │
├────────────────────────────────────────────────────────────────┤
│  2. Measure & evidence store (FHIR Measure/Library/ValueSet,   │
│     real CQL evaluator, SHA-256 provenance to blob + commit)   │
├────────────────────────────────────────────────────────────────┤
│  1. Knowledge sources (CMS · openFDA · RxNorm · MedlinePlus ·  │
│     ClinicalTrials · cqframework — 15 live adapters, 36 canon) │
└────────────────────────────────────────────────────────────────┘
```

### Repository layout

```
src/
  adapters/          FHIR-lite, HL7 v2, CSV, XLSX
  agents/            AgentSpec, runtime, registry, skills, spec-sync
  agentic/           model router + tool registry (legacy path)
  assessments/       validated instrument library
  entity-compiler/   entity-pack → governed AgentSpec compiler
  healthcare-core/   policy, DQ, measures, QAPI, events, replay
  hypergraph/        temporal hypergraph kernel
  identity/          SSO / SCIM / invites / break-glass
  ingestion/         manuals + docs → policy templates
  knowledge/         source registry, sync engine, scheduler, agents/tool-bus
  lifecycle/         patient lifecycle stages + agent hooks
  measures/          evaluator, store-loader, value-set registry, types
  onboarding/        org + facility bootstrap wizard
  ontology/          canonical entity + relationship vocab
  policy-graph/      composable policy DAG
  realm/             agent-runtime, ambient, attribution, billing, choice,
                     clock, counterfactual, effect-ledger, entity-graph,
                     episode, federation, governance, hitl, llm-registry,
                     narrative, notifications, org-graph, perception,
                     plan-runner, planner, policy, presence, realm-snapshot,
                     replay, rules, self-model, sim-populator
  research/          research + pharma source registry
  self-serve/        operator self-service
  server/            fastify app, admin routes, knowledge routes, bootstrap

packs/
  flagship-agents/    20 cross-setting flagship agents
  dialysis-deep/      60 dialysis-specialized agents
  primary-care-deep/  50 primary-care-specialized agents
  urgent-care-deep/   40 urgent-care-specialized agents
  research-pharma/    pharma + trials + drug-safety pipeline
  dialysis-provider/  provider-side ops
  cms-universe/       CMS programs as executable metadata

hh-admin-ui/          single-page admin (Knowledge, Learn, Realm, Measures,
                      Agents, Drafts, Governance, Counterfactuals, Billing)
tests/                vitest suites — 263 tests across 42 files
.harness/             local store: knowledge/, measures/, secrets/, snapshots/
```

### Running

```
npm install
npm run typecheck           # strict TS, exactOptionalPropertyTypes
npm test                    # vitest — 263 passing, 1 skipped

# server
npm run dev                 # fastify with admin routes at /admin/*

# admin UI (single-page)
pplx-tool deploy_website    # deploys hh-admin-ui with the shared asset name

# real FHIR measure evaluation (M21)
npm run measures:sync       # sync cqframework/ecqm-content-qicore-2025
curl -X POST http://localhost:3000/admin/measures/CMS165/evaluate \
     -H 'content-type: application/json' \
     -d @tests/fixtures/m21/bundle-in-numerator.json
```

---

## Roadmap — M22 → M27 (planned, not shipped)

The realm is stood up. The knowledge substrate is real. The measure evaluator runs. The next arc is what the harness was actually built to do: **make persona twins rehearse behavior change across a population, then land the winner in the world.**

Each of the milestones below has an acceptance test the arc will fail without.

### M22 — Persona twin substrate

**Every agent becomes a full digital twin, not a spec + runtime.**

A twin carries: a **persona identity** (role, clearance, cohort, cultural context, language), a **policy graph** (what it may do, per realm, per time), a **skill set** (tools it may call), a **memory** (per-episode + long-term), and a **voice** (how it speaks, in which register, to whom).

- `src/twins/` module: `TwinIdentity`, `TwinMemory`, `TwinVoice`, `TwinPolicyBinding`.
- Twins are addressable across realms; the same nephrologist twin can be present in a training realm, a counterfactual, and production simultaneously.
- Admin UI: **Twin Browser** — one card per twin, with its context, tools, current realm(s), and last 20 effects.
- Acceptance test: instantiate a nephrologist twin, place it in two realms, verify perception and effects are isolated per realm but the twin's identity + memory persist.

### M23 — Realm population + cohort ticking

**A realm is not one patient — it is the whole cohort ticking together.**

- `RealmPopulation` primitive: N patient twins, their family twins, the shift's clinician twins, the facility's operator twins, ticking on one clock.
- Cohort-scoped perception (nurse sees her 12-chair pod; medical director sees the whole facility).
- Realistic scheduling — dialysis shifts, PC panels, urgent-care throughput — driven by real CMS/USRDS distributions where available.
- Admin UI: **Population canvas** — dots for patients, colored by risk / adherence / most-recent-effect, live-updating as the realm ticks.
- Acceptance test: seed a facility with 120 patients across 3 shifts, tick 14 days, verify every measure evaluator run reflects population-level population membership (not one-off).

### M24 — Counterfactual rehearsal engine

**Before a nudge lands on a human, fork the realm and run it across the population.**

- `CounterfactualRehearsal.propose(nudge)` → forks K parallel realms (baseline + variants), reuses snapshot mechanics from M14.
- Each variant runs the same population through the same clock; effects, choices, and measure scores diverge.
- **Selection layer**: a variant is promoted to production only if (a) primary measure improves, (b) no equity metric regresses beyond floor, (c) no twin's policy is violated. All three gates are hard.
- Admin UI: **Rehearsal Studio** — variants side-by-side, deltas on measures + equity + cost + burden, promote/discard.
- Acceptance test: propose "phosphate-reminder-at-4am"; three variants (silence, gentle, insistent); rehearsal shows insistent-improves-adherence-but-degrades-sleep-equity; system refuses to promote and surfaces the reason.

### M25 — Ambient nudge delivery

**Turn rehearsed nudges into real-world channels — SMS, in-app, calendar, EHR order suggestion — with full provenance.**

- Channel adapters: SMS (Twilio), email, in-app, calendar (ICS), FHIR CommunicationRequest, EHR order suggestion via HL7 v2.
- Every real-world delivery carries: rehearsal id, variant id, expected effect, expiry.
- Bidirectional: the ambient loop closes when the twin observes response (message read, appointment kept, lab drawn, PRO answered).
- Admin UI: **Nudge Ledger** — every delivered nudge with expected vs observed, in one scroll.
- Acceptance test: a rehearsed dietitian nudge is sent via SMS to a test number, the response updates the twin's memory, and the realm's next tick re-scores the measure.

### M26 — Federated realms across facilities

**Multi-facility, multi-org, multi-region realms without collapsing sovereignty.**

- Extends M13 federation to persona twins: a payer twin in a national realm can perceive facility-level aggregates without seeing PHI.
- Cross-realm effect routing with cryptographic provenance (Merkle roots per tick, per facility).
- Regional policy overlays (state-by-state break-glass rules, CMS regional variance).
- Admin UI: **Federation map** — realms as nodes, allowed perception + nudge flows as edges, denied by default.
- Acceptance test: two facility realms + one payer realm; a patient transfer preserves twin identity and memory across facility boundaries; the payer sees the transfer as an aggregate event, not as a PHI leak.

### M27 — Trust primitives + external audit

**Everything the harness did, replayable and provable to an outside party.**

- Deterministic replay from any snapshot to any tick — already prototyped in M11, now hardened for audit.
- **Attestation bundle**: one signed archive per audit request containing the snapshot, the effect ledger slice, the governance directives, the measure evaluator provenance, and the counterfactual rehearsals that led to any external nudge.
- External verifier: a standalone tool a regulator can run against an attestation bundle to confirm the harness's account of what it did matches the ledger.
- Admin UI: **Audit Workbench** — pick a time range or a patient, generate the attestation bundle, hand it off.
- Acceptance test: generate an attestation bundle for a QIP measure period; the external verifier reproduces every population membership decision from the raw provenance without touching the running system.

---

## Design invariants

These are non-negotiable. When something is added to the harness, it either upholds these or it doesn't ship.

1. **No mocks in the path.** No stubs, no placeholder measures, no seeded fake data in production code paths. If tests require fixtures, they live in `tests/fixtures/` and are labeled.
2. **Every claim carries provenance.** Every knowledge artifact carries `{repo, path, blobSha, commitSha, rawUrl, fetchedAt, contentHash}`. Every measure evaluation carries `provenance.measure` + `provenance.libraries[]`. Every agent tool call is logged to the effect ledger with citations.
3. **Deny by default.** Every twin's policy graph, every access decision, every cross-realm perception starts denied. Explicit grants only.
4. **Replay is a trust primitive.** Any workflow, any nudge, any measure evaluation can be replayed from a snapshot to the exact same result. Replay divergence is a P0.
5. **Packs are cross-workflow, sources are cross-pack.** Pack↔source is many-to-many, modeled as a hypergraph, not tree ownership.
6. **Regulations are executable metadata.** CMS Conditions for Coverage, ESRD QIP, ESRD PPS, MIPS, VBP, IQR, PI, NHSN, CMS-0057-F all live as data that packs bind to — not as prose in comments.
7. **Twins are the substrate, not features.** A pack does not "have" nudges; twins in the pack's realm receive perception and emit choices, and some of those choices become nudges. The nudge is downstream.
8. **The reasoning model is swappable.** Different twins may run different LLMs (or none). The runtime picks per task via the LLM registry.
9. **Innovative unique UI, one view per concept.** No duplicated screens for the same idea. New patterns pass KISS before they pass polish.
10. **Production posture from day one.** Numbers reported in this README are from the real test suite and the real store. If a number cannot be substantiated against the codebase, it does not appear here.

---

## What this replaces

- **Point behavioral apps (CareCentra, Vida, Omada, Livongo pattern)** — they nudge a person; we nudge the person's realm.
- **Population-health dashboards** — they show what happened; we rehearse what will.
- **Ad-hoc CQL/measure tooling** — we run the real evaluator over the real bundle with the real provenance.
- **Bespoke care-management platforms** — the twin substrate + realm + policy graph is the platform; care programs are configurations.
- **Consultants writing per-facility SOPs** — SOPs are twin policy bindings; changes propagate.

## What this is NOT

- Not an EMR. Reads from EMRs via FHIR / HL7 v2 / CSV / XLSX adapters; writes back only through governed channels.
- Not a chatbot. Twins can converse, but the substrate is choice, perception, and effect — not tokens.
- Not a rules engine. Policy is a graph agents live inside, not `if/then` a human maintains.

---

## Repo, license, and contact

Private. All rights reserved. Canonical remote: [`bayyagari86/healthcare-harness`](https://github.com/bayyagari86/healthcare-harness).

For the deeper architectural walk-through, see `ARCHITECTURE.md`. For the M-milestone changelog, see `git log`.
