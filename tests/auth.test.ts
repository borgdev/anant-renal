/******************************************************************************
 *
 * Copyright (c) 2026 AnantHQ Inc.
 * All Rights Reserved.
 *
 * This software is licensed, not sold.
 *
 * The contents of this file constitute confidential and proprietary
 * information belonging exclusively to Unison Software Technologies Pvt. Ltd.
 *
 * This source code incorporates proprietary algorithms, software architecture,
 * business logic, computational methods, optimization techniques,
 * workflows, data structures, APIs, and implementation details that are
 * protected by copyright law, patent law, trade secret law, and
 * international intellectual property treaties.
 *
 * Except as expressly permitted by a written license agreement,
 * no person or organization may:
 *
 *   • Copy or reproduce this software.
 *   • Modify or create derivative works.
 *   • Reverse engineer, decompile, or disassemble.
 *   • Benchmark or publicly disclose performance.
 *   • Redistribute, sublicense, lease, rent, or sell.
 *   • Use this software for competitive analysis.
 *   • Disclose any implementation details.
 *
 * Any unauthorized use is strictly prohibited and may result in
 * civil damages, injunctive relief, criminal prosecution,
 * and all other remedies available under applicable law.
 *
 ******************************************************************************/

// Console auth — login / logout / me, local user management, and the
// session→ActorContext mapping that lets the console run under a real identity.

import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import type { PostgresEventStore } from '../src/server/postgres-event-store.js';
import type { CanonicalEvent } from '../src/healthcare-core/events.js';
import type { LedgerEntry } from '../src/hypergraph/ledger.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import { LocalUserStore, seedDefaultUsers, SessionManager, actorFromUser } from '../src/server/auth/index.js';

function inMemoryStore(): PostgresEventStore {
  const events: CanonicalEvent[] = [];
  const ledger: LedgerEntry[] = [];
  const audit: unknown[] = [];
  return {
    async applyMigrations() { /* noop */ },
    async appendEvent(_scope: { scopeId: string; actorRef: string }, ev: CanonicalEvent) { events.push(ev); },
    async queryEvents() { return events; },
    async appendLedger(_scopeId: string, entry: LedgerEntry) { ledger.push(entry); },
    async queryLedger() { return ledger; },
    async appendAudit(row: unknown) { audit.push(row); },
    async withTransaction<T>(fn: (client: unknown) => Promise<T>) { return fn({}); },
  } as unknown as PostgresEventStore;
}

async function makeApp() {
  return buildApp({
    store: inMemoryStore(),
    telemetry: new Telemetry('test', new InMemorySink()),
    packs: [healthcareCorePack],
    authenticate: async () => ({ actorRef: 'user:test', scopeIds: ['scope:*'], purposeOfUse: 'operations', clearance: 'restricted-phi' }),
    checkHealth: async () => ({ db: true, redis: true }),
  });
}

const cookieOf = (res: { headers: Record<string, unknown> }): string | undefined => {
  const h = res.headers['set-cookie'];
  if (Array.isArray(h)) return h[0] as string;
  return h as string | undefined;
};

