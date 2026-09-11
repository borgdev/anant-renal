/******************************************************************************
 * Durability and silent-failure regressions.
 *
 * Every assertion here guards a defect that produced NO error at runtime: the
 * system answered 200 while state was absent, discarded, or unreadable. The tests
 * are written against the mechanism (alias folding, kind registration, hydration
 * accounting, write-through) rather than any one endpoint, because the failure
 * mode is always the same shape — a durable path that quietly stops being used.
 ******************************************************************************/

import { describe, it, expect } from 'vitest';
import { aliasNames, restoreAliasCase } from '../src/server/sql/sql-db.js';
import { MIGRATIONS, WIDEN_TO_BIGINT } from '../src/server/sql/schema.js';
import { SqlStore } from '../src/server/sql/sql-store.js';
import { SwarmWorkspaceStore, WORKSPACE_KINDS, type WorkspacePersistence } from '../src/swarm/workspace.js';
import { LocalUserStore, seedDefaultUsers, sqlUserPersistence, type LocalUser, type UserPersistence } from '../src/server/auth/users.js';
import { SessionManager } from '../src/server/auth/session.js';

describe('Postgres alias casing', () => {
  it('extracts declared aliases and ignores others', () => {
    const aliases = aliasNames('SELECT entity_json AS entityJson, created_at AS createdAt FROM t');
    expect(aliases).toContain('entityJson');
    expect(aliases).toContain('createdAt');
  });

  it('restores camelCase keys from the lower-cased keys Postgres returns', () => {
    // Postgres folds unquoted identifiers: `AS entityJson` arrives as `entityjson`.
    const row = { entityjson: '{"a":1}', createdat: 'now', updatedat: 'now' };
    const fixed = restoreAliasCase(row, 'SELECT entity_json AS entityJson, created_at AS createdAt, updated_at AS updatedAt FROM t') as Record<string, unknown>;
    expect(fixed.entityJson).toBe('{"a":1}');
    expect(fixed.createdAt).toBe('now');
    expect(fixed.updatedAt).toBe('now');
    // the original lower-case key is preserved so either spelling works
    expect(row.entityjson).toBe('{"a":1}');
  });

  it('leaves a row untouched when the alias already matches', () => {
    const row = { n: 3 };
    expect(restoreAliasCase(row, 'SELECT count(*) AS n FROM t')).toBe(row);
  });

  it('does not invent keys that the query never selected', () => {
    const row = { other: 1 };
    const fixed = restoreAliasCase(row, 'SELECT x AS entityJson FROM t') as Record<string, unknown>;
    expect(fixed).not.toHaveProperty('entityJson');
    expect(fixed).toHaveProperty('other');
  });
});

