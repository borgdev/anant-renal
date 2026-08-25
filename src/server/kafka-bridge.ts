/******************************************************************************
 * M-S3 — kafka-bridge: the deployable connection to the organization's brokers.
 *
 * The hosted worker intentionally terminates Kafka at authenticated HTTPS. The
 * bridge is the bounded connector on the harness side: it consumes canonical
 * topics from the transactional outbox, posts each row through integrity and
 * tenant validation, leases the row (only one worker owns a row at a time),
 * publishes with an idempotent producer (message key = event id) and records a
 * receipt or a terminal incident.
 *
 * Works identically against the portable SqlStore (prod) or the in-memory
 * MemoryBridgeStore (tests / embedded demo) via the BridgeStore seam.
 ******************************************************************************/

import type { CanonicalEvent } from '../healthcare-core/events.js';
import { decodeCanonicalEvent, type EventBroker } from './event-broker.js';
import type { BridgeCounts, BridgeReceiptRow, OutboxRow } from './sql/sql-store.js';

export interface BridgeReceipt {
  outboxId: string;
  topic: string;
  partitionKey: string;
  idempotencyKey: string;
  publishedAt: string;
  ackOffset?: number;
  state: 'delivered' | 'incident';
  incident?: string;
}

/** Persistence seam for the bridge — satisfied by SqlStore and MemoryBridgeStore. */
export interface BridgeStore {
  enqueueOutboxEvent(row: { id: string; topic: string; scopeId: string; eventJson: string; createdAt?: string }): Promise<void>;
  leaseBridgeOutbox(opts: { owner: string; limit?: number; leaseTtlMs?: number; now?: string }): Promise<OutboxRow[]>;
  releaseBridgeLease(outboxId: string, owner: string): Promise<void>;
  renewBridgeLease(outboxId: string, owner: string, attempts: number, error: string | null, until: string): Promise<void>;
  markBridgeTerminal(outboxId: string, owner: string, error: string): Promise<void>;
  recordBridgeReceipt(row: Omit<BridgeReceipt, never>): Promise<void>;
  markOutboxDelivered(id: string, deliveredAt?: string): Promise<boolean>;
  outboxCounts(): Promise<{ pending: number; delivered: number; dead: number }>;
  bridgeCounts(): Promise<BridgeCounts>;
  listBridgeReceipts(limit?: number): Promise<BridgeReceiptRow[]>;
}

export interface KafkaBridgeOptions {
  workerId: string;
  /** Lease TTL before another worker may re-own a row. */
  leaseTtlMs?: number;
  pollLimit?: number;
  /** Publish failures beyond this → terminal incident. */
  maxAttempts?: number;
  /** Integrity/tenant validation hook — return an error string to reject the row. */
  validate?: (event: CanonicalEvent, row: OutboxRow) => Promise<string | null> | string | null;
  onReceipt?: (receipt: BridgeReceipt) => void;
  onIncident?: (receipt: BridgeReceipt) => void;
}

export interface BridgePollResult {
  leased: number;
  published: number;
  retrying: number;
  incidents: number;
}

export interface BridgeStatus {
  workerId: string;
  driver: string;
  counts: BridgeCounts;
  outbox: { pending: number; delivered: number; dead: number };
  receipts: BridgeReceiptRow[];
}

/** Default integrity/tenant validation: every event must carry a tenant scope id. */
export function tenantValidation(event: CanonicalEvent): string | null {
  if (!event.scopeId || event.scopeId.trim().length === 0) return 'missing tenant scopeId';
  return null;
}

