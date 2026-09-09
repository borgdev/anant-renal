/******************************************************************************
 * DST-Q #2 — multi-signal early-warning.
 *
 * Pure coverage for `src/swarm/early-warning.ts` plus a route-level check of
 * the watch cohort over /admin/swarm/early-warning.
 ******************************************************************************/

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import type { PostgresEventStore } from '../src/server/postgres-event-store.js';
import type { CanonicalEvent } from '../src/healthcare-core/events.js';
import type { LedgerEntry } from '../src/hypergraph/ledger.js';
import type { ActorContext } from '../src/server/scoped-persistence.js';
import {
  defaultEarlyWarningSignals,
  fuseEarlyWarningCohort,
  fusePatientReadout,
  EW_ALERT_BELIEF_GATE,
  EW_CONTESTED_K_GATE,
  type EarlyWarningSignal,
} from '../src/swarm/early-warning.js';

const NOW = '2026-09-01T00:00:00Z';

function sig(patientId: string, kind: EarlyWarningSignal['kind'], label: string, polarity: EarlyWarningSignal['polarity'], weight: number, sourceId: string): EarlyWarningSignal {
  return { patientId, facilityId: 'fac-1', kind, label, polarity, weight, sourceId, at: NOW };
}

/* ---------- pure engine ---------- */

describe('fusePatientReadout / fuseEarlyWarningCohort', () => {
  it('is internally consistent (belief ≤ plausibility ≤ 1, scores bounded)', () => {
    const cohort = fuseEarlyWarningCohort(defaultEarlyWarningSignals());
    expect(cohort.length).toBe(6);
    for (const r of cohort) {
      expect(r.belief).toBeGreaterThanOrEqual(0);
      expect(r.belief).toBeLessThanOrEqual(r.plausibility);
      expect(r.plausibility).toBeLessThanOrEqual(1);
      expect(r.uncertainty).toBeGreaterThanOrEqual(0);
      expect(r.conflictMass).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
      expect(r.signalCount).toBe(r.signals.length);
    }
  });

  it('auto-flags only high-commitment, low-conflict evidence (patient A)', () => {
    const a = fusePatientReadout('f1-pt-0001', defaultEarlyWarningSignals());
    expect(a).toBeDefined();
    expect(a!.posture).toBe('corroborated');
    expect(a!.alert).toBe(true);
    expect(a!.belief).toBeGreaterThanOrEqual(EW_ALERT_BELIEF_GATE);
    expect(a!.conflictMass).toBeLessThan(EW_CONTESTED_K_GATE);
    expect(a!.signalCount).toBe(6);
  });

  it('does not auto-flag a single strong signal alone (patient B — watch)', () => {
    const b = fusePatientReadout('f1-pt-0002', defaultEarlyWarningSignals());
    expect(b!.posture).toBe('weak');
    expect(b!.alert).toBe(false);
    expect(b!.belief).toBeLessThan(EW_ALERT_BELIEF_GATE);
  });

  it('suppresses auto-flag when evidence is contested (patient C)', () => {
    const c = fusePatientReadout('f1-pt-0003', defaultEarlyWarningSignals());
    expect(c!.posture).toBe('contested');
    expect(c!.alert).toBe(false);
    expect(c!.conflictMass).toBeGreaterThanOrEqual(EW_CONTESTED_K_GATE);
  });

  it('reads a fully reassuring patient as reassured with no alert (patient D)', () => {
    const d = fusePatientReadout('f1-pt-0004', defaultEarlyWarningSignals());
    expect(d!.posture).toBe('reassured');
    expect(d!.alert).toBe(false);
    expect(d!.belief).toBeLessThan(0.2);
  });

  it('keeps a single ESA no-response channel below alert (patient E)', () => {
    const e = fusePatientReadout('f1-pt-0005', defaultEarlyWarningSignals());
    expect(e!.posture).toBe('weak');
    expect(e!.alert).toBe(false);
  });

  it('widens uncertainty (Pl − Bel) when only low-reliability sources support the flag (patient F)', () => {
    const f = fusePatientReadout('f1-pt-0006', defaultEarlyWarningSignals());
    expect(f!.posture).toBe('weak');
    expect(f!.alert).toBe(false);
    // sim-derived mass → real ignorance is reported, not hidden.
    expect(f!.uncertainty).toBeGreaterThan(0.3);
    expect(f!.plausibility - f!.belief).toBeCloseTo(f!.uncertainty, 3);
  });

  it('returns undefined for a patient with no signals', () => {
    expect(fusePatientReadout('nobody', [])).toBeUndefined();
  });

  it('orders the cohort alerts-first, then by score', () => {
    const cohort = fuseEarlyWarningCohort(defaultEarlyWarningSignals());
    const postures = cohort.map((r) => r.posture);
    expect(postures[0]).toBe('corroborated');
    // no other corroborated patient: first entry is the only alert
    expect(postures.filter((p) => p === 'corroborated').length).toBe(1);
    const ranks = { corroborated: 0, weak: 1, contested: 2, reassured: 3 } as const;
    for (let i = 1; i < cohort.length; i += 1) {
      expect(ranks[cohort[i]!.posture]).toBeGreaterThanOrEqual(ranks[cohort[i - 1]!.posture]);
    }
  });

  it('a strong reassuring signal flips an alerting patient to contested (K rises)', () => {
    const base = defaultEarlyWarningSignals().filter((s) => s.patientId === 'f1-pt-0001');
    const mixed = [
      ...base,
      sig('f1-pt-0001', 'vitals', 'SpO2 98% · reassuring vitals', 'stable', 0.7, 'realm-ledger:fac-1:vitals'),
    ];
    const out = fusePatientReadout('f1-pt-0001', mixed)!;
    expect(out.posture).toBe('contested');
    expect(out.alert).toBe(false);
  });
});

