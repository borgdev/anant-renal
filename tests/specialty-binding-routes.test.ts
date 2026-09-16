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

// G6 at the wire: the binding CRUD, and what a binding actually changes about
// /api/context.
//
// The assertions that matter are about SEPARATION — hiding a specialty must not
// stop it being applied, and a binding for one pack must not disturb another. A
// test that only checked "the row saved" would pass on a model where one flag
// answered all three questions, which is the defect this slice exists to prevent.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import { dialysisProviderPack } from '../packs/dialysis-provider/index.js';
import { payerPack } from '../packs/payer/index.js';
import type { PostgresEventStore } from '../src/server/postgres-event-store.js';
import type { CanonicalEvent } from '../src/healthcare-core/events.js';
import type { LedgerEntry } from '../src/hypergraph/ledger.js';
import type { ActorContext } from '../src/server/scoped-persistence.js';

function inMemoryStore() {
  const events: CanonicalEvent[] = [];
  const ledger: LedgerEntry[] = [];
  const audit: unknown[] = [];
  return {
    async applyMigrations() { /* noop */ },
    async appendEvent(_s: { scopeId: string; actorRef: string }, ev: CanonicalEvent) { events.push(ev); },
    async queryEvents() { return events; },
    async ledgerAppend(_s: { scopeId: string; actorRef: string }, e: LedgerEntry) { ledger.push(e); },
    async ledgerQuery() { return ledger; },
    async appendAudit(_s: { scopeId: string; actorRef: string }, row: unknown) { audit.push(row); },
    async queryAudit() { return audit; },
    async recordFhirResource() { /* noop */ },
    async listFhirResources() { return []; },
  } as unknown as PostgresEventStore;
}

const actor = {
  actorRef: 'user:test',
  scopeIds: ['scope:*'],
  clearance: 'restricted-phi',
  purposeOfUse: 'operations',
} as ActorContext;

type App = Awaited<ReturnType<typeof build>>;
async function build() {
  return buildApp({
    store: inMemoryStore(),
    telemetry: new Telemetry('test', new InMemorySink()),
    // dialysis-provider is the pack that DECLARES views, so `viewGroups` is
    // non-empty and hiding it is observable rather than vacuous.
    packs: [healthcareCorePack, dialysisProviderPack, payerPack],
    authenticate: async () => actor,
    checkHealth: async () => ({ db: true, redis: true }),
    adminApiAuth: true,
  });
}

interface ResolvedRow {
  packId: string;
  applied: boolean;
  appliedScopes: string[];
  show: boolean;
  entitled: boolean;
  primary: boolean;
  reason: string;
}
interface ContextBody {
  pack: { id: string; lens: string };
  packs: ResolvedRow[];
  viewGroups: { packId: string; label: string; primary: boolean; views: { id: string }[] }[];
}

const RENAL = 'dialysis-provider';
const PAYER = 'payer';
const CORE = 'healthcare-core';

