# Renal harness Kafka bridge

The hosted product exposes authenticated HTTPS ingress and a durable D1 outbox. This small external service binds those interfaces to an existing Kafka estate without embedding raw Kafka sockets in the hosted web worker.

## Guarantees

- Kafka consumer offsets advance only after the runtime accepts a canonical, integrity-bearing event.
- `eventId` makes ingress idempotent across consumer redelivery.
- Approved commands enter a durable outbox before this bridge publishes them.
- Kafka producer idempotence and one in-flight request preserve ordered delivery per partition.
- Publication receipts are written back to the assurance ledger.
- The bridge never invents role authority and cannot approve an action.

## Run

```bash
npm install
KAFKA_BROKERS=broker-1:9092,broker-2:9092 \
HARNESS_BASE_URL=https://your-site.example \
RUNTIME_ADAPTER_TOKEN='at-least-24-secret-characters' \
npm start
```

Optional variables: `KAFKA_INPUT_TOPICS`, `KAFKA_CLIENT_ID`, `KAFKA_GROUP_ID`, `KAFKA_BRIDGE_INSTANCE_ID`, `OUTBOX_POLL_MS`, and `BRIDGE_PORT`. Give every replica a unique bridge instance ID; the runtime leases outbox rows for 60 seconds to prevent concurrent publication. Create the configured topics through the organization’s existing topic-management workflow; auto-creation is disabled.

The health endpoint is `GET /healthz` and requires `Authorization: Bearer <RUNTIME_ADAPTER_TOKEN>`. In Platform Admin, store only a runtime binding reference such as `binding:KAFKA_BRIDGE_TOKEN`; bind that value to the same secret in the hosted environment. TLS/SASL properties can be added to the `Kafka` client construction using the deployment’s secret manager; no credentials belong in this repository or the control-plane database.
