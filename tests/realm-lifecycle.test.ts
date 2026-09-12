/******************************************************************************
 * Realm lifecycle — a stopped realm must come back fully alive.
 *
 * THE DEFECT THIS FILE EXISTS FOR: `stop()` cancels the clock subscription that
 * drives `ambient.tick()` and `rules.onTick()`, but `start()` used to restart only
 * the clock. One pause/resume cycle therefore left a realm that LOOKED alive — the
 * tick counter climbed, the status said "running" — while every ambient process
 * (lab maturation, patient trajectory, the insurance clock) and the rules engine
 * were permanently dead. The user-visible consequence was a simulator that ticked
 * forever and produced no clinical data, with every page derived from it frozen.
 *
 * These tests assert the property, not the implementation: after a stop/start the
 * realm must behave exactly as it did before the stop. Both pipelines are covered,
 * because re-arming only one of them is the same class of bug.
 ******************************************************************************/

import { describe, it, expect, afterEach } from 'vitest';
import { RealmRegistry, populateFacility } from '../src/realm/index.js';
import { WallClock } from '../src/realm/clock.js';
import type { AmbientContext, AmbientProcess } from '../src/realm/ambient.js';

let counter = 0;
const makeRealmId = (): string => {
  counter += 1;
  return `realm:lifecycle-${counter}`;
};

/** Counts the ticks it is given, in both phases, so the two can be compared. */
class TickCounter implements AmbientProcess {
  readonly id = 'lifecycle.tick-counter';
  started = 0;
  afterRestart = 0;
  private restarted = false;
  markRestart(): void { this.restarted = true; }
  onTick(_ctx: AmbientContext): void {
    if (this.restarted) this.afterRestart += 1;
    else this.started += 1;
  }
}

afterEach(() => {
  for (const realm of RealmRegistry.list()) if (realm.id.startsWith('realm:lifecycle-')) RealmRegistry.remove(realm.id);
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/** A fast wall clock (~10 ms/tick) so the test measures real ticking quickly. */
const fastClock = (): WallClock => new WallClock({ intervalMs: 10 });

describe('realm lifecycle — stop() then start() restores the whole pipeline', () => {
  it('ambient processes keep receiving ticks after a stop/start cycle', async () => {
    const id = makeRealmId();
    const ticks = new TickCounter();
    // A fast clock so the test is quick but the assertion is about real ticking.
    const realm = RealmRegistry.create({ id, mode: 'sim', clock: fastClock(), ambientProcesses: [ticks] });
    realm.start();
    await sleep(80);
    const before = ticks.started;
    expect(before, 'the realm never ticked at all — the test would pass vacuously').toBeGreaterThan(0);

    realm.stop();
    await sleep(40);
    const frozen = ticks.started;
    realm.start();
    ticks.markRestart();
    await sleep(80);

    // The property: the ambient process is driven again after the restart.
    expect(ticks.afterRestart, 'ambient processes are dead after a stop/start cycle').toBeGreaterThan(0);
    realm.stop();
    expect(frozen).toBeGreaterThanOrEqual(before);
  });

  it('the clock is genuinely stopped while stopped — a stopped realm is not just slowed', async () => {
    const id = makeRealmId();
    const ticks = new TickCounter();
    const realm = RealmRegistry.create({ id, mode: 'sim', clock: fastClock(), ambientProcesses: [ticks] });
    realm.start();
    await sleep(60);
    realm.stop();
    const atStop = ticks.started;
    await sleep(60);
    // Nothing may tick while stopped, or `pause` would not mean paused.
    expect(ticks.started).toBe(atStop);
    realm.stop();
  });

  it('repeated cycles do not multiply the subscriptions', async () => {
    // If `start()` armed a NEW subscription each time without checking, three
    // cycles would triple the tick rate — a bug that looks like "the fix works".
    const id = makeRealmId();
    const ticks = new TickCounter();
    const realm = RealmRegistry.create({ id, mode: 'sim', clock: fastClock(), ambientProcesses: [ticks] });
    realm.start();
    await sleep(60);
    realm.stop();
    for (let i = 0; i < 3; i += 1) { realm.start(); realm.stop(); }
    realm.start();
    const atStart = ticks.started;
    await sleep(100);
    const gained = ticks.started - atStart;
    realm.stop();
    // One clock at ~10 ms over ~100 ms is roughly 10 ticks; three subscriptions
    // would be ~30. Generous bound so a slow CI cannot flake, tight enough to catch
    // a tripled rate.
    expect(gained).toBeLessThan(25);
  });

  it('effect → rules stays wired across a stop/start (the same Experience is produced)', async () => {
    const id = makeRealmId();
    const realm = RealmRegistry.create({ id, mode: 'sim', clock: fastClock() });
    populateFacility(realm, { facilityId: 'f1', kind: 'dialysis', name: 'Lifecycle Dialysis', units: ['U1'], patientCount: 1 });
    // populateFacility seeds the clinical graph; the acting presence is explicit.
    const presence = realm.spawnPresence({ agentSpecId: 'lifecycle-md', role: 'md', clearance: 'restricted-phi', location: { facilityId: 'f1' } });
    realm.start();

    const experiences: string[] = [];
    realm.rules.subscribe((exp) => experiences.push(exp.kind));

    // A potassium result deterministically trips the `hyperkalemia-suspected` rule,
    // so a detached ledger→rules feed shows up as a MISSING Experience rather than
    // as a silent no-op. Each emission needs its own orderId: a matured result is
    // keyed `<orderId>-result`, and reusing one would collide on the second emit.
    const emitPotassium = (n: number) => realm.emit(presence.presenceId, {
      kind: 'result-lab', orderId: `lifecycle-order-${n}`, code: 'K', value: 6.9, unit: 'mmol/L', abnormal: true,
    } as never);

    emitPotassium(1);
    expect(experiences, 'the rule did not fire before the restart — the test would prove nothing').toEqual(['hyperkalemia-suspected']);

    realm.stop();
    realm.start();
    emitPotassium(2);

    // Exactly one Experience per effect: two emissions, two Experiences. A feed that
    // was not re-armed leaves it at one.
    expect(experiences).toEqual(['hyperkalemia-suspected', 'hyperkalemia-suspected']);
    const ledgered = realm.ledger.listAll().filter((e) => (e.effect as { kind?: string }).kind === 'result-lab');
    expect(ledgered.length).toBe(2);
    realm.stop();
  });
});
