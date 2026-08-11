# Architecture

## Layers

```
                +--------------------------------------------+
                |               Applications                 |
                |  (dashboards, queues, generated apps, UI)  |
                +--------------------+-----------------------+
                                     |
                +--------------------v-----------------------+
                |             Agentic runtime                |
                |   model router · tool registry · planner   |
                +--------------------+-----------------------+
                                     |
                +--------------------v-----------------------+
                |            Healthcare core                 |
                |  policy · DQ · measures · QAPI · replay    |
                |             · simulation                   |
                +--------------------+-----------------------+
                                     |
                +--------------------v-----------------------+
                |              Control plane                 |
                |  access · audit · workflow · pack registry |
                +--------------------+-----------------------+
                                     |
                +--------------------v-----------------------+
                |                  Kernel                    |
                |  ids · org/person/scope · temporal         |
                |  hypergraph · cyclic temporality           |
                +--------------------+-----------------------+
                                     |
                +--------------------v-----------------------+
                |                Adapters                    |
                |  FHIR-lite · HL7 v2 lite · CSV             |
                +--------------------------------------------+
```

Packs (`dialysis-provider`, `ckd-navigation`, `payer`, `cms-universe`) are consumers of every layer above the kernel and are the extension unit of the harness.

## Data flow (dialysis replay)

1. External systems emit records via FHIR / HL7 v2 / CSV.
2. Adapters map records into `CanonicalEvent`s with provenance + classification.
3. The DQ engine evaluates every event; critical/error findings gate execution.
4. The replay engine folds events through a pack's `WorkflowReducer` (for dialysis, `dialysisReplayReducer`) producing a state trace + emitted signals.
5. Quality measures evaluate the resulting dataset against CMS programs.
6. The audit ledger seals every access decision + workflow event into a hash-chained record.
7. The UI reads from the state + audit + measures and presents case queues, replay viewers, QAPI boards, and audit chains.

## Zero-trust access

`AccessEvaluator` is the only place trust is decided. The evaluation order is:

1. **Environmental floors**: PHI on unmanaged device -> deny; stale MFA -> step-up; restricted-PHI export without emergency -> step-up.
2. **Scope containment**: subject must be a member (via ancestry) of a scope containing the resource's scope.
3. **RBAC grant**: subject must have a role granted the requested action for the resource type.
4. **ABAC rules**: deny wins, step-up second, allow accumulates reasons.

Every decision is written to the audit ledger with policy version, matched rules, and reasons.

## Cyclic temporality

Dialysis rhythms (MWF, TTS, custom) are represented as `DialysisTreatmentCycle`s. The kernel's `classifyRhythm` + `summarizeRhythm` turn expected/observed pairs into a `CycleStatus` (`on-rhythm | drifting | broken | recovering`) that the missed-treatment reducer and QAPI board key off — no calendar math in workflow code.

## Model agnosticism

`ModelRouter` accepts any `ModelAdapter`. The deterministic in-process adapter is shipped for tests + offline demos. Production deployments add OpenAI/Anthropic/Bedrock/etc adapters; the harness never binds to a specific vendor.

## Packs

Each pack:

- declares `manifest.yaml` + a `DomainPack` descriptor (id, version, extends, capabilities, cmsUniverse, requiredControls)
- exports an ontology, DQ rules, state machines, quality measures, and (optionally) a replay reducer
- registers against the same `PackRegistry` at boot; dependency resolution is caret-range aware

Adding a specialty (oncology, infusion, care management, prior-auth vertical, etc.) is: add a manifest, add ontology + DQ + workflows + measures, register at boot. The core does not change.

## CMS universe

`cms-universe` turns CMS programs into typed metadata other packs bind to. `programsFor('esrd-qip.ktv-adequacy')` returns every program that references that measure, enabling the harness to route regulatory obligations without hardcoding them into workflows.

## Replay + simulation

`replay(batch, reducer, dq)` is pure: same events, same reducer, same DQ engine -> identical `ReplayReport`. `SimulationLog` records the metadata (pack, policy version, window, metrics) so pack promotion has a durable audit trail.

## Audit

`AuditLedger.append` chains each entry to its predecessor via a stable hash. `verify()` recomputes the chain to detect tampering. Adapters can swap FNV-1a for SHA-256 without changing callers.
