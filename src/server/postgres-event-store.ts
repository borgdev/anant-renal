// Postgres-backed event store + mutation-ledger persistence.
//
// Design:
//   • Two tables live in the harness schema: `canonical_events` (the
//     domain-event stream) and `mutation_ledger` (the bitemporal hypergraph
//     ledger). Both are append-only. Both carry a `scope_id` column so RBAC
//     scoping happens at the SQL layer.
//   • Migrations are shipped inline (see `MIGRATIONS`) and run on
//     `applyMigrations()`. They are idempotent and forward-only.
//   • This module never mutates or deletes rows. Corrections are handled by
//     appending new rows (retraction rows in the ledger; new events in the
//     event stream with `provenance.correctionOf` set).

import { Pool, PoolClient } from 'pg';
import type { CanonicalEvent } from '../healthcare-core/events.js';
import type { LedgerEntry } from '../hypergraph/ledger.js';

export interface EventStoreScope {
  readonly scopeId: string;
  readonly actorRef: string;
}

export interface EventQuery {
  readonly scopeId: string;
  readonly types?: readonly string[];
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;
}

export interface LedgerQuery {
  readonly scopeId: string;
  readonly transactionAt?: string;
  readonly kinds?: readonly LedgerEntry['kind'][];
  readonly limit?: number;
}

