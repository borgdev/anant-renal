// M17.C — SCIM 2.0 receiver.
//
// Implements the minimum SCIM 2.0 subset every IdP uses:
//   POST   /scim/v2/Users             create
//   GET    /scim/v2/Users/:id         read
//   PUT    /scim/v2/Users/:id         replace
//   PATCH  /scim/v2/Users/:id         update (add/remove/replace ops)
//   DELETE /scim/v2/Users/:id         deprovision
//   GET    /scim/v2/Users             list with filter
//   POST   /scim/v2/Groups            create
//   GET    /scim/v2/Groups            list
//   GET    /scim/v2/Groups/:id        read
//   PATCH  /scim/v2/Groups/:id        add/remove members
//
// Auth: Bearer token per provider config (scim.bearerToken).
// Every write mutates IdentityRegistry — including auto-deprovision.

import type { IdentityPrincipal } from './types.js';
import { IdentityRegistry } from './registry.js';

export interface ScimUser {
  schemas: string[];
  id: string;
  userName: string;
  active?: boolean;
  emails?: Array<{ value: string; primary?: boolean; type?: string }>;
  name?: { givenName?: string; familyName?: string; formatted?: string };
  displayName?: string;
  groups?: Array<{ value: string; display?: string }>;
  externalId?: string;
  meta?: { resourceType: 'User'; created?: string; lastModified?: string };
}

export interface ScimGroup {
  schemas: string[];
  id: string;
  displayName: string;
  members?: Array<{ value: string; display?: string }>;
  meta?: { resourceType: 'Group'; created?: string; lastModified?: string };
}

interface ScimPatchOp {
  op: 'add' | 'remove' | 'replace';
  path?: string;
  value?: unknown;
}

const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

// Per-tenant token registry: bearerToken → orgId
const scimTokens = new Map<string, string>();
export function registerScimToken(bearerToken: string, orgId: string): void { scimTokens.set(bearerToken, orgId); }
export function revokeScimToken(bearerToken: string): void { scimTokens.delete(bearerToken); }
export function orgForToken(bearerToken: string): string | undefined { return scimTokens.get(bearerToken); }

const users = new Map<string, ScimUser>();     // scimId → user
const groups = new Map<string, ScimGroup>();    // scimId → group
const groupsByUser = new Map<string, Set<string>>();

function nowIso(): string { return new Date().toISOString(); }

function principalFromScim(orgId: string, user: ScimUser): IdentityPrincipal {
  const groupNames = (user.groups ?? []).map((g) => g.display ?? g.value);
  const resolved = IdentityRegistry.resolveRole(orgId, groupNames);
  const email = user.emails?.find((e) => e.primary)?.value ?? user.emails?.[0]?.value ?? user.userName;
  const displayName = user.displayName ?? user.name?.formatted ?? ([user.name?.givenName, user.name?.familyName].filter(Boolean).join(' ') || user.userName);
  return {
    subjectId: user.id,
    email,
    displayName,
    role: resolved.role,
    clearance: resolved.clearance,
    purposeOfUse: resolved.purposeOfUse,
    orgId,
    ...(resolved.facilityIds ? { facilityIds: resolved.facilityIds } : {}),
    groups: groupNames,
    source: 'scim',
  };
}

