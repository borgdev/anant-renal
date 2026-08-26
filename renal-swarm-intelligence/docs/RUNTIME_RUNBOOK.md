# Runtime and integration runbook

## Executable path

`source event → authenticated ingress → contract/integrity check → event + evidence + temporal projection → eligible cells → proposals → swarm synthesis/conflict retention → policy-ranked NBA → role/scope approval → command + durable outbox → Kafka bridge → downstream acknowledgement → resolved outcome → calculated measure → dry-run package`

The reference data are synthetic. The same contracts accept organization adapters only after tenant, identity, purpose, security and clinical governance are configured.

## Hosted components

| Component | Responsibility |
|---|---|
| `POST /api/runtime` | Replay, canonical ingress, simulations, approvals, acknowledgements, evidence reviews and dry-run packages |
| `GET /api/runtime` | One governed runtime snapshot for operator cockpits |
| `GET/POST /api/runtime/outbox` | Adapter-token-only 60-second Kafka leases and publication receipts |
| `GET/POST /api/knowledge` | Scope-authorized node notes, versions and comments |
| `POST /api/harness` | Persisted green/red evaluation and legacy audit events |
| `GET/POST /api/v1/admin` | Tenant onboarding, Kafka bridge test, agent/policy drafts, five-suite validation and hot activation |
| `GET/POST /api/v1/agents` | Effective agent manifests, runtime message fabric and governed synthetic replay |
| `GET /api/v1/work-items` | Server-assembled, role/scope-filtered drill-down context |
| D1 | Durable reference event, evidence, temporal, topology, swarm, policy, command, assurance and collaboration state |

Deployment applies the generated migrations in `drizzle/`. Do not hand-edit those SQL files.

## Required bindings

- `DB`: D1 binding declared in `.openai/hosting.json`.
- `RUNTIME_ADAPTER_TOKEN`: at least 24 random characters, delivered by the deployment secret manager. Only the Kafka bridge receives it.
- `KAFKA_BRIDGE_TOKEN`: hosted binding used by Platform Admin to authenticate a live `/healthz` probe. Bind it to the same value accepted by the bridge; Platform Admin stores only `binding:KAFKA_BRIDGE_TOKEN`.
- `RUNTIME_DEMO_MODE=enabled`: optional local-only switch that permits the explicit `x-runtime-synthetic: owner-demo` header. Never enable it in a real-data environment.

Hosted operator calls rely on the authenticated workspace identity header. Selecting an operator perspective creates a labeled synthetic role delegation in the reference environment; production must resolve roles and scope from the organization’s IAM/HR sources rather than a UI selector.

## Kafka bridge

Run `services/kafka-bridge` outside the hosted worker, close to the organization brokers. It disables topic auto-creation, consumes configured input topics, uses `eventId` idempotency, produces one in-flight idempotent command per partition and writes delivery receipts back to the runtime. Each replica needs a unique `KAFKA_BRIDGE_INSTANCE_ID`.

```bash
cd services/kafka-bridge
npm install
KAFKA_BROKERS=broker-1:9092,broker-2:9092 \
HARNESS_BASE_URL=https://your-owner-site.example \
RUNTIME_ADAPTER_TOKEN='from-secret-manager' \
KAFKA_BRIDGE_INSTANCE_ID=renal-bridge-prod-01 \
npm start
```

The bridge exposes an authenticated `/healthz` response that distinguishes bridge process health from downstream Kafka connectivity. Platform Admin calls it only when the URL is not a reserved `.example` host and the referenced secret binding resolves. A `.example` URL performs a clearly labeled contract-only verification and cannot satisfy a production promotion gate. Failed outbox delivery uses exponential backoff; eight failures open a persisted severity-2 incident. Downstream consumers must also enforce command idempotency.

## Platform Admin release lifecycle

1. Save the tenant environment and deployment mode.
2. Save an HTTPS bridge URL, topic mappings, consumer group and runtime secret reference.
3. Test the bridge. Production requires authenticated live health plus Kafka connected; reference mode may retain a contract-only result.
4. Edit an agent manifest or action-boundary threshold. The server creates a content-addressed draft and copies unchanged objects from the active release.
5. Run schema, green-team, red-team, integration and promotion suites. Each suite persists checks, score and evidence hash.
6. Activate the validated release. The prior active release becomes the rollback target.
7. New event executions resolve active manifests and policy from D1; no application build or frontend deployment occurs.

Raw secret-like fields are rejected recursively. Configuration rows contain binding names, never passwords, tokens or API-key values. A blocked or corrupt active object fails closed.

## EMR and assessment activation

1. Inventory each source event, field, owner, sensitivity, valid-time semantics and correction behavior.
2. Map FHIR/HL7/source records into `contracts/canonical-event.schema.json`; keep raw-source pointers outside the canonical payload where required.
3. Calculate SHA-256 over the canonical `payload` exactly as sent.
4. Tokenize patient identifiers and provide tenant, purpose, source, valid time, recorded time and correlation IDs.
5. Validate structured answers deterministically. Treat free text as untrusted evidence; retain exact cited text and require human review for semantic facts.
6. Prove duplicate, out-of-order, late-correction, cross-patient and outage behavior with replay before shadow activation.
7. Start read-only. Keep every external write disabled until the organization approves its action-specific adapter.

## Command and acknowledgement activation

The reference command only requests a service-coordination review. It does not reserve a chair, change an order, notify a patient or write an EMR. A real downstream adapter must validate tenant, subject, purpose, action class, approval evidence, idempotency key and effective time again. Its acknowledgement must carry the command ID and observed outcome; transport success alone never proves the outcome.

## CMS activation

The reference pipeline creates a content-addressed, non-transmitted package from pinned measure/source versions. A production connector additionally needs deterministic measure parity, record-level reconciliation, dual approval, CMS/EQRS/NHSN credential isolation, submission receipts, rejection/resubmission handling and retained exact payloads. Proposed authority sources remain simulation-only.

## Promotion checklist

- contracts compatible and replayable;
- tenant/patient/purpose scope tests pass;
- gold sets and demographic/language slices pass;
- all applicable red scenarios are contained;
- authority sources are current, final and effective;
- action allowlists, role/scope rules and kill switches approved;
- SLO, cost, capacity, backpressure and recovery tests pass;
- security, privacy and clinical safety sign-off complete;
- rollback target and incident drill proven;
- ownership and on-call escalation recorded.