export class KafkaBridge {
  private readonly broker: EventBroker;
  private readonly workerId: string;
  private readonly leaseTtlMs: number;
  private readonly pollLimit: number;
  private readonly maxAttempts: number;
  private readonly validate: ((event: CanonicalEvent, row: OutboxRow) => Promise<string | null> | string | null) | undefined;
  private readonly onReceipt: ((receipt: BridgeReceipt) => void) | undefined;
  private readonly onIncident: ((receipt: BridgeReceipt) => void) | undefined;
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly store: BridgeStore,
    opts: KafkaBridgeOptions & { broker: EventBroker },
  ) {
    this.broker = opts.broker;
    this.workerId = opts.workerId;
    this.leaseTtlMs = opts.leaseTtlMs ?? 30_000;
    this.pollLimit = opts.pollLimit ?? 20;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.validate = opts.validate;
    this.onReceipt = opts.onReceipt;
    this.onIncident = opts.onIncident;
  }

  /** Drain one batch: lease → validate → publish → receipt / incident. */
  async pollOnce(now = new Date().toISOString()): Promise<BridgePollResult> {
    const result: BridgePollResult = { leased: 0, published: 0, retrying: 0, incidents: 0 };
    const rows = await this.store.leaseBridgeOutbox({ owner: this.workerId, limit: this.pollLimit, leaseTtlMs: this.leaseTtlMs, now });
    result.leased = rows.length;
    for (const row of rows) {
      const event = decodeCanonicalEvent(row.eventJson);
      if (!event || event.id !== row.id) {
        await this.fail(row, 'integrity-validation-failed', 'event undecodable or id mismatch', now);
        result.incidents += 1;
        continue;
      }
      const validationError = await this.validate?.(event, row);
      if (validationError) {
        await this.fail(row, 'tenant-validation-failed', validationError, now);
        result.incidents += 1;
        continue;
      }
      const outcome = await this.publish(row, event, now);
      if (outcome === 'published') result.published += 1;
      else if (outcome === 'incident') result.incidents += 1;
      else result.retrying += 1;
    }
    return result;
  }

  private async publish(row: OutboxRow, event: CanonicalEvent, now: string): Promise<'published' | 'retrying' | 'incident'> {
    const partitionKey = row.scopeId;
    try {
      await this.broker.publish(
        {
          topic: row.topic,
          event,
          headers: {
            'x-event-id': row.id,
            'x-bridge-worker': this.workerId,
            'x-idempotency-key': event.id,
            'x-partition-key': partitionKey,
          },
        },
        { partitionKey },
      );
      const receipt: BridgeReceipt = {
        outboxId: row.id, topic: row.topic, partitionKey, idempotencyKey: event.id,
        publishedAt: new Date().toISOString(), state: 'delivered',
      };
      await this.store.recordBridgeReceipt(receipt);
      await this.store.markOutboxDelivered(row.id, receipt.publishedAt);
      await this.store.releaseBridgeLease(row.id, this.workerId);
      this.onReceipt?.(receipt);
      return 'published';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const attempts = (row.bridgeAttempts ?? 0) + 1;
      if (attempts >= this.maxAttempts) {
        await this.fail(row, 'publish-terminal', message, now);
        return 'incident';
      }
      // Transient — renew the lease so the same worker retries inside the TTL.
      const until = new Date(Date.parse(now) + this.leaseTtlMs).toISOString();
      await this.store.renewBridgeLease(row.id, this.workerId, attempts, message, until);
      return 'retrying';
    }
  }

  private async fail(row: OutboxRow, code: string, message: string, _now: string): Promise<void> {
    const publishedAt = new Date().toISOString();
    const detail = `${code}: ${message}`;
    const receipt: BridgeReceipt = {
      outboxId: row.id, topic: row.topic, partitionKey: row.scopeId,
      idempotencyKey: `row:${row.id}`, publishedAt, state: 'incident', incident: detail,
    };
    await this.store.markBridgeTerminal(row.id, this.workerId, detail);
    await this.store.recordBridgeReceipt(receipt);
    this.onIncident?.(receipt);
  }

  async status(): Promise<BridgeStatus> {
    const [counts, outbox, receipts] = await Promise.all([
      this.store.bridgeCounts(),
      this.store.outboxCounts(),
      this.store.listBridgeReceipts(50),
    ]);
    return { workerId: this.workerId, driver: this.broker.driver, counts, outbox, receipts };
  }

  start(intervalMs = 1000): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => { void this.pollOnce().catch(() => undefined); }, intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    await this.broker.stop().catch(() => undefined);
  }
}

/** In-memory BridgeStore — for tests and the embedded demo (no SqlStore). */
export class MemoryBridgeStore implements BridgeStore {
  outbox: OutboxRow[] = [];
  private readonly leases = new Map<string, { owner: string; until: string; attempts: number; lastError: string | null; terminal: boolean; updatedAt: string }>();
  receipts: BridgeReceiptRow[] = [];

  enqueue(row: OutboxRow): void {
    this.outbox.push(row);
  }
  clear(): void {
    this.outbox = [];
    this.leases.clear();
    this.receipts = [];
  }

  async enqueueOutboxEvent(row: { id: string; topic: string; scopeId: string; eventJson: string; createdAt?: string }): Promise<void> {
    this.outbox.push({
      id: row.id, topic: row.topic, scopeId: row.scopeId, eventJson: row.eventJson,
      status: 'pending', attempts: 0, nextAttemptAt: null, lastError: null,
      createdAt: row.createdAt ?? new Date().toISOString(), deliveredAt: null,
    });
  }

