/******************************************************************************
 * Admin API security guard — defense-in-depth over the /admin/* surface.
 *
 * The console shells are public so their login screens can render, and
 * /auth/* handles sign-in. EVERY other /admin/* endpoint now requires a valid
 * hh_session cookie, and is role-scoped:
 *
 *   /admin/swarm/*          → executive roles (admin | md | safety)
 *   /admin/auth/users*      → admin only
 *   everything else /admin/*→ operations roles (admin + data/integration/ops)
 *
 * This closes the gap where an unauthenticated client (or a non-executive
 * role) could read executive swarm data directly from the API. The UI never
 * decides authorization — the server does.
 ******************************************************************************/

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { LocalUserStore } from './auth/users.js';
import type { SessionManager } from './auth/session.js';
import { CONSOLE_ROLES, resolveConsoleActor, roleAllowsConsole } from './console-gate.js';

export interface AdminApiGuardDeps {
  users: LocalUserStore;
  sessions: SessionManager;
}

const PUBLIC_ADMIN_PREFIXES = ['/admin/ui/', '/admin/ui'];
const PUBLIC_ADMIN_PATHS = new Set(['/admin/console-access', '/admin/auth/meta']);

export async function registerAdminApiGuard(app: FastifyInstance, deps: AdminApiGuardDeps): Promise<void> {
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const url = (req.url ?? '').split('?')[0] ?? '';
    if (!url.startsWith('/admin/')) return;
    if (PUBLIC_ADMIN_PREFIXES.some((p) => url.startsWith(p) || url === p)) return;
    if (PUBLIC_ADMIN_PATHS.has(url)) return;

    const actor = resolveConsoleActor(req, deps);
    if (!actor.authenticated) {
      return reply.code(401).send({ error: 'not-authenticated', hint: 'sign in via POST /auth/login and send the hh_session cookie' });
    }
    const { role } = actor;

    if (url.startsWith('/admin/swarm/')) {
      if (!roleAllowsConsole(role, 'exec')) {
        return reply.code(403).send({ error: 'role-not-permitted-for-console', console: 'exec', role, allowed: CONSOLE_ROLES.exec });
      }
      return;
    }
    if (url.startsWith('/admin/auth/users')) {
      if (role !== 'admin') {
        return reply.code(403).send({ error: 'admin-required', role });
      }
      return;
    }
    if (!roleAllowsConsole(role, 'ops')) {
      return reply.code(403).send({ error: 'role-not-permitted-for-console', console: 'ops', role, allowed: CONSOLE_ROLES.ops });
    }
  });
}
