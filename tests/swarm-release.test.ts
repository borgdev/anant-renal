import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import type { PostgresEventStore } from '../src/server/postgres-event-store.js';
import type { CanonicalEvent, CanonicalEventType } from '../src/healthcare-core/events.js';
import type { LedgerEntry } from '../src/hypergraph/ledger.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import type { ActorContext } from '../src/server/scoped-persistence.js';
import { applyRedOverrides, demoReleaseInput, evaluateRelease } from '../src/swarm/release.js';
import { KafkaBridge, MemoryBridgeStore, seedBridgeOutbox, tenantValidation } from '../src/server/kafka-bridge.js';
import { EventBrokerError, type EventBroker, type EventBrokerDriver, type EventBrokerRecord, type EventBrokerPublishOptions } from '../src/server/event-broker.js';

const NOW = '2026-08-22T10:00:00.000Z';

function mkEvent(id: string, scopeId = 'realm:dialysis-1', type: CanonicalEventType = 'treatment.completed'): CanonicalEvent {
  return {
    id, type, occurredAt: NOW, scopeId, subjectId: 'pt:1', facilityId: 'fac:1',
    payload: {}, provenance: { sourceId: 'test', observedAt: NOW, ingestedAt: NOW }, classification: 'confidential',
  };
}

class RecordingBroker implements EventBroker {
  readonly driver: EventBrokerDriver = 'inprocess';
  published: Array<{ topic: string; event: CanonicalEvent; headers?: Readonly<Record<string, string>>; partitionKey?: string }> = [];
  failPublish = false;
  async publish(record: EventBrokerRecord, opts?: EventBrokerPublishOptions): Promise<void> {
    if (this.failPublish) throw new EventBrokerError('broker unavailable');
    this.published.push({ topic: record.topic, event: record.event, ...(record.headers ? { headers: record.headers } : {}), ...(opts?.partitionKey ? { partitionKey: opts.partitionKey } : {}) });
  }
  async subscribe(): Promise<void> { /* noop */ }
  async start(): Promise<void> { /* noop */ }
  async stop(): Promise<void> { /* noop */ }
  async health() { return { ok: true, driver: 'inprocess' as const }; }
  async deadLetterSize() { return 0; }
}

function inMemoryStore(): PostgresEventStore {
  const events: CanonicalEvent[] = [];
  const ledger: LedgerEntry[] = [];
  const audit: unknown[] = [];
  const store = {
    async applyMigrations() { /* noop */ },
    async appendEvent(_scope: { scopeId: string; actorRef: string }, ev: CanonicalEvent) { events.push(ev); },
    async queryEvents() { return events; },
    async ledgerAppend(_scope: { scopeId: string; actorRef: string }, e: LedgerEntry) { ledger.push(e); },
    async ledgerQuery() { return ledger; },
    async appendAudit(_scope: { scopeId: string; actorRef: string }, row: unknown) { audit.push(row); },
    async queryAudit() { return audit; },
    async recordFhirResource(_scope: { scopeId: string; actorRef: string }, r: unknown) { /* noop */ },
    async listFhirResources() { return []; },
  } as unknown as PostgresEventStore;
  return store;
}

const actor: ActorContext = { actorRef: 'user:test', scopeIds: ['scope:*'], clearance: 'restricted-phi', purposeOfUse: 'operations' } as ActorContext;

async function build() {
  return buildApp({
    store: inMemoryStore(),
    telemetry: new Telemetry('test', new InMemorySink()),
    packs: [healthcareCorePack],
    authenticate: async () => actor,
    checkHealth: async () => ({ db: true, redis: true }),
  });
}

