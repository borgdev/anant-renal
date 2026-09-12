/******************************************************************************
 * Phase 3.2/3.3 route contracts.
 *
 * The engines are unit-tested; this file defends the WIRING, which is where the
 * interesting failures live:
 *   - a digest with no recorded round must return `baseline: null` at the WIRE, so
 *     a console cannot render an empty diff as a calm fleet;
 *   - closing a round must produce a durable baseline the NEXT digest reads;
 *   - the baseline must be scoped, so a clinician diffing against their own last
 *     round is not silently handed a colleague's.
 ******************************************************************************/

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerSwarmRoutes, resetSwarmRuntime } from '../src/server/swarm-routes.js';
import { registerRoundRoutes } from '../src/server/round-routes.js';
import type { FluidPatientWindow } from '../src/swarm/fluid.js';
import type { RenalPatientInput } from '../src/swarm/renal-cohort.js';

const hypotensive: FluidPatientWindow = {
  patientId: 'p-idh-1', sessionCount: 24, telemetryPoints: 12, ufRateMlH: 900, postWeightKg: 70,
  nadirSbp: 92, nadirSbpPrev: 88, idwgKg: 3.4, plannedMinutes: 240, deliveredMinutes: 240, ufVolumeL: 3.4,
  asOf: '2026-09-12T09:00:00.000Z', dryWeightAssessedAt: '2026-09-11T09:00:00.000Z',
};

/** A window the guardrail blocks, so the lens has an unassessable patient too. */
const blind: FluidPatientWindow = { ...hypotensive, patientId: 'p-idh-3', telemetryPoints: 0 };

const sick: RenalPatientInput = {
  id: 'p-1', realmId: 'sim:renal-a', medCodes: [],
  state: {
    access: { type: 'avf', observations: 3 },
    labs: { K: 5.8, HGB: 9.1, URR: 60, PHOS: 6.6, calcium: 10.2, pth: 780, albumin: 3.2, bicarb: 19, crp: 18 },
    sessions: [
      { sessionId: 's1', startedAt: '2026-09-10T07:00:00.000Z', endedAt: '2026-09-10T11:00:00.000Z', deliveredMinutes: 240, prescribedMinutes: 240, ufVolumeL: 2.4, targetUfL: 2.4, stoppedEarly: false, telemetryPoints: 6, nadirSbp: 96, idwgKg: 3.1 },
      { sessionId: 's2', startedAt: '2026-09-08T07:00:00.000Z', endedAt: '2026-09-08T11:00:00.000Z', deliveredMinutes: 240, prescribedMinutes: 240, ufVolumeL: 2.3, targetUfL: 2.4, stoppedEarly: false, telemetryPoints: 6, nadirSbp: 98, idwgKg: 3.3 },
    ],
  },
};

const calm: RenalPatientInput = {
  id: 'p-2', realmId: 'sim:renal-b', medCodes: [],
  state: {
    access: { type: 'avf', observations: 4 },
    labs: { K: 4.5, HGB: 11.6, URR: 74, PHOS: 4.1, calcium: 9.3, pth: 200, albumin: 4.0, bicarb: 24, crp: 3 },
    sessions: [
      { sessionId: 's1', startedAt: '2026-09-10T07:00:00.000Z', endedAt: '2026-09-10T11:00:00.000Z', deliveredMinutes: 240, prescribedMinutes: 240, ufVolumeL: 1.4, targetUfL: 1.4, stoppedEarly: false, telemetryPoints: 8, nadirSbp: 130, idwgKg: 1.2 },
    ],
  },
};

let app: FastifyInstance;