export const MIGRATIONS: readonly string[] = Object.freeze([
  `CREATE SCHEMA IF NOT EXISTS __schema__;`,
  `CREATE TABLE IF NOT EXISTS __schema__.canonical_events (
     id                TEXT PRIMARY KEY,
     scope_id          TEXT NOT NULL,
     subject_id        TEXT NOT NULL,
     facility_id       TEXT NOT NULL,
     type              TEXT NOT NULL,
     classification    TEXT NOT NULL,
     occurred_at       TIMESTAMPTZ NOT NULL,
     ingested_at       TIMESTAMPTZ NOT NULL,
     provenance        JSONB NOT NULL,
     payload           JSONB NOT NULL
   );`,
  `CREATE INDEX IF NOT EXISTS canonical_events_scope_type_time
     ON __schema__.canonical_events (scope_id, type, occurred_at DESC);`,
  `CREATE INDEX IF NOT EXISTS canonical_events_subject
     ON __schema__.canonical_events (scope_id, subject_id, occurred_at DESC);`,
  `CREATE TABLE IF NOT EXISTS __schema__.mutation_ledger (
     id                TEXT PRIMARY KEY,
     scope_id          TEXT NOT NULL,
     kind              TEXT NOT NULL,
     valid_from        TIMESTAMPTZ NOT NULL,
     valid_to          TIMESTAMPTZ NULL,
     transaction_at    TIMESTAMPTZ NOT NULL,
     retracted_at      TIMESTAMPTZ NULL,
     predecessor_id    TEXT NULL,
     actor_ref         TEXT NOT NULL,
     reason            TEXT NULL,
     payload           JSONB NOT NULL
   );`,
  `CREATE INDEX IF NOT EXISTS mutation_ledger_scope_time
     ON __schema__.mutation_ledger (scope_id, transaction_at DESC);`,
  `CREATE INDEX IF NOT EXISTS mutation_ledger_valid_from
     ON __schema__.mutation_ledger (scope_id, valid_from);`,
  `CREATE TABLE IF NOT EXISTS __schema__.audit_chain (
     sequence         BIGINT PRIMARY KEY,
     hash             TEXT NOT NULL,
     previous_hash    TEXT NOT NULL,
     scope_id         TEXT NOT NULL,
     actor_ref        TEXT NOT NULL,
     action           TEXT NOT NULL,
     trace_id         TEXT NOT NULL,
     occurred_at      TIMESTAMPTZ NOT NULL,
     payload          JSONB NOT NULL
   );`,
  `CREATE INDEX IF NOT EXISTS audit_chain_scope_time
     ON __schema__.audit_chain (scope_id, occurred_at DESC);`,
  // ---- Agent + billing + facility-config additions ----
  `CREATE TABLE IF NOT EXISTS __schema__.agent_spec_mirror (
     agent_id TEXT NOT NULL,
     version TEXT NOT NULL,
     pack_id TEXT NOT NULL,
     source TEXT NOT NULL CHECK (source IN ('git', 'studio')),
     git_sha TEXT,
     yaml_body TEXT NOT NULL,
     parsed_json JSONB NOT NULL,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_by TEXT NOT NULL,
     PRIMARY KEY (agent_id, version)
   );`,
  `CREATE INDEX IF NOT EXISTS agent_spec_mirror_pack_idx ON __schema__.agent_spec_mirror (pack_id);`,
  `CREATE TABLE IF NOT EXISTS __schema__.agent_runs (
     run_id TEXT PRIMARY KEY,
     agent_id TEXT NOT NULL,
     agent_version TEXT NOT NULL,
     scope_id TEXT NOT NULL,
     facility_id TEXT,
     status TEXT NOT NULL,
     started_at TIMESTAMPTZ NOT NULL,
     ended_at TIMESTAMPTZ,
     trigger JSONB NOT NULL,
     inputs JSONB NOT NULL,
     outputs JSONB,
     error JSONB,
     trace_id TEXT NOT NULL,
     parent_run_id TEXT
   );`,
  `CREATE INDEX IF NOT EXISTS agent_runs_scope_idx ON __schema__.agent_runs (scope_id, started_at DESC);`,
  `CREATE INDEX IF NOT EXISTS agent_runs_agent_idx ON __schema__.agent_runs (agent_id, started_at DESC);`,
  `CREATE TABLE IF NOT EXISTS __schema__.agent_run_steps (
     step_uid TEXT PRIMARY KEY,
     run_id TEXT NOT NULL REFERENCES __schema__.agent_runs(run_id) ON DELETE CASCADE,
     step_id TEXT NOT NULL,
     skill_id TEXT NOT NULL,
     started_at TIMESTAMPTZ NOT NULL,
     ended_at TIMESTAMPTZ,
     status TEXT NOT NULL,
     inputs JSONB NOT NULL,
     outputs JSONB,
     error JSONB,
     cost_usd NUMERIC(12,6) DEFAULT 0,
     metered_units JSONB DEFAULT '[]'::jsonb
   );`,
  `CREATE INDEX IF NOT EXISTS agent_run_steps_run_idx ON __schema__.agent_run_steps (run_id, started_at ASC);`,
  `CREATE TABLE IF NOT EXISTS __schema__.metering_events (
     event_id TEXT PRIMARY KEY,
     scope_id TEXT NOT NULL,
     facility_id TEXT,
     agent_id TEXT NOT NULL,
     run_id TEXT NOT NULL,
     step_uid TEXT,
     unit TEXT NOT NULL,
     quantity NUMERIC(18,6) NOT NULL,
     unit_price_usd NUMERIC(12,6) NOT NULL,
     total_usd NUMERIC(14,6) NOT NULL,
     currency TEXT NOT NULL DEFAULT 'USD',
     occurred_at TIMESTAMPTZ NOT NULL,
     billing_period TEXT NOT NULL,
     invoiced BOOLEAN NOT NULL DEFAULT FALSE
   );`,
  `CREATE INDEX IF NOT EXISTS metering_events_scope_period ON __schema__.metering_events (scope_id, billing_period);`,
  `CREATE INDEX IF NOT EXISTS metering_events_facility_period ON __schema__.metering_events (facility_id, billing_period);`,
  `CREATE TABLE IF NOT EXISTS __schema__.invoices (
     invoice_id TEXT PRIMARY KEY,
     scope_id TEXT NOT NULL,
     facility_id TEXT,
     billing_period TEXT NOT NULL,
     total_usd NUMERIC(14,6) NOT NULL,
     line_items JSONB NOT NULL,
     issued_at TIMESTAMPTZ NOT NULL,
     paid_at TIMESTAMPTZ
   );`,
  `CREATE TABLE IF NOT EXISTS __schema__.facility_config (
     config_id TEXT PRIMARY KEY,
     scope_level TEXT NOT NULL CHECK (scope_level IN ('org', 'region', 'facility')),
     scope_id TEXT NOT NULL,
     category TEXT NOT NULL,
     key TEXT NOT NULL,
     value JSONB NOT NULL,
     valid_from TIMESTAMPTZ NOT NULL,
     valid_to TIMESTAMPTZ,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_by TEXT NOT NULL,
     UNIQUE (scope_level, scope_id, category, key, valid_from)
   );`,
  `CREATE INDEX IF NOT EXISTS facility_config_lookup ON __schema__.facility_config (category, key, scope_level, scope_id);`,
  `CREATE TABLE IF NOT EXISTS __schema__.job_dedup (
     key TEXT PRIMARY KEY,
     processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   );`,
  `CREATE TABLE IF NOT EXISTS __schema__.hitl_gates (
     gate_id TEXT PRIMARY KEY,
     run_id TEXT NOT NULL,
     step_id TEXT NOT NULL,
     role_required TEXT NOT NULL,
     opened_at TIMESTAMPTZ NOT NULL,
     sla_deadline TIMESTAMPTZ NOT NULL,
     resolved_at TIMESTAMPTZ,
     resolved_by TEXT,
     decision TEXT,
     rationale TEXT
   );`,
]);

