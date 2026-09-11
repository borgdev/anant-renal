/******************************************************************************
 * Admin API security guard — defense-in-depth over the /admin/* surface.
 *
 * The console shells are public so their login screens can render, and
 * /auth/* handles sign-in. EVERY other /admin/* endpoint now requires a valid
 * hh_session cookie, and is role-scoped:
 *
 *   /admin/swarm/*          → executive roles (admin | md | safety)
 *   /admin/executive/*      → executive roles (admin | md | safety)
 *   /admin/auth/users*      → admin only
 *   everything else /admin/*→ operations roles (admin + data/integration/ops)
 *
 * CONFIGURATION IS READ-ONLY FOR READS-ONLY ROLES. A compliance role must be able
 * to SEE what the platform is configured to do — that is the whole point of the
 * role — without being able to change it. The operator console enforces this in
 * its UI, but a UI is not a boundary, so the same rule is enforced here: on the
 * setup surface below, `auditor` may read and may not write.
 *
 * The SAME surface is readable by the executive roles. The executive console shows
 * a read-only view of the release gate and the active configuration, so it reads
 * these documents rather than keeping a second exec-scoped spelling of them —
 * which is what produced the duplicate API families in the first place.
 *
 * The list is deliberately the CONFIGURATION surface only. An auditor's
 * compliance WORKFLOW stays writable (acknowledging a dead-letter incident,
 * recording a finding decision); what is frozen is the configuration itself.
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

/** Roles that may read the configuration surface but never write it. */
export const READ_ONLY_ROLES: ReadonlyArray<string> = ['auditor'];

/** The configuration surface: what the platform is set up to do. */
export const SETUP_WRITE_PREFIXES: ReadonlyArray<string> = [
  '/admin/platform/organization',
  '/admin/platform/topics',
  '/admin/platform/onboarding',
  '/admin/platform/packs',
  '/admin/platform/policy',
  '/admin/platform/integrations',
  '/admin/platform/config-objects',
  '/admin/platform/releases',
  '/admin/platform/agent-specs',
  // The exec-scoped twins of the same documents, while they still exist.
  '/admin/swarm/admin',
  '/admin/ontology',
];

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The configuration the executive console READS (never writes): the release gate
 *  and the active configuration it scores. */
export const EXEC_READABLE_PLATFORM_PREFIXES: ReadonlyArray<string> = [
  '/admin/platform/release-gate',
  '/admin/platform/releases',
  '/admin/platform/packs',
  '/admin/platform/organization',
  '/admin/platform/policy',
  '/admin/platform/config-objects',
  '/admin/platform/topics',
  '/admin/platform/agent-specs',
];

export function isSetupWrite(url: string, method: string): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return false;
  return SETUP_WRITE_PREFIXES.some((p) => url === p || url.startsWith(`${p}/`) || url.startsWith(p));
}

/** Read-only for the executive console: it may GET, never write. */
export function isExecReadableConfig(url: string): boolean {
  return EXEC_READABLE_PLATFORM_PREFIXES.some((p) => url === p || url.startsWith(`${p}/`) || url.startsWith(p));
}

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

    // Read-only roles can see the configuration and cannot change it — checked
    // BEFORE the console scoping below so the answer is the same whichever
    // prefix the caller used to reach the same document.
    if (READ_ONLY_ROLES.includes(role) && isSetupWrite(url, req.method ?? 'GET')) {
      return reply.code(403).send({
        error: 'read-only-role',
        role,
        method: req.method,
        detail: 'This role may read the configuration but not change it. Ask an administrator to make the change.',
      });
    }

    if (url.startsWith('/admin/swarm/')) {
      if (!roleAllowsConsole(role, 'exec')) {
        return reply.code(403).send({ error: 'role-not-permitted-for-console', console: 'exec', role, allowed: CONSOLE_ROLES.exec });
      }
      return;
    }
    // Executive outcomes + delegation (Journey N) live in the Outcome Workspace,
    // so they are exec-role-scoped (admin | md | safety) — reachable from the
    // exec cockpit as well as the operator console (admin).
    if (url.startsWith('/admin/executive/')) {
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
    // The executive console reads the configuration read-only — same documents,
    // no second exec-scoped spelling, and writes still fall through to the ops
    // scoping below (which excludes md/safety).
    if (roleAllowsConsole(role, 'exec') && SAFE_METHODS.has((req.method ?? 'GET').toUpperCase()) && isExecReadableConfig(url)) {
      return;
    }
    if (!roleAllowsConsole(role, 'ops')) {
      return reply.code(403).send({ error: 'role-not-permitted-for-console', console: 'ops', role, allowed: CONSOLE_ROLES.ops });
    }
  });
}
