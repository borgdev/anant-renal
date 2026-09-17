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

// SimPopulator — seeds a realm with a synthetic patient population.
// Not a claim of clinical accuracy — enough plausible variation for agent
// evaluation and operator demos.

import type { Realm } from './realm.js';
import { StaticPatientSource } from '../population/static-source.js';
import type { FacilitySeed, PatientSource, PopulateHistoryOptions } from '../population/source.js';

// The seed vocabulary lives in the population layer now, because a source has to
// describe a population without importing the thing that consumes it. Re-exported
// so every existing importer keeps working unchanged.
export type { FacilitySeed, PopulateHistoryOptions } from '../population/source.js';

export function populateFacility(
  realm: Realm,
  seed: FacilitySeed,
  history?: PopulateHistoryOptions,
  source: PatientSource = StaticPatientSource,
): { facilityId: string; unitIds: string[]; patientIds: string[]; sourceId: string } {
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
  // The realm clock is read ONCE and handed to the source, rather than the source
  // reaching for a wall clock. A source that read `new Date()` itself would seed a
  // different population on every run, and the golden guarding this refactor would
  // be measuring the clock instead of the seeder.
  const patients = source.patients({
    facilityId: seed.facilityId,
    facilityKind: seed.kind,
    unitIds,
    patientCount: seed.patientCount,
    realmAt: realm.clock.realmAt,
    ...(history ? { history } : {}),
  });

  const patientIds: string[] = [];
  for (const patient of patients) {
    const rec = g.create('patient', patient.id, patient.state);
    g.addRelation(rec.urn, 'in-unit', g.urnFor('unit', patient.unitId));
    g.addRelation(rec.urn, 'in-facility', facilityUrn);
    patientIds.push(patient.id);
  }
  return { facilityId: seed.facilityId, unitIds, patientIds, sourceId: source.id };
}

// `problemsFor`, `COMORBIDITIES` and `comorbidityFor` used to live here. They are
// the population, so they moved to `src/population/static-source.ts` with the
// arithmetic unchanged. If you are looking for where a patient's problem list comes
// from, it is there — and its limitations are documented at the top of that file
// rather than only in a design document.
