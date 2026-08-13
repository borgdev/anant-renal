// M13.C — Multi-facility federation
//
// Cross-realm aggregation. A ProviderOrg is a logical group of realms
// (e.g., "DVC" spans dvc-nashville, dvc-franklin, dvc-antioch). This module
// provides typed rollups across the group: cost, HITL load, plan throughput,
// safety events. Realms remain isolated; federation only reads.

import { RealmRegistry } from './registry.js';
import type { Realm } from './realm.js';

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
