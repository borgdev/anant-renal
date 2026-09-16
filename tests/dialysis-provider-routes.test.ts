/******************************************************************************
 * Dialysis-provider pack route surface (G1 phase 2) — tests.
 *
 * The renal data-model module moved out of `src/server/` and into the pack that
 * owns it. What this file pins is the part of that move that is behavioural
 * rather than cosmetic: the endpoints now exist BECAUSE the pack is installed, so
 * an uninstalled pack must 404 rather than answer, and the patient projection the
 * module used to reach for itself now arrives as a dependency.
 ******************************************************************************/

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import { dialysisProviderPack } from '../packs/dialysis-provider/index.js';
import { registerRenalRoutes } from '../packs/dialysis-provider/renal-routes.js';
import type { PackPatient } from '../src/control-plane/pack-contributions.js';
import type { RenalPatientInput } from '../src/swarm/renal-cohort.js';
import type { PostgresEventStore } from '../src/server/postgres-event-store.js';
import type { CanonicalEvent } from '../src/healthcare-core/events.js';
import type { LedgerEntry } from '../src/hypergraph/ledger.js';
import type { ActorContext } from '../src/server/scoped-persistence.js';

// The platform hands over `PackPatient` and a pack's own module consumes
// `RenalPatientInput` (or whatever shape that specialty derived). The two must
// stay mutually assignable or every migration needs a cast at the seam, which is
// exactly the coupling the move was meant to remove. Pinned at COMPILE time, in
// both directions, so a field added to one side and not the other fails here
// rather than silently widening to `any` at a call site.
const _patientForward: (p: RenalPatientInput) => PackPatient = (p) => p;
const _patientBackward: (p: PackPatient) => RenalPatientInput = (p) => p;
void _patientForward;
void _patientBackward;

function inMemoryStore() {
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

async function build(installed: boolean) {
  return buildApp({
    store: inMemoryStore(),
    telemetry: new Telemetry('test', new InMemorySink()),
    packs: installed ? [healthcareCorePack, dialysisProviderPack] : [healthcareCorePack],
    authenticate: async () => actor,
    checkHealth: async () => ({ db: true, redis: true }),
    adminApiAuth: true,
  });
}

type App = Awaited<ReturnType<typeof build>>;

async function login(app: App, username: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { username, password } });
  const raw = Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'].join(';') : String(res.headers['set-cookie'] ?? '');
  const token = /hh_session=([^;]+)/.exec(raw)?.[1];
  if (!token) throw new Error(`no session cookie: ${res.statusCode} ${res.body}`);
  return token;
}
const cookie = (token: string) => `hh_session=${token}`;

const RENAL_ROUTES = [
  '/admin/swarm/renal/cohort',
  '/admin/swarm/renal/summary',
] as const;

describe('dialysis-provider pack routes', () => {
  describe('with the pack installed', () => {
    let app: App;
    let admin: string;
    beforeAll(async () => {
      app = await build(true);
      admin = await login(app, 'admin', 'admin123');
    });
    afterAll(async () => { await app.close(); });

    it('serves the renal data-model surface the pack declares', async () => {
      for (const url of RENAL_ROUTES) {
        const res = await app.inject({ method: 'GET', url, headers: { cookie: cookie(admin) } });
        expect(res.statusCode, url).toBe(200);
      }
    });

    it('answers the fleet roll-up from the projection the platform supplied', async () => {
      const res = await app.inject({ method: 'GET', url: '/admin/swarm/renal/summary', headers: { cookie: cookie(admin) } });
      expect(res.statusCode).toBe(200);
      const { summary } = res.json();
      expect(typeof summary.patients).toBe('number');
      expect(typeof summary.realms).toBe('number');
      expect(typeof summary.sessions).toBe('number');
    });
  });

  describe('with the pack absent', () => {
    let app: App;
    let admin: string;
    beforeAll(async () => {
      app = await build(false);
      admin = await login(app, 'admin', 'admin123');
    });
    afterAll(async () => { await app.close(); });

    it('404s rather than 403s', async () => {
      // 404, not 403, and this distinction is the whole reason the endpoints
      // moved: the route genuinely does not exist, because the pack that declares
      // it is not installed. A 403 would claim the caller lacks authority over a
      // surface nobody registered, which sends an operator to look at permissions
      // when the real answer is the install.
      for (const url of RENAL_ROUTES) {
        const res = await app.inject({ method: 'GET', url, headers: { cookie: cookie(admin) } });
        expect(res.statusCode, url).toBe(404);
      }
    });

    it('reports on exactly the patients the platform supplies', async () => {
      // Asserted THROUGH the module rather than by inspecting the deps object, so
      // this fails if the pack ever goes back to resolving its own population.
      // A bare Fastify instance has no realm registry behind it, which is the
      // point: the only way to get a patient here is to be given one.
      const bare = Fastify();
      await registerRenalRoutes(bare, {
        patients: () => [{ id: 'p-injected', realmId: 'r1', state: {} }],
      });
      const res = await bare.inject({ method: 'GET', url: '/admin/swarm/renal/summary' });
      expect(res.statusCode).toBe(200);
      expect(res.json().summary.patients).toBe(1);
      expect(res.json().summary.realms).toBe(1);
      await bare.close();
    });
  });
});
