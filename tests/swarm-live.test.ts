import { describe, expect, it } from 'vitest';
import { deriveLiveSwarm, hasLiveData, integrationHealth, type LiveRealmSource } from '../src/swarm/live.js';

const NOW = () => '2026-08-23T09:00:00.000Z';

function realm(id: string, opts: Partial<LiveRealmSource> = {}): LiveRealmSource {
  return {
    realmId: id,
    mode: 'sim',
    counts: { 'org-node': 26 },
    presences: 0,
    effects: 0,
    episodes: { total: 0, openNow: 0 },
    realmAt: '2026-08-23T09:00:00.000Z',
    ...opts,
  };
}

const liveRealms: LiveRealmSource[] = [
  realm('realm:b3', { counts: { 'org-node': 26, facility: 1, unit: 2, patient: 3 }, presences: 1, effects: 4 }),
  realm('realm:c2', { counts: { 'org-node': 26, facility: 1, unit: 1, patient: 1 }, effects: 1 }),
  realm('realm:live', {}),
];

describe('live swarm synthesis', () => {
  it('derives a LIVE state from real realms (source=live, real KPIs)', () => {
    const state = deriveLiveSwarm({ realms: liveRealms, now: NOW });
    expect(state.source).toBe('live');
    expect(state.cells.length).toBe(12);
    // Real KPI numbers from the realm counts (4 patients, 3 units, 5 effects).
    expect(state.kpis.treatmentsProtected).toBe(4);
    expect(state.kpis.capacityHours).toBe(Math.round(3 * 8.25 * 10) / 10);
    expect(state.kpis.valueAtRisk).toBe(5 * 250);
    expect(state.kpis.cmsReadiness).toBe(Math.round((2 / 3) * 100)); // 2 of 3 realms populated
  });

  it('aggregates real insights with consensus + a retained conflict', () => {
    const state = deriveLiveSwarm({ realms: liveRealms, now: NOW });
    expect(state.insights.length).toBeGreaterThan(0);
    // All insight subjects are REAL realm ids, not the synthetic reference subjects.
    for (const i of state.insights) {
      expect(i.subject).toMatch(/^realm:/);
      expect(i.cells.length).toBeGreaterThan(0);
    }
    expect(state.conflictCount).toBeGreaterThanOrEqual(1); // access dissent retained
    const conflict = state.insights.find((i) => i.retained);
    expect(conflict?.conflicts.length).toBeGreaterThan(0);
  });

  it('ranks real NBAs scoped to actual realms', () => {
    const state = deriveLiveSwarm({ realms: liveRealms, now: NOW });
    expect(state.nbas.length).toBeGreaterThan(0);
    for (const nba of state.nbas) {
      expect(nba.subject).toMatch(/^realm:/);
      expect(nba.expectedOutcome).toBeGreaterThan(0);
    }
  });

  it('opens a real outcome episode per populated realm (focus driven through the closed loop)', () => {
    const state = deriveLiveSwarm({ realms: liveRealms, now: NOW });
    const populated = liveRealms.filter((r) => (r.counts.patient ?? 0) > 0).length;
    expect(state.episodes.length).toBe(populated);
    const b3 = state.episodes.find((e) => e.subject === 'realm:b3');
    const c2 = state.episodes.find((e) => e.subject === 'realm:c2');
    expect(b3?.subject).toBe('realm:b3');
    expect(b3?.state).toBe('Resolved'); // focus realm completes the durable closed loop
    expect(b3?.command?.ack).toBeTruthy(); // acknowledgement recorded
    expect(b3?.measureResult?.met).toBe(true); // measure verified
    expect(c2?.state).toBe('Observed'); // non-focus realms stay open for human approval
  });

  it('hasLiveData is false when no realm has patients (fallback to reference)', () => {
    expect(hasLiveData(liveRealms)).toBe(true);
    expect(hasLiveData([realm('realm:live', {})])).toBe(false);
  });

  it('integrationHealth reports per-cell live source counts + mode', () => {
    const state = deriveLiveSwarm({ realms: liveRealms, now: NOW });
    const health = integrationHealth(liveRealms, state);
    expect(health.mode).toBe('live');
    expect(health.totals.realms).toBe(3);
    expect(health.totals.patients).toBe(4);
    expect(health.totals.units).toBe(3);
    expect(health.totals.effects).toBe(5);
    expect(health.cells).toHaveLength(12);
    for (const cell of health.cells) {
      expect(cell.live).toBe(true); // populated realms feed every observer
      expect(cell.sources.patients).toBe(4);
      expect(typeof cell.proposals).toBe('number');
    }
  });

  it('is deterministic for the same realm input (ignoring wall-clock rankedAt)', () => {
    const strip = (x: typeof a) =>
      JSON.parse(JSON.stringify(x, (_k, v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) ? '' : v)));
    const a = deriveLiveSwarm({ realms: liveRealms, now: NOW });
    const b = deriveLiveSwarm({ realms: liveRealms, now: NOW });
    expect(strip(a).insights).toEqual(strip(b).insights);
    expect(strip(a).nbas).toEqual(strip(b).nbas);
    expect(strip(a).kpis).toEqual(strip(b).kpis);
  });
});