beforeAll(async () => {
  resetSwarmRuntime();
  app = Fastify();
  // The workspace singleton is created by registerSwarmRoutes, and the round routes
  // persist into it — so it has to be up first, exactly as it is in app.ts.
  await registerSwarmRoutes(app);
  await registerRoundRoutes(app, {
    patients: () => [sick, calm],
    windows: () => [hypotensive, blind],
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  resetSwarmRuntime();
});

describe('3.2 · GET /admin/swarm/next-session', () => {
  it('returns the unit ranked, with the counterfactual and the unassessable patient named', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/swarm/next-session' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.horizon).toBe('next session');
    expect(body.rows.length).toBe(2);
    const worst = body.rows[0]!;
    expect(worst.patientId).toBe('p-idh-1');
    expect(worst.peakPct).toBeGreaterThan(0);
    expect(worst.change?.ufRateMlH).toBeLessThan(worst.current.ufRateMlH);
    expect(worst.counterfactual.peakPct).toBeLessThan(worst.peakPct);

    // The blocked window is present but NOT in a risk band.
    const blocked = body.rows.find((r: { patientId: string }) => r.patientId === 'p-idh-3')!;
    expect(blocked.unassessable).toBe(true);
    expect(blocked.counterfactual).toBeNull();
    expect(body.totals.unassessable).toBe(1);
    expect(body.totals.high + body.totals.watch + body.totals.low).toBe(1);
    expect(Array.isArray(body.reading)).toBe(true);
  });

  it('404s an unknown patient rather than returning a blank lens', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/swarm/next-session/p-nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('patient-window-not-found');
  });
});

describe('3.3 · rounds — close, then diff', () => {
  it('the digest with no recorded round reports baseline:null at the wire', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/swarm/rounds/digest' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.baseline).toBeNull();
    expect(body.movements).toEqual([]);
    expect(body.reading[0]).toMatch(/no previous round/i);
  });

  it('closing a round records a durable baseline', async () => {
    const close = await app.inject({ method: 'POST', url: '/admin/swarm/rounds/close', payload: { takenBy: 'Dr. Alvarez' } });
    expect(close.statusCode).toBe(200);
    expect(close.json().round.takenBy).toBe('Dr. Alvarez');
    expect(close.json().round.patients).toBe(2);

    const list = await app.inject({ method: 'GET', url: '/admin/swarm/rounds' });
    expect(list.json().count).toBe(1);
    expect(list.json().rounds[0]!.takenBy).toBe('Dr. Alvarez');
    expect(list.json().rounds[0]!.patients).toBe(2);
  });

  it('the next digest is measured against it, and unchanged data reports nothing', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/swarm/rounds/digest' });
    const body = res.json();
    expect(body.baseline).not.toBeNull();
    expect(body.baseline.takenBy).toBe('Dr. Alvarez');
    expect(body.since.takenAt).toBe(body.baseline.takenAt);
    // Identical inputs → identical severities → an empty movement list, not noise.
    expect(body.movements).toEqual([]);
    expect(body.summary.unchanged).toBe(2);
    expect(body.reading[0]).toMatch(/nothing moved/i);
  });

  it('scopes the baseline to the clinician who asked', async () => {
    await app.inject({ method: 'POST', url: '/admin/swarm/rounds/close', payload: { takenBy: 'Dr. Chen' } });
    const mine = await app.inject({ method: 'GET', url: '/admin/swarm/rounds/digest?by=Dr.%20Alvarez' });
    expect(mine.json().scopedTo).toBe('Dr. Alvarez');
    expect(mine.json().baseline.takenBy).toBe('Dr. Alvarez');

    const theirs = await app.inject({ method: 'GET', url: '/admin/swarm/rounds/digest?by=Dr.%20Chen' });
    expect(theirs.json().baseline.takenBy).toBe('Dr. Chen');

    // An unknown clinician has no round at all — `baseline: null`, never someone
    // else's round attributed to them.
    const stranger = await app.inject({ method: 'GET', url: '/admin/swarm/rounds/digest?by=Nobody' });
    expect(stranger.json().baseline).toBeNull();
    expect(stranger.json().reading[0]).toMatch(/no previous round/i);
  });

  it('current exposes the snapshot without recording one', async () => {
    const before = (await app.inject({ method: 'GET', url: '/admin/swarm/rounds' })).json().count;
    const res = await app.inject({ method: 'GET', url: '/admin/swarm/rounds/current' });
    expect(res.statusCode).toBe(200);
    expect(res.json().patients).toBe(2);
    expect(res.json().snapshot.patients).toHaveLength(2);
    const after = (await app.inject({ method: 'GET', url: '/admin/swarm/rounds' })).json().count;
    // Reading must never write: a GET that recorded a round would move the baseline
    // every time somebody looked at the page.
    expect(after).toBe(before);
  });

  it('closing without a clinician still records, attributed honestly', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/swarm/rounds/close', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().round.takenBy).toBe('operator');
  });
});