describe('specialty bindings (G6)', () => {
  let app: App;
  let admin: string;

  beforeAll(async () => {
    app = await build();
    const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { username: 'admin', password: 'admin123' } });
    const raw = Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'].join(';') : String(res.headers['set-cookie'] ?? '');
    admin = `hh_session=${/hh_session=([^;]+)/.exec(raw)?.[1] ?? ''}`;
    expect(admin).not.toBe('hh_session=');
  });

  afterAll(async () => { await app?.close(); });

  // The workspace singleton is shared across the file, so a binding written by
  // one test would otherwise decide another's outcome.
  const clearBindings = async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/platform/specialty-bindings', headers: { cookie: admin } });
    for (const b of res.json().bindings as { id: string }[]) {
      await app.inject({ method: 'DELETE', url: `/admin/platform/specialty-bindings/${encodeURIComponent(b.id)}`, headers: { cookie: admin } });
    }
  };
  afterEach(clearBindings);

  const put = (payload: Record<string, unknown>) =>
    app.inject({ method: 'PUT', url: '/admin/platform/specialty-bindings', headers: { cookie: admin }, payload });
  const list = () =>
    app.inject({ method: 'GET', url: '/admin/platform/specialty-bindings', headers: { cookie: admin } }).then((r) => r.json());
  const context = () =>
    app.inject({ method: 'GET', url: '/api/context' }).then((r) => r.json() as ContextBody);

  it('is behind the admin guard', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/platform/specialty-bindings' });
    expect(res.statusCode).toBe(401);
  });

  it('starts empty, and resolves every installed pack to the install default', async () => {
    const body = await list();
    expect(body.bindings).toEqual([]);
    expect(body.issues).toEqual([]);
    expect(body.installed).toEqual([CORE, RENAL, PAYER]);
    for (const row of body.resolved as ResolvedRow[]) {
      expect(row.reason, row.packId).toBe('no-binding');
      expect(row.applied, row.packId).toBe(true);
      expect(row.show, row.packId).toBe(true);
      expect(row.entitled, row.packId).toBe(true);
      expect(row.appliedScopes, row.packId).toEqual(['scope:*']);
    }
  });

  it('creates a binding, keyed on scope and pack, and reads it back', async () => {
    const res = await put({ scope: 'scope:*', packId: RENAL, applied: true, show: false, entitled: true, by: 'ops' });
    expect(res.statusCode).toBe(200);
    const saved = res.json().binding;
    expect(saved.id).toBe(`scope:*::${RENAL}`);
    expect(saved.by).toBe('ops');

    const body = await list();
    expect(body.bindings).toHaveLength(1);
    expect(body.resolved.find((r: ResolvedRow) => r.packId === RENAL)).toMatchObject({
      show: false,
      applied: true,
      reason: 'binding',
    });
  });

  it('hides a specialty from the submenu without stopping it being applied', async () => {
    // The whole point of three flags. `show:false`, `applied:true` means the pack
    // keeps evaluating the population and the console stops offering its pages —
    // which is a legitimate configuration AND the one that must not be mistaken
    // for "switched off".
    await put({ scope: 'scope:*', packId: RENAL, applied: true, show: false, entitled: true });

    const ctx = await context();
    expect(ctx.viewGroups.map((g) => g.packId)).not.toContain(RENAL);
    const renal = ctx.packs.find((p) => p.packId === RENAL)!;
    expect(renal.show).toBe(false);
    expect(renal.applied).toBe(true);
    expect(renal.appliedScopes).toEqual(['scope:*']);
  });

  it('leaves a specialty it does not mention exactly as it was', async () => {
    await put({ scope: 'scope:*', packId: RENAL, applied: false, show: false, entitled: false });

    const ctx = await context();
    for (const packId of [CORE, PAYER]) {
      const row = ctx.packs.find((p) => p.packId === packId)!;
      expect(row.show, packId).toBe(true);
      expect(row.applied, packId).toBe(true);
      expect(row.reason, packId).toBe('no-binding');
    }
  });

  it('restores the submenu group when the binding is deleted, and says what deleting means', async () => {
    await put({ scope: 'scope:*', packId: RENAL, applied: true, show: false, entitled: true });
    expect((await context()).viewGroups.map((g) => g.packId)).not.toContain(RENAL);

    const del = await app.inject({
      method: 'DELETE',
      url: `/admin/platform/specialty-bindings/${encodeURIComponent(`scope:*::${RENAL}`)}`,
      headers: { cookie: admin },
    });
    expect(del.statusCode).toBe(200);
    // Deleting an override is not the same as switching a specialty off, and the
    // response says so rather than leaving the operator to infer it.
    expect(del.json().note).toMatch(/install default/i);

    const ctx = await context();
    expect(ctx.viewGroups.map((g) => g.packId)).toContain(RENAL);
    expect(ctx.packs.find((p) => p.packId === RENAL)!.reason).toBe('no-binding');
  });

  it('404s deleting a binding that is not there', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/admin/platform/specialty-bindings/nope%3A%3Anope', headers: { cookie: admin } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('binding-not-found');
  });

  it('refuses a binding naming a pack nobody installed', async () => {
    const res = await put({ scope: 'scope:*', packId: 'ghost-pack', applied: true, show: true, entitled: true });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('binding-invalid');
    expect(res.json().issues.map((i: { code: string }) => i.code)).toContain('pack-not-installed');
    // Nothing was written.
    expect((await list()).bindings).toEqual([]);
  });

  it('refuses an unusable scope, and requires both halves of the key', async () => {
    const bad = await put({ scope: 'has space', packId: RENAL, applied: true, show: true, entitled: true });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('invalid-scope');

    const missing = await put({ scope: 'scope:*' });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toBe('scope-and-pack-required');
  });

  it('updates in place rather than duplicating, and does not report itself as a duplicate', async () => {
    // The failure this guards is subtle: validating the new value against the raw
    // stored list reports the binding's OWN previous version as a duplicate of
    // itself, which refuses every edit.
    await put({ scope: 'scope:*', packId: RENAL, applied: true, show: true, entitled: true, by: 'first' });
    const second = await put({ scope: 'scope:*', packId: RENAL, applied: false, show: false, entitled: false, by: 'second' });
    expect(second.statusCode).toBe(200);
    expect(second.json().issues).toEqual([]);

    const body = await list();
    const renal = body.bindings.filter((b: { packId: string }) => b.packId === RENAL);
    expect(renal).toHaveLength(1);
    expect(renal[0].by).toBe('second');
    expect(renal[0].show).toBe(false);
  });

  it('reports a soft problem instead of refusing to record it', async () => {
    // Applied without an entitlement is the honest state during a trial. Refusing
    // to store it would push an operator to claim a licence they do not have.
    const res = await put({ scope: 'scope:*', packId: RENAL, applied: true, show: true, entitled: false });
    expect(res.statusCode).toBe(200);
    expect(res.json().issues.map((i: { code: string }) => i.code)).toContain('applied-without-entitled');
    expect(res.json().issues.every((i: { blocking: boolean }) => !i.blocking)).toBe(true);
  });

  it('applies a realm-scoped binding to a holder of that scope and not to an unscoped caller', async () => {
    // Scoping is the whole reason a binding carries a scope. A rule written for
    // one site must not silently reconfigure every other one — and the difference
    // has to be observable from the two seats, not just asserted in the resolver.
    await put({ scope: 'realm:sim:renal-a', packId: RENAL, applied: false, show: false, entitled: false });

    // The admin session holds `scope:*`, which matches every binding.
    const adminView = await list();
    expect(adminView.viewerScopeIds).toEqual(['scope:*']);
    expect(adminView.resolved.find((r: ResolvedRow) => r.packId === RENAL)).toMatchObject({ show: false, applied: false });

    // An anonymous caller — the console's pre-login context fetch — holds no
    // scopes, so a realm-scoped rule does not reach them and the install default
    // stands. A `scope:*` binding DOES reach them (asserted in the hide test
    // above): a global decision is global, a site decision needs a site.
    const ctx = await context();
    expect(ctx.packs.find((p) => p.packId === RENAL)!.reason).toBe('no-binding');
    expect(ctx.viewGroups.map((g) => g.packId)).toContain(RENAL);
  });

  it('exposes the resolved set on /api/context so a console can explain itself', async () => {
    const ctx = await context();
    expect(Array.isArray(ctx.packs)).toBe(true);
    expect(ctx.packs.map((p) => p.packId)).toEqual([CORE, RENAL, PAYER]); // installed order
    for (const row of ctx.packs) {
      expect(typeof row.applied).toBe('boolean');
      expect(typeof row.show).toBe('boolean');
      expect(typeof row.entitled).toBe('boolean');
      expect(Array.isArray(row.appliedScopes)).toBe(true);
    }
    // With nothing claiming leadership and three packs shown, no pack leads — the
    // caller falls back to the organization, and the substrate is never elected
    // just for sorting first.
    expect(ctx.packs.filter((p) => p.primary)).toEqual([]);
  });
});
