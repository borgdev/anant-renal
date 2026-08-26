# Threat model and assurance boundary

## Protected assets

Patient identity and evidence, tenant isolation, clinical/operational decision authority, Kafka commands, CMS packages and credentials, public-authority provenance, configuration releases, model/prompt/rule versions, audit records and institutional notes.

## Trust boundaries

1. Source systems and external adapters.
2. Kafka broker, topic ACL and bridge workload identity.
3. HTTPS runtime ingress and workspace identity.
4. D1 tenant/scope persistence.
5. Cell execution and untrusted model/text content.
6. Human approval and delegated organization scope.
7. Command outbox and downstream workflow adapters.
8. Regulatory transmission connector.

## Implemented reference controls

- versioned canonical envelope, tenant allowlist, SHA-256 payload verification and event-id deduplication;
- exact assessment text retained as evidence; embedded instructions never enter an action/tool channel;
- recorded-time history preserves late corrections;
- independent cell rules, typed proposals, action allowlists, eval gates and kill switches;
- swarm conflict retention rather than silent winner selection;
- server-side action-class, role and hierarchy-scope authorization;
- commands and outbox written durably before publication;
- adapter-token-only outbox, per-replica leases, idempotent Kafka production, backoff and terminal incident;
- acknowledgement-correlated outcome closure and evidence-hashed measure result;
- proposed CMS sources cannot activate a final pack in executable red-team checks;
- trace, cost, drift, model, policy, audit and evaluation records;
- scope-authorized, versioned topology notes;
- external clinical, scheduling, messaging and regulatory writes disabled.

## Organization controls still required

- real IAM groups, HR role assignments, patient relationship and purpose-of-use policy;
- workload mTLS/SASL, broker ACLs, secret rotation and network segmentation;
- field-level PHI minimization, encryption/key management, retention, legal hold and deletion workflows;
- signed schema/source/config releases and separation of duties;
- clinical hazard analysis, local validation, human factors and downtime procedures;
- independent security testing, dependency/SBOM scanning and supply-chain controls;
- production SLOs, load/chaos tests, backup/restore and regional recovery;
- certified CMS/EQRS/NHSN connectors and reconciliation operations;
- monitoring for re-identification, exfiltration, poisoned sources and insider misuse.

## Executable red-team suite

| Scenario | Assertion |
|---|---|
| Prompt injection in an answer | Only a human-confirmation proposal is possible; no prescribe/order action exists |
| Cross-patient evidence | Subject correlation fails closed |
| Duplicate Kafka delivery | Three deliveries collapse to one event identity |
| Late correction | Both recorded beliefs remain; latest recorded belief resolves current state |
| Stale/proposed CMS authority | Proposed-only pack cannot activate |
| Unsafe clinical recommendation | FA cannot authorize Class D clinical change |
| Measure drift | Identical replay inputs produce identical outputs |
| Model outage | Deterministic cells continue while assessment extraction is isolated |

These tests validate reference controls, not an organization’s production certification. Add adapter, identity, model, facility, language, demographic and failure-mode suites before each controlled expansion.