export const Scim = {
  createUser(orgId: string, input: Partial<ScimUser>): ScimUser {
    const id = input.id ?? `scim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const user: ScimUser = {
      schemas: [USER_SCHEMA],
      id,
      userName: input.userName ?? input.emails?.[0]?.value ?? id,
      active: input.active ?? true,
      ...(input.emails ? { emails: input.emails } : {}),
      ...(input.name ? { name: input.name } : {}),
      ...(input.displayName ? { displayName: input.displayName } : {}),
      ...(input.groups ? { groups: input.groups } : {}),
      ...(input.externalId ? { externalId: input.externalId } : {}),
      meta: { resourceType: 'User', created: nowIso(), lastModified: nowIso() },
    };
    users.set(id, user);
    if (user.active) IdentityRegistry.upsertPrincipal(principalFromScim(orgId, user));
    IdentityRegistry.audit('scim.user.created', { subjectId: id });
    return user;
  },

  getUser(id: string): ScimUser | undefined { return users.get(id); },

  listUsers(orgId: string, filter?: string): { schemas: string[]; totalResults: number; Resources: ScimUser[]; itemsPerPage: number; startIndex: number } {
    let all = [...users.values()];
    if (filter) {
      // Support the two filters IdPs actually send: userName eq "…" and emails eq "…"
      const m = /(userName|emails|externalId)\s+eq\s+"([^"]+)"/i.exec(filter);
      if (m) {
        const field = m[1]!.toLowerCase();
        const val = m[2]!;
        all = all.filter((u) => {
          if (field === 'username') return u.userName === val;
          if (field === 'externalid') return u.externalId === val;
          return (u.emails ?? []).some((e) => e.value === val);
        });
      }
    }
    // Filter to principals belonging to this org (approx — SCIM tenants are the auth boundary)
    all = all.filter((u) => IdentityRegistry.getPrincipal(u.id)?.orgId === orgId || IdentityRegistry.getPrincipal(u.id) === undefined);
    return {
      schemas: [LIST_SCHEMA],
      totalResults: all.length,
      Resources: all,
      itemsPerPage: all.length,
      startIndex: 1,
    };
  },

  replaceUser(orgId: string, id: string, input: ScimUser): ScimUser {
    if (!users.has(id)) throw new Error(`scim-user-not-found:${id}`);
    input.id = id;
    input.meta = { resourceType: 'User', created: users.get(id)!.meta?.created ?? nowIso(), lastModified: nowIso() };
    users.set(id, input);
    if (input.active === false) IdentityRegistry.deprovision(id);
    else IdentityRegistry.upsertPrincipal(principalFromScim(orgId, input));
    IdentityRegistry.audit('scim.user.replaced', { subjectId: id });
    return input;
  },

  patchUser(orgId: string, id: string, ops: ScimPatchOp[]): ScimUser {
    const user = users.get(id);
    if (!user) throw new Error(`scim-user-not-found:${id}`);
    for (const op of ops) {
      if (op.path === 'active' || (op.op === 'replace' && typeof op.value === 'object' && op.value && 'active' in (op.value as Record<string, unknown>))) {
        const active = op.path === 'active' ? Boolean(op.value) : Boolean((op.value as Record<string, unknown>)['active']);
        user.active = active;
      }
      if (op.path === 'emails' && Array.isArray(op.value)) user.emails = op.value as NonNullable<ScimUser['emails']>;
      if (op.path === 'displayName') user.displayName = String(op.value);
      if (op.path?.startsWith('groups')) {
        // Group membership is derived from group PATCHes; treat as info only here
      }
    }
    user.meta = { resourceType: 'User', created: user.meta?.created ?? nowIso(), lastModified: nowIso() };
    users.set(id, user);
    if (user.active === false) IdentityRegistry.deprovision(id);
    else IdentityRegistry.upsertPrincipal(principalFromScim(orgId, user));
    IdentityRegistry.audit('scim.user.patched', { subjectId: id, note: `ops=${ops.length}` });
    return user;
  },

  deleteUser(id: string): boolean {
    const ok = users.delete(id);
    if (ok) {
      IdentityRegistry.deprovision(id);
      IdentityRegistry.audit('scim.user.deleted', { subjectId: id });
    }
    return ok;
  },

  createGroup(orgId: string, input: Partial<ScimGroup>): ScimGroup {
    const id = input.id ?? `grp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const g: ScimGroup = {
      schemas: [GROUP_SCHEMA],
      id,
      displayName: input.displayName ?? id,
      ...(input.members ? { members: input.members } : {}),
      meta: { resourceType: 'Group', created: nowIso(), lastModified: nowIso() },
    };
    groups.set(id, g);
    for (const m of g.members ?? []) {
      const set = groupsByUser.get(m.value) ?? new Set();
      set.add(g.displayName);
      groupsByUser.set(m.value, set);
      // Re-resolve principal role
      const user = users.get(m.value);
      if (user) {
        user.groups = [...set].map((n) => ({ value: n, display: n }));
        IdentityRegistry.upsertPrincipal(principalFromScim(orgId, user));
      }
    }
    IdentityRegistry.audit('scim.group.created', { note: `name=${g.displayName}` });
    return g;
  },

  listGroups(): { schemas: string[]; totalResults: number; Resources: ScimGroup[]; itemsPerPage: number; startIndex: number } {
    const all = [...groups.values()];
    return { schemas: [LIST_SCHEMA], totalResults: all.length, Resources: all, itemsPerPage: all.length, startIndex: 1 };
  },

  getGroup(id: string): ScimGroup | undefined { return groups.get(id); },

  patchGroup(orgId: string, id: string, ops: ScimPatchOp[]): ScimGroup {
    const g = groups.get(id);
    if (!g) throw new Error(`scim-group-not-found:${id}`);
    for (const op of ops) {
      if (op.op === 'add' && op.path === 'members' && Array.isArray(op.value)) {
        const cur = g.members ?? [];
        g.members = [...cur, ...(op.value as Array<{ value: string; display?: string }>)];
        for (const m of op.value as Array<{ value: string }>) {
          const set = groupsByUser.get(m.value) ?? new Set();
          set.add(g.displayName);
          groupsByUser.set(m.value, set);
          const user = users.get(m.value);
          if (user) {
            user.groups = [...set].map((n) => ({ value: n, display: n }));
            IdentityRegistry.upsertPrincipal(principalFromScim(orgId, user));
          }
        }
      }
      if (op.op === 'remove' && op.path?.startsWith('members')) {
        const m = /members\[value eq "([^"]+)"\]/.exec(op.path);
        if (m) {
          const userId = m[1]!;
          g.members = (g.members ?? []).filter((x) => x.value !== userId);
          const set = groupsByUser.get(userId);
          if (set) set.delete(g.displayName);
          const user = users.get(userId);
          if (user) {
            user.groups = [...(set ?? new Set())].map((n) => ({ value: n, display: n }));
            IdentityRegistry.upsertPrincipal(principalFromScim(orgId, user));
          }
        }
      }
    }
    g.meta = { resourceType: 'Group', created: g.meta?.created ?? nowIso(), lastModified: nowIso() };
    groups.set(id, g);
    IdentityRegistry.audit('scim.group.patched', { note: `id=${id} ops=${ops.length}` });
    return g;
  },

  resetForTests(): void {
    users.clear();
    groups.clear();
    groupsByUser.clear();
    scimTokens.clear();
  },
};
