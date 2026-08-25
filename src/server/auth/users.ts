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

// Local console users — username/password identities that back the operator
// console login. Seeded defaults let you sign in immediately; admins can
// create more from System → Users. Principals are also upserted into
// IdentityRegistry (source: 'local') so governance/audit treat them uniformly.

import type { IdentityRole, Clearance, PurposeOfUse } from '../../identity/types.js';
import { IdentityRegistry } from '../../identity/registry.js';
import { hashPassword, verifyPassword } from './password.js';

export interface LocalUser {
  username: string;
  displayName: string;
  passwordHash: string;
  role: IdentityRole;
  clearance: Clearance; // 'internal' | 'phi' | 'break-glass'
  purposeOfUse: PurposeOfUse[];
  orgId: string;
  scopeIds: string[];
  createdAt: string;
  lastLoginAt?: string;
}

export interface CreateLocalUserInput {
  username: string;
  displayName?: string;
  password: string;
  role?: IdentityRole;
  clearance?: Clearance;
  purposeOfUse?: PurposeOfUse[];
  orgId?: string;
  scopeIds?: string[];
}

const DEFAULT_ROLE: IdentityRole = 'nurse';
const DEFAULT_CLEARANCE: Clearance = 'phi';
const DEFAULT_POU: PurposeOfUse[] = ['treatment', 'operations'];

export class LocalUserStore {
  private byUsername = new Map<string, LocalUser>();

  create(input: CreateLocalUserInput): LocalUser {
    const username = input.username.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(username)) throw new Error('invalid-username: use 2-64 lowercase letters/digits/._-');
    if (input.password.length < 4) throw new Error('password-too-short: minimum 4 characters');
    if (this.byUsername.has(username)) throw new Error(`user-exists: ${username}`);
    const user: LocalUser = {
      username,
      displayName: input.displayName?.trim() || username,
      passwordHash: hashPassword(input.password),
      role: input.role ?? DEFAULT_ROLE,
      clearance: input.clearance ?? DEFAULT_CLEARANCE,
      purposeOfUse: input.purposeOfUse?.length ? input.purposeOfUse : DEFAULT_POU,
      orgId: input.orgId ?? 'org:default',
      scopeIds: input.scopeIds?.length ? input.scopeIds : ['scope:*'],
      createdAt: new Date().toISOString(),
    };
    this.byUsername.set(username, user);
    // Mirror into IdentityRegistry so identity/governance views include console users.
    try {
      IdentityRegistry.upsertPrincipal({
        subjectId: `local:${username}`,
        email: `${username}@anant.local`,
        displayName: user.displayName,
        role: user.role,
        clearance: user.clearance,
        purposeOfUse: user.purposeOfUse,
        orgId: user.orgId,
        source: 'local',
        ...(user.scopeIds && user.scopeIds.length ? { metadata: { scopeIds: user.scopeIds.join(',') } } : {}),
      });
    } catch { /* identity registry is best-effort */ }
    return user;
  }

  /** Verify credentials. On success records lastLoginAt and returns the user. */
  verify(username: string, password: string): LocalUser | null {
    const user = this.byUsername.get(username.trim().toLowerCase());
    if (!user) return null;
    if (!verifyPassword(password, user.passwordHash)) return null;
    user.lastLoginAt = new Date().toISOString();
    return user;
  }

  get(username: string): LocalUser | undefined { return this.byUsername.get(username.trim().toLowerCase()); }
  list(): LocalUser[] { return [...this.byUsername.values()]; }
  remove(username: string): boolean {
    const key = username.trim().toLowerCase();
    const ok = this.byUsername.delete(key);
    if (ok) { try { IdentityRegistry.deprovision(`local:${key}`); } catch { /* best-effort */ } }
    return ok;
  }
  resetPassword(username: string, password: string): boolean {
    const user = this.get(username);
    if (!user) return false;
    user.passwordHash = hashPassword(password);
    return true;
  }
}

/** Developer-friendly seeded users for local/demo login. */
export function seedDefaultUsers(store: LocalUserStore): void {
  const seeds: Array<CreateLocalUserInput & { username: string }> = [
    { username: 'admin', displayName: 'Console Administrator', password: 'admin123', role: 'admin', clearance: 'break-glass', purposeOfUse: ['operations', 'quality'], orgId: 'org:default' },
    { username: 'nurse', displayName: 'Nurse Clinician', password: 'nurse123', role: 'nurse', clearance: 'phi', purposeOfUse: ['treatment', 'operations'], orgId: 'org:default' },
    { username: 'auditor', displayName: 'Compliance Auditor', password: 'audit123', role: 'auditor', clearance: 'break-glass', purposeOfUse: ['quality', 'research'], orgId: 'org:default' },
  ];
  for (const s of seeds) {
    if (!store.get(s.username)) {
      try { store.create(s); } catch { /* idempotent seed */ }
    }
  }
}
