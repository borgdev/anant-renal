// M13.B — Metered billing surface
//
// Consumer-friendly billing on top of the cost ledger + effect ledger.
// Two pricing dimensions:
//   1. Per-effect metering: each accepted effect kind has a unit cost
//      (like Stripe metered events). Rejected/shadow effects are free.
//   2. Per-episode pricing tier: episodes fall into a tier based on complexity
//      (effect count + safety weight). Each tier has a flat + variable fee.
//
// Exports two views:
//   - meterUsage(realm, period): line items ready to submit to a billing system
//   - invoicePreview(realm, period, plan): dollar totals + breakdown, matching
//     what the customer would see on an invoice.

import type { Realm } from './realm.js';

export interface EffectMeter {
  effectKind: string;
  unitPriceUsd: number; // cost per accepted emission
}

export interface EpisodeTier {
  id: string;
  displayName: string;
  matches: (ep: { effectCount: number; hadCritical: boolean; hadSafetyEvent: boolean }) => boolean;
  flatFeeUsd: number;
  perEffectUsd: number;
}

export interface BillingPlan {
  planId: string;
  displayName: string;
  meters: EffectMeter[];
  episodeTiers: EpisodeTier[];
  minimumMonthlyUsd?: number;
}

/** Sensible starter plan for a dialysis facility. Prices are illustrative,
 * tuned to be close to real per-encounter costs so demos feel realistic. */
export const DEFAULT_BILLING_PLAN: BillingPlan = {
  planId: 'plan.dialysis-basic',
  displayName: 'Dialysis Basic (per-effect + per-episode)',
  meters: [
    { effectKind: 'submit-claim', unitPriceUsd: 12 }, // per claim submitted
    { effectKind: 'flag-safety-event', unitPriceUsd: 0 }, // no charge, but tracked
    { effectKind: 'order-lab', unitPriceUsd: 0.25 },
    { effectKind: 'result-lab', unitPriceUsd: 0 },
    { effectKind: 'record-vitals', unitPriceUsd: 0.05 },
    { effectKind: 'order-med', unitPriceUsd: 0.15 },
    { effectKind: 'hold-med', unitPriceUsd: 0.15 },
    { effectKind: 'schedule-followup', unitPriceUsd: 0.30 },
    { effectKind: 'discharge-patient', unitPriceUsd: 5 },
    { effectKind: 'admit-patient', unitPriceUsd: 5 },
    { effectKind: 'open-ticket', unitPriceUsd: 0.10 },
    { effectKind: 'record-assessment', unitPriceUsd: 0.10 },
  ],
  episodeTiers: [
    { id: 't3.critical', displayName: 'Critical episode', matches: (e) => e.hadCritical, flatFeeUsd: 40, perEffectUsd: 1.5 },
    { id: 't2.complex', displayName: 'Complex episode', matches: (e) => e.hadSafetyEvent || e.effectCount >= 6, flatFeeUsd: 20, perEffectUsd: 1 },
    { id: 't1.routine', displayName: 'Routine episode', matches: () => true, flatFeeUsd: 8, perEffectUsd: 0.5 },
  ],
  minimumMonthlyUsd: 250,
};

export interface MeterLineItem {
  effectKind: string;
  count: number;
  unitPriceUsd: number;
  subtotalUsd: number;
}

export interface EpisodeLineItem {
  episodeId: string;
  role: string;
  tierId: string;
  effectCount: number;
  flatFeeUsd: number;
  variableFeeUsd: number;
  subtotalUsd: number;
}

export interface UsagePeriod {
  from?: Date; // inclusive
  to?: Date; // exclusive
}

export interface UsageReport {
  period: UsagePeriod;
  meters: MeterLineItem[];
  episodes: EpisodeLineItem[];
  metersSubtotalUsd: number;
  episodesSubtotalUsd: number;
  subtotalUsd: number;
  minimumApplied: boolean;
  minimumTopUpUsd: number;
  totalDueUsd: number;
}

function inPeriod(iso: string, period: UsagePeriod): boolean {
  const t = new Date(iso).getTime();
  if (period.from && t < period.from.getTime()) return false;
  if (period.to && t >= period.to.getTime()) return false;
  return true;
}

