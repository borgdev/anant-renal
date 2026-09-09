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
  buildRegionMembership,
  resolveRegionForFacility,
  upsertRegionMembership,
  autofillRegionFor,
  autofillRegionAssignments,
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

describe('operating-model region membership (real ontology wiring)', () => {
  const scopePath = [
    { id: 'ent', level: 'enterprise', label: 'Riverbend Kidney Care' },
    { id: 'reg-mid', level: 'region', label: 'Middle TN', facilityIds: ['rb-nashville-a', 'rb-nashville-b'] },
    { id: 'reg-east', level: 'region', label: 'East TN', facilityIds: ['rb-knoxville-a', 'rb-chattanooga-a'] },
    { id: 'fac-sample', level: 'facility', label: 'Ignored', facilityIds: ['rb-whatever'] },
  ];
  const membership = buildRegionMembership(scopePath);

  it('builds facility → region membership from region/market nodes only', () => {
    expect(membership.get('rb-nashville-a')).toBe('Middle TN');
    expect(membership.get('rb-knoxville-a')).toBe('East TN');
    // facility-level nodes are ignored for membership.
    expect(membership.has('rb-whatever')).toBe(false);
  });

  it('resolveRegionForFacility prefers ontology membership, else id-derived fallback', () => {
    expect(resolveRegionForFacility(membership, 'rb-chattanooga-a', 'sim:ent-easttn-b')).toBe('East TN');
    expect(resolveRegionForFacility(membership, 'rb-unknown', 'sim:ent-westtn-a')).toBe('West TN');
    expect(resolveRegionForFacility(membership, 'rb-unknown', 'sim:renal-a')).toBe('Default');
  });

  it('rollupRealmRegions honours an ontology-driven regionOf', () => {
    const rows = [
      { realmId: 'sim:ent-midtn-a', patients: 8, units: 3 },
      { realmId: 'sim:ent-midtn-b', patients: 6, units: 2 },
      { realmId: 'sim:ent-westtn-a', patients: 8, units: 3 },
    ];
    const byFacility = new Map<string, string>([['sim:ent-midtn-a', 'rb-nashville-a'], ['sim:ent-midtn-b', 'rb-nashville-b'], ['sim:ent-westtn-a', 'rb-unknown']]);
    const out = rollupRealmRegions(rows, (row) => resolveRegionForFacility(membership, byFacility.get(row.realmId), row.realmId));
    const mid = out.find((r) => r.regionId === 'Middle TN');
    const west = out.find((r) => r.regionId === 'West TN');
    expect(mid?.realms).toBe(2);
    expect(mid?.patients).toBe(14);
    expect(west?.patients).toBe(8); // rb-unknown fell back to the realm's West TN
  });

  it('upsertRegionMembership merges into existing region nodes and preserves others', () => {
    const scope = [
      { id: 'ent', level: 'enterprise', label: 'RK' },
      { id: 'reg-mid', level: 'region', label: 'Middle TN', facilityIds: ['rb-nashville-a'] },
      { id: 'f-node', level: 'facility', label: 'Sample' },
    ];
    const out = upsertRegionMembership(scope, [
      { regionId: 'reg-mid', label: 'Middle TN', facilityIds: ['rb-nashville-b', 'rb-nashville-a'] },
      { regionId: '', label: 'East TN', facilityIds: ['rb-knoxville-a'] },
    ]);
    const mid = out.find((n) => n.id === 'reg-mid');
    expect(mid?.facilityIds?.sort()).toEqual(['rb-nashville-a', 'rb-nashville-b']);
    expect(out.find((n) => n.id === 'ent')).toBeTruthy();
    expect(out.find((n) => n.id === 'f-node')).toBeTruthy();
    const east = out.find((n) => n.label === 'East TN');
    expect(east?.level).toBe('region');
    expect(east?.facilityIds).toEqual(['rb-knoxville-a']);
  });

  it('autofill derives facility → region assignments deterministically', () => {
    const facilities = [
      { id: 'rb-nashville-a', name: 'A', realmId: 'sim:ent-midtn-a' },
      { id: 'rb-nashville-b', name: 'B', realmId: 'sim:ent-midtn-b' },
      { id: 'rb-memphis-a', name: 'M', realmId: 'sim:ent-westtn-a' },
      { id: 'fac-1', name: 'Plain', realmId: 'sim:renal-a' },
    ];
    expect(autofillRegionFor(facilities[0]!)).toBe('Middle TN');
    const assignments = autofillRegionAssignments(facilities);
    const mid = assignments.find((a) => a.label === 'Middle TN');
    const west = assignments.find((a) => a.label === 'West TN');
    expect(mid?.facilityIds).toEqual(['rb-nashville-a', 'rb-nashville-b']);
    expect(west?.facilityIds).toEqual(['rb-memphis-a']);
    expect(assignments.some((a) => a.label === 'Default' && a.facilityIds.includes('fac-1'))).toBe(true);
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
