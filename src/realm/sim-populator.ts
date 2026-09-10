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

// SimPopulator — seeds a realm with a synthetic patient population.
// Not a claim of clinical accuracy — enough plausible variation for agent
// evaluation and operator demos.

import type { Realm } from './realm.js';

export interface FacilitySeed {
  facilityId: string;
  kind: 'dialysis' | 'primary-care' | 'urgent-care' | 'hospital';
  name: string;
  units: string[]; // e.g. ['ICH-A','ICH-B','ICH-C'] for dialysis
  patientCount: number;
}

import { generateLongitudinalHistory, baselinePanelFor } from '../simulator/longitudinal.js';

const TRAJECTORIES = ['stable', 'decompensating', 'recovering', 'anemic-worsening', 'anemic-recovering', 'underdialyzed', 'hyperphosphatemia'] as const;
const AGES = [45, 52, 58, 61, 64, 68, 71, 74, 77, 79];
const SEXES: Array<'F' | 'M'> = ['F', 'M'];
/** F1 — vascular access modalities, cycled deterministically per patient index. */
const ACCESS_TYPES = ['avf', 'avf', 'avg', 'catheter'] as const;

/** R1 — optional complete-data backfill: seed each patient's chart with a
 *  deterministic 90-day-consistent lab/vitals summary at creation. */
export interface PopulateHistoryOptions {
  seed?: number;
  days?: number;
}

export function populateFacility(realm: Realm, seed: FacilitySeed, history?: PopulateHistoryOptions): { facilityId: string; unitIds: string[]; patientIds: string[] } {
  const g = realm.graph;
  const facilityUrn = g.urnFor('facility', seed.facilityId);
  if (!g.get(facilityUrn)) g.create('facility', seed.facilityId, { kind: seed.kind, name: seed.name });
  const unitIds: string[] = [];
  for (const u of seed.units) {
    const urn = g.urnFor('unit', `${seed.facilityId}-${u}`);
    if (!g.get(urn)) {
      const rec = g.create('unit', `${seed.facilityId}-${u}`, { code: u, facilityId: seed.facilityId });
      g.addRelation(rec.urn, 'in-facility', facilityUrn);
    }
    unitIds.push(`${seed.facilityId}-${u}`);
  }
  const patientIds: string[] = [];
  for (let i = 0; i < seed.patientCount; i++) {
    const pid = `${seed.facilityId}-pt-${String(i + 1).padStart(4, '0')}`;
    const unitId = unitIds[i % unitIds.length]!;
    const trajectory = TRAJECTORIES[i % TRAJECTORIES.length]!;
    const age = AGES[i % AGES.length]!;
    const sex = SEXES[i % SEXES.length]!;
    const rec = g.create('patient', pid, {
      admitted: true,
      facilityId: seed.facilityId,
      unitId,
      age,
      sex,
      trajectory,
      // dialysis vintage — a real slice dimension for fairness reporting, and
      // the infection triage's vintage driver
      dialysisVintageYears: Math.round((0.5 + ((i * 1.7) % 13)) * 10) / 10,
      admittedAt: realm.clock.realmAt.toISOString(),
      problemList: problemsFor(seed.kind, trajectory),
      lastVitals: { hr: 72 + (i % 10), bp: '128/78', spo2: 97, at: realm.clock.realmAt.toISOString() },
      // ---- F1 renal protocol foundations ----
      access: {
        type: ACCESS_TYPES[i % ACCESS_TYPES.length]!,
        site: i % 3 === 0 ? 'left-forearm' : i % 3 === 1 ? 'right-forearm' : 'left-upper-arm',
        ageDays: 120 + (i * 37) % 900,
        events: [],
      },
      sessions: [],
      accessObservations: [],
      accessAcoustic: [],
      ...(history
        ? (() => {
            const profile = generateLongitudinalHistory({ patientId: pid, facilityId: seed.facilityId, trajectory, days: history.days ?? 90, seed: history.seed ?? 1, asOf: new Date(realm.clock.realmAt) });
            const esaPts = profile.history.filter((p) => p.esaDose !== undefined);
            const latestEsa = esaPts.length ? esaPts[esaPts.length - 1]?.esaDose : undefined;
            const esaDosingHistory = esaPts.map((p) => ({ at: `${p.date}T07:00:00.000Z`, dose: p.esaDose as number }));
            return {
              labs: { ...profile.latest.labs, ...baselinePanelFor(trajectory) },
              lastVitals: { ...profile.latest.vitals, at: realm.clock.realmAt.toISOString() },
              ...(latestEsa !== undefined ? { esaDose: latestEsa } : {}),
              esaEscalationsLast90d: profile.latest.esaEscalationsLast90d,
              ...(esaDosingHistory.length ? { esaDosingHistory } : {}),
            };
          })()
        : {}),
    });
    g.addRelation(rec.urn, 'in-unit', g.urnFor('unit', unitId));
    g.addRelation(rec.urn, 'in-facility', facilityUrn);
    patientIds.push(pid);
  }
  return { facilityId: seed.facilityId, unitIds, patientIds };
}

function problemsFor(kind: FacilitySeed['kind'], trajectory: string): string[] {
  const base: Record<FacilitySeed['kind'], string[]> = {
    'dialysis': ['ESRD', 'HTN', 'DM2'],
    'primary-care': ['HTN', 'DM2', 'Hyperlipidemia'],
    'urgent-care': [],
    'hospital': ['CAD', 'CHF'],
  };
  const extra: Record<string, string[]> = {
    'anemic-worsening': ['CKD-anemia'],
    'anemic-recovering': ['CKD-anemia'],
    'underdialyzed': ['Underdialysis'],
    'hyperphosphatemia': ['Hyperphosphatemia', 'CKD-MBD'],
    'decompensating': ['Sepsis-risk'],
  };
  return [...base[kind], ...(extra[trajectory] ?? [])];
}
