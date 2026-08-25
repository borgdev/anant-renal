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

// M17 — IdentityRegistry: per-org IdP configs, role mappings, and issued principals.

import type { IdentityProviderConfig, IdentityPrincipal, RoleMapping, IdentityRole, Clearance, PurposeOfUse } from './types.js';

class IdentityRegistryImpl {
  private providers = new Map<string, IdentityProviderConfig>();       // providerId
  private principalsBySubject = new Map<string, IdentityPrincipal>();  // subjectId → principal
  private mappings = new Map<string, RoleMapping>();                    // orgId → mapping
  private auditLog: Array<{ at: string; kind: string; subjectId?: string; providerId?: string; note?: string }> = [];

  // --- Providers ---
  addProvider(cfg: IdentityProviderConfig): IdentityProviderConfig {
    this.providers.set(cfg.providerId, cfg);
    this.audit('provider.added', { providerId: cfg.providerId });
    return cfg;
  }
  getProvider(id: string): IdentityProviderConfig | undefined { return this.providers.get(id); }
  listProviders(orgId?: string): IdentityProviderConfig[] {
    const all = [...this.providers.values()];
    return orgId ? all.filter((p) => p.orgId === orgId) : all;
  }
  removeProvider(id: string): boolean {
    const ok = this.providers.delete(id);
    if (ok) this.audit('provider.removed', { providerId: id });
    return ok;
  }
  setProviderEnabled(id: string, enabled: boolean): boolean {
    const p = this.providers.get(id);
    if (!p) return false;
    p.enabled = enabled;
    this.audit(enabled ? 'provider.enabled' : 'provider.disabled', { providerId: id });
    return true;
  }

  // --- Role mappings ---
  setMapping(m: RoleMapping): RoleMapping {
    this.mappings.set(m.orgId, m);
    this.audit('mapping.set', { note: `orgId=${m.orgId} entries=${m.entries.length}` });
    return m;
  }
  getMapping(orgId: string): RoleMapping | undefined { return this.mappings.get(orgId); }
  listMappings(): RoleMapping[] { return [...this.mappings.values()]; }

  /** Given IdP groups, resolve role/clearance/purpose per the org's mapping. */
  resolveRole(orgId: string, groups: string[]): { role: IdentityRole; clearance: Clearance; purposeOfUse: PurposeOfUse[]; facilityIds?: string[] } {
    const m = this.mappings.get(orgId);
    if (!m) return { role: 'nurse', clearance: 'internal', purposeOfUse: ['operations'] };
    for (const e of m.entries) {
      if (groups.includes(e.idpGroup)) {
        return { role: e.role, clearance: e.clearance, purposeOfUse: e.purposeOfUse, ...(e.facilityIds ? { facilityIds: e.facilityIds } : {}) };
      }
    }
    return { role: m.defaultRole ?? 'nurse', clearance: 'internal', purposeOfUse: ['operations'] };
  }

  // --- Principals ---
  upsertPrincipal(p: IdentityPrincipal): IdentityPrincipal {
    const existing = this.principalsBySubject.get(p.subjectId);
    this.principalsBySubject.set(p.subjectId, p);
    this.audit(existing ? 'principal.updated' : 'principal.created', { subjectId: p.subjectId });
    return p;
  }
  getPrincipal(subjectId: string): IdentityPrincipal | undefined { return this.principalsBySubject.get(subjectId); }
  listPrincipals(orgId?: string): IdentityPrincipal[] {
    const all = [...this.principalsBySubject.values()];
    return orgId ? all.filter((p) => p.orgId === orgId) : all;
  }
  deprovision(subjectId: string): boolean {
    const ok = this.principalsBySubject.delete(subjectId);
    if (ok) this.audit('principal.deprovisioned', { subjectId });
    return ok;
  }

  // --- Audit ---
  audit(kind: string, ctx: { providerId?: string; subjectId?: string; note?: string } = {}): void {
    this.auditLog.push({ at: new Date().toISOString(), kind, ...ctx });
  }
  listAudit(limit = 200): Array<{ at: string; kind: string; subjectId?: string; providerId?: string; note?: string }> {
    return this.auditLog.slice(-limit);
  }

  // For tests / bootstrap
  reset(): void {
    this.providers.clear();
    this.principalsBySubject.clear();
    this.mappings.clear();
    this.auditLog = [];
  }
}

export const IdentityRegistry = new IdentityRegistryImpl();
