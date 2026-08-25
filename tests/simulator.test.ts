import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import type { PostgresEventStore } from '../src/server/postgres-event-store.js';
import type { CanonicalEvent } from '../src/healthcare-core/events.js';
import type { LedgerEntry } from '../src/hypergraph/ledger.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import type { ActorContext } from '../src/server/scoped-persistence.js';
import { AcceleratedClock, populateFacility, RealmRegistry } from '../src/realm/index.js';
import { RealmHypergraph } from '../src/realm/hypergraph-bridge.js';
import { buildHealthcareHypergraphSchema } from '../packs/healthcare-core/hypergraph.js';
import { mulberry32 } from '../src/simulator/rng.js';
import { ScriptedEventGenerator } from '../src/simulator/script.js';
import { SimulatorController } from '../src/simulator/controller.js';
import { DIALYSIS_BASIC, listScenarios, scenarioFor } from '../src/simulator/scenarios.js';
import type { FleetPersistState, SimScript } from '../src/simulator/types.js';

function inMemoryStore(): PostgresEventStore {
  const events: CanonicalEvent[] = [];
  const ledger: LedgerEntry[] = [];
  const audit: unknown[] = [];
  const store = {
    async applyMigrations() { /* noop */ },
    async appendEvent(_scope: { scopeId: string; actorRef: string }, ev: CanonicalEvent) { events.push(ev); },
    async queryEvents() { return events; },
    async ledgerAppend(_scope: { scopeId: string; actorRef: string }, e: LedgerEntry) { ledger.push(e); },
    async ledgerQuery() { return ledger; },
    async appendAudit(_scope: { scopeId: string; actorRef: string }, row: unknown) { audit.push(row); },
    async queryAudit() { return audit; },
    async recordFhirResource(_scope: { scopeId: string; actorRef: string }, r: unknown) { /* noop */ },
    async listFhirResources() { return []; },
  } as unknown as PostgresEventStore;
  return store;
}

const actor: ActorContext = { actorRef: 'user:test', scopeIds: ['scope:*'], clearance: 'restricted-phi', purposeOfUse: 'operations' } as ActorContext;

async function build() {
  return buildApp({
    store: inMemoryStore(),
    telemetry: new Telemetry('test', new InMemorySink()),
    packs: [healthcareCorePack],
    authenticate: async () => actor,
    checkHealth: async () => ({ db: true, redis: true }),
  });
}

/** Remove every sim realm from the process-global registry (idempotent). */
function cleanupSimRealms() {
  for (const r of RealmRegistry.list()) {
    if (r.id.startsWith('sim:')) RealmRegistry.remove(r.id);
  }
}

/** A direct realm with a script generator — no controller, no intervals. */
function buildScriptRealm(id: string, script: SimScript) {
  const realm = RealmRegistry.create({
    id,
    mode: 'sim',
    clock: new AcceleratedClock({ startAt: new Date('2026-08-01T06:00:00.000Z'), msPerTick: 10, realmMsPerTick: 3_600_000 }),
    hypergraph: new RealmHypergraph(buildHealthcareHypergraphSchema(), id),
  });
  populateFacility(realm, { facilityId: 'fac', kind: 'dialysis', name: 'F', units: ['U-1'], patientCount: 3 });
  for (const role of ['md', 'nurse'] as const) {
    realm.presences.spawn({
      realmId: id, agentSpecId: `sim.${role}`, runId: `sim.${role}`, role,
      clearance: 'restricted-phi', purposeOfUse: ['treatment'],
      location: { facilityId: 'fac' }, perceptualRange: { units: ['*'], patients: ['*'], eventTypes: ['*'] },
    });
  }
  realm.ambient.register(new ScriptedEventGenerator({ realm, script, seed: 7 }));
  return realm;
}

describe('scenario registry + RNG determinism', () => {
  it('registers the demo + basic scenarios', () => {
    const ids = listScenarios().map((s) => s.id);
    expect(ids).toContain('dialysis-demo');
    expect(ids).toContain('dialysis-basic');
    expect(scenarioFor('dialysis-demo')?.realms.length).toBeGreaterThan(0);
    expect(scenarioFor('nope')).toBeUndefined();
  });

  it('mulberry32 is deterministic for a seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).toEqual(seqB);
    const c = mulberry32(43);
    expect(c()).not.toBe(seqA[0]);
  });
});

