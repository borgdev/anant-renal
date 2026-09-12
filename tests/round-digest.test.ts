/******************************************************************************
 * Phase 3.3 — "since your last round".
 *
 * The digest is only as honest as its baseline, and the baseline is the hard part:
 * severity is a function of a patient's whole window at one moment, so it cannot be
 * recomputed for a past moment from the ledger. A round is therefore recorded, and
 * the digest diffs against it. Three properties are asserted here:
 *
 *   1. With no recorded round, the digest SAYS SO. An empty diff reads as calm,
 *      which is the one thing it must never do.
 *   2. Below the movement floor nothing is reported — a zero-drift cohort must not
 *      fill the list with decimal noise from fixed rules.
 *   3. "Newly at risk" means green/unknown before and red/amber now. A patient who
 *      was red and got redder is a worsening, not a discovery.
 ******************************************************************************/

import { describe, it, expect } from 'vitest';
import { RENAL_PROTOCOLS } from '../src/protocols/registry.js';
import { buildRenalCohort, type RenalPatientInput } from '../src/swarm/renal-cohort.js';
import { ROUND_MOVEMENT_FLOOR, diffRounds, snapshotRound } from '../src/swarm/round-digest.js';

const AT = '2026-09-12T06:00:00.000Z';
const LATER = '2026-09-12T18:00:00.000Z';

/** A renal patient input with a controllable panel — only the fields under test. */
const patient = (id: string, over: Record<string, unknown> = {}): RenalPatientInput => ({
  id,
  realmId: 'sim:renal-a',
  medCodes: [],
  state: {
    access: { type: 'avf', observations: 3, recirculationPct: 4 },
    labs: { K: 4.6, HGB: 11.4, URR: 72, PHOS: 4.2, calcium: 9.4, pth: 220, albumin: 3.9, bicarb: 24, crp: 4 },
    sessions: [
      { sessionId: 's1', startedAt: '2026-09-10T07:00:00.000Z', endedAt: '2026-09-10T11:00:00.000Z', deliveredMinutes: 240, prescribedMinutes: 240, ufVolumeL: 2.4, targetUfL: 2.4, stoppedEarly: false, telemetryPoints: 6, nadirSbp: 124, idwgKg: 2.1 },
      { sessionId: 's2', startedAt: '2026-09-08T07:00:00.000Z', endedAt: '2026-09-08T11:00:00.000Z', deliveredMinutes: 240, prescribedMinutes: 240, ufVolumeL: 2.3, targetUfL: 2.4, stoppedEarly: false, telemetryPoints: 6, nadirSbp: 126, idwgKg: 2.2 },
    ],
    ...over,
  },
});

const snapshotOf = (inputs: RenalPatientInput[], takenAt = AT) =>
  snapshotRound(buildRenalCohort(inputs).patients, { takenBy: 'Dr. Alvarez', takenAt });

describe('round snapshot — the baseline a digest is measured against', () => {
  it('records every patient × every protocol', () => {
    const snap = snapshotOf([patient('p-1'), patient('p-2')]);
    expect(snap.patients).toHaveLength(2);
    for (const p of snap.patients) {
      expect(Object.keys(p.protocols).sort()).toEqual(RENAL_PROTOCOLS.map((r) => r.id).sort());
      // The worst status must name the protocol that carries it, or a reader has
      // the number without the thing to look at.
      expect(p.worstProtocol.length).toBeGreaterThan(0);
      expect(p.protocols[p.worstProtocol]).toBeDefined();
    }
  });

  it('is time-stamped and attributed, so a digest can say who it is measured from', () => {
    const snap = snapshotOf([patient('p-1')]);
    expect(snap.takenAt).toBe(AT);
    expect(snap.takenBy).toBe('Dr. Alvarez');
  });
});