export class PostgresEventStore {
  constructor(private readonly pool: Pool, private readonly schema: string) {}

  private q(sql: string): string {
    return sql.replaceAll('__schema__', this.schema);
  }

  async applyMigrations(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const m of MIGRATIONS) await client.query(this.q(m));
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async appendEvent(scope: EventStoreScope, event: CanonicalEvent): Promise<void> {
    await this.pool.query(
      this.q(`INSERT INTO __schema__.canonical_events
              (id, scope_id, subject_id, facility_id, type, classification, occurred_at, ingested_at, provenance, payload)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)`),
      [
        event.id, scope.scopeId, event.subjectId, event.facilityId, event.type, event.classification,
        event.occurredAt, event.provenance.ingestedAt,
        JSON.stringify(event.provenance), JSON.stringify(event.payload),
      ],
    );
  }

  async queryEvents(q: EventQuery): Promise<readonly CanonicalEvent[]> {
    const params: unknown[] = [q.scopeId];
    let sql = this.q(`SELECT id, scope_id, subject_id, facility_id, type, classification,
                             occurred_at, ingested_at, provenance, payload
                        FROM __schema__.canonical_events
                       WHERE scope_id = $1`);
    if (q.types && q.types.length > 0) { params.push(q.types); sql += ` AND type = ANY($${params.length}::text[])`; }
    if (q.since) { params.push(q.since); sql += ` AND occurred_at >= $${params.length}`; }
    if (q.until) { params.push(q.until); sql += ` AND occurred_at < $${params.length}`; }
    sql += ` ORDER BY occurred_at ASC`;
    if (q.limit) { params.push(q.limit); sql += ` LIMIT $${params.length}`; }
    const res = await this.pool.query(sql, params);
    return res.rows.map(rowToEvent);
  }

  async appendLedger(scopeId: string, entry: LedgerEntry): Promise<void> {
    const payload = ledgerPayload(entry);
    await this.pool.query(
      this.q(`INSERT INTO __schema__.mutation_ledger
              (id, scope_id, kind, valid_from, valid_to, transaction_at, retracted_at, predecessor_id, actor_ref, reason, payload)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`),
      [
        entry.id, scopeId, entry.kind, entry.validFrom, entry.validTo ?? null, entry.transactionAt,
        entry.retractedAt ?? null, entry.predecessorId ?? null, entry.actorRef, entry.reason ?? null,
        JSON.stringify(payload),
      ],
    );
  }

