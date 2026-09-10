// R1 — realm history backfill.
//
// A realm created through the console had patient STATE but an empty LEDGER, so
// every protocol observer — which replays the ledger — saw permanently
// un-monitored patients and every coverage gate blocked them. These tests hold
// the fix at both levels: the backfill itself (deterministic, complete, lands on
// "now") and the user-visible outcome (a created realm's clinical windows are
// COVERED, for all six packs).

import { describe, expect, it, afterEach } from 'vitest';
import { Realm, populateFacility } from '../src/realm/index.js';
import { RealmHypergraph } from '../src/realm/hypergraph-bridge.js';
import { buildHealthcareHypergraphSchema } from '../packs/healthcare-core/hypergraph.js';
import { AcceleratedClock } from '../src/realm/clock.js';
import { RealmRegistry } from '../src/realm/registry.js';
import { backfillAnchorMs, backfillRealmHistory } from '../src/simulator/backfill.js';
import { buildInfectionTwin } from '../src/swarm/infection-twin.js';
import { infectionCoverage } from '../src/swarm/infection-governance.js';
import { buildNutritionTwin } from '../src/swarm/nutrition-twin.js';
import { nutritionWindowFromTwin } from '../src/swarm/nutrition-twin.js';
import { nutritionCoverage } from '../src/swarm/nutrition-governance.js';
import { buildMbdTwin, mbdWindowFromTwin } from '../src/swarm/mbd-twin.js';
import { mbdCoverage } from '../src/swarm/mbd-governance.js';
import { attributePatientIdFromOrder } from '../src/swarm/renal-cohort.js';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import type { PostgresEventStore } from '../src/server/postgres-event-store.js';
import type { CanonicalEvent } from '../src/healthcare-core/events.js';
import type { LedgerEntry } from '../src/hypergraph/ledger.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import type { ActorContext } from '../src/server/scoped-persistence.js';

const DAYS = 90;
const FACILITY = { facilityId: 'bf', kind: 'dialysis' as const, name: 'Backfill Test', units: ['U1', 'U2'], patientCount: 6 };

function anchoredRealm(id: string, withProjection = false): Realm {
  return new Realm({
    id,
    mode: 'sim',
    clock: new AcceleratedClock({ startAt: new Date(Date.now() - backfillAnchorMs(DAYS)), msPerTick: 1000, realmMsPerTick: 3_600_000 }),
    ...(withProjection ? { hypergraph: new RealmHypergraph(buildHealthcareHypergraphSchema(), id) } : {}),
  });
}

function kindSequence(realm: Realm): string[] {
  return realm.ledger.listAll().map((e) => (e.effect as { kind: string }).kind);
}

function labValues(realm: Realm): string[] {
  return realm.ledger.listAll()
    .filter((e) => (e.effect as { kind: string }).kind === 'result-lab')
    .map((e) => {
      const eff = e.effect as { code: string; value: number };
      return `${eff.code}=${eff.value}`;
    });
}

afterEach(() => {
  for (const id of RealmRegistry.list().map((r) => r.id)) {
    if (id.startsWith('sim:bf-') || id.startsWith('realm:bf-')) RealmRegistry.remove(id);
  }
});