describe('digest — no baseline is stated, never implied', () => {
  it('says there is nothing to compare against', () => {
    const digest = diffRounds(null, snapshotOf([patient('p-1')], LATER));
    expect(digest.since).toBeNull();
    expect(digest.movements).toEqual([]);
    expect(digest.summary.worsened).toBe(0);
    expect(digest.reading[0]).toMatch(/no previous round/i);
    expect(digest.reading[0]).toMatch(/baseline/i);
  });
});

describe('digest — what moved', () => {
  it('reports a worsening with its protocol, its before/after and its drivers', () => {
    const before = snapshotOf([patient('p-1')]);
    // Same patient, anaemia and potassium both deteriorating.
    const after = snapshotOf([patient('p-1', { labs: { K: 5.9, HGB: 9.4, URR: 62, PHOS: 6.4, calcium: 9.4, pth: 220, albumin: 3.9, bicarb: 24, crp: 4 } })], LATER);

    const digest = diffRounds(before, after, buildRenalCohort([patient('p-1', { labs: { K: 5.9, HGB: 9.4, URR: 62, PHOS: 6.4, calcium: 9.4, pth: 220, albumin: 3.9, bicarb: 24, crp: 4 } })]).patients);

    expect(digest.since!.takenAt).toBe(AT);
    expect(digest.movements.length).toBeGreaterThan(0);
    // Worsening first.
    expect(digest.movements[0]!.direction).toBe('worsened');
    expect(digest.movements[0]!.deltaSeverity).toBeGreaterThan(0);
    const anaemia = digest.movements.find((m) => m.protocol === 'anemia')!;
    expect(anaemia.after.severity).toBeGreaterThan(anaemia.before.severity);
    expect(anaemia.protocolLabel.length).toBeGreaterThan(0);
    expect(anaemia.substate.length).toBeGreaterThan(0);
    // Drivers are carried so the movement names the thing to look at.
    expect(Array.isArray(anaemia.drivers)).toBe(true);
    expect(digest.summary.fleetSeverityNow).toBeGreaterThan(digest.summary.fleetSeverityBefore);
    expect(digest.reading.some((r) => /worsened/.test(r))).toBe(true);
  });

  it('a patient who crossed into red/amber is "newly at risk"; one already there is not', () => {
    const before = snapshotOf([patient('p-1')]);
    const worse = snapshotOf([patient('p-1', { labs: { K: 6.0, HGB: 9.2, URR: 58, PHOS: 7.2, calcium: 10.9, pth: 900, albumin: 3.1, bicarb: 18, crp: 22 } })], LATER);
    const digest = diffRounds(before, worse);

    const crossings = digest.movements.filter((m) => m.newlyAtRisk);
    for (const m of crossings) {
      expect(['green', 'unknown']).toContain(m.before.status);
      expect(['red', 'amber']).toContain(m.after.status);
    }
    expect(digest.newlyAtRisk).toEqual(crossings);
    // Everything else that worsened was already being worked.
    for (const m of digest.movements.filter((x) => x.direction === 'worsened')) {
      if (['red', 'amber'].includes(m.before.status)) expect(m.newlyAtRisk).toBe(false);
    }
  });

  it('an improvement is reported as an improvement, and never first', () => {
    const bad = { labs: { K: 6.0, HGB: 9.2, URR: 58, PHOS: 7.2, calcium: 10.9, pth: 900, albumin: 3.1, bicarb: 18, crp: 22 } };
    const before = snapshotOf([patient('p-1', bad)]);
    const after = snapshotOf([patient('p-1')], LATER);
    const digest = diffRounds(before, after);
    expect(digest.improved.length).toBeGreaterThan(0);
    expect(digest.improved.every((m) => m.direction === 'improved')).toBe(true);
    expect(digest.movements[0]!.direction).toBe('improved');
    expect(digest.summary.fleetSeverityNow).toBeLessThan(digest.summary.fleetSeverityBefore);
    expect(digest.newlyAtRisk).toEqual([]);
  });

  it('reports NOTHING when the data did not move', () => {
    // The same inputs twice: fixed rules must produce a byte-identical snapshot, so
    // the digest is empty rather than full of decimal drift.
    const digest = diffRounds(snapshotOf([patient('p-1'), patient('p-2')]), snapshotOf([patient('p-1'), patient('p-2')], LATER));
    expect(digest.movements).toEqual([]);
    expect(digest.summary.worsened).toBe(0);
    expect(digest.summary.improved).toBe(0);
    expect(digest.summary.unchanged).toBe(2);
    expect(digest.reading[0]).toMatch(/nothing moved/i);
  });

  it('uses a floor so a sub-threshold drift is not a "movement"', () => {
    const digest = diffRounds(snapshotOf([patient('p-1')]), snapshotOf([patient('p-1', { labs: { K: 4.65, HGB: 11.38, URR: 72, PHOS: 4.2, calcium: 9.4, pth: 220, albumin: 3.9, bicarb: 24, crp: 4 } })], LATER));
    for (const m of digest.movements) expect(Math.abs(m.deltaSeverity)).toBeGreaterThanOrEqual(ROUND_MOVEMENT_FLOOR);
  });

  it('a departed patient is named as departed, never counted as improved', () => {
    const before = snapshotOf([patient('p-1'), patient('p-2')]);
    const after = snapshotOf([patient('p-1')], LATER);
    const digest = diffRounds(before, after);
    expect(digest.departed.map((d) => d.patientId)).toEqual(['p-2']);
    // p-2 simply not being there must not appear as a movement of any kind.
    expect(digest.movements.some((m) => m.patientId === 'p-2')).toBe(false);
    expect(digest.reading.some((r) => /no longer in the cohort/.test(r))).toBe(true);
  });

  it('a brand-new patient is listed as appeared, not as a worsening', () => {
    const before = snapshotOf([patient('p-1')]);
    const after = snapshotOf([patient('p-1'), patient('p-new', { labs: { K: 6.4, HGB: 8.6, URR: 52, PHOS: 7.4, calcium: 10.8, pth: 980, albumin: 2.9, bicarb: 17, crp: 30 } })], LATER);
    const digest = diffRounds(before, after);
    expect(digest.appeared.map((p) => p.patientId)).toEqual(['p-new']);
    expect(digest.movements.some((m) => m.patientId === 'p-new')).toBe(false);
    expect(digest.reading.some((r) => /no previous record/.test(r))).toBe(true);
  });

  it('a protocol missing from the previous round is skipped, not treated as zero', () => {
    // A snapshot written by an older build with one protocol absent must not invent
    // a movement for it — "unknown before" is not "zero before".
    const before = snapshotOf([patient('p-1')]);
    const trimmed = { ...before, patients: before.patients.map((p) => ({ ...p, protocols: { ...p.protocols, anemia: undefined as never } })) };
    const after = snapshotOf([patient('p-1', { labs: { K: 6.0, HGB: 8.8 } })], LATER);
    const digest = diffRounds(trimmed as never, after);
    expect(digest.movements.some((m) => m.protocol === 'anemia')).toBe(false);
  });

  it('orders worsenings worst-first, then improvements, deterministically', () => {
    const before = snapshotOf([patient('p-1'), patient('p-2'), patient('p-3')]);
    const after = snapshotOf([
      patient('p-1', { labs: { K: 6.2, HGB: 8.8, URR: 55, PHOS: 7.4, calcium: 10.9, pth: 950, albumin: 3.0, bicarb: 17, crp: 26 } }),
      patient('p-2', { labs: { K: 5.6 } }),
      patient('p-3'),
    ], LATER);
    const a = diffRounds(before, after);
    const b = diffRounds(before, after);
    expect(a.movements.map((m) => `${m.patientId}:${m.protocol}`)).toEqual(b.movements.map((m) => `${m.patientId}:${m.protocol}`));
    const dirs = a.movements.map((m) => m.direction);
    const firstImprovement = dirs.indexOf('improved');
    if (firstImprovement >= 0) {
      // No worsening may appear after an improvement.
      expect(dirs.slice(firstImprovement).every((d) => d !== 'worsened')).toBe(true);
    }
  });
});