describe('release gate (M-S3)', () => {
  it('baseline demo change ships (all green pass, red contained, sources current, approvals met)', () => {
    const input = demoReleaseInput();
    const v = evaluateRelease(input, NOW);
    expect(v.decision).toBe('ship');
    expect(v.score).toBe(1);
    expect(v.greenScore).toBe(1);
    expect(v.redOpen).toBe(0);
    expect(v.sourcesCurrent).toBe(true);
    expect(v.approvalsMet).toBe(true);
    expect(v.blocks).toEqual([]);
    expect(v.reasons).toEqual([]);
  });

  it('is deterministic — identical input yields an identical verdict', () => {
    const a = evaluateRelease(demoReleaseInput(), NOW);
    const b = evaluateRelease(demoReleaseInput(), NOW);
    expect(a).toEqual(b);
  });

  it('an uncontained red finding blocks the release', () => {
    const input = demoReleaseInput();
    const v = evaluateRelease({ ...input, red: input.red.map((r) => (r.id === 'red/stale-rule' ? { ...r, contained: false } : r)) }, NOW);
    expect(v.decision).toBe('block');
    expect(v.blocks).toContain('red:red/stale-rule');
    expect(v.redOpen).toBe(1);
  });

  it('a green fail blocks the release', () => {
    const input = demoReleaseInput();
    const green = input.green.map((g) => (g.id === 'goldset/parity' ? { ...g, status: 'fail' as const } : g));
    const v = evaluateRelease({ ...input, green }, NOW);
    expect(v.decision).toBe('block');
    expect(v.blocks).toContain('green:goldset/parity');
  });

  it('stale sources block the release', () => {
    const input = demoReleaseInput();
    const v = evaluateRelease({ ...input, sources: { current: 12, required: 14 } }, NOW);
    expect(v.decision).toBe('block');
    expect(v.blocks).toContain('sources-stale');
    expect(v.sourcesCurrent).toBe(false);
  });

  it('missing approvals holds the release (not blocked)', () => {
    const input = demoReleaseInput();
    const v = evaluateRelease({ ...input, approvals: { required: 2, granted: ['user:operator'] } }, NOW);
    expect(v.decision).toBe('hold');
    expect(v.blocks).toEqual([]);
    expect(v.reasons.some((r) => r.startsWith('approvals'))).toBe(true);
    expect(v.approvalsMet).toBe(false);
  });

  it('applyRedOverrides toggles containment without mutating the base', () => {
    const base = demoReleaseInput().red;
    const toggled = applyRedOverrides(base, [{ id: 'red/stale-rule', contained: false }]);
    expect(toggled.find((r) => r.id === 'red/stale-rule')?.contained).toBe(false);
    expect(base.find((r) => r.id === 'red/stale-rule')?.contained).toBe(true);
  });
});

describe('kafka-bridge (M-S3)', () => {
  function seededStore(n = 4): MemoryBridgeStore {
    const store = new MemoryBridgeStore();
    for (let i = 1; i <= n; i += 1) {
      store.enqueue({
        id: `evt:bridge-000${i}`, topic: 'anant.canonical.events', scopeId: 'realm:dialysis-1',
        eventJson: JSON.stringify(mkEvent(`evt:bridge-000${i}`)), status: 'pending', attempts: 0,
        nextAttemptAt: null, lastError: null, createdAt: NOW, deliveredAt: null,
      });
    }
    return store;
  }

  it('leases, validates, publishes with an idempotency key, records a delivered receipt and releases the lease', async () => {
    const store = seededStore(2);
    const broker = new RecordingBroker();
    const bridge = new KafkaBridge(store, { broker, workerId: 'bridge:test', validate: tenantValidation });
    const result = await bridge.pollOnce(NOW);
    expect(result.leased).toBe(2);
    expect(result.published).toBe(2);
    expect(result.incidents).toBe(0);
    expect(broker.published).toHaveLength(2);
    for (const p of broker.published) {
      expect(p.headers?.['x-idempotency-key']).toBe(p.event.id);
      expect(p.partitionKey).toBe('realm:dialysis-1');
    }
    const counts = await store.outboxCounts();
    expect(counts.pending).toBe(0);
    expect(counts.delivered).toBe(2);
    const status = await bridge.status();
    expect(status.counts.receipts).toBe(2);
    expect(status.counts.activeLeases).toBe(0); // delivered → lease released
  });

  it('does not double-publish — a second poll leases nothing for delivered rows', async () => {
    const store = seededStore(1);
    const broker = new RecordingBroker();
    const bridge = new KafkaBridge(store, { broker, workerId: 'bridge:test' });
    await bridge.pollOnce(NOW);
    const second = await bridge.pollOnce(NOW);
    expect(second.leased).toBe(0);
    expect(broker.published).toHaveLength(1);
  });

  it('enforces lease exclusivity — a second worker cannot lease a row owned by the first within TTL', async () => {
    const store = seededStore(1);
    const brokerA = new RecordingBroker();
    const brokerB = new RecordingBroker();
    brokerA.failPublish = true; // A retries → keeps the lease
    const bridgeA = new KafkaBridge(store, { broker: brokerA, workerId: 'bridge:a', maxAttempts: 5 });
    const rA = await bridgeA.pollOnce(NOW);
    expect(rA.leased).toBe(1);
    expect(rA.retrying).toBe(1);
    const bridgeB = new KafkaBridge(store, { broker: brokerB, workerId: 'bridge:b' });
    const rB = await bridgeB.pollOnce(NOW);
    expect(rB.leased).toBe(0); // exclusivity holds
    expect(brokerB.published).toHaveLength(0);
    // After the lease TTL expires, the row is leaseable again.
    const later = new Date(Date.parse(NOW) + 31_000).toISOString();
    const rB2 = await bridgeB.pollOnce(later);
    expect(rB2.leased).toBe(1);
  });

  it('tenant validation rejects a missing scopeId → terminal incident + receipt, no publish', async () => {
    const store = new MemoryBridgeStore();
    const bad = { ...mkEvent('evt:bad-tenant'), scopeId: '  ' };
    store.enqueue({
      id: bad.id, topic: 'anant.canonical.events', scopeId: bad.scopeId, eventJson: JSON.stringify(bad),
      status: 'pending', attempts: 0, nextAttemptAt: null, lastError: null, createdAt: NOW, deliveredAt: null,
    });
    const broker = new RecordingBroker();
    const bridge = new KafkaBridge(store, { broker, workerId: 'bridge:test', validate: tenantValidation });
    const result = await bridge.pollOnce(NOW);
    expect(result.incidents).toBe(1);
    expect(result.published).toBe(0);
    expect(broker.published).toHaveLength(0);
    const status = await bridge.status();
    expect(status.counts.incidents).toBe(1);
    expect(status.receipts[0]?.incident).toContain('tenant-validation-failed');
  });

  it('an undecodable outbox row → integrity incident', async () => {
    const store = new MemoryBridgeStore();
    store.enqueue({
      id: 'evt:garbage', topic: 'anant.canonical.events', scopeId: 'realm:dialysis-1', eventJson: 'not-json',
      status: 'pending', attempts: 0, nextAttemptAt: null, lastError: null, createdAt: NOW, deliveredAt: null,
    });
    const broker = new RecordingBroker();
    const bridge = new KafkaBridge(store, { broker, workerId: 'bridge:test' });
    const result = await bridge.pollOnce(NOW);
    expect(result.incidents).toBe(1);
    expect((await bridge.status()).receipts[0]?.incident).toContain('integrity-validation-failed');
  });

  it('transient publish failures retry within the lease, then become a terminal incident after maxAttempts', async () => {
    const store = seededStore(1);
    const broker = new RecordingBroker();
    broker.failPublish = true;
    const bridge = new KafkaBridge(store, { broker, workerId: 'bridge:test', maxAttempts: 3 });
    const r1 = await bridge.pollOnce(NOW);
    expect(r1.retrying).toBe(1);
    expect((await bridge.status()).counts.activeLeases).toBe(1);
    // Broker recovers mid-batch → the row publishes on a later poll.
    broker.failPublish = false;
    const r2 = await bridge.pollOnce(new Date(Date.parse(NOW) + 1000).toISOString());
    expect(r2.published).toBe(1);
    expect(broker.published).toHaveLength(1);
    expect((await bridge.status()).counts.incidents).toBe(0);
  });

  it('terminal incident after maxAttempts on persistent failure', async () => {
    const store = seededStore(1);
    const broker = new RecordingBroker();
    broker.failPublish = true;
    const bridge = new KafkaBridge(store, { broker, workerId: 'bridge:test', maxAttempts: 2 });
    const r1 = await bridge.pollOnce(NOW);
    expect(r1.retrying).toBe(1);
    const r2 = await bridge.pollOnce(new Date(Date.parse(NOW) + 1000).toISOString());
    expect(r2.incidents).toBe(1);
    const status = await bridge.status();
    expect(status.counts.incidents).toBe(1);
    expect(status.receipts[0]?.incident).toContain('publish-terminal');
  });

  it('seedBridgeOutbox enqueues events through the store seam', async () => {
    const store = new MemoryBridgeStore();
    const n = await seedBridgeOutbox(store, [mkEvent('evt:a'), mkEvent('evt:b')]);
    expect(n).toBe(2);
    expect((await store.outboxCounts()).pending).toBe(2);
  });
});

