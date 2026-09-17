/******************************************************************************
 *
 * Copyright (c) 2026 AnantHQ Inc.
 * All Rights Reserved.
 *
 * This software is licensed, not sold.
 *
 * The contents of this file constitute confidential and proprietary
 * information belonging exclusively to AnantHQ Inc.
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

// The hand-written population (S1).
//
// This is today's seeder, moved out of `sim-populator.ts` with its arithmetic
// unchanged. It is the default source, it is what the unit tests use, and it needs
// nothing installed — which is the whole reason it stays rather than being
// deleted. S4 replaces it *as the source of truth* for a configured deployment;
// it remains the fallback a test can rely on.
//
// Two things worth stating plainly, because a reader will otherwise treat this as
// a model of a population rather than a fixture:
//
//   * **Every attribute is `array[index % length]`.** Ten ages, two strictly
//     alternating sexes, seven trajectories, four access modalities, nine
//     comorbidity patterns of which five are empty. The dimensions have an LCM of
//     1260, so a population smaller than that contains no repeats — but its
//     diversity ceiling is ten ages and four oncology presentations, not 1260
//     anything.
//   * **It carries no equity dimensions at all** — no race, ethnicity, language or
//     insurance. Age and sex are the only demographic axes, so an equity screen
//     run against this population cannot slice on what healthcare equity is
//     mostly measured by. That is measured in §9.2 of the Synthea plan, and it is
//     the strongest single argument for replacing this file.
//
// The pathological properties are stated here rather than in the plan alone
// because the plan is a document and this is the code someone will read.

import { generateLongitudinalHistory, baselinePanelFor } from '../simulator/longitudinal.js';
import type { PatientSeedContext, PatientSource, PopulatedPatient } from './source.js';

const TRAJECTORIES = ['stable', 'decompensating', 'recovering', 'anemic-worsening', 'anemic-recovering', 'underdialyzed', 'hyperphosphatemia'] as const;
const AGES = [45, 52, 58, 61, 64, 68, 71, 74, 77, 79];
const SEXES: Array<'F' | 'M'> = ['F', 'M'];
/** F1 — vascular access modalities, cycled deterministically per patient index. */
const ACCESS_TYPES = ['avf', 'avf', 'avg', 'catheter'] as const;

function problemsFor(kind: PatientSeedContext['facilityKind'], trajectory: string): string[] {
  const base: Record<PatientSeedContext['facilityKind'], string[]> = {
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

/**
 * Chronic comorbidity carried by a share of the synthetic population.
 *
 * A multi-specialty deployment needs patients who belong to MORE THAN ONE
 * specialty, and this is where they come from. A patient with ESRD and a
 * malignancy is in two cohorts at once — which is the entire reason a platform
 * hosts several specialties instead of shipping several products — and it is
 * clinically ordinary rather than a contrivance: malignancy is common in dialysis
 * populations.
 *
 * A PLATFORM list, deliberately, and not any specialty's. The simulator generates
 * a population; which of these a specialty considers its own is that specialty's
 * business (each pack's own `cohort.ts`). A simulator that knew oncology's
 * vocabulary would be the same coupling in the other direction — a specialty named
 * in the platform, which is what G1 and G4b spent their whole time removing.
 *
 * The fraction is raised above real prevalence on purpose: a synthetic cohort of
 * three patients cannot show whether a second specialty's screen works, and the
 * number is a property of the fixture rather than a clinical claim. In a real
 * deployment these arrive as `condition.recorded` from the EMR, and this list is
 * the stand-in for that feed.
 *
 * S0 measured what the stand-in costs: four presentations, no onsets, and 36 of 58
 * deployed patients carrying exactly one of them.
 */
const COMORBIDITIES: readonly (readonly string[])[] = Object.freeze([
  ['NSCLC'],
  ['Breast cancer'],
  ['Colorectal cancer'],
  ['RCC'],
  [],
  [],
  [],
  [],
  [],
]);

/** Deterministic on the patient index, so a seeded run is reproducible. */
function comorbidityFor(i: number): string[] {
  return [...(COMORBIDITIES[i % COMORBIDITIES.length] ?? [])];
}

/**
 * Today's population: a deterministic round-robin over hand-written arrays.
 *
 * Moved here from `sim-populator.ts` with the arithmetic untouched. Nothing about
 * the output changed, and `tests/population-source.test.ts` pins that with a hash
 * captured before the move.
 */
export const StaticPatientSource: PatientSource = {
  id: 'static',
  describe: 'Hand-written round-robin over fixed arrays (no generator, no install)',

  patients(ctx: PatientSeedContext): readonly PopulatedPatient[] {
    const out: PopulatedPatient[] = [];
    for (let i = 0; i < ctx.patientCount; i++) {
      const pid = `${ctx.facilityId}-pt-${String(i + 1).padStart(4, '0')}`;
      const unitId = ctx.unitIds[i % ctx.unitIds.length]!;
      const trajectory = TRAJECTORIES[i % TRAJECTORIES.length]!;
      const age = AGES[i % AGES.length]!;
      const sex = SEXES[i % SEXES.length]!;
      const history = ctx.history;
      const realmAtIso = ctx.realmAt.toISOString();

      out.push({
        id: pid,
        unitId,
        state: {
          admitted: true,
          facilityId: ctx.facilityId,
          unitId,
          age,
          sex,
          trajectory,
          // dialysis vintage — a real slice dimension for fairness reporting, and
          // the infection triage's vintage driver
          dialysisVintageYears: Math.round((0.5 + ((i * 1.7) % 13)) * 10) / 10,
          admittedAt: realmAtIso,
          problemList: [...problemsFor(ctx.facilityKind, trajectory), ...comorbidityFor(i)],
          lastVitals: { hr: 72 + (i % 10), bp: '128/78', spo2: 97, at: realmAtIso },
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
                const profile = generateLongitudinalHistory({ patientId: pid, facilityId: ctx.facilityId, trajectory, days: history.days ?? 90, seed: history.seed ?? 1, asOf: ctx.realmAt });
                const esaPts = profile.history.filter((p) => p.esaDose !== undefined);
                const latestEsa = esaPts.length ? esaPts[esaPts.length - 1]?.esaDose : undefined;
                const esaDosingHistory = esaPts.map((p) => ({ at: `${p.date}T07:00:00.000Z`, dose: p.esaDose as number }));
                return {
                  labs: { ...profile.latest.labs, ...baselinePanelFor(trajectory) },
                  lastVitals: { ...profile.latest.vitals, at: realmAtIso },
                  ...(latestEsa !== undefined ? { esaDose: latestEsa } : {}),
                  esaEscalationsLast90d: profile.latest.esaEscalationsLast90d,
                  ...(esaDosingHistory.length ? { esaDosingHistory } : {}),
                };
              })()
            : {}),
        },
      });
    }
    return out;
  },
};
