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

// R1 — realm history backfill.
//
// WHY THIS EXISTS. Seeding patient STATE (sim-populator) is not the same as
// seeding the LEDGER, and every protocol observer in this platform reads the
// ledger: the twins replay `record-vitals` / `result-lab` / `order-med` events
// to build their series. A realm created through the console had state but no
// ledger events, so its patients looked permanently un-monitored — every pack's
// coverage gate blocked them, and the console showed a cohort that could never
// be assessed.
//
// This module fixes that at the source instead of weakening the gates: when a
// realm is created, a deterministic longitudinal history is WALKED THROUGH THE
// REAL CLOCK and written to the ledger as real effects through a real presence,
// so the reducer, the authority rules and the hypergraph bridge all see exactly
// what they would see if the unit had actually been running. Nothing about the
// gate changes — the data simply exists.
//
// The realm is created anchored `days` in the past, the history is replayed
// forward to the present, and the caller then starts the clock. Timestamps are
// therefore real realm time, not manufactured look-back strings.

import type { Realm } from '../realm/realm.js';
import type { WorldEffect } from '../realm/types.js';
import { generateLongitudinalHistory, baselinePanelFor, type LongitudinalTrajectory } from './longitudinal.js';

export interface BackfillOptions {
  /** History length in days (default 90). */
  days?: number;
  /** Deterministic site seed (default 1). */
  seed?: number;
  /** Emit the CKD-MBD / nutrition / infection panel alongside the core labs. */
  panel?: boolean;
}

export interface BackfillResult {
  patients: number;
  effects: number;
  rejected: number;
  days: number;
  presenceId?: string;
  firstAt?: string;
  lastAt?: string;
  /** realm hours the clock was advanced through */
  hoursAdvanced: number;
}

const DAY_MS = 86_400_000;

/** Units for the lab codes this backfill writes (the ledger carries units). */
const LAB_UNITS: Record<string, string> = {
  K: 'mmol/L', HGB: 'g/dL', URR: '%', PHOS: 'mg/dL', CALCIUM: 'mg/dL',
  PTH: 'pg/mL', ALBUMIN: 'g/dL', CREATININE: 'mg/dL', BICARB: 'mmol/L',
  CRP: 'mg/L', WBC: '10^3/uL', PROCALCITONIN: 'ng/mL',
};

/** Flag the values a clinician would act on, so the chart is not all "normal". */
function labAbnormal(code: string, value: number): 'H' | 'L' | undefined {
  switch (code) {
    case 'K': return value > 6 ? 'H' : value < 3.5 ? 'L' : undefined;
    case 'HGB': return value < 10 ? 'L' : undefined;
    case 'URR': return value < 65 ? 'L' : undefined;
    case 'PHOS': return value > 5.5 ? 'H' : undefined;
    case 'CALCIUM': return value > 10.2 ? 'H' : value < 8.4 ? 'L' : undefined;
    case 'PTH': return value > 585 ? 'H' : undefined;
    case 'ALBUMIN': return value < 3.5 ? 'L' : undefined;
    case 'BICARB': return value < 22 ? 'L' : undefined;
    case 'CRP': return value > 10 ? 'H' : undefined;
    case 'WBC': return value > 11 ? 'H' : value < 4 ? 'L' : undefined;
    case 'PROCALCITONIN': return value > 0.5 ? 'H' : undefined;
    default: return undefined;
  }
}

/** The weekdays a dialysis unit treats (Mon/Wed/Fri). */
function isDialysisDay(date: Date): boolean {
  const d = date.getUTCDay();
  return d === 1 || d === 3 || d === 5;
}

/**
 * Replay a deterministic longitudinal history into the realm ledger.
 *
 * Call with the realm clock anchored at `now - days`; this walks forward one
 * day at a time and emits the day's effects, so every event lands at its real
 * realm time and the ambient processes tick exactly as they would in a live
 * realm.
 */