/* ---------- route smoke ---------- */

function inMemoryStore() {
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
type App = Awaited<ReturnType<typeof build>>;
async function build() {
  return buildApp({
    store: inMemoryStore(),
    telemetry: new Telemetry('test', new InMemorySink()),
    packs: [healthcareCorePack],
    authenticate: async () => actor,
    checkHealth: async () => ({ db: true, redis: true }),
    adminApiAuth: true,
  });
}
async function login(app: App, username: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { username, password } });
  const setCookie = res.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie.join(';') : String(setCookie ?? '');
  const m = /hh_session=([^;]+)/.exec(raw);
  const token = m?.[1];
  if (!token) throw new Error(`no session cookie: ${res.statusCode} ${res.body}`);
  return token;
}
const cookie = (token: string) => `hh_session=${token}`;

describe('early-warning watch over /admin/swarm/early-warning', () => {
  let app: App;
  let admin: string;
  beforeAll(async () => {
    app = await build();
    admin = await login(app, 'admin', 'admin123');
  });
  afterAll(async () => { await app.close(); });

  it('serves the fused cohort with gates + one alert, and accepts a new signal', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/swarm/early-warning', headers: { cookie: cookie(admin) } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.gates.alertBelief).toBe(EW_ALERT_BELIEF_GATE);
    expect(Array.isArray(body.cohort)).toBe(true);
    expect(body.signalCount).toBeGreaterThan(0);
    expect(body.cohort[0].alert).toBe(true);
    expect(body.cohort[0].posture).toBe('corroborated');

    const add = await app.inject({
      method: 'POST', url: '/admin/swarm/early-warning/signal', headers: { cookie: cookie(admin) },
      payload: { patientId: 'f1-pt-0002', kind: 'lab', polarity: 'deteriorating', label: 'K 6.1 mmol/L · second result', weight: 0.7, sourceId: 'realm-ledger:fac-1:lab:k' },
    });
    expect(add.statusCode).toBe(200);
    const added = add.json().cohort.find((r: { patientId: string }) => r.patientId === 'f1-pt-0002');
    expect(added).toBeTruthy();
    // Two agreeing realm-ledger facts now cross the alert gate.
    expect(added.alert).toBe(true);
  });

  it('rejects a malformed signal (400)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/admin/swarm/early-warning/signal', headers: { cookie: cookie(admin) },
      payload: { patientId: 'x' }, // missing kind/polarity
    });
    expect(res.statusCode).toBe(400);
  });
});