describe('release-gate + bridge admin routes', () => {
  it('GET /admin/platform/release-gate returns a shipping verdict', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/admin/platform/release-gate' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.verdict.decision).toBe('ship');
    expect(body.input.green.length).toBeGreaterThan(0);
  });

  it('POST /admin/platform/release-gate/evaluate blocks when a red finding is opened', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST', url: '/admin/platform/release-gate/evaluate',
      payload: { red: [{ id: 'red/stale-rule', contained: false }] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.verdict.decision).toBe('block');
    expect(body.verdict.blocks).toContain('red:red/stale-rule');
  });

  it('GET /admin/swarm/bridge reports a live worker status (SqlStore is wired by buildApp)', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/admin/swarm/bridge' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status.workerId).toMatch(/^bridge:/);
    expect(body.status.driver).toBeTruthy();
    expect(typeof body.status.counts.receipts).toBe('number');
  });

  it('POST /admin/swarm/bridge/seed then poll drains the outbox to delivered receipts', async () => {
    const app = await build();
    const seed = await app.inject({ method: 'POST', url: '/admin/swarm/bridge/seed' });
    expect(seed.statusCode).toBe(200);
    expect(seed.json().seeded).toBe(4);
    const poll = await app.inject({ method: 'POST', url: '/admin/swarm/bridge/poll' });
    expect(poll.statusCode).toBe(200);
    const body = poll.json();
    expect(body.published).toBe(4);
    expect(body.status.outbox.pending).toBe(0);
    expect(body.status.counts.receipts).toBeGreaterThanOrEqual(4);
  });
});
