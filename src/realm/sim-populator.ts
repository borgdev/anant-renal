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

const TRAJECTORIES = ['stable', 'decompensating', 'recovering', 'anemic-worsening', 'anemic-recovering', 'underdialyzed', 'hyperphosphatemia'] as const;
const AGES = [45, 52, 58, 61, 64, 68, 71, 74, 77, 79];
const SEXES: Array<'F' | 'M'> = ['F', 'M'];

export function populateFacility(realm: Realm, seed: FacilitySeed): { facilityId: string; unitIds: string[]; patientIds: string[] } {
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
      admittedAt: realm.clock.realmAt.toISOString(),
      problemList: problemsFor(seed.kind, trajectory),
      lastVitals: { hr: 72 + (i % 10), bp: '128/78', spo2: 97, at: realm.clock.realmAt.toISOString() },
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
