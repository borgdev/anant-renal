/******************************************************************************
 * R1 — deterministic longitudinal patient history (complete data).
 *
 * Pure coverage for `src/simulator/longitudinal.ts` plus a realm-creation check
 * that a populated facility backfills complete, trajectory-consistent labs.
 ******************************************************************************/

import { describe, it, expect, afterEach } from 'vitest';
import { AcceleratedClock, populateFacility, RealmRegistry } from '../src/realm/index.js';
import { RealmHypergraph } from '../src/realm/hypergraph-bridge.js';
import { buildHealthcareHypergraphSchema } from '../packs/healthcare-core/hypergraph.js';
import {
  generateLongitudinalHistory,
  baselineLabsFor,
  trajectoryOnEsa,
  hashSeed,
  LONGITUDINAL_TRAJECTORIES,
} from '../src/simulator/longitudinal.js';
import { mulberry32 } from '../src/simulator/rng.js';

const AS_OF = new Date('2026-09-01T00:00:00.000Z');
const opts = (trajectory: Parameters<typeof generateLongitudinalHistory>[0]['trajectory'], over: Record<string, unknown> = {}) => ({
  patientId: 'f1-pt-0001', facilityId: 'fac-1', trajectory, days: 90, seed: 42, asOf: AS_OF, ...over,
});

describe('generateLongitudinalHistory (R1 complete data)', () => {
  it('is fully deterministic for the same patientId + seed', () => {
    const a = generateLongitudinalHistory(opts('stable') as Parameters<typeof generateLongitudinalHistory>[0]);
    const b = generateLongitudinalHistory(opts('stable') as Parameters<typeof generateLongitudinalHistory>[0]);
    expect(a.history).toEqual(b.history);
    expect(a.latest).toEqual(b.latest);
    // Different seed → different history.
    const c = generateLongitudinalHistory(opts('stable', { seed: 43 }) as Parameters<typeof generateLongitudinalHistory>[0]);
    expect(c.history).not.toEqual(a.history);
  });

  it('produces one daily point with vitals and a weekly lab cadence', () => {
    const p = generateLongitudinalHistory(opts('stable', { days: 60 }) as Parameters<typeof generateLongitudinalHistory>[0]);
    expect(p.history).toHaveLength(60);
    expect(p.history[0]?.dayOffset).toBe(-59);
    expect(p.history[p.history.length - 1]?.dayOffset).toBe(0);
    for (const point of p.history) {
      expect(point.vitals.hr).toBeGreaterThan(30);
      expect(point.vitals.hr).toBeLessThan(160);
      expect(point.vitals.spo2).toBeGreaterThan(80);
      expect(typeof point.vitals.bp).toBe('string');
      expect(typeof point.treatmentMissed).toBe('boolean');
    }
    const labDays = p.history.filter((point) => point.labs).length;
    // 60 days → ~8-9 weekly labs.
    expect(labDays).toBeGreaterThanOrEqual(8);
    expect(labDays).toBeLessThanOrEqual(9);
  });

  it('keeps labs trajectory-consistent (anemia, dialysis adequacy, MBD)', () => {
    const stable = generateLongitudinalHistory(opts('stable') as Parameters<typeof generateLongitudinalHistory>[0]);
    const anemic = generateLongitudinalHistory(opts('anemic-worsening') as Parameters<typeof generateLongitudinalHistory>[0]);
    const under = generateLongitudinalHistory(opts('underdialyzed') as Parameters<typeof generateLongitudinalHistory>[0]);
    const hyper = generateLongitudinalHistory(opts('hyperphosphatemia') as Parameters<typeof generateLongitudinalHistory>[0]);
    expect(anemic.latest.labs.HGB).toBeLessThan(stable.latest.labs.HGB);
    expect(under.latest.labs.URR).toBeLessThan(stable.latest.labs.URR);
    expect(under.latest.labs.K).toBeGreaterThan(stable.latest.labs.K);
    expect(hyper.latest.labs.PHOS).toBeGreaterThan(6.0);
    expect(hyper.latest.labs.PHOS).toBeGreaterThan(stable.latest.labs.PHOS);
  });

  it('tracks missed treatments and ESA escalations honestly', () => {
    const decomp = generateLongitudinalHistory(opts('decompensating') as Parameters<typeof generateLongitudinalHistory>[0]);
    const stable = generateLongitudinalHistory(opts('stable') as Parameters<typeof generateLongitudinalHistory>[0]);
    const missed = decomp.history.filter((point) => point.treatmentMissed).length;
    expect(decomp.latest.missedTreatmentsLast90d).toBe(missed);
    expect(decomp.latest.missedTreatmentsLast90d).toBeGreaterThanOrEqual(stable.latest.missedTreatmentsLast90d);
    // ESA escalations are only counted when the trajectory is on ESA.
    expect(trajectoryOnEsa('anemic-worsening')).toBe(true);
    expect(trajectoryOnEsa('stable')).toBe(false);
    const anemic = generateLongitudinalHistory(opts('anemic-worsening') as Parameters<typeof generateLongitudinalHistory>[0]);
    expect(anemic.onEsa).toBe(true);
    expect(anemic.history.some((point) => point.esaDose !== undefined)).toBe(true);
    expect(stable.history.some((point) => point.esaDose !== undefined)).toBe(false);
  });

  it('baselineLabsFor is deterministic per trajectory + jitter', () => {
    const rngA = mulberry32(5);
    const rngB = mulberry32(5);
    expect(baselineLabsFor('stable', rngA)).toEqual(baselineLabsFor('stable', rngB));
    expect(Object.keys(baselineLabsFor('stable', rngA))).toEqual(['K', 'HGB', 'URR', 'PHOS']);
  });

  it('hashSeed is deterministic and differs across patient ids', () => {
    expect(hashSeed('f1-pt-0001')).toBe(hashSeed('f1-pt-0001'));
    expect(hashSeed('f1-pt-0001')).not.toBe(hashSeed('f1-pt-0002'));
  });
});