  async leaseBridgeOutbox(opts: { owner: string; limit?: number; leaseTtlMs?: number; now?: string }): Promise<OutboxRow[]> {
    const now = opts.now ?? new Date().toISOString();
    const until = new Date(Date.parse(now) + (opts.leaseTtlMs ?? 30_000)).toISOString();
    // The owning worker may re-lease its own row immediately (retry loop);
    // other workers must wait for the lease TTL to expire.
    const eligible = this.outbox
      .filter((r) => r.status === 'pending')
      .filter((r) => {
        const l = this.leases.get(r.id);
        return !l || l.terminal || l.owner === opts.owner || l.until <= now;
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, opts.limit ?? 20);
    const leased: OutboxRow[] = [];
    for (const r of eligible) {
      const existing = this.leases.get(r.id);
      if (existing && !existing.terminal && existing.owner !== opts.owner && existing.until > now) continue;
      this.leases.set(r.id, { owner: opts.owner, until, attempts: existing?.attempts ?? 0, lastError: existing?.lastError ?? null, terminal: false, updatedAt: now });
      leased.push({ ...r, bridgeAttempts: this.leases.get(r.id)?.attempts ?? 0 });
    }
    return leased;
  }
  async releaseBridgeLease(outboxId: string, owner: string): Promise<void> {
    const l = this.leases.get(outboxId);
    if (l && l.owner === owner) this.leases.delete(outboxId);
  }
  async renewBridgeLease(outboxId: string, owner: string, attempts: number, error: string | null, until: string): Promise<void> {
    const l = this.leases.get(outboxId);
    if (l && l.owner === owner) { l.attempts = attempts; l.lastError = error; l.until = until; l.updatedAt = new Date().toISOString(); }
  }
  async markBridgeTerminal(outboxId: string, owner: string, error: string): Promise<void> {
    const l = this.leases.get(outboxId);
    if (l && l.owner === owner) { l.terminal = true; l.lastError = error; l.updatedAt = new Date().toISOString(); }
  }
  async recordBridgeReceipt(row: Omit<BridgeReceipt, never>): Promise<void> {
    this.receipts.unshift({ outboxId: row.outboxId, topic: row.topic, partitionKey: row.partitionKey, idempotencyKey: row.idempotencyKey, publishedAt: row.publishedAt, ackOffset: row.ackOffset ?? null, state: row.state, incident: row.incident ?? null });
    if (row.state === 'delivered') await this.markOutboxDelivered(row.outboxId, row.publishedAt);
  }
  async markOutboxDelivered(id: string, deliveredAt = new Date().toISOString()): Promise<boolean> {
    const row = this.outbox.find((o) => o.id === id);
    if (row && row.status === 'pending') { row.status = 'delivered'; row.deliveredAt = deliveredAt; row.attempts += 1; return true; }
    return false;
  }
  async outboxCounts(): Promise<{ pending: number; delivered: number; dead: number }> {
    const c = { pending: 0, delivered: 0, dead: 0 };
    for (const r of this.outbox) {
      if (r.status === 'pending') c.pending += 1;
      else if (r.status === 'delivered') c.delivered += 1;
      else if (r.status === 'dead') c.dead += 1;
    }
    return c;
  }
  async bridgeCounts(): Promise<BridgeCounts> {
    let active = 0; let terminal = 0;
    for (const l of this.leases.values()) { if (l.terminal) terminal += 1; else active += 1; }
    let receipts = 0; let incidents = 0;
    for (const r of this.receipts) { if (r.state === 'delivered') receipts += 1; else incidents += 1; }
    return { leases: active + terminal, activeLeases: active, receipts, incidents };
  }
  async listBridgeReceipts(limit = 100): Promise<BridgeReceiptRow[]> {
    return this.receipts.slice(0, limit);
  }
}

/** Seed a few canonical events into the outbox for the embedded bridge demo. */
export async function seedBridgeOutbox(store: BridgeStore, events: CanonicalEvent[], topic = 'anant.canonical.events'): Promise<number> {
  for (const ev of events) {
    await store.enqueueOutboxEvent({
      id: ev.id, topic, scopeId: ev.scopeId, eventJson: JSON.stringify(ev), createdAt: ev.occurredAt,
    });
  }
  return events.length;
}
