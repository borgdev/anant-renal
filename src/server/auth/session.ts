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

// Session manager for the operator console login. In-memory for the dev /
// self-hosted profile; production can swap in a Redis-backed session store.

import { randomBytes, createHash } from 'node:crypto';
import type { ActorContext } from '../scoped-persistence.js';
import type { PurposeOfUse } from '../../identity/types.js';
import type { LocalUser, LocalUserStore } from './users.js';

export const SESSION_COOKIE = 'hh_session';
const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000; // 8h

export interface Session {
  /** the SHA-256 of the cookie token — the raw token is never retained server-side */
  token: string;
  username: string;
  createdAt: string;
  expiresAt: number; // epoch ms
}

/**
 * Durable session backing. Both consoles (`/admin/ui` and `/exec`) authenticate
 * with the SAME `hh_session` cookie, so this one store keeps a single login
 * alive across them AND across a process restart — an in-memory-only manager
 * logs every console out whenever the dev server reloads.
 */
export interface SessionPersistence {
  list(): Promise<Array<{ tokenHash: string; username: string; createdAt: string; expiresAt: number }>>;
  save(row: { tokenHash: string; username: string; createdAt: string; expiresAt: number }): Promise<void>;
  remove(tokenHash: string): Promise<void>;
  prune(nowEpochMs: number): Promise<void>;
}

/** The raw token never leaves the cookie; only its hash is persisted. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private persistence: SessionPersistence | undefined;
  constructor(private readonly ttlMs: number = DEFAULT_TTL_MS) {}

  /**
   * Attach durable backing. The in-memory map stays the synchronous READ path
   * (preHandlers call `get(token)` on every request); this is write-through for
   * create/destroy plus a restore source at boot.
   */
  attachPersistence(persistence: SessionPersistence): void {
    this.persistence = persistence;
  }

  /**
   * Restore sessions written by a previous process. Expired rows are dropped
   * (both here and from the store) so a restart cannot resurrect a dead login.
   */
  async restore(): Promise<number> {
    if (!this.persistence) return 0;
    const now = Date.now();
    const rows = await this.persistence.list();
    let restored = 0;
    for (const row of rows) {
      if (row.expiresAt <= now) continue;
      const token = row.tokenHash;
      this.sessions.set(token, {
        token,
        username: row.username,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
      });
      restored += 1;
    }
    await this.persistence.prune(now).catch(() => undefined);
    return restored;
  }

  create(username: string): string {
    this.prune();
    const token = randomBytes(32).toString('hex');
    const tokenHash = hashSessionToken(token);
    const session: Session = {
      token: tokenHash,
      username,
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + this.ttlMs,
    };
    this.sessions.set(tokenHash, session);
    // Fire-and-forget: the login must not fail because the store hiccuped, and
    // the map is authoritative for the lifetime of this process.
    void this.persistence
      ?.save({ tokenHash, username, createdAt: session.createdAt, expiresAt: session.expiresAt })
      .catch(() => undefined);
    return token;
  }

  get(token: string): Session | undefined {
    const s = this.sessions.get(hashSessionToken(token));
    if (!s) return undefined;
    if (s.expiresAt <= Date.now()) { this.sessions.delete(s.token); return undefined; }
    return s;
  }

  destroy(token: string): boolean {
    const tokenHash = hashSessionToken(token);
    const existed = this.sessions.delete(tokenHash);
    void this.persistence?.remove(tokenHash).catch(() => undefined);
    return existed;
  }

  count(): number { return this.sessions.size; }

  prune(): void {
    const now = Date.now();
    for (const [t, s] of this.sessions) if (s.expiresAt <= now) this.sessions.delete(t);
    void this.persistence?.prune(now).catch(() => undefined);
  }
}

/** Parse a single cookie value from a raw Cookie header (no dep on @fastify/cookie). */
export function readCookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export function setSessionCookie(token: string, maxAgeSec = 28800): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`;
}
export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

const CLEARANCE_MAP: Record<LocalUser['clearance'], ActorContext['clearance']> = {
  internal: 'internal',
  phi: 'phi',
  'break-glass': 'restricted-phi',
};// Identity PurposeOfUse is richer than the ActorContext vocabulary; fold the
// extra values onto the closest scoped-operation purpose.
const POU_MAP: Record<PurposeOfUse, ActorContext['purposeOfUse']> = {
  treatment: 'treatment',
  operations: 'operations',
  billing: 'operations',
  quality: 'compliance',
  research: 'research',
};

/** Map a console user to the ActorContext used by every scoped operation. */
export function actorFromUser(u: LocalUser): ActorContext {
  return {
    actorRef: `user:${u.username}`,
    scopeIds: u.scopeIds.length ? u.scopeIds : ['scope:*'],
    purposeOfUse: POU_MAP[u.purposeOfUse[0] ?? 'operations'],
    clearance: CLEARANCE_MAP[u.clearance] ?? 'internal',
  };
}

/**
 * Build a resolver that turns a valid `hh_session` cookie into an ActorContext.
 * Used by the app-level authenticate() so the whole console runs under the
 * logged-in identity (falling back to x-actor / power-user when absent).
 */
export function sessionActorResolver(opts: { users: LocalUserStore; sessions: SessionManager; cookieName?: string }) {
  const name = opts.cookieName ?? SESSION_COOKIE;
  return (req: { headers: Record<string, string | string[] | undefined> }): ActorContext | undefined => {
    const raw = req.headers['cookie'];
    const h = Array.isArray(raw) ? raw[0] : raw;
    const token = readCookieValue(h, name);
    if (!token) return undefined;
    const session = opts.sessions.get(token);
    if (!session) return undefined;
    const user = opts.users.get(session.username);
    if (!user) return undefined;
    return actorFromUser(user);
  };
}

/**
 * SqlStore-backed session persistence (structural type — no import cycle).
 *
 * Console logins are the same token for both consoles, so making this durable
 * fixes a real annoyance: a `tsx watch` reload (or a deploy) used to wipe every
 * live console session, and whichever page you reloaded first looked like it
 * had "lost" the other console's login.
 */
export function sqlSessionPersistence(store: {
  saveSession(row: { tokenHash: string; username: string; createdAt: string; expiresAt: number }): Promise<void>;
  listSessions(): Promise<Array<{ tokenHash: string; username: string; createdAt: string; expiresAt: number }>>;
  deleteSession(tokenHash: string): Promise<void>;
  pruneSessions(nowEpochMs: number): Promise<void>;
}): SessionPersistence {
  return {
    list: () => store.listSessions(),
    save: (row) => store.saveSession(row),
    remove: (tokenHash) => store.deleteSession(tokenHash),
    prune: (nowEpochMs) => store.pruneSessions(nowEpochMs),
  };
}