describe('realm backfill — the ledger gets a real monitoring history', () => {
  it('replays a complete longitudinal record and lands the clock on now', () => {
    const realm = anchoredRealm('realm:bf-unit');
    populateFacility(realm, FACILITY, { seed: 1, days: DAYS });
    const before = Date.now();
    const result = backfillRealmHistory(realm, { days: DAYS, seed: 1 });

    expect(result.patients).toBe(6);
    expect(result.rejected).toBe(0);
    expect(result.effects).toBeGreaterThan(500);
    expect(result.days).toBe(DAYS);
    // the clock advanced through the history and is back at the present
    expect(new Date(realm.clock.realmAt).getTime()).toBeGreaterThanOrEqual(before - 60_000);
    expect(new Date(realm.clock.realmAt).getTime()).toBeLessThanOrEqual(Date.now() + 60_000);
    expect(result.firstAt!.localeCompare(result.lastAt!)).toBeLessThan(0);

    const kinds = kindSequence(realm);
    expect(kinds).toContain('record-vitals');
    expect(kinds).toContain('result-lab');
    expect(kinds).toContain('order-med');
    realm.stop();
  });

  it('gives every patient a serial temperature series (the P6 triage contract)', () => {
    const realm = anchoredRealm('realm:bf-temps');
    populateFacility(realm, FACILITY, { seed: 1, days: DAYS });
    backfillRealmHistory(realm, { days: DAYS, seed: 1 });

    for (const patient of realm.graph.listKind('patient')) {
      const temps = realm.ledger.listAll()
        .filter((e) => (e.effect as { patientId?: string; kind: string }).patientId === patient.id)
        .filter((e) => (e.effect as { kind: string }).kind === 'record-vitals')
        .map((e) => (e.effect as { temp?: number }).temp)
        .filter((t): t is number => typeof t === 'number');
      expect(temps.length, patient.id).toBe(DAYS);
      expect(Math.min(...temps)).toBeGreaterThan(34);
      expect(Math.max(...temps)).toBeLessThan(41);
    }
    // the inflamed trajectory really is febrile — the signal is not decorative
    const decompensating = realm.graph.listKind('patient').find((p) => (p.state as { trajectory?: string }).trajectory === 'decompensating');
    expect(decompensating, 'the cohort must include a decompensating patient').toBeDefined();
    const febrile = realm.ledger.listAll()
      .filter((e) => (e.effect as { patientId?: string }).patientId === decompensating!.id)
      .map((e) => (e.effect as { temp?: number }).temp ?? 0);
    expect(Math.max(...febrile)).toBeGreaterThanOrEqual(38);
    realm.stop();
  });

  it('writes the core labs and the CKD-MBD / nutrition / infection panel every lab week', () => {
    const realm = anchoredRealm('realm:bf-panel');
    populateFacility(realm, FACILITY, { seed: 1, days: DAYS });
    backfillRealmHistory(realm, { days: DAYS, seed: 1 });

    const pid = realm.graph.listKind('patient')[0]!.id;
    const codes = new Map<string, number>();
    for (const e of realm.ledger.listAll()) {
      const eff = e.effect as { kind: string; orderId?: string; code?: string; unit?: string };
      if (eff.kind !== 'result-lab' || !(eff.orderId ?? '').startsWith(`${pid}-`)) continue;
      codes.set(eff.code!, (codes.get(eff.code!) ?? 0) + 1);
      expect(eff.unit, `${eff.code} must carry a unit`).toBeTruthy();
    }
    for (const code of ['K', 'HGB', 'URR', 'PHOS', 'CALCIUM', 'PTH', 'ALBUMIN', 'CREATININE', 'BICARB', 'CRP', 'WBC', 'PROCALCITONIN']) {
      expect(codes.get(code), `${code} results`).toBe(13);
    }
    realm.stop();
  });

  it('is deterministic: the same patient + seed yields the same history', () => {
    const a = anchoredRealm('realm:bf-det-a');
    const b = anchoredRealm('realm:bf-det-b');
    for (const realm of [a, b]) {
      populateFacility(realm, FACILITY, { seed: 1, days: DAYS });
      backfillRealmHistory(realm, { days: DAYS, seed: 1 });
    }
    expect(kindSequence(a)).toEqual(kindSequence(b));
    expect(labValues(a)).toEqual(labValues(b));
    expect(a.ledger.listAll().length).toBe(b.ledger.listAll().length);
    a.stop();
    b.stop();
  });

  it('does not let the ambient lab process overwrite the deterministic results', () => {
    const realm = anchoredRealm('realm:bf-noorder');
    populateFacility(realm, FACILITY, { seed: 1, days: DAYS });
    backfillRealmHistory(realm, { days: DAYS, seed: 1 });
    // results are written directly; no order is left for maturation to re-draw
    expect(kindSequence(realm).filter((k) => k === 'order-lab')).toHaveLength(0);
    const pid = realm.graph.listKind('patient')[0]!.id;
    const hgb = realm.ledger.listAll()
      .filter((e) => (e.effect as { orderId?: string }).orderId?.startsWith(`${pid}-HGB-`))
      .map((e) => (e.effect as { value: number }).value);
    expect(hgb).toHaveLength(13);
    realm.stop();
  });

  it('anchors the realm so the clock lands on now', () => {
    // clamped to the same 7..365 day window the backfill itself enforces
    expect(backfillAnchorMs(7)).toBe(6 * 86_400_000);
    expect(backfillAnchorMs(90)).toBe(89 * 86_400_000);
    expect(backfillAnchorMs(1_000)).toBe(364 * 86_400_000);
  });

  it('attaches the hypergraph projection and syncs the populated graph once', () => {
    const realm = anchoredRealm('realm:bf-hg');
    populateFacility(realm, FACILITY, { seed: 1, days: DAYS });
    backfillRealmHistory(realm, { days: DAYS, seed: 1 });
    expect(realm.hypergraph).toBeUndefined();

    const synced = realm.attachHypergraph(new RealmHypergraph(buildHealthcareHypergraphSchema(), 'realm:bf-hg'));
    expect(synced.nodes).toBeGreaterThan(0);
    expect(realm.hypergraph).toBeDefined();
    expect(realm.hypergraph!.store.now().nodes.size).toBeGreaterThan(0);
    realm.stop();
  });
});

