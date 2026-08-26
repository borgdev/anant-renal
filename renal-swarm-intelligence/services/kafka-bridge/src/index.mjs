import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { Kafka, logLevel } from "kafkajs";

const config = {
  brokers: required("KAFKA_BROKERS").split(",").map((value) => value.trim()).filter(Boolean),
  clientId: process.env.KAFKA_CLIENT_ID ?? "renal-harness-bridge",
  groupId: process.env.KAFKA_GROUP_ID ?? "renal-harness-runtime-v1",
  instanceId: process.env.KAFKA_BRIDGE_INSTANCE_ID ?? `${process.env.KAFKA_CLIENT_ID ?? "renal-harness-bridge"}-${process.pid}`,
  inputTopics: (process.env.KAFKA_INPUT_TOPICS ?? "adt.discharge.v2,assessment.response.v1,facility.capacity.changed.v2,staffing.coverage.changed.v1,quality.measure.changed.v1,claim.status.changed.v2,cms.submission.gap.v1,machine.maintenance.signal.v1,referral.received.v1,experience.response.v1").split(",").map((value) => value.trim()).filter(Boolean),
  baseUrl: required("HARNESS_BASE_URL").replace(/\/$/, ""),
  token: required("RUNTIME_ADAPTER_TOKEN"),
  pollMs: positiveNumber(process.env.OUTBOX_POLL_MS, 1500),
  port: positiveNumber(process.env.BRIDGE_PORT, 8788),
};

const kafka = new Kafka({ clientId: config.clientId, brokers: config.brokers, logLevel: logLevel.INFO, retry: { initialRetryTime: 300, retries: 8 } });
const consumer = kafka.consumer({ groupId: config.groupId, allowAutoTopicCreation: false });
const producer = kafka.producer({ allowAutoTopicCreation: false, idempotent: true, maxInFlightRequests: 1 });
let running = true;
let draining = false;
const health = { startedAt: new Date().toISOString(), connected: false, consumed: 0, published: 0, rejected: 0, lastError: null };

await Promise.all([consumer.connect(), producer.connect()]);
health.connected = true;
for (const topic of config.inputTopics) await consumer.subscribe({ topic, fromBeginning: false });

await consumer.run({
  eachMessage: async ({ topic, partition, message, heartbeat }) => {
    const raw = message.value?.toString("utf8") ?? "";
    try {
      const event = JSON.parse(raw);
      const response = await runtimeRequest("/api/runtime", { method: "POST", body: { action: "ingest", event } });
      if (!response.ok) throw new Error(`ingress ${response.status}: ${await response.text()}`);
      health.consumed += 1;
      health.lastError = null;
      await heartbeat();
    } catch (error) {
      health.rejected += 1;
      health.lastError = `${topic}[${partition}]: ${messageFor(error)}`;
      throw error;
    }
  },
});

const outboxTimer = setInterval(() => void drainOutbox(), config.pollMs);
outboxTimer.unref();
void drainOutbox();

const server = http.createServer((request, response) => {
  if (request.url === "/healthz") {
    if (!authorizedProbe(request.headers.authorization)) {
      response.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ status: "unauthorized" }));
      return;
    }
    response.writeHead(health.connected ? 200 : 503, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: health.connected ? "healthy" : "unhealthy", kafka: health.connected ? "connected" : "disconnected", ...health, inputTopics: config.inputTopics, groupId: config.groupId }));
    return;
  }
  response.writeHead(404).end();
});
server.listen(config.port);

function authorizedProbe(authorization) {
  const expected = Buffer.from(`Bearer ${config.token}`);
  const observed = Buffer.from(authorization ?? "");
  return observed.length === expected.length && timingSafeEqual(observed, expected);
}

async function drainOutbox() {
  if (!running || draining) return;
  draining = true;
  try {
    const response = await runtimeRequest("/api/runtime/outbox");
    if (!response.ok) throw new Error(`outbox ${response.status}: ${await response.text()}`);
    const payload = await response.json();
    for (const item of payload.messages ?? []) {
      try {
        const result = await producer.send({ topic: item.topic, messages: [{ key: item.messageKey, value: JSON.stringify(item.envelope), headers: { "x-outbox-id": item.outboxId, "x-content-hash": item.envelope?.integrity?.contentHash ?? "" } }] });
        await recordDelivery(item.outboxId, "published", { baseOffset: result[0]?.baseOffset, partition: result[0]?.partition });
        health.published += 1;
        health.lastError = null;
      } catch (error) {
        health.lastError = `publish ${item.outboxId}: ${messageFor(error)}`;
        await recordDelivery(item.outboxId, "failed", { error: messageFor(error) });
      }
    }
  } catch (error) {
    health.lastError = messageFor(error);
  } finally {
    draining = false;
  }
}

async function recordDelivery(outboxId, status, metadata) {
  const response = await runtimeRequest("/api/runtime/outbox", { method: "POST", body: { outboxId, status, metadata } });
  if (!response.ok) throw new Error(`delivery receipt ${response.status}: ${await response.text()}`);
}

async function runtimeRequest(path, options = {}) {
  return fetch(`${config.baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json", "x-bridge-id": config.instanceId },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
}

async function shutdown(signal) {
  if (!running) return;
  running = false;
  clearInterval(outboxTimer);
  health.connected = false;
  server.close();
  await Promise.allSettled([consumer.disconnect(), producer.disconnect()]);
  process.stdout.write(`${signal}: renal harness Kafka bridge stopped\n`);
}

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void shutdown(signal));

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveNumber(value, fallback) {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function messageFor(error) {
  return error instanceof Error ? error.message : String(error);
}