describe('ScriptedEventGenerator', () => {
  afterEach(() => cleanupSimRealms());

  it('fires atHour once and everyHours on schedule through real presences', () => {
    const realm = buildScriptRealm('sim:script-a', {
      entries: [
        { id: 'seed-assessment', atHour: 1, viaRole: 'nurse', emit: ({ patientIds }) => patientIds.map((pid) => ({ kind: 'record-assessment', patientId: pid, assessmentId: 'phq9', score: 3, band: 'mild' })) },
        { id: 'vitals', everyHours: 2, viaRole: 'nurse', emit: ({ patientIds }) => patientIds.map((pid) => ({ kind: 'record-vitals', patientId: pid, hr: 80, spo2: 96, bp: '128/78' })) },
        { id: 'labs', everyHours: 3, viaRole: 'md', emit: ({ patientIds }) => patientIds.map((pid) => ({ kind: 'order-lab', patientId: pid, code: 'K', priority: 'routine' })) },
      ],
    });
    const generator = realm.ambient.list().find((p) => p.id === 'sim.scripted-events') as ScriptedEventGenerator;

    // tick 1 → realm hour 1: only the one-shot assessment fires.
    realm.clock.advanceBy(3_600_000);
    expect(generator.counts['seed-assessment']?.fired).toBe(1);
    expect(generator.counts['vitals']?.fired).toBe(0);
    expect(generator.counts['labs']?.fired).toBe(0);
    expect(realm.ledger.listAll().some((e) => e.effect.kind === 'record-assessment')).toBe(true);

    // tick 3 → hour 3: vitals fired once (at hour 2), labs fired once (at hour 3).
    realm.clock.advanceBy(3_600_000);
    realm.clock.advanceBy(3_600_000);
    expect(generator.counts['vitals']?.fired).toBe(1);
    expect(generator.counts['labs']?.fired).toBe(1);
    expect(generator.counts['seed-assessment']?.fired).toBe(1); // never refires
    const kinds = realm.ledger.listAll().map((e) => e.effect.kind);
    expect(kinds).toContain('record-vitals');
    expect(kinds).toContain('order-lab');

    // Lab maturation: routine labs ordered at hour 3 mature 4 ticks later → hour 7.
    for (let i = 0; i < 4; i += 1) realm.clock.advanceBy(3_600_000);
    expect(realm.ledger.listAll().some((e) => e.effect.kind === 'result-lab')).toBe(true);
  });
});

describe('SimulatorController lifecycle', () => {
  const sim = new SimulatorController();
  afterEach(() => { sim.reset(); cleanupSimRealms(); });

  it('starts the basic scenario (autoRun off) with populated realms + presences', async () => {
    const snap = await sim.start('dialysis-basic', { autoRun: false });
    expect(snap.status).toBe('running');
    expect(snap.scenario).toBe('dialysis-basic');
    expect(snap.totals.realms).toBe(1);
    expect(snap.totals.patients).toBe(DIALYSIS_BASIC.realms[0]!.facility.patientCount);
    expect(snap.totals.presences).toBe(3); // md + nurse + coder
    const realm = RealmRegistry.get('sim:test-a');
    expect(realm).toBeDefined();
    expect(realm?.graph.listKind('patient').length).toBe(DIALYSIS_BASIC.realms[0]!.facility.patientCount);
  });

  it('step advances every realm and emits scripted events', async () => {
    await sim.start('dialysis-basic', { autoRun: false });
    // 3 realm-hours: vitals at hour 2 + labs at hour 3 (+ optional one-shot subset).
    const r = sim.step(3);
    expect(r.tick).toBe(3);
    expect(r.events).toBeGreaterThanOrEqual(8); // 4 vitals + 4 labs
    const kinds = RealmRegistry.get('sim:test-a')!.ledger.listAll().map((e) => e.effect.kind);
    expect(kinds).toContain('record-vitals');
    expect(kinds).toContain('order-lab');
    expect(sim.snapshot().eventCount).toBeGreaterThanOrEqual(8);
  });

  it('pause freezes the clock and resume restarts it', async () => {
    await sim.start('dialysis-basic', { autoRun: false });
    sim.step(1);
    const paused = sim.pause();
    expect(paused.status).toBe('paused');
    const seqAtPause = RealmRegistry.get('sim:test-a')!.clock.seq;
    expect(sim.resume().status).toBe('running');
    expect(RealmRegistry.get('sim:test-a')!.clock.seq).toBe(seqAtPause); // no auto-tick in test mode
  });

  it('reset tears the fleet down and returns to idle', async () => {
    await sim.start('dialysis-basic', { autoRun: false });
    sim.step(2);
    expect(RealmRegistry.get('sim:test-a')).toBeDefined();
    sim.reset();
    expect(sim.snapshot().status).toBe('idle');
    expect(sim.snapshot().totals.realms).toBe(0);
    expect(RealmRegistry.get('sim:test-a')).toBeUndefined();
  });

  it('is deterministic for a given scenario + seed', async () => {
    const kinds = async () => {
      await sim.start('dialysis-basic', { autoRun: false });
      sim.step(8);
      const out = RealmRegistry.get('sim:test-a')!.ledger.listAll().map((e) => e.effect.kind);
      sim.reset();
      return out;
    };
    expect(await kinds()).toEqual(await kinds());
  });
});

