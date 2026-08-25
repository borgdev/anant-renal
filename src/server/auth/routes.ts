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

// Console auth routes — login / logout / me + local user management.
// Login issues an httpOnly `hh_session` cookie; logout invalidates it.
// Admin user CRUD backs the System → Users panel ("create a few users").

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { LocalUserStore, CreateLocalUserInput } from './users.js';
import { SessionManager, SESSION_COOKIE, readCookieValue, setSessionCookie, clearSessionCookie } from './session.js';
import type { IdentityRole, Clearance, PurposeOfUse } from '../../identity/types.js';

export interface AuthRoutesDeps {
  readonly users: LocalUserStore;
  readonly sessions: SessionManager;
  readonly cookieName?: string;
}

function publicUser(u: { username: string; displayName: string; role: string; clearance: string; purposeOfUse: string[] }) {
  return { username: u.username, displayName: u.displayName, role: u.role, clearance: u.clearance, purposeOfUse: u.purposeOfUse };
}

export async function registerAuthRoutes(app: FastifyInstance, deps: AuthRoutesDeps): Promise<void> {
  const cookieName = deps.cookieName ?? SESSION_COOKIE;

  const sessionFromReq = (req: FastifyRequest) => {
    const raw = req.headers['cookie'];
    const h = Array.isArray(raw) ? raw[0] : raw;
    const token = readCookieValue(h, cookieName);
    return token ? deps.sessions.get(token) : undefined;
  };

  // POST /auth/login — verify credentials, issue session cookie.
  app.post<{ Body: { username?: string; password?: string } }>('/auth/login', async (req, reply) => {
    const { username, password } = req.body ?? {};
    if (!username || !password) return reply.code(400).send({ error: 'username-and-password-required' });
    const user = deps.users.verify(username, password);
    if (!user) return reply.code(401).send({ error: 'invalid-credentials' });
    const token = deps.sessions.create(user.username);
    reply.header('set-cookie', setSessionCookie(token));
    return { ok: true, user: publicUser(user) };
  });

  // POST /auth/logout — destroy the session and clear the cookie.
  app.post('/auth/logout', async (req, reply) => {
    const raw = req.headers['cookie'];
    const h = Array.isArray(raw) ? raw[0] : raw;
    const token = readCookieValue(h, cookieName);
    if (token) deps.sessions.destroy(token);
    reply.header('set-cookie', clearSessionCookie());
    return { ok: true };
  });

  // GET /auth/me — current session identity (drives the console landing gate).
  app.get('/auth/me', async (req, reply) => {
    const session = sessionFromReq(req);
    if (!session) return reply.code(401).send({ error: 'not-authenticated' });
    const user = deps.users.get(session.username);
    if (!user) return reply.code(401).send({ error: 'not-authenticated' });
    return { authenticated: true, user: publicUser(user), issuedAt: session.createdAt, expiresAt: new Date(session.expiresAt).toISOString() };
  });

  // ---- Admin: local console users (System → Users) ----

  app.get('/admin/auth/users', async () => ({
    users: deps.users.list().map((u) => ({
      username: u.username,
      displayName: u.displayName,
      role: u.role,
      clearance: u.clearance,
      purposeOfUse: u.purposeOfUse,
      orgId: u.orgId,
      createdAt: u.createdAt,
      ...(u.lastLoginAt ? { lastLoginAt: u.lastLoginAt } : {}),
    })),
    activeSessions: deps.sessions.count(),
  }));

  app.post<{ Body: CreateLocalUserInput }>('/admin/auth/users', async (req, reply) => {
    try {
      const user = deps.users.create(req.body);
      return { user: publicUser(user) };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.post<{ Params: { username: string }; Body: { password: string } }>('/admin/auth/users/:username/reset-password', async (req, reply) => {
    try {
      if (!req.body?.password) return reply.code(400).send({ error: 'password-required' });
      const ok = deps.users.resetPassword(req.params.username, req.body.password);
      if (!ok) return reply.code(404).send({ error: 'user-not-found' });
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.delete<{ Params: { username: string } }>('/admin/auth/users/:username', async (req, reply) => {
    const ok = deps.users.remove(req.params.username);
    if (!ok) return reply.code(404).send({ error: 'user-not-found' });
    return { ok: true, removed: req.params.username };
  });

  // Role / clearance / purposeOfUse vocabularies for the Users panel forms.
  app.get('/admin/auth/meta', async () => ({
    roles: ['admin', 'md', 'nurse', 'pharmacist', 'coder', 'auditor', 'facilities-tech', 'safety'] satisfies IdentityRole[],
    clearances: ['internal', 'phi', 'break-glass'] satisfies Clearance[],
    purposesOfUse: ['operations', 'treatment', 'billing', 'quality', 'research'] satisfies PurposeOfUse[],
  }));
}