describe('realm backfill — the clinical windows are covered', () => {
  it('covers the P6 infection window, the P5 nutrition window and the P4 MBD window', () => {
    const realm = anchoredRealm('realm:bf-covered');
    populateFacility(realm, FACILITY, { seed: 1, days: DAYS });
    backfillRealmHistory(realm, { days: DAYS, seed: 1 });

    const events = realm.ledger.listAll().map((e) => ({
      realmId: realm.id,
      eventId: e.effectId,
      kind: (e.effect as { kind: string }).kind,
      emittedAt: e.emittedAt,
      ...(e.realmAt ? { realmAt: e.realmAt } : {}),
      ...(typeof (e.effect as { patientId?: string }).patientId === 'string' ? { patientId: (e.effect as { patientId: string }).patientId } : {}),
      payload: e.effect as Record<string, unknown>,
    }));
    const states = realm.graph.listKind('patient').map((p) => ({ patientId: p.id, realmId: realm.id, state: p.state as Record<string, unknown> }));
    const knownIds = realm.graph.listKind('patient').map((p) => p.id);

    for (const patient of realm.graph.listKind('patient')) {
      // labs carry only an orderId — attribute them exactly as the routes do
      const patientEvents = events.filter((e) =>
        e.patientId === patient.id
        || attributePatientIdFromOrder(String((e.payload as { orderId?: string }).orderId ?? ''), knownIds) === patient.id);

      // P6 — serial temperatures + an inflammatory marker
      const infectionTwin = buildInfectionTwin({ patientId: patient.id, events: patientEvents, patients: states });
      expect(infectionTwin.summary.serialReadings, `${patient.id} P6 readings`).toBeGreaterThanOrEqual(3);
      expect(infectionTwin.summary.inflammatoryMarkers, `${patient.id} P6 markers`).toBeGreaterThanOrEqual(1);
      expect(infectionCoverage(infectionTwin.window).covered, `${patient.id} P6 covered`).toBe(true);

      // P5 — the nutrition window needs serial measurements + markers
      const nutritionTwin = buildNutritionTwin({ patientId: patient.id, events: patientEvents, patients: states });
      const nutritionWindow = nutritionWindowFromTwin(nutritionTwin);
      expect(nutritionCoverage(nutritionWindow).covered, `${patient.id} P5 covered`).toBe(true);

      // P4 — the MBD window needs ≥2 triplets
      const mbdTwin = buildMbdTwin({ patientId: patient.id, events: patientEvents, patients: states });
      const mbdWindow = mbdWindowFromTwin(mbdTwin);
      expect(mbdCoverage(mbdWindow).covered, `${patient.id} P4 covered`).toBe(true);
    }
    realm.stop();
  });
});

