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

// M13.C — Multi-facility federation
//
// Cross-realm aggregation. A ProviderOrg is a logical group of realms
// (e.g., "DVC" spans dvc-nashville, dvc-franklin, dvc-antioch). This module
// provides typed rollups across the group: cost, HITL load, plan throughput,
// safety events. Realms remain isolated; federation only reads.

import { RealmRegistry } from './registry.js';
import type { Realm } from './realm.js';
import { invoicePreview, DEFAULT_BILLING_PLAN, type BillingPlan, type UsagePeriod, type UsageReport } from './billing.js';

export interface ProviderOrg {
  orgId: string;
  displayName: string;
  realmIds: string[]; // participating realm ids
}

const orgs = new Map<string, ProviderOrg>();

export const Federation = {
  registerOrg(org: ProviderOrg): ProviderOrg {
    orgs.set(org.orgId, org);
    return org;
  },
  getOrg(orgId: string): ProviderOrg | undefined { return orgs.get(orgId); },
  listOrgs(): ProviderOrg[] { return [...orgs.values()]; },
  removeOrg(orgId: string): void { orgs.delete(orgId); },

  /** Realms belonging to an org, filtered to those currently registered. */
  realmsFor(orgId: string): Realm[] {
    const org = orgs.get(orgId);
    if (!org) return [];
    return org.realmIds.map((id) => RealmRegistry.get(id)).filter((r): r is Realm => r !== undefined);
  },

  /** Roll up cost/outcome ledger across all realms in the org. */
  costRollup(orgId: string) {
    const rs = this.realmsFor(orgId);
    const totals = { dollars: 0, clinicianMin: 0, safetyRisk: 0, patientSatisfaction: 0, throughput: 0 };
    let episodeCount = 0;
    const perRealm: Array<{ realmId: string; rollup: ReturnType<Realm['cost']['rollup']> }> = [];
    for (const r of rs) {
      const roll = r.cost.rollup();
      totals.dollars += roll.totals.dollars;
      totals.clinicianMin += roll.totals.clinicianMin;
      totals.safetyRisk += roll.totals.safetyRisk;
      totals.patientSatisfaction += roll.totals.patientSatisfaction;
      totals.throughput += roll.totals.throughput;
      episodeCount += roll.episodeCount;
      perRealm.push({ realmId: r.id, rollup: roll });
    }
    const averages = episodeCount === 0 ? totals : {
      dollars: totals.dollars / episodeCount,
      clinicianMin: totals.clinicianMin / episodeCount,
      safetyRisk: totals.safetyRisk / episodeCount,
      patientSatisfaction: totals.patientSatisfaction / episodeCount,
      throughput: totals.throughput / episodeCount,
    };
    return { totals, averages, episodeCount, perRealm };
  },

  /** Cross-realm HITL load: how many approvals are pending / decided per realm. */
  hitlLoad(orgId: string) {
    const rs = this.realmsFor(orgId);
    return rs.map((r) => {
      const all = r.hitl.all();
      return {
        realmId: r.id,
        pending: all.filter((a) => a.status === 'pending').length,
        approved: all.filter((a) => a.status === 'approved').length,
        rejected: all.filter((a) => a.status === 'rejected').length,
        total: all.length,
      };
    });
  },

  /** Cross-realm plan throughput: intents submitted + plans produced per realm. */
  planThroughput(orgId: string) {
    const rs = this.realmsFor(orgId);
    return rs.map((r) => ({
      realmId: r.id,
      intents: r.listIntents().length,
      plans: r.listPlans().length,
      completedPlans: r.listPlans().filter((p) => p.steps.every((s) => s.status === 'completed')).length,
    }));
  },

  /** Cross-realm safety-event count over the ledger. */
  safetyLoad(orgId: string) {
    const rs = this.realmsFor(orgId);
    return rs.map((r) => {
      const evs = r.ledger.listAll().filter((e) => e.effect.kind === 'flag-safety-event' && e.status !== 'rejected');
      const bySeverity: Record<string, number> = {};
      for (const e of evs) {
        const sev = (e.effect as { severity?: string }).severity ?? 'unknown';
        bySeverity[sev] = (bySeverity[sev] ?? 0) + 1;
      }
      return { realmId: r.id, total: evs.length, bySeverity };
    });
  },

  /** M14.E — Aggregate billing preview across every realm in the org. */
  invoicePreviewForOrg(orgId: string, plan: BillingPlan = DEFAULT_BILLING_PLAN, period: UsagePeriod = {}): {
    plan: BillingPlan;
    perRealm: Array<{ realmId: string; report: UsageReport }>;
    totals: { metersSubtotalUsd: number; episodesSubtotalUsd: number; minimumTopUpUsd: number; totalDueUsd: number };
  } {
    const rs = this.realmsFor(orgId);
    const perRealm: Array<{ realmId: string; report: UsageReport }> = [];
    const totals = { metersSubtotalUsd: 0, episodesSubtotalUsd: 0, minimumTopUpUsd: 0, totalDueUsd: 0 };
    for (const r of rs) {
      const report = invoicePreview(r, plan, period);
      perRealm.push({ realmId: r.id, report });
      totals.metersSubtotalUsd += report.metersSubtotalUsd;
      totals.episodesSubtotalUsd += report.episodesSubtotalUsd;
      totals.minimumTopUpUsd += report.minimumTopUpUsd;
      totals.totalDueUsd += report.totalDueUsd;
    }
    return { plan, perRealm, totals };
  },

  /** One-shot summary: everything the operator UI needs to render an org page. */
  orgSummary(orgId: string) {
    const org = orgs.get(orgId);
    if (!org) throw new Error(`org-not-found:${orgId}`);
    const realms = this.realmsFor(orgId);
    return {
      org,
      realmCount: realms.length,
      realms: realms.map((r) => ({ id: r.id, mode: r.mode, seq: r.clock.seq, realmAt: r.clock.realmAt.toISOString() })),
      cost: this.costRollup(orgId),
      hitl: this.hitlLoad(orgId),
      plans: this.planThroughput(orgId),
      safety: this.safetyLoad(orgId),
    };
  },
};