/** Compute a full invoice preview from the ledger + cost records. Idempotent. */
export function invoicePreview(realm: Realm, plan: BillingPlan = DEFAULT_BILLING_PLAN, period: UsagePeriod = {}): UsageReport {
  const meterIndex = new Map(plan.meters.map((m) => [m.effectKind, m]));

  // 1. Per-effect metering
  const countByKind = new Map<string, number>();
  for (const e of realm.ledger.listAll()) {
    if (e.status === 'rejected') continue;
    if (!inPeriod(e.emittedAt, period)) continue;
    if (!meterIndex.has(e.effect.kind)) continue;
    countByKind.set(e.effect.kind, (countByKind.get(e.effect.kind) ?? 0) + 1);
  }
  const meters: MeterLineItem[] = [];
  for (const m of plan.meters) {
    const count = countByKind.get(m.effectKind) ?? 0;
    if (count === 0) continue;
    meters.push({ effectKind: m.effectKind, count, unitPriceUsd: m.unitPriceUsd, subtotalUsd: count * m.unitPriceUsd });
  }
  const metersSubtotalUsd = meters.reduce((s, m) => s + m.subtotalUsd, 0);

  // 2. Per-episode tiering
  const episodes: EpisodeLineItem[] = [];
  for (const c of realm.cost.list()) {
    if (!inPeriod(c.closedAt, period)) continue;
    const ep = realm.episodes.get(c.episodeId);
    const effectIds = ep?.consequences ?? [];
    const role = ep?.presenceId ? (realm.presences.get(ep.presenceId)?.role ?? 'unknown') : 'unknown';
    const effectCount = effectIds.length;
    const allEffects = realm.ledger.listAll();
    const idSet = new Set(effectIds);
    const effs = allEffects.filter((e) => idSet.has(e.effectId));
    const hadSafetyEvent = effs.some((e) => e.effect.kind === 'flag-safety-event');
    const hadCritical = effs.some((e) => e.effect.kind === 'flag-safety-event' && (e.effect as { severity?: string }).severity === 'critical');
    const tier = plan.episodeTiers.find((t) => t.matches({ effectCount, hadCritical, hadSafetyEvent })) ?? plan.episodeTiers[plan.episodeTiers.length - 1]!;
    const variableFeeUsd = effectCount * tier.perEffectUsd;
    episodes.push({
      episodeId: c.episodeId,
      role,
      tierId: tier.id,
      effectCount,
      flatFeeUsd: tier.flatFeeUsd,
      variableFeeUsd,
      subtotalUsd: tier.flatFeeUsd + variableFeeUsd,
    });
  }
  const episodesSubtotalUsd = episodes.reduce((s, e) => s + e.subtotalUsd, 0);

  const subtotalUsd = metersSubtotalUsd + episodesSubtotalUsd;
  const minimum = plan.minimumMonthlyUsd ?? 0;
  const minimumApplied = subtotalUsd < minimum;
  const minimumTopUpUsd = minimumApplied ? minimum - subtotalUsd : 0;
  const totalDueUsd = subtotalUsd + minimumTopUpUsd;

  return {
    period,
    meters,
    episodes,
    metersSubtotalUsd,
    episodesSubtotalUsd,
    subtotalUsd,
    minimumApplied,
    minimumTopUpUsd,
    totalDueUsd,
  };
}

/** Line-item CSV for hand-off to accounting systems / QuickBooks / Stripe usage records. */
export function usageCsv(report: UsageReport): string {
  const rows: string[] = ['type,identifier,count_or_effects,unit_price_usd,subtotal_usd'];
  for (const m of report.meters) rows.push(`meter,${m.effectKind},${m.count},${m.unitPriceUsd},${m.subtotalUsd.toFixed(2)}`);
  for (const e of report.episodes) rows.push(`episode,${e.episodeId},${e.effectCount},${(e.flatFeeUsd + e.variableFeeUsd).toFixed(2)},${e.subtotalUsd.toFixed(2)}`);
  if (report.minimumApplied) rows.push(`minimum,top-up,,,${report.minimumTopUpUsd.toFixed(2)}`);
  rows.push(`total,total,,,${report.totalDueUsd.toFixed(2)}`);
  return rows.join('\n');
}