describe('realm backfill — POST /admin/realms creates a monitored realm', () => {
  function inMemoryStore(): PostgresEventStore {
    const events: CanonicalEvent[] = [];
    const ledger: LedgerEntry[] = [];
    const audit: unknown[] = [];
    return {
      async applyMigrations() { /* noop */ },
      async appendEvent(_scope: { scopeId: string; actorRef: string }, ev: CanonicalEvent) { events.push(ev); },
      async queryEvents() { return events; },
      async ledgerAppend(_scope: { scopeId: string; actorRef: string }, e: LedgerEntry) { ledger.push(e); },
      async ledgerQuery() { return ledger; },
      async appendAudit(_scope: { scopeId: string; actorRef: string }, row: unknown) { audit.push(row); },
      async queryAudit() { return audit; },
      async recordFhirResource() { /* noop */ },
      async listFhirResources() { return []; },
    } as unknown as PostgresEventStore;
  }
  const actor: ActorContext = { actorRef: 'user:test', scopeIds: ['scope:*'], clearance: 'restricted-phi', purposeOfUse: 'operations' } as ActorContext;

  it('seeds a ledger history, reports it, and leaves the realm projected', async () => {
    const app = await buildApp({
      store: inMemoryStore(),
      telemetry: new Telemetry('test', new InMemorySink()),
      packs: [healthcareCorePack],
      authenticate: async () => actor,
      checkHealth: async () => ({ db: true, redis: true }),
    });
    try {
      const res = await app.inject({
        method: 'POST', url: '/admin/realms',
        payload: { id: 'realm:bf-route', mode: 'sim', seed: { facilityId: 'rout', kind: 'dialysis', name: 'Routed', units: ['U1'], patientCount: 3 } },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { history?: { patients: number; effects: number; days: number }; effects: number };
      expect(body.history).toBeDefined();
      expect(body.history!.patients).toBe(3);
      expect(body.history!.effects).toBeGreaterThan(200);
      expect(body.effects).toBeGreaterThan(200);

      const realm = RealmRegistry.get('realm:bf-route');
      expect(realm).toBeDefined();
      expect(realm!.ledger.listAll().length).toBe(body.history!.effects);
      // the projection is attached (Phase 1b contract still holds)
      expect(realm!.hypergraph).toBeDefined();
      expect(realm!.hypergraph!.store.now().nodes.size).toBeGreaterThan(0);
      // the P6 window of a created realm is covered — the bug this fixes
      const pid = realm!.graph.listKind('patient')[0]!.id;
      const twin = buildInfectionTwin({
        patientId: pid,
        events: realm!.ledger.listAll().map((e) => ({
          realmId: realm!.id, eventId: e.effectId, kind: (e.effect as { kind: string }).kind,
          emittedAt: e.emittedAt, ...(e.realmAt ? { realmAt: e.realmAt } : {}),
          ...(typeof (e.effect as { patientId?: string }).patientId === 'string' ? { patientId: (e.effect as { patientId: string }).patientId } : {}),
          payload: e.effect as Record<string, unknown>,
        })),
        patients: realm!.graph.listKind('patient').map((p) => ({ patientId: p.id, realmId: realm!.id, state: p.state as Record<string, unknown> })),
      });
      expect(infectionCoverage(twin.window).covered).toBe(true);
    } finally {
      await app.close();
      RealmRegistry.remove('realm:bf-route');
    }
  });

  it('honours historyDays so a caller can ask for a shorter or longer record', async () => {
    const app = await buildApp({
      store: inMemoryStore(),
      telemetry: new Telemetry('test', new InMemorySink()),
      packs: [healthcareCorePack],
      authenticate: async () => actor,
      checkHealth: async () => ({ db: true, redis: true }),
    });
    try {
      const res = await app.inject({
        method: 'POST', url: '/admin/realms',
        payload: { id: 'realm:bf-short', mode: 'sim', historyDays: 30, seed: { facilityId: 'shrt', kind: 'dialysis', name: 'Short', units: ['U1'], patientCount: 2 } },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { history: { days: number; effects: number } };
      expect(body.history.days).toBe(30);
      const realm = RealmRegistry.get('realm:bf-short')!;
      const temps = realm.ledger.listAll().filter((e) => (e.effect as { kind: string }).kind === 'record-vitals');
      expect(temps).toHaveLength(60);
    } finally {
      await app.close();
      RealmRegistry.remove('realm:bf-short');
    }
  });
});
