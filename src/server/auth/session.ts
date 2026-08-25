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

import { randomBytes } from 'node:crypto';
import type { ActorContext } from '../scoped-persistence.js';
import type { PurposeOfUse } from '../../identity/types.js';
import type { LocalUser, LocalUserStore } from './users.js';

export const SESSION_COOKIE = 'hh_session';
const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000; // 8h

export interface Session {
  token: string;
  username: string;
  createdAt: string;
  expiresAt: number; // epoch ms
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  constructor(private readonly ttlMs: number = DEFAULT_TTL_MS) {}

  create(username: string): string {
    this.prune();
    const token = randomBytes(32).toString('hex');
    this.sessions.set(token, {
      token,
      username,
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + this.ttlMs,
    });
    return token;
  }

  get(token: string): Session | undefined {
    const s = this.sessions.get(token);
    if (!s) return undefined;
    if (s.expiresAt <= Date.now()) { this.sessions.delete(token); return undefined; }
    return s;
  }

  destroy(token: string): boolean { return this.sessions.delete(token); }

  count(): number { return this.sessions.size; }

  prune(): void {
    const now = Date.now();
    for (const [t, s] of this.sessions) if (s.expiresAt <= now) this.sessions.delete(t);
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
};

// Identity PurposeOfUse is richer than the ActorContext vocabulary; fold the
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
