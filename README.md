# healthcare-harness

Model-agnostic, hypergraph-native healthcare agent harness with production-grade access, policy, audit, temporal, and pack contracts.

The harness compiles healthcare intent + local data into deployable, auditable applications. Dialysis is the first packaged domain; the durable product is the compiler, policy layer, adapters, templates, and validation runtime around interchangeable reasoning models.

## Why this exists

- **EMRs are systems of record; the harness is the application plane.** It replaces bespoke operational apps, unmanaged spreadsheets, and shadow dashboards, not EMRs.
- **FHIR is preferred, never required.** FHIR, HL7 v2, and CSV feeds all map into a canonical event vocabulary before the harness reasons about them.
- **Replay is a trust primitive.** Every generated workflow must run against historical events before it deploys.
- **Regulations are executable metadata.** CMS Conditions for Coverage, ESRD QIP, and ESRD PPS live in the cms-universe pack as data other packs bind to.

## Repository layout

```
src/
  kernel/              ids, org/person/scope, temporal hypergraph, cyclic temporality
  control-plane/       zero-trust access, audit ledger, harness contract, workflow, pack registry
  healthcare-core/     policy, DQ, quality measures, QAPI, events, replay, simulation
  agentic/             model router, tool registry, harness runtime + recipes
  adapters/            FHIR-lite, HL7 v2 lite, CSV
packs/
  healthcare-core/     generic core pack
  dialysis-provider/   dialysis + sub-packs (missed-treatment, labs, scheduling, hospitalization, vascular-access)
  ckd-navigation/      CKD -> ESRD navigation
  payer/               prior-auth + utilization mgmt + appeals
  cms-universe/        executable metadata for CMS programs
ui/                    Next.js App Router UI (cases, replay, audit, QAPI, packs, measures)
examples/              end-to-end demos (dialysis-replay)
tests/                 vitest suites across kernel, access, packs, adapters, agentic
```

## Running

```
npm install
npm run typecheck
npm test
npm run demo:replay

cd ui
npm install
npm run dev
```

## Design principles

1. **The kernel is small and immutable.** Every mutation of the hypergraph produces a new version; history is a first-class array, not a log we hope is complete.
2. **Zero-trust access is enforced in one place.** `AccessEvaluator` denies by default and requires an explicit RBAC grant plus environment-floor checks (managed device, MFA freshness, scope containment) before ABAC rules even run.
3. **DQ gates execution.** No workflow or replay proceeds past critical or error findings.
4. **Packs are the extension unit, not plugins.** Packs declare their dependencies, capabilities, CMS bindings, and required controls in manifest.yaml + `DomainPack` and register against the same `PackRegistry` at boot.
5. **The reasoning model is swappable.** The `ModelRouter` picks an adapter per task; the deterministic in-process adapter is used for tests and offline demos.

See `ARCHITECTURE.md` for the deeper walk-through.

## License

Private. All rights reserved.
