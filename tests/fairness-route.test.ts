/******************************************************************************
 *
 * Copyright (c) 2026 AnantHQ Inc.
 * All Rights Reserved.
 *
 * This software is licensed, not sold.
 *
 * The contents of this file constitute confidential and proprietary
 * information belonging exclusively to AnantHQ Inc.
 *
 * This source code incorporates proprietary algorithms, software architecture,
 * business logic, computational methods, optimization techniques,
 * workflows, data structures, APIs, and implementation details that are
 * protected by copyright law, patent law, trade secret law, and
 * international intellectual property treaties.
 *
 * Except as expressly permitted by a written license agreement,
 * no person or organization may:
 *
 *   • Copy or reproduce this software.
 *   • Modify or create derivative works.
 *   • Reverse engineer, decompile, or disassemble.
 *   • Benchmark or publicly disclose performance.
 *   • Redistribute, sublicense, lease, rent, or sell.
 *   • Use this software for competitive analysis.
 *   • Disclose any implementation details.
 *
 * Any unauthorized use is strictly prohibited and may result in
 * civil damages, injunctive relief, criminal prosecution,
 * and all other remedies available under applicable law.
 *
 ******************************************************************************/

// S5 L0 — the route, and the answer to "does the screen fire?".
//
// This is the test that closes the loop the whole S5 finding was about. Before the
// route existed, `exec-app/src/lib/assurance.ts` called
// `/admin/swarm/assurance/fairness` and the backend served nothing — so the screen
// was unreachable, and "the screen reports no disparity" and "the screen is not
// wired" were indistinguishable from the outside. They are not any more.
//
// The last test records the VERDICT rather than asserting a specific one. That is
// deliberate: whether the screen fires is an empirical question about this fixture,
// and the value of measuring it is the measurement, not a green tick. What the test
// asserts is that the answer is *reachable* and *about a real cohort*.

import { describe, expect, it, beforeEach } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import type { PostgresEventStore } from '../src/server/postgres-event-store.js';
import type { CanonicalEvent } from '../src/healthcare-core/events.js';
import type { LedgerEntry } from '../src/hypergraph/ledger.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import type { ActorContext } from '../src/server/scoped-persistence.js';
import { AcceleratedClock } from '../src/realm/clock.js';
import { RealmRegistry } from '../src/realm/index.js';
import { populateFacility } from '../src/realm/sim-populator.js';

const FIXED_START = new Date('2026-01-01T00:00:00.000Z');

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

async function build() {
  return buildApp({
    store: inMemoryStore(),
    telemetry: new Telemetry('test', new InMemorySink()),
    packs: [healthcareCorePack],
    authenticate: async () => actor,
    checkHealth: async () => ({ db: true, redis: true }),
  });
}

/** A 12-patient realm, so sexes are exactly 6/6 (the fixture's strict alternation). */
function seedRealm(): void {
  const realm = RealmRegistry.create({
    id: 'fair-route',
    mode: 'sim',
    clock: new AcceleratedClock({ startAt: FIXED_START }),
  });
  populateFacility(realm, {
    facilityId: 'fair-route-fac',
    kind: 'dialysis',
    name: 'Fairness Route Dialysis',
    units: ['A', 'B'],
    patientCount: 12,
  }, { seed: 1, days: 90 });
}

beforeEach(() => {
  for (const realm of RealmRegistry.list()) RealmRegistry.remove(realm.id);
});

describe('S5 L0 — GET /admin/swarm/assurance/fairness is served', () => {
  // The finding, inverted into an assertion: a cohort of real patients reaches the
  // report. `cohortN` is the strongest available check because it is exactly the
  // number `fairnessReport` compares against `minSliceN` before it will say anything.
  it('reports over the live population, not an empty cohort', async () => {
    seedRealm();
    const app = await build();
    try {
      const res = await app.inject({ method: 'GET', url: '/admin/swarm/assurance/fairness' });
      expect(res.statusCode).toBe(200);

      const body = res.json() as {
        report: { cohortN: number; dimensions: unknown[]; findings: string[]; verdict: string };
        signature: string;
        reference: { minSliceN: number };
      };

      expect(body.report.cohortN).toBe(12);
      expect(body.report.dimensions).toHaveLength(4);
      expect(body.reference.minSliceN).toBe(5);
      expect(typeof body.signature).toBe('string');
      // The reason it used to be `insufficient`, now absent.
      expect(body.report.findings.join(' ')).not.toContain('smaller than the minimum slice size');
    } finally {
      await app.close();
    }
  });

  it('serves a single dimension', async () => {
    seedRealm();
    const app = await build();
    try {
      const res = await app.inject({ method: 'GET', url: '/admin/swarm/assurance/fairness?dimension=sex' });
      expect(res.statusCode).toBe(200);

      const body = res.json() as { dimension: { slices: Array<{ slice: string; n: number }> } };
      // 6/6 exactly, because `SEXES` alternates. §1.2, served over HTTP.
      expect(body.dimension.slices.map((s) => [s.slice, s.n])).toEqual([['F', 6], ['M', 6]]);
    } finally {
      await app.close();
    }
  });

  // S5 L1's blocker, made explicit at the boundary. `race` is a real field on every
  // Synthea patient and NOT a declared `SliceDimension`, so asking for it must fail
  // loudly. An empty `DisparityReport` would read as "no racial disparity", which is
  // the single most dangerous wrong answer this endpoint could give.
  it('refuses an undeclared dimension rather than reporting it as empty', async () => {
    seedRealm();
    const app = await build();
    try {
      const res = await app.inject({ method: 'GET', url: '/admin/swarm/assurance/fairness?dimension=race' });
      expect(res.statusCode).toBe(400);

      const body = res.json() as { error: string };
      expect(body.error).toContain('race');
      // And it names what IS declared, so the caller can act on the failure.
      expect(body.error).toContain('age');
      expect(body.error).toContain('access');
    } finally {
      await app.close();
    }
  });

  // The measurement, recorded rather than asserted. A green tick here would say "the
  // fixture is equitable", which is not a claim this fixture can support — it would
  // only mean the screen found nothing in a population built to have nothing to find.
  it('records whether the screen fires at all', async () => {
    seedRealm();
    const app = await build();
    try {
      const res = await app.inject({ method: 'GET', url: '/admin/swarm/assurance/fairness' });
      const body = res.json() as {
        report: { verdict: string; findings: string[]; dimensions: Array<{ dimension: string; verdict: string }> };
      };

      const byDimension = body.report.dimensions.map((d) => `${d.dimension}=${d.verdict}`).join(' ');
      // eslint-disable-next-line no-console
      console.log(`[S5 L0] fairness verdict=${body.report.verdict} :: ${byDimension}`);

      // Reachable, and each dimension decided on its own — whatever it decided.
      expect(body.report.dimensions.map((d) => d.dimension)).toEqual(['age', 'sex', 'vintage', 'access']);
      expect(body.report.dimensions.every((d) => ['ok', 'watch', 'breach', 'insufficient'].includes(d.verdict))).toBe(true);
    } finally {
      await app.close();
    }
  });
});