describe('millisecond columns are 64-bit', () => {
  it('declares the ms/epoch columns as BIGINT', () => {
    const ddl = MIGRATIONS.join('\n');
    // 30-day retention is 2.592e9, past INT4's 2.147e9 ceiling
    expect(ddl).toMatch(/max_age_ms BIGINT NOT NULL/);
    // session expiry is epoch ms (~1.8e12) — as INTEGER this broke every login
    expect(ddl).toMatch(/expires_at BIGINT NOT NULL/);
    expect(ddl).not.toMatch(/max_age_ms INTEGER/);
    expect(ddl).not.toMatch(/expires_at INTEGER/);
  });

  it('widens pre-existing databases, Postgres only', () => {
    expect(WIDEN_TO_BIGINT.join('\n')).toMatch(/ALTER COLUMN max_age_ms TYPE BIGINT/);
    expect(WIDEN_TO_BIGINT.join('\n')).toMatch(/ALTER COLUMN expires_at TYPE BIGINT/);
    // SQLite has no ALTER COLUMN; including it would break the SQLite path
    expect(new Set(WIDEN_TO_BIGINT.map((s) => s.split(' ')[2]))).toEqual(
      new Set(['retention_policies', 'auth_sessions', 'bridge_leases']),
    );
  });

  it('reads a BIGINT back as a number, because Postgres returns it as a string', async () => {
    // Declaring a column `number` in TypeScript does not make the driver return
    // one. On Postgres a restored session's `expires_at` arrived as "1789…", so
    // `new Date(session.expiresAt)` produced an Invalid Date and `toISOString()`
    // threw `Invalid time value` — a 500 on GET /auth/me that ALSO meant the
    // durable session restore never worked. SQLite returns a number, which is why
    // every SQLite test passed.
    const rows = [
      { tokenHash: 'h1', username: 'admin', createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '1790000000000' },
      { tokenHash: 'h2', username: 'nurse', createdAt: '2026-01-01T00:00:00.000Z', expiresAt: 1790000000000 },
    ];
    const db = {
      async all() { return rows; },
      async run() { return { changes: 0 }; },
      async exec() { /* noop */ },
    };
    const store = new SqlStore(db as never);
    const sessions = await store.listSessions();
    for (const s of sessions) {
      expect(typeof s.expiresAt).toBe('number');
      // the exact operation that used to throw
      expect(() => new Date(s.expiresAt).toISOString()).not.toThrow();
    }
    expect(sessions[0]!.expiresAt).toBe(sessions[1]!.expiresAt);
  });

  it('coerces the other BIGINT columns the same way', async () => {
    const db = {
      async all(sql: string) {
        if (sql.includes('retention_policies')) {
          return [{ id: 'p1', entity: 'audit_events', scopeId: null, maxAgeMs: '2592000000', enabled: true }];
        }
        if (sql.includes('bridge_receipts')) {
          return [{ outboxId: 'o1', topic: 't', partitionKey: null, idempotencyKey: 'k', publishedAt: 'now', ackOffset: '42', state: 'delivered', incident: null }];
        }
        return [];
      },
      async run() { return { changes: 0 }; },
      async exec() { /* noop */ },
    };
    const store = new SqlStore(db as never);
    const policies = await store.listRetentionPolicies();
    expect(policies[0]!.maxAgeMs).toBe(2_592_000_000);
    // a purge window computed from a string would be a silent zero
    expect(Date.now() - policies[0]!.maxAgeMs).toBeLessThan(Date.now());
    const receipts = await store.listBridgeReceipts();
    expect(receipts[0]!.ackOffset).toBe(42);
  });
});

describe('workspace hydration', () => {
  const docs = [
    { kind: 'cohort-definition', id: 'c1', entityJson: JSON.stringify({ definitionId: 'c1', label: 'One', createdAt: 'a', updatedAt: 'b' }) },
    { kind: 'cohort-decision', id: 'c1::p1::decline', entityJson: JSON.stringify({ cohortId: 'c1', patientId: 'p1', action: 'decline', reason: 'r', actor: 'a', criterionVersion: '1.0.0', suggestionReason: 's', confidence: 1, risk: 1, at: 'now', createdAt: 'a', updatedAt: 'b' }) },
  ];

  it('registers every durable kind it can write', () => {
    // A kind that can be persisted but is not listed here is written and then
    // never read back: the decline survived in the table and vanished from the
    // system after a restart.
    expect(WORKSPACE_KINDS).toContain('cohort-definition');
    expect(WORKSPACE_KINDS).toContain('cohort-membership');
    expect(WORKSPACE_KINDS).toContain('cohort-decision');
  });

  it('loads documents written by a previous process', async () => {
    const persistence: WorkspacePersistence = {
      list: async (kind) => docs.filter((d) => d.kind === kind).map(({ id, entityJson }) => ({ id, entityJson, createdAt: 'a', updatedAt: 'b' })),
      save: async () => undefined,
      remove: async () => undefined,
    };
    const store = new SwarmWorkspaceStore(persistence);
    const defs = await store.listCohortDefinitions();
    expect(defs.map((d) => d.id)).toEqual(['c1']);
    expect(await store.cohortDecisions('c1')).toHaveLength(1);
  });

  it('refuses to report success when every durable row was unreadable', async () => {
    // This is the exact shape of the alias-casing bug: rows are returned, none
    // parse, and the old code swallowed each failure — so a populated table
    // hydrated to an empty system with no error anywhere.
    const broken: WorkspacePersistence = {
      list: async () => [{ id: 'x', entityJson: undefined as unknown as string, createdAt: 'a', updatedAt: 'b' }],
      save: async () => undefined,
      remove: async () => undefined,
    };
    const store = new SwarmWorkspaceStore(broken);
    await expect(store.listCohortDefinitions()).rejects.toThrow(/hydrate failed/);
  });
});