describe('SimulatorController persistence + resume', () => {
  afterEach(() => { cleanupSimRealms(); });

  it('persists the fleet state on start/step/pause/resume/reset', async () => {
    const saved: FleetPersistState[] = [];
    const sim = new SimulatorController({ persistFleet: (s) => saved.push(s) });
    await sim.start('dialysis-basic', { autoRun: false });
    sim.step(1);
    sim.pause();
    sim.resume();
    sim.reset();
    expect(saved.length).toBeGreaterThanOrEqual(5);
    const running = saved.find((s) => s.scenarioId === 'dialysis-basic');
    expect(running?.realmIds).toContain('sim:test-a');
    expect(running?.status).toBe('running');
    expect(saved[saved.length - 1]?.status).toBe('idle');
    expect(saved.some((s) => s.status === 'paused')).toBe(true);
  });

  it('adopt resumes a persisted fleet onto already-restored realms', async () => {
    const sim = new SimulatorController();
    await sim.start('dialysis-basic', { autoRun: false });
    sim.step(2);
    const state = sim.fleetState();
    expect(state.tickCount).toBe(2);
    sim.reset();
    expect(RealmRegistry.get('sim:test-a')).toBeUndefined();

    // Simulate the boot path: realms rebuilt into the registry (restoreRealmsFromSpecs
    // would do this from realm_specs/realm_snapshots), then the controller adopts them.
    const realm = RealmRegistry.create({
      id: 'sim:test-a', mode: 'sim',
      clock: new AcceleratedClock({ startAt: new Date('2026-08-01T06:00:00.000Z'), msPerTick: 10, realmMsPerTick: 3_600_000 }),
      hypergraph: new RealmHypergraph(buildHealthcareHypergraphSchema(), 'sim:test-a'),
    });
    populateFacility(realm, DIALYSIS_BASIC.realms[0]!.facility);
    for (const role of DIALYSIS_BASIC.realms[0]!.presences) {
      realm.presences.spawn({
        realmId: 'sim:test-a', agentSpecId: `sim.${role}`, runId: `sim.${role}`, role,
        clearance: 'restricted-phi', purposeOfUse: ['treatment'],
        location: { facilityId: 'fac' }, perceptualRange: { units: ['*'], patients: ['*'], eventTypes: ['*'] },
      });
    }

    const adopted = await sim.adopt(state);
    expect(adopted.status).toBe('running');
    expect(adopted.scenario).toBe('dialysis-basic');
    expect(adopted.tickCount).toBe(2);
    expect(adopted.totals.realms).toBe(1);
    expect(adopted.totals.patients).toBe(DIALYSIS_BASIC.realms[0]!.facility.patientCount);

    // The scripted generator is re-attached → stepping emits events again.
    const r = sim.step(3);
    expect(r.events).toBeGreaterThanOrEqual(8);
    sim.reset();
  });
});

describe('simulator routes', () => {
  let app: Awaited<ReturnType<typeof build>> | null = null;
  beforeEach(async () => { app = await build(); });
  afterEach(async () => { await app?.close(); cleanupSimRealms(); });

  it('exposes scenarios + idle status', async () => {
    const sc = await app!.inject({ method: 'GET', url: '/admin/simulator/scenarios' });
    expect(sc.statusCode).toBe(200);
    const scenarios = sc.json().scenarios;
    expect(scenarios.map((s: { id: string }) => s.id)).toContain('dialysis-demo');
    const st = await app!.inject({ method: 'GET', url: '/admin/simulator/status' });
    expect(st.statusCode).toBe(200);
    expect(st.json().simulator.status).toBe('idle');
  });

  it('start → step → pause → resume → reset round-trip', async () => {
    const start = await app!.inject({ method: 'POST', url: '/admin/simulator/start', payload: { scenario: 'dialysis-basic', autoRun: false } });
    expect(start.statusCode).toBe(200);
    expect(start.json().simulator.totals.realms).toBe(1);

    const step = await app!.inject({ method: 'POST', url: '/admin/simulator/step', payload: { ticks: 3 } });
    expect(step.statusCode).toBe(200);
    expect(step.json().events).toBeGreaterThanOrEqual(8);

    const paused = await app!.inject({ method: 'POST', url: '/admin/simulator/pause' });
    expect(paused.statusCode).toBe(200);
    expect(paused.json().simulator.status).toBe('paused');

    const resumed = await app!.inject({ method: 'POST', url: '/admin/simulator/resume' });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().simulator.status).toBe('running');

    const reset = await app!.inject({ method: 'POST', url: '/admin/simulator/reset' });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().simulator.status).toBe('idle');
    expect(RealmRegistry.get('sim:test-a')).toBeUndefined();
  });

  it('rejects an unknown scenario', async () => {
    const res = await app!.inject({ method: 'POST', url: '/admin/simulator/start', payload: { scenario: 'does-not-exist' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/unknown-scenario/);
  });
});
