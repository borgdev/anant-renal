/******************************************************************************
 * Fleet generation governor + restored-fleet truthfulness.
 *
 * Guards the coupling between how fast the simulated fleet produces events and how
 * fast the rest of the system consumes them, plus the `paused` state actually
 * meaning paused — a restored fleet used to report paused while its clocks kept
 * running, so the operator saw a stopped fleet, the governor respected the pause,
 * and the process stayed pinned producing events nobody consumed.
 ******************************************************************************/

import { describe, it, expect, afterEach } from 'vitest';
import { FleetGovernor } from '../src/simulator/governor.js';
import { SimulatorController } from '../src/simulator/controller.js';
import { RealmRegistry } from '../src/realm/registry.js';

/** Drive a governor with a controllable backlog and record what it did. */
function harness(backlog: number, running = true) {
  const applied: number[] = [];
  let stopped = 0;
  let started = 0;
  const governor = new FleetGovernor({
    readBacklog: async () => backlog,
    isRunning: () => running,
    setTickInterval: (ms) => applied.push(ms),
    stopClocks: () => { stopped += 1; },
    startClocks: () => { started += 1; },
    baseTickIntervalMs: 250,
    thresholds: { low: 100, high: 1_000, critical: 10_000, slowFactor: 4 },
  });
  return {
    governor,
    applied,
    get stopped() { return stopped; },
    get started() { return started; },
    setBacklog: (n: number) => { backlog = n; },
    setRunning: (r: boolean) => { running = r; },
  };
}

afterEach(() => {
  for (const r of RealmRegistry.list()) if (r.id.startsWith('sim:')) RealmRegistry.remove(r.id);
});

describe('fleet governor', () => {
  it('leaves a healthy fleet at its configured pace', async () => {
    const h = harness(10);
    const report = await h.governor.step();
    expect(report.state).toBe('unthrottled');
    expect(h.applied).toEqual([]);
    // the reason is stated even when nothing happens, so "idle" is distinguishable
    // from "stuck"
    expect(report.lastReason).toMatch(/configured pace/);
  });

  it('slows the fleet when the backlog passes the high mark', async () => {
    const h = harness(2_000);
    const report = await h.governor.step();
    expect(report.state).toBe('throttled');
    expect(h.applied).toEqual([1_000]); // base 250 × slowFactor 4
    expect(report.lastReason).toMatch(/slowing fleet/);
  });

  it('stops generation when the backlog passes the critical mark', async () => {
    const h = harness(2_000);
    await h.governor.step(); // → throttled
    h.setBacklog(50_000);
    const report = await h.governor.step();
    expect(report.state).toBe('paused');
    expect(h.stopped).toBe(1);
  });

  it('releases in two stages, and only once the backlog is genuinely down', async () => {
    const h = harness(50_000);
    await h.governor.step(); // unthrottled → throttled
    await h.governor.step(); // throttled → paused
    expect(h.stopped).toBe(1);

    // still above LOW: must stay paused (hysteresis, no flapping)
    h.setBacklog(500);
    expect((await h.governor.step()).state).toBe('paused');
    expect(h.started).toBe(0);

    // at/below LOW: resume generation, still throttled
    h.setBacklog(50);
    expect((await h.governor.step()).state).toBe('throttled');
    expect(h.started).toBe(1);

    // and only then back to the configured pace
    expect((await h.governor.step()).state).toBe('unthrottled');
    expect(h.applied.at(-1)).toBe(250);
  });

  it('never resumes a fleet the operator paused', async () => {
    const h = harness(50_000);
    await h.governor.step(); // → throttled (governor decided this itself)
    h.setRunning(false);
    h.setBacklog(0);
    const report = await h.governor.step();
    // an operator pause is not the governor's to undo
    expect(report.state).toBe('throttled');
    expect(h.started).toBe(0);
  });

  it('does not thrash between paces on a single threshold', async () => {
    const h = harness(1_500);
    await h.governor.step();
    await h.governor.step();
    await h.governor.step();
    // one engage, held — not one per step
    expect(h.applied).toEqual([1_000]);
    expect(h.governor.report().changes).toBe(1);
  });
});

describe('a restored fleet honours the status it reports', () => {
  it('stops the clocks when the persisted status is paused', async () => {
    const controller = new SimulatorController({});
    // 50ms ticks, so a clock that is still running visibly advances within the wait.
    const started = await controller.start('dialysis-basic', { autoRun: true, pace: { wallMsPerTick: 50 } });
    expect(started.status).toBe('running');
    const realms = controller.fleetRealmIds().map((id) => RealmRegistry.get(id)!);
    expect(realms.length).toBeGreaterThan(0);

    // A fresh controller adopting the persisted state is what a restart does.
    // Realm restore starts every clock unconditionally, so the controller must
    // reconcile them with the status it is about to report.
    const adopted = new SimulatorController({});
    const snap = await adopted.adopt({
      scenarioId: 'dialysis-basic', status: 'paused',
      startedAt: new Date().toISOString(), tickCount: 3, eventCount: 3,
      realmIds: realms.map((r) => r.id),
    });
    expect(snap.status).toBe('paused');

    // Nothing here stops the clocks: if adopt() failed to, the seq advances and
    // the fleet keeps producing events while claiming to be paused.
    const before = realms.map((r) => r.clock.seq);
    await new Promise((r) => setTimeout(r, 400));
    expect(realms.map((r) => r.clock.seq)).toEqual(before);
  });

  it('keeps running when the persisted status is running', async () => {
    const controller = new SimulatorController({});
    await controller.start('dialysis-basic', { autoRun: true, pace: { wallMsPerTick: 50 } });
    const realms = controller.fleetRealmIds().map((id) => RealmRegistry.get(id)!);

    const adopted = new SimulatorController({});
    const snap = await adopted.adopt({
      scenarioId: 'dialysis-basic', status: 'running',
      startedAt: new Date().toISOString(), tickCount: 1, eventCount: 1,
      realmIds: realms.map((r) => r.id),
    });
    expect(snap.status).toBe('running');
    const before = realms[0]!.clock.seq;
    await new Promise((r) => setTimeout(r, 400));
    expect(realms[0]!.clock.seq).toBeGreaterThan(before);
  });
});