describe('populateFacility complete-data backfill', () => {
  afterEach(() => {
    for (const r of RealmRegistry.list()) if (r.id.startsWith('sim:hist')) RealmRegistry.remove(r.id);
  });

  it('seeds patients with trajectory-consistent labs + vitals when a history seed is given', () => {
    const realm = RealmRegistry.create({
      id: 'sim:hist-a',
      mode: 'sim',
      clock: new AcceleratedClock({ startAt: new Date('2026-08-01T06:00:00.000Z'), msPerTick: 10, realmMsPerTick: 3_600_000 }),
      hypergraph: new RealmHypergraph(buildHealthcareHypergraphSchema(), 'sim:hist-a'),
    });
    const { patientIds } = populateFacility(realm, { facilityId: 'fac-h', kind: 'dialysis', name: 'H', units: ['U-1'], patientCount: 7 }, { seed: 7, days: 90 });
    expect(patientIds).toHaveLength(7);
    const patients = realm.graph.listKind('patient');
    expect(patients.length).toBe(7);
    for (const p of patients) {
      const state = p.state as { labs?: { K: number; HGB: number; URR: number; PHOS: number }; lastVitals?: { hr: number; spo2: number; bp: string } };
      expect(state.labs).toBeDefined();
      expect(typeof state.labs?.K).toBe('number');
      expect(typeof state.labs?.HGB).toBe('number');
      expect(typeof state.labs?.URR).toBe('number');
      expect(typeof state.labs?.PHOS).toBe('number');
      expect(state.lastVitals?.spo2).toBeGreaterThan(80);
    }
    // Patient index 0 → trajectory TRAJECTORIES[0] = 'stable' → HGB ≥ 10.
    const first = patients[0]!.state as { labs?: { HGB: number }; trajectory?: string };
    expect(first.trajectory).toBe(LONGITUDINAL_TRAJECTORIES[0]);
    expect(first.labs?.HGB).toBeGreaterThanOrEqual(10);
  });
});
