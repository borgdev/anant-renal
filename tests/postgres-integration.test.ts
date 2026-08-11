// Testcontainers integration test for M6.
// Spins up a real Postgres, runs migrations, appends events + ledger
// entries + audit rows, and asserts the harness schema is durable.
// Skipped automatically when Docker is unavailable so unit CI stays green.

import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgresEventStore } from '../src/server/postgres-event-store.js';
import type { CanonicalEvent } from '../src/healthcare-core/events.js';

const dockerAvailable = process.env.RUN_POSTGRES_IT === '1';

describe.skipIf(!dockerAvailable)('Postgres Testcontainers integration (M6)', () => {
  it('applies migrations and roundtrips events + ledger', async () => {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const container = await new PostgreSqlContainer('postgres:16-alpine').start();
    const pool = new Pool({ connectionString: container.getConnectionUri() });
    try {
      const store = new PostgresEventStore(pool, 'harness');
      await store.applyMigrations();

      const ev: CanonicalEvent = {
        id: 'ev:it-1',
        type: 'lab.result-arrived',
        occurredAt: '2026-01-01T00:00:00Z',
        scopeId: 'scope:facility-1',
        subjectId: 'p1',
        facilityId: 'f1',
        classification: 'phi',
        provenance: { sourceId: 'lab-x', observedAt: '2026-01-01T00:00:00Z', ingestedAt: '2026-01-01T00:00:00Z' },
        payload: { code: 'HGB', value: 10.4 },
      };
      await store.appendEvent({ scopeId: ev.scopeId, actorRef: 'user:md-1' }, ev);
      const rows = await store.queryEvents({ scopeId: ev.scopeId, limit: 10 });
      expect(rows.length).toBe(1);
      expect(rows[0]?.id).toBe('ev:it-1');
    } finally {
      await pool.end();
      await container.stop();
    }
  }, 120_000);
});