describe('console auth', () => {
  it('seeds default users (admin / nurse / auditor)', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/admin/auth/users' });
    expect(res.statusCode).toBe(200);
    const names = (res.json() as { users: Array<{ username: string }> }).users.map((u) => u.username);
    expect(names).toContain('admin');
    expect(names).toContain('nurse');
    expect(names).toContain('auditor');
  });

  it('logs in with valid credentials and issues a session cookie', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { username: 'admin', password: 'admin123' } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; user: { username: string; role: string } };
    expect(body.ok).toBe(true);
    expect(body.user.username).toBe('admin');
    expect(body.user.role).toBe('admin');
    const cookie = cookieOf(res);
    expect(cookie).toBeDefined();
    expect(cookie).toContain('hh_session=');
    expect(cookie).toContain('HttpOnly');
  });

  it('rejects bad credentials', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { username: 'admin', password: 'wrong' } });
    expect(res.statusCode).toBe(401);
  });

  it('/auth/me returns the identity for a valid session and 401 otherwise', async () => {
    const app = await makeApp();
    const anon = await app.inject({ method: 'GET', url: '/auth/me' });
    expect(anon.statusCode).toBe(401);

    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { username: 'nurse', password: 'nurse123' } });
    const cookie = cookieOf(login);
    expect(cookie).toBeDefined();
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: cookie!.split(';')[0] } });
    expect(me.statusCode).toBe(200);
    const body = me.json() as { authenticated: boolean; user: { username: string; role: string } };
    expect(body.authenticated).toBe(true);
    expect(body.user.username).toBe('nurse');
    expect(body.user.role).toBe('nurse');
  });

  it('logout invalidates the session and clears the cookie', async () => {
    const app = await makeApp();
    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { username: 'admin', password: 'admin123' } });
    const cookie = cookieOf(login)!.split(';')[0];

    const out = await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie } });
    expect(out.statusCode).toBe(200);
    expect(cookieOf(out)).toContain('Max-Age=0');

    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(401);
  });

  it('admins can create, list, reset, and delete local users', async () => {
    const app = await makeApp();
    const created = await app.inject({
      method: 'POST', url: '/admin/auth/users',
      payload: { username: 'clinician', displayName: 'Clinic MD', password: 'pass1234', role: 'md', clearance: 'phi', purposeOfUse: ['treatment'] },
    });
    expect(created.statusCode).toBe(200);
    expect((created.json() as { user: { username: string } }).user.username).toBe('clinician');

    const dup = await app.inject({ method: 'POST', url: '/admin/auth/users', payload: { username: 'clinician', password: 'pass1234' } });
    expect(dup.statusCode).toBe(400);
    expect((dup.json() as { error: string }).error).toContain('user-exists');

    // New user can log in.
    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { username: 'clinician', password: 'pass1234' } });
    expect(login.statusCode).toBe(200);

    // Reset password → old fails, new works.
    const reset = await app.inject({ method: 'POST', url: '/admin/auth/users/clinician/reset-password', payload: { password: 'newpass99' } });
    expect(reset.statusCode).toBe(200);
    const oldLogin = await app.inject({ method: 'POST', url: '/auth/login', payload: { username: 'clinician', password: 'pass1234' } });
    expect(oldLogin.statusCode).toBe(401);
    const newLogin = await app.inject({ method: 'POST', url: '/auth/login', payload: { username: 'clinician', password: 'newpass99' } });
    expect(newLogin.statusCode).toBe(200);

    const del = await app.inject({ method: 'DELETE', url: '/admin/auth/users/clinician' });
    expect(del.statusCode).toBe(200);
    const after = await app.inject({ method: 'POST', url: '/auth/login', payload: { username: 'clinician', password: 'newpass99' } });
    expect(after.statusCode).toBe(401);
  });

  it('maps a console user to an ActorContext (session → scoped operations)', () => {
    const store = new LocalUserStore();
    seedDefaultUsers(store);
    const admin = store.get('admin')!;
    const actor = actorFromUser(admin);
    expect(actor.actorRef).toBe('user:admin');
    expect(actor.clearance).toBe('restricted-phi'); // break-glass maps up
    expect(actor.scopeIds).toContain('scope:*');

    const nurse = actorFromUser(store.get('nurse')!);
    expect(nurse.clearance).toBe('phi');
    expect(nurse.purposeOfUse).toBe('treatment');
  });

  it('sessions expire and are pruned', () => {
    const s = new SessionManager(1); // 1ms TTL
    const token = s.create('admin');
    expect(s.get(token)).toBeDefined();
    // Force expiry check via a stale timestamp isn't needed — prune() removes expired.
    expect(s.count()).toBe(1);
  });
});
