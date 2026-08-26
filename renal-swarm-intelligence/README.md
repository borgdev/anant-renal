# Renal Swarm Intelligence

An event-native, governed business outcome harness for dialysis care, operations, quality and regulatory intelligence.

The included experience is a runnable reference platform: all patient, treatment, staff and facility records are synthetic; labeled CMS, CDC, USRDS and eCQI facts come from real public sources. The event kernel, temporal/evidence ledger, cells, swarm synthesis, policy replay, role/scope authorization, command outbox, acknowledgement loop, measure result, dry-run package, telemetry and shared notes execute server-side against D1. Live EMR writes and regulatory transmission are intentionally disabled until organization-specific credentials, controls and approvals are configured.

## Product surfaces

- Swarm Control enterprise cockpit with hierarchy/role views, cross-facility intelligence, persisted NBAs, stepped event replay, agent execution telemetry and server-side policy simulation
- Agent Operations with twelve bounded specialists, runtime traces, proposal boundaries, costs, kill switches and a dedicated swarm message fabric
- Outcome Command, Patient Intelligence, Facility Operations and Assessment Intelligence
- Shared Intelligence enterprise temporal hypergraph in Three.js
- CMS Operations with real public sources, benchmarks and submission readiness
- AI Assurance with green team, red team, traces, drift/SLO controls and kill switches
- Executive Outcomes across clinical, operational, regulatory and economic value
- Configuration Studio for operating model, FHIR, Kafka, agents, policies, thresholds and measure packs
- Platform Admin for customer onboarding, identity posture, Kafka bridge setup/test, UI-based agent and policy editing, red/green release validation and hot activation without a code redeploy
- D1 event/evidence/bitemporal/topology/outcome/swarm/policy/command/acknowledgement/measure/assurance/collaboration ledger
- External Kafka bridge with authenticated canonical ingress, leased durable outbox, idempotent producer and delivery receipts
- Eleven configurable renal ecosystem domain packs; only the synthetic in-center reference pack is active by default

## Architecture and demo

- [Reference architecture](docs/ARCHITECTURE.md)
- [Demo runbook](docs/DEMO_RUNBOOK.md)
- [Runtime and integration runbook](docs/RUNTIME_RUNBOOK.md)
- [Threat model and assurance boundary](docs/THREAT_MODEL.md)
- [Frontend/backend security boundary](docs/SECURITY_BOUNDARY.md)
- [Executive product pitch](docs/EXECUTIVE_PITCH.md)
- [AsyncAPI contract](contracts/asyncapi.yaml)
- [Control-plane OpenAPI contract](contracts/control-plane.openapi.yaml)
- [SQLite/PostgreSQL portable control-plane schema](db/control-plane.portable.sql)
- JSON Schemas live in `contracts/`

## Local development

```bash
npm run install:ci
npm run dev
```

The project uses Vinext/Next, React, Three.js, Drizzle and Cloudflare D1. `.openai/hosting.json` declares the `DB` binding. Never place EMR, Kafka, CMS or other credentials in the repository; inject them through the deployment environment and private bindings.

## Validation

```bash
npm run lint
npm run test:contracts
npm run test:runtime
npm run typecheck
npm run verify:cms
npm test
```

- `test:contracts` validates authority sources, measure-source resolution, bounded-cell controls, red-team coverage, all D1 migrations, domain packs, Kafka bridge properties, data boundaries and versioned schemas.
- `test:runtime` executes the deterministic event, swarm, policy, facility-simulation and eight-scenario red-team kernels.
- `verify:cms` fetches the official CMS Provider Data API and verifies the six committed public benchmark rows and snapshot hash.
- `test` performs the deployable build and all local suites.

## Configurable product contracts

| Area | Location |
|---|---|
| Public authority registry | `config/public-sources.json` |
| Verified CMS benchmark snapshot | `config/public-benchmarks.json` |
| Measure packs | `config/measure-packs.json` |
| Bounded cell manifests | `config/agent-manifests.json` |
| Enterprise hierarchy, roles and domains | `config/enterprise-operating-model.json` |
| Renal ecosystem domain packs | `config/domain-packs.json` |
| Runtime action policy | `config/runtime-policy.json` |
| Synthetic ecosystem replay, insights and NBAs | `config/ecosystem-demo.json` |
| Adversarial scenarios | `config/red-team-scenarios.json` |
| Canonical event and domain schemas | `contracts/` |
| Durable ledger schema | `db/schema.ts` |
| Portable logical control-plane schema | `db/control-plane.portable.sql` |
| Generated D1 migration | `drizzle/` |
| Tenant onboarding and hot-release control plane | `lib/server/onboarding.ts` |
| Effective agent and policy resolution | `lib/server/configuration-repository.ts` |
| Executable runtime kernel | `lib/runtime/` |
| Kafka bridge | `services/kafka-bridge/` |

## Production boundary

Before using real patient data or transmitting CMS/EQRS/NHSN submissions, complete EMR/Kafka adapter activation, organization identity and authorization mapping, security/privacy review, clinical safety validation, local data-quality reconciliation, connector certification, operational ownership, capacity testing and incident/rollback drills. Platform Admin can hot-activate validated runtime configuration without deploying code, but it cannot waive these production gates. The owner-only synthetic role switch is a demonstration delegation aid, not a production identity model.
