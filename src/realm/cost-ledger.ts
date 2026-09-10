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

// M12 — Cost / Outcome ledger.
//
// Parallel to the effect ledger, this scores every closed Episode on a vector
// of business dimensions the operator's CFO/COO cares about:
//   - dollars       (billed value + averted-cost proxy)
//   - clinicianMin  (clinician-minutes spent)
//   - safetyRisk    (weighted safety-event count during the episode)
//   - patientSatisfaction  (schedule-followup, resolution completeness proxy)
//   - throughput    (discharges/transfers completed)
//
// Weights are pluggable so an org can express what "value" means in its terms.

import type { EpisodeStore, Episode } from './episode.js';
import type { EffectLedger } from './effect-ledger.js';
import type { EmittedEffect, WorldEffect } from './types.js';

export interface CostWeights {
  dollarsPerCptCode: number;              // avg reimbursement per CPT code
  dollarsPerAvertedSafety: number;        // averted-cost proxy for holding meds on hyperkalemia etc.
  clinicianMinPerEffectKind: Partial<Record<WorldEffect['kind'], number>>;
  safetyRiskPerSeverity: { low: number; moderate: number; high: number; critical: number };
  satisfactionPerFollowup: number;
  satisfactionPerResolvedTicket: number;
}

export const DEFAULT_WEIGHTS: CostWeights = {
  dollarsPerCptCode: 175,
  dollarsPerAvertedSafety: 3200,
  clinicianMinPerEffectKind: {
    'admit-patient': 20,
    'transfer-patient': 10,
    'discharge-patient': 25,
    'order-lab': 3,
    'result-lab': 2,
    'order-med': 4,
    'administer-med': 5,
    'hold-med': 3,
    'titrate-med': 4,
    'record-vitals': 2,
    'record-assessment': 6,
    'record-immunisation': 8,
    'update-care-plan': 8,
    'schedule-followup': 4,
    'notify-staff': 2,
    'flag-safety-event': 5,
    'submit-claim': 12,
    'request-prior-auth': 10,
    'open-ticket': 5,
    'update-ticket': 3,
    'close-ticket': 3,
    'escalate': 2,
    'assign-object': 2,
    'release-object': 2,
    'mark-object-state': 1,
    'approve-effect': 4,
  },
  safetyRiskPerSeverity: { low: 1, moderate: 3, high: 8, critical: 20 },
  satisfactionPerFollowup: 2,
  satisfactionPerResolvedTicket: 1,
};

export interface EpisodeCostRecord {
  episodeId: string;
  presenceId: string;
  closedAt: string;
  scores: {
    dollars: number;
    clinicianMin: number;
    safetyRisk: number;
    patientSatisfaction: number;
    throughput: number;
  };
  detail: {
    effectCount: number;
    cptCodes: number;
    avertedSafety: number;
    followups: number;
    resolvedTickets: number;
    safetyEvents: { low: number; moderate: number; high: number; critical: number };
    discharges: number;
    transfers: number;
  };
}

export class CostLedger {
  private records: Map<string, EpisodeCostRecord> = new Map();

  constructor(private episodes: EpisodeStore, private ledger: EffectLedger, private weights: CostWeights = DEFAULT_WEIGHTS) {
    // Subscribe to episode close.
    this.episodes.onClose((ep) => this.scoreEpisode(ep));
  }

  private effectsFor(ep: Episode): EmittedEffect[] {
    const ids = new Set(ep.consequences);
    return this.ledger.listAll().filter((e) => ids.has(e.effectId));
  }

  private scoreEpisode(ep: Episode): void {
    const effects = this.effectsFor(ep);
    const detail = {
      effectCount: effects.length,
      cptCodes: 0,
      avertedSafety: 0,
      followups: 0,
      resolvedTickets: 0,
      safetyEvents: { low: 0, moderate: 0, high: 0, critical: 0 },
      discharges: 0,
      transfers: 0,
    };
    let clinicianMin = 0;
    for (const e of effects) {
      const kind = e.effect.kind;
      clinicianMin += this.weights.clinicianMinPerEffectKind[kind] ?? 0;
      if (kind === 'submit-claim') detail.cptCodes += ((e.effect as { cptCodes?: string[] }).cptCodes ?? []).length;
      if (kind === 'hold-med') detail.avertedSafety += 1;
      if (kind === 'schedule-followup') detail.followups += 1;
      if (kind === 'close-ticket' && (e.effect as { resolution?: string }).resolution === 'resolved') detail.resolvedTickets += 1;
      if (kind === 'flag-safety-event') {
        const sev = (e.effect as { severity?: 'low' | 'moderate' | 'high' | 'critical' }).severity ?? 'low';
        detail.safetyEvents[sev] += 1;
      }
      if (kind === 'discharge-patient') detail.discharges += 1;
      if (kind === 'transfer-patient') detail.transfers += 1;
    }
    const safetyRisk =
      detail.safetyEvents.low * this.weights.safetyRiskPerSeverity.low +
      detail.safetyEvents.moderate * this.weights.safetyRiskPerSeverity.moderate +
      detail.safetyEvents.high * this.weights.safetyRiskPerSeverity.high +
      detail.safetyEvents.critical * this.weights.safetyRiskPerSeverity.critical;
    const dollars = detail.cptCodes * this.weights.dollarsPerCptCode + detail.avertedSafety * this.weights.dollarsPerAvertedSafety;
    const patientSatisfaction =
      detail.followups * this.weights.satisfactionPerFollowup +
      detail.resolvedTickets * this.weights.satisfactionPerResolvedTicket;
    const throughput = detail.discharges + detail.transfers;
    const rec: EpisodeCostRecord = {
      episodeId: ep.episodeId,
      presenceId: ep.presenceId,
      closedAt: ep.closedAt ?? new Date().toISOString(),
      scores: { dollars, clinicianMin, safetyRisk, patientSatisfaction, throughput },
      detail,
    };
    this.records.set(ep.episodeId, rec);
  }

  list(): EpisodeCostRecord[] { return [...this.records.values()]; }
  get(episodeId: string): EpisodeCostRecord | undefined { return this.records.get(episodeId); }

  /** Aggregate all closed-episode scores into an org-level rollup. */
  rollup(): { totals: EpisodeCostRecord['scores']; episodeCount: number; avg: EpisodeCostRecord['scores'] } {
    const totals = { dollars: 0, clinicianMin: 0, safetyRisk: 0, patientSatisfaction: 0, throughput: 0 };
    let n = 0;
    for (const r of this.records.values()) {
      totals.dollars += r.scores.dollars;
      totals.clinicianMin += r.scores.clinicianMin;
      totals.safetyRisk += r.scores.safetyRisk;
      totals.patientSatisfaction += r.scores.patientSatisfaction;
      totals.throughput += r.scores.throughput;
      n++;
    }
    const avg = n > 0
      ? { dollars: totals.dollars / n, clinicianMin: totals.clinicianMin / n, safetyRisk: totals.safetyRisk / n, patientSatisfaction: totals.patientSatisfaction / n, throughput: totals.throughput / n }
      : { ...totals };
    return { totals, episodeCount: n, avg };
  }
}
