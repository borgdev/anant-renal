// Durable console sessions.
//
// The ops console (/admin/ui) and the exec console (/exec) authenticate with the
// SAME `hh_session` cookie, so "my login was invalidated when I moved between
// consoles" is never two auth systems — it is ONE session being lost. The
// in-memory SessionManager used to drop every session on a process restart
// (`tsx watch` reloads on every file save, and a deploy does the same), so
// whichever page you reloaded first showed a login screen and looked like it had
// killed the other console's login.
//
// These tests pin the fix: a session survives a restart, and it is the same
// session for both consoles.

import { describe, expect, it, beforeEach } from 'vitest';
import {
  SessionManager, hashSessionToken, sqlSessionPersistence,
  type SessionPersistence,
} from '../src/server/auth/session.js';

/** In-memory stand-in for the `auth_sessions` table. */
function memoryPersistence(): SessionPersistence & { rows: Array<{ tokenHash: string; username: string; createdAt: string; expiresAt: number }> } {
  const rows: Array<{ tokenHash: string; username: string; createdAt: string; expiresAt: number }> = [];
  return {
    rows,
    list: async () => [...rows],
    save: async (row) => {
      const existing = rows.findIndex((r) => r.tokenHash === row.tokenHash);
      if (existing >= 0) rows[existing] = row;
      else rows.push(row);
    },
    remove: async (tokenHash) => {
      const i = rows.findIndex((r) => r.tokenHash === tokenHash);
      if (i >= 0) rows.splice(i, 1);
    },
    prune: async (now) => {
      for (let i = rows.length - 1; i >= 0; i -= 1) if (rows[i]!.expiresAt <= now) rows.splice(i, 1);
    },
  };
}

/** Let queued fire-and-forget writes settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('durable console sessions', () => {
  let store: ReturnType<typeof memoryPersistence>;

  beforeEach(() => { store = memoryPersistence(); });

  it('keeps one session alive across a process restart', async () => {
    const before = new SessionManager();
    before.attachPersistence(store);
    const token = before.create('admin');
    await settle();

    // the raw token is never persisted — only its hash
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]!.tokenHash).toBe(hashSessionToken(token));
    expect(JSON.stringify(store.rows)).not.toContain(token);

    // "restart": a brand-new manager over the same durable store
    const after = new SessionManager();
    after.attachPersistence(store);
    expect(after.get(token)).toBeUndefined(); // nothing until restore runs

    const restored = await after.restore();
    expect(restored).toBe(1);
    const session = after.get(token);
    expect(session?.username).toBe('admin');
    expect(after.count()).toBe(1);
  });

  it('does not resurrect an expired session on restart', async () => {
    const ttlMs = 5;
    const before = new SessionManager(ttlMs);
    before.attachPersistence(store);
    const token = before.create('admin');
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 15));

    const after = new SessionManager(ttlMs);
    after.attachPersistence(store);
    expect(await after.restore()).toBe(0);
    expect(after.get(token)).toBeUndefined();
    expect(store.rows).toHaveLength(0); // pruned, not merely skipped
  });

  it('logs out durably — a restart cannot revive a destroyed session', async () => {
    const before = new SessionManager();
    before.attachPersistence(store);
    const token = before.create('admin');
    await settle();
    expect(before.destroy(token)).toBe(true);
    await settle();

    const after = new SessionManager();
    after.attachPersistence(store);
    expect(await after.restore()).toBe(0);
    expect(after.get(token)).toBeUndefined();
  });

  it('serves BOTH consoles from the one session (the reported symptom)', async () => {
    // The consoles differ only by which routes they call; both resolve the same
    // cookie to the same session, so one login must satisfy both.
    const sessions = new SessionManager();
    sessions.attachPersistence(store);
    const token = sessions.create('admin');
    await settle();

    const opsConsole = { users: [{ username: 'admin', role: 'admin' }] };
    const execConsole = { users: [{ username: 'admin', role: 'admin' }] };
    expect(sessions.get(token)?.username).toBe(opsConsole.users[0]!.username);
    expect(sessions.get(token)?.username).toBe(execConsole.users[0]!.username);

    // and after a restart BOTH are still authenticated by the same token
    const restarted = new SessionManager();
    restarted.attachPersistence(store);
    await restarted.restore();
    expect(restarted.get(token)?.username).toBe('admin');
  });

  it('stays a purely in-memory manager when no persistence is attached', async () => {
    const sessions = new SessionManager();
    const token = sessions.create('admin');
    expect(sessions.get(token)?.username).toBe('admin');
    await expect(sessions.restore()).resolves.toBe(0);
  });

  it('survives a failing store without breaking login', async () => {
    const broken: SessionPersistence = {
      list: async () => { throw new Error('store down'); },
      save: async () => { throw new Error('store down'); },
      remove: async () => { throw new Error('store down'); },
      prune: async () => { throw new Error('store down'); },
    };
    const sessions = new SessionManager();
    sessions.attachPersistence(broken);
    const token = sessions.create('admin'); // must not throw
    expect(sessions.get(token)?.username).toBe('admin');
    await expect(sessions.restore()).rejects.toThrow('store down'); // caller decides
  });
});

describe('sqlSessionPersistence adapter', () => {
  it('forwards to the store accessors and only ever passes hashes', async () => {
    const calls: string[] = [];
    const rows: Array<{ tokenHash: string; username: string; createdAt: string; expiresAt: number }> = [];
    const adapter = sqlSessionPersistence({
      saveSession: async (row) => { calls.push(`save:${row.tokenHash}`); rows.push(row); },
      listSessions: async () => { calls.push('list'); return [...rows]; },
      deleteSession: async (h) => { calls.push(`delete:${h}`); },
      pruneSessions: async (now) => { calls.push(`prune:${now > 0}`); },
    });

    const sessions = new SessionManager();
    sessions.attachPersistence(adapter);
    const token = sessions.create('nurse');
    await settle();
    expect(calls).toContain(`save:${hashSessionToken(token)}`);
    expect(calls.join(' ')).not.toContain(token);

    await sessions.restore();
    expect(calls).toContain('list');
    sessions.destroy(token);
    await settle();
    expect(calls).toContain(`delete:${hashSessionToken(token)}`);
  });
});