describe('console users are durable', () => {
  function memoryPersistence(): UserPersistence & { rows: Map<string, LocalUser> } {
    const rows = new Map<string, LocalUser>();
    return {
      rows,
      list: async () => [...rows.values()],
      save: async (u) => { rows.set(u.username, u); },
      remove: async (username) => { rows.delete(username); },
    };
  }

  it('writes a created user through, and a new process reads it back', async () => {
    const persistence = memoryPersistence();
    const first = new LocalUserStore();
    first.attachPersistence(persistence);
    first.create({ username: 'renal.nurse', password: 'secret1', displayName: 'Renal Nurse', role: 'nurse' });
    await new Promise((r) => setTimeout(r, 0)); // write-through is fire-and-forget

    // a fresh process: nothing in memory, everything from the store
    const second = new LocalUserStore();
    second.attachPersistence(persistence);
    expect(await second.restore()).toBe(1);
    seedDefaultUsers(second);
    expect(second.get('renal.nurse')?.displayName).toBe('Renal Nurse');
    // the seeded defaults are still available for first-time login
    expect(second.get('admin')).toBeDefined();
  });

  it('does not let a shipped seed overwrite a restored account', async () => {
    const persistence = memoryPersistence();
    const store = new LocalUserStore();
    store.attachPersistence(persistence);
    store.create({ username: 'admin', password: 'changed-by-operator', role: 'admin' });
    await new Promise((r) => setTimeout(r, 0));

    const restarted = new LocalUserStore();
    restarted.attachPersistence(persistence);
    await restarted.restore();
    seedDefaultUsers(restarted);
    // the operator's password still works; the shipped default does not
    expect(restarted.verify('admin', 'changed-by-operator')).not.toBeNull();
    expect(restarted.verify('admin', 'admin123')).toBeNull();
  });

  it('persists a password reset and a removal', async () => {
    const persistence = memoryPersistence();
    const store = new LocalUserStore();
    store.attachPersistence(persistence);
    store.create({ username: 'rn', password: 'first1', role: 'nurse' });
    store.resetPassword('rn', 'second2');
    await new Promise((r) => setTimeout(r, 0));

    const restarted = new LocalUserStore();
    restarted.attachPersistence(persistence);
    await restarted.restore();
    expect(restarted.verify('rn', 'second2')).not.toBeNull();

    restarted.remove('rn');
    await new Promise((r) => setTimeout(r, 0));
    expect(persistence.rows.has('rn')).toBe(false);
  });

  it('survives a failing store without breaking login', async () => {
    const store = new LocalUserStore();
    store.attachPersistence({
      list: async () => [],
      save: async () => { throw new Error('store down'); },
      remove: async () => { throw new Error('store down'); },
    });
    // the user is created and can authenticate even though durability failed
    expect(store.create({ username: 'rn', password: 'pw12345' }).username).toBe('rn');
    expect(store.verify('rn', 'pw12345')).not.toBeNull();
  });

  it('drops sessions whose account no longer exists', () => {
    const sessions = new SessionManager();
    const alive = sessions.create('admin');
    const orphan = sessions.create('deleted-user');
    const dropped = sessions.pruneUnknownUsers(new Set(['admin']));
    expect(dropped).toBe(1);
    expect(sessions.get(alive)).toBeDefined();
    // a deleted account must not keep authenticating on a live session
    expect(sessions.get(orphan)).toBeUndefined();
  });

  it('the SqlStore adapter maps to the documented method names', async () => {
    const calls: string[] = [];
    const adapter = sqlUserPersistence({
      saveLocalUser: async () => { calls.push('save'); },
      listLocalUsers: async () => { calls.push('list'); return []; },
      deleteLocalUser: async () => { calls.push('remove'); },
    });
    await adapter.list();
    await adapter.save({ username: 'u' } as LocalUser);
    await adapter.remove('u');
    expect(calls).toEqual(['list', 'save', 'remove']);
  });
});