export function backfillRealmHistory(realm: Realm, opts: BackfillOptions = {}): BackfillResult {
  const days = Math.max(7, Math.min(365, opts.days ?? 90));
  const seed = opts.seed ?? 1;
  const withPanel = opts.panel ?? true;
  const patients = realm.graph.listKind('patient');
  if (patients.length === 0) return { patients: 0, effects: 0, rejected: 0, days, hoursAdvanced: 0 };

  // A backfill is performed BY a clinician presence, so the authority rules and
  // the policy layer apply to it like any other write.
  const facility = realm.graph.listKind('facility')[0];
  const unit = realm.graph.listKind('unit')[0];
  const location: { facilityId: string; unitId?: string } = { facilityId: facility?.id ?? 'unknown' };
  if (unit) location.unitId = unit.id;
  const presence = realm.presences.spawn({
    realmId: realm.id,
    agentSpecId: 'system.backfill',
    runId: `backfill-${realm.id}`,
    role: 'md',
    clearance: 'restricted-phi',
    purposeOfUse: ['treatment'],
    location,
    perceptualRange: { units: ['*'], patients: ['*'], eventTypes: ['*'] },
  });

  const profiles = patients.map((p) => {
    const state = p.state as { facilityId?: string; trajectory?: string };
    const trajectory = (state.trajectory ?? 'stable') as LongitudinalTrajectory;
    return {
      patientId: p.id,
      facilityId: state.facilityId ?? 'unknown',
      trajectory,
      profile: generateLongitudinalHistory({
        patientId: p.id,
        facilityId: state.facilityId ?? 'unknown',
        trajectory,
        days,
        seed,
        asOf: new Date(realm.clock.realmAt.getTime() + (days - 1) * DAY_MS),
      }),
      panel: withPanel ? baselinePanelFor(trajectory) : undefined,
    };
  });

  let effects = 0;
  let rejected = 0;
  let firstAt: string | undefined;
  let lastAt: string | undefined;
  let labSeq = 0;

  const emit = (effect: WorldEffect): void => {
    const at = realm.clock.realmAt.toISOString();
    firstAt ??= at;
    lastAt = at;
    effects += 1;
    try {
      const emitted = realm.emit(presence.presenceId, effect);
      if (emitted.rejection) rejected += 1;
    } catch {
      // an unmatched authority/location must never abort a realm creation
      rejected += 1;
    }
  };

  // The clock is already anchored at day 0; the first day needs no advance.
  for (let day = 0; day < days; day += 1) {
    if (day > 0) realm.clock.advanceBy(DAY_MS);
    const now = realm.clock.realmAt;
    for (const entry of profiles) {
      const point = entry.profile.history[day];
      if (!point) continue;
      emit({
        kind: 'record-vitals',
        patientId: entry.patientId,
        hr: point.vitals.hr,
        bp: point.vitals.bp,
        spo2: point.vitals.spo2,
        temp: point.vitals.tempC,
      });
      if (point.labs) {
        labSeq += 1;
        const core: Array<[string, number]> = [['K', point.labs.K], ['HGB', point.labs.HGB], ['URR', point.labs.URR], ['PHOS', point.labs.PHOS]];
        // a real unit draws a panel alongside the core dialysis labs; the codes
        // match what the ambient lab process would have produced
        const panel: Array<[string, number]> = entry.panel
          ? [['CALCIUM', entry.panel.calcium], ['PTH', entry.panel.pth], ['ALBUMIN', entry.panel.albumin], ['CREATININE', entry.panel.creatinine], ['BICARB', entry.panel.bicarb], ['CRP', entry.panel.crp], ['WBC', entry.panel.wbc], ['PROCALCITONIN', entry.panel.procalcitonin]]
          : [];
        for (const [code, value] of [...core, ...panel]) {
          // Results are written DIRECTLY, not as order→maturation→result: the
          // live LabMaturationProcess would otherwise mature the same order with
          // its own random draw and overwrite the deterministic history. The
          // orderId is still carried so every observer attributes the result to
          // its patient the same way it does for live results.
          const orderId = `${entry.patientId}-${code}-${realm.clock.seq}`;
          emit({
            kind: 'result-lab',
            orderId,
            code,
            value,
            unit: LAB_UNITS[code] ?? 'unit',
            ...(labAbnormal(code, value) ? { abnormal: labAbnormal(code, value)! } : {}),
          });
        }
      }
      // weekly ESA order on an ESA trajectory — the twin reads the real dosing history
      if (isDialysisDay(now) && point.esaDose !== undefined && point.esaDose > 0) {
        emit({
          kind: 'order-med',
          patientId: entry.patientId,
          code: 'epoetin-alfa',
          dose: String(point.esaDose),
          route: 'IV',
          frequency: 'weekly',
          indication: 'anemia',
        });
      }
    }
  }

  return {
    patients: profiles.length,
    effects,
    rejected,
    days,
    presenceId: presence.presenceId,
    ...(firstAt ? { firstAt } : {}),
    ...(lastAt ? { lastAt } : {}),
    hoursAdvanced: (days - 1) * 24,
  };
}

/**
 * How far in the past a realm must be anchored for a backfill of `days`, so the
 * clock lands back on "now" when the history has been replayed.
 */
export function backfillAnchorMs(days: number): number {
  return (Math.max(7, Math.min(365, days)) - 1) * DAY_MS;
}
