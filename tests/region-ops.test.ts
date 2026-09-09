/******************************************************************************
 * R2/R3 — regional operations + D-S at enterprise scale.
 *
 * Pure coverage for `src/swarm/region-ops.ts`: deterministic region mapping,
 * realm census rollup and region-level deterioration aggregation.
 ******************************************************************************/

import { describe, it, expect } from 'vitest';
import {
  regionFromRealmId,
  regionForFacility,
  rollupRealmRegions,
  countPostures,
  aggregateDeteriorationByRegion,
} from '../src/swarm/region-ops.js';
import { fusePatientReadout, defaultEarlyWarningSignals, type EarlyWarningSignal } from '../src/swarm/early-warning.js';

const NOW = '2026-09-01T00:00:00Z';
function sig(patientId: string, facilityId: string, kind: EarlyWarningSignal['kind'], label: string, polarity: EarlyWarningSignal['polarity'], weight: number, sourceId: string): EarlyWarningSignal {
  return { patientId, facilityId, kind, label, polarity, weight, sourceId, at: NOW };
}

describe('regionFromRealmId / regionForFacility', () => {
  it('maps enterprise realm ids to Tennessee regions deterministically', () => {
    expect(regionFromRealmId('sim:ent-midtn-a')).toBe('Middle TN');
    expect(regionFromRealmId('sim:ent-easttn-b')).toBe('East TN');
    expect(regionFromRealmId('sim:ent-westtn-b')).toBe('West TN');
    expect(regionFromRealmId('sim:renal-a')).toBe('Default');
  });

  it('maps facility ids to regions best-effort', () => {
    expect(regionForFacility('rb-nashville-a')).toBe('Middle TN');
    expect(regionForFacility('rb-memphis-b')).toBe('West TN');
    expect(regionForFacility('fac-1')).toBe('Default');
    expect(regionForFacility('rb-x', { 'rb-x': 'South' })).toBe('South');
  });
});

describe('rollupRealmRegions (R2 census)', () => {
  it('rolls realm rows up to per-region sums', () => {
    const rows = [
      { realmId: 'sim:ent-midtn-a', patients: 8, units: 3, liveEffects: 40 },
      { realmId: 'sim:ent-midtn-b', patients: 6, units: 2, liveEffects: 30 },
      { realmId: 'sim:ent-westtn-a', patients: 8, units: 3, liveEffects: 25 },
      { realmId: 'sim:renal-a', patients: 6, units: 2, liveEffects: 10 },
    ];
    const out = rollupRealmRegions(rows);
    const mid = out.find((r) => r.regionId === 'Middle TN');
    const west = out.find((r) => r.regionId === 'West TN');
    const def = out.find((r) => r.regionId === 'Default');
    expect(mid?.realms).toBe(2);
    expect(mid?.patients).toBe(14);
    expect(mid?.units).toBe(5);
    expect(mid?.liveEffects).toBe(70);
    expect(west?.patients).toBe(8);
    expect(def?.realms).toBe(1);
  });
});

describe('countPostures / aggregateDeteriorationByRegion (R3)', () => {
  it('counts the default cohort postures (enterprise roll-up)', () => {
    const cohort = defaultEarlyWarningSignals();
    const patients = [...new Set(cohort.map((s) => s.patientId))];
    const readouts = patients.map((id) => fusePatientReadout(id, cohort)).filter((r) => r !== undefined);
    const posture = countPostures(readouts);
    expect(posture.patients).toBe(6);
    expect(posture.alerts).toBe(1); // f1-pt-0001
    expect(posture.contested).toBe(1); // f1-pt-0003
    expect(posture.watch).toBe(3); // 0002, 0005, 0006
    expect(posture.reassured).toBe(1); // 0004
  });

  it('groups deterioration by region and sorts alerts first', () => {
    const readouts = [
      fusePatientReadout('pt-a', [sig('pt-a', 'rb-memphis-a', 'lab', 'K 5.9', 'deteriorating', 0.7, 'realm-ledger:rb-memphis-a:lab:k'), sig('pt-a', 'rb-memphis-a', 'vitals', 'HR 104', 'deteriorating', 0.7, 'realm-ledger:rb-memphis-a:vitals'), sig('pt-a', 'rb-memphis-a', 'lab', 'URR 57', 'deteriorating', 0.7, 'realm-ledger:rb-memphis-a:lab:urr')]),
      fusePatientReadout('pt-b', [sig('pt-b', 'rb-nashville-a', 'lab', 'K 5.7', 'deteriorating', 0.7, 'realm-ledger:rb-nashville-a:lab:k')]),
      fusePatientReadout('pt-c', [sig('pt-c', 'rb-knoxville-a', 'lab', 'PHOS 4.3', 'stable', 0.7, 'realm-ledger:rb-knoxville-a:lab:phos')]),
    ].filter((r) => r !== undefined);
    const byRegion = aggregateDeteriorationByRegion(readouts, (r) => regionForFacility(r.facilityId));
    const west = byRegion.find((r) => r.regionId === 'West TN');
    const mid = byRegion.find((r) => r.regionId === 'Middle TN');
    const east = byRegion.find((r) => r.regionId === 'East TN');
    expect(west?.alerts).toBe(1);
    expect(mid?.watch).toBe(1);
    expect(east?.reassured).toBe(1);
    expect(byRegion[0]?.regionId).toBe('West TN'); // alert region first
  });
});