  async queryLedger(q: LedgerQuery): Promise<readonly LedgerEntry[]> {
    const params: unknown[] = [q.scopeId];
    let sql = this.q(`SELECT id, kind, valid_from, valid_to, transaction_at, retracted_at,
                             predecessor_id, actor_ref, reason, payload
                        FROM __schema__.mutation_ledger
                       WHERE scope_id = $1`);
    if (q.kinds && q.kinds.length > 0) { params.push(q.kinds); sql += ` AND kind = ANY($${params.length}::text[])`; }
    if (q.transactionAt) { params.push(q.transactionAt); sql += ` AND transaction_at <= $${params.length}`; }
    sql += ` ORDER BY transaction_at ASC, id ASC`;
    if (q.limit) { params.push(q.limit); sql += ` LIMIT $${params.length}`; }
    const res = await this.pool.query(sql, params);
    return res.rows.map(rowToLedger);
  }

  async appendAudit(row: {
    sequence: number; hash: string; previousHash: string; scopeId: string;
    actorRef: string; action: string; traceId: string; occurredAt: string; payload: unknown;
  }): Promise<void> {
    await this.pool.query(
      this.q(`INSERT INTO __schema__.audit_chain
              (sequence, hash, previous_hash, scope_id, actor_ref, action, trace_id, occurred_at, payload)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`),
      [row.sequence, row.hash, row.previousHash, row.scopeId, row.actorRef, row.action, row.traceId, row.occurredAt, JSON.stringify(row.payload)],
    );
  }

  /** Escape-hatch execute for extension modules. Use sparingly. */
  async execRaw(sql: string, params: readonly unknown[]): Promise<void> {
    await this.pool.query(this.q(sql), params as unknown[]);
  }
  /** Escape-hatch query for extension modules. */
  async queryRaw<T = Record<string, unknown>>(sql: string, params: readonly unknown[]): Promise<T[]> {
    const res = await this.pool.query(this.q(sql), params as unknown[]);
    return res.rows as T[];
  }

  /** Transaction helper. */
  async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

function rowToEvent(row: Record<string, unknown>): CanonicalEvent {
  return {
    id: row['id'] as string,
    type: row['type'] as CanonicalEvent['type'],
    occurredAt: (row['occurred_at'] as Date).toISOString(),
    scopeId: row['scope_id'] as string,
    subjectId: row['subject_id'] as string,
    facilityId: row['facility_id'] as string,
    classification: row['classification'] as CanonicalEvent['classification'],
    provenance: row['provenance'] as CanonicalEvent['provenance'],
    payload: row['payload'] as CanonicalEvent['payload'],
  };
}

function rowToLedger(row: Record<string, unknown>): LedgerEntry {
  const base = {
    id: row['id'] as string,
    kind: row['kind'] as LedgerEntry['kind'],
    validFrom: (row['valid_from'] as Date).toISOString(),
    ...(row['valid_to'] ? { validTo: (row['valid_to'] as Date).toISOString() } : {}),
    transactionAt: (row['transaction_at'] as Date).toISOString(),
    ...(row['retracted_at'] ? { retractedAt: (row['retracted_at'] as Date).toISOString() } : {}),
    ...(row['predecessor_id'] ? { predecessorId: row['predecessor_id'] as string } : {}),
    actorRef: row['actor_ref'] as string,
    ...(row['reason'] ? { reason: row['reason'] as string } : {}),
    scopeId: row['scope_id'] as string ?? '',
  };
  const payload = row['payload'] as Record<string, unknown>;
  return { ...base, ...payload } as LedgerEntry;
}

function ledgerPayload(entry: LedgerEntry): Record<string, unknown> {
  switch (entry.kind) {
    case 'node.assert': return { node: entry.node };
    case 'node.retract': return { nodeId: entry.nodeId };
    case 'edge.assert': return { edge: entry.edge };
    case 'edge.retract': return { edgeId: entry.edgeId };
    case 'edge.supersede': return { predecessorEdgeId: entry.predecessorEdgeId, successor: entry.successor };
  }
}
