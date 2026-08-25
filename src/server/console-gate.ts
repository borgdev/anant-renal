/******************************************************************************
 * Console access gate — server-enforced split between the two product surfaces.
 *
 *   /exec/        → Renal Swarm executive console (decision/analytics/clinical)
 *   /admin/ui/    → AnantHealth operator console (data / integration / IT ops)
 *
 * The harness identity model already carries `IdentityRole` (admin | md | nurse
 * | pharmacist | coder | auditor | facilities-tech | safety). This gate maps a
 * role to the console(s) it may load and enforces it on the console document
 * requests via the hh_session cookie. Admins get both consoles; decision and
 * clinical roles get /exec/; data, integration and operations roles get
 * /admin/ui/. The gate fails closed for authenticated roles outside their
 * console, while leaving pre-login requests to the console's own login screen.
 ******************************************************************************/

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { IdentityRole } from '../identity/types.js';
import { SESSION_COOKIE, readCookieValue, type SessionManager } from './auth/session.js';
import type { LocalUserStore } from './auth/users.js';

export type ConsoleId = 'exec' | 'ops';

/** Role → console access. Admin sees both; decision/clinical roles get the
 *  executive console; data/integration/operations roles get the ops console. */
export const CONSOLE_ROLES: Record<ConsoleId, IdentityRole[]> = {
  exec: ['admin', 'md', 'safety'],
  ops: ['admin', 'nurse', 'pharmacist', 'coder', 'auditor', 'facilities-tech'],
};

export function roleAllowsConsole(role: IdentityRole, console: ConsoleId): boolean {
  return CONSOLE_ROLES[console].includes(role);
}

export function consolesForRole(role: IdentityRole): ConsoleId[] {
  return (['exec', 'ops'] as ConsoleId[]).filter((c) => roleAllowsConsole(role, c));
}

/** True when `url` is the console document itself (not an asset subpath). */
export function isConsoleDocumentPath(url: string, console: ConsoleId): boolean {
  const prefix = console === 'exec' ? '/exec' : '/admin/ui';
  return url === prefix || url === `${prefix}/`;
}

export const CONSOLE_LABEL: Record<ConsoleId, string> = {
  exec: 'Renal Swarm · Executive Console',
  ops: 'AnantHealth · Operator Console',
};

function forbiddenPage(console: ConsoleId, role: string, allowed: ConsoleId[]): string {
  const roles = CONSOLE_ROLES[console].join(', ');
  const usable = allowed.length ? allowed.map((c) => CONSOLE_LABEL[c]).join(', ') : 'No console is assigned to this role — ask an administrator.';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Access restricted · ${CONSOLE_LABEL[console]}</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;background:#040a09;color:#eef7f3;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
  .card{max-width:480px;padding:40px;border:1px solid rgba(190,229,214,.16);border-radius:16px;background:#0d1a17}
  h1{font-size:20px;margin:0 0 10px;color:#f27987}
  p{color:#9fb6ad;font-size:14px;line-height:1.55;margin:8px 0}
  .pill{display:inline-block;padding:2px 10px;border-radius:999px;border:1px solid rgba(190,229,214,.2);font-size:12px;color:#9fb6ad;margin:0 4px 4px 0}
  .muted{color:#71877e;font-size:12px;margin-top:16px}
</style></head><body><div class="card">
  <h1>This console is not available to your role.</h1>
  <p>Signed in as <strong>${role}</strong>. <strong>${CONSOLE_LABEL[console]}</strong> is for roles: ${roles}.</p>
  <p>You can use: <span class="pill">${usable}</span></p>
  <p class="muted">Server-enforced access control · session cookie verified · the UI never decides authorization.</p>
</div></body></html>`;
}

export interface ConsoleGateDeps {
  users: LocalUserStore;
  sessions: SessionManager;
}

export function resolveConsoleActor(
  req: FastifyRequest,
  deps: ConsoleGateDeps,
): { authenticated: false; role?: undefined } | { authenticated: true; role: IdentityRole } {
  const token = readCookieValue(typeof req.headers.cookie === 'string' ? req.headers.cookie : undefined, SESSION_COOKIE);
  if (!token) return { authenticated: false };
  const session = deps.sessions.get(token);
  if (!session) return { authenticated: false };
  const user = deps.users.get(session.username);
  if (!user) return { authenticated: false };
  return { authenticated: true, role: user.role };
}

export async function registerConsoleGate(app: FastifyInstance, deps: ConsoleGateDeps): Promise<void> {
  // Report which console(s) the current session may load — used by the UIs to
  // show a "switch console" affordance without trusting the client to enforce.
  app.get('/admin/console-access', async (req) => {
    const actor = resolveConsoleActor(req, deps);
    if (!actor.authenticated) {
      return { authenticated: false, all: CONSOLE_ROLES };
    }
    return { authenticated: true, role: actor.role, consoles: consolesForRole(actor.role), all: CONSOLE_ROLES };
  });

  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const url = (req.url ?? '').split('?')[0] ?? '';
    const execDoc = isConsoleDocumentPath(url, 'exec');
    const opsDoc = isConsoleDocumentPath(url, 'ops');
    if (!execDoc && !opsDoc) return;

    // Pre-login requests render the console's own login screen.
    const actor = resolveConsoleActor(req, deps);
    if (!actor.authenticated) return;

    if (execDoc && !roleAllowsConsole(actor.role, 'exec')) {
      return reply.code(403).type('text/html').send(forbiddenPage('exec', actor.role, consolesForRole(actor.role)));
    }
    if (opsDoc && !roleAllowsConsole(actor.role, 'ops')) {
      return reply.code(403).type('text/html').send(forbiddenPage('ops', actor.role, consolesForRole(actor.role)));
    }
  });
}
