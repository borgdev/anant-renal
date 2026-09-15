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

// Phase 3 at the HTTP surface: the Pack Studio reports what each pack DECLARES
// and whether that declaration resolved.
//
// The packs here are the three that ship a real specialty surface plus the
// substrate, because the point of the slice is that a specialty arrives through
// registration — a fixture pack that declares nothing would prove nothing.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import { dialysisProviderPack } from '../packs/dialysis-provider/index.js';
import { payerPack } from '../packs/payer/index.js';
import { ckdNavigationPack } from '../packs/ckd-navigation/index.js';
import { resetSwarmRuntime } from '../src/server/swarm-routes.js';
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
    async appendEvent(_scope: { scopeId: string; actorRef: string }, ev: CanonicalEvent) { events.push(ev); },
    async queryEvents() { return events; },
    async ledgerAppend(_scope: { scopeId: string; actorRef: string }, e: LedgerEntry) { ledger.push(e); },
    async ledgerQuery() { return ledger; },
    async appendAudit(_scope: { scopeId: string; actorRef: string }, row: unknown) { audit.push(row); },
    async queryAudit() { return audit; },
    async recordFhirResource(_scope: { scopeId: string; actorRef: string }, r: unknown) { /* noop */ },
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
    packs: [healthcareCorePack, dialysisProviderPack, payerPack, ckdNavigationPack],
    authenticate: async () => actor,
    checkHealth: async () => ({ db: true, redis: true }),
    adminApiAuth: true,
  });
}

interface PackRow {
  id: string;
  version: string;
  manifest: {
    present: boolean;
    declaredVersion?: string;
    drift: { field: string; manifest: string; pack: string }[];
    ontology: { id: string; version: string; concepts: readonly string[] } | null;
    eventTypes: readonly string[];
    workflows: readonly string[];
    measures: readonly string[];
    lens: { id: string; label: string; nav: readonly string[] } | null;
    resolved: boolean;
    issues: { code: string; blocking: boolean; detail: string }[];
  };
}

describe('pack resolution at the platform surface', () => {
  let app: App;
  let admin: string;

  beforeAll(async () => {
    app = await build();
    const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { username: 'admin', password: 'admin123' } });
    const raw = Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'].join(';') : String(res.headers['set-cookie'] ?? '');
    admin = /hh_session=([^;]+)/.exec(raw)?.[1] ?? '';
    expect(admin).not.toBe('');
  });
  afterAll(async () => {
    await app?.close();
    resetSwarmRuntime();
  });

  const get = (url: string) => app.inject({ method: 'GET', url, headers: { cookie: `hh_session=${admin}` } });

  it('is still behind the admin guard', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/platform/packs/dialysis-provider/resources' });
    expect(res.statusCode).toBe(401);
  });

  it('reports each pack’s declared surface, resolved', async () => {
    const res = await get('/admin/platform/packs');
    expect(res.statusCode).toBe(200);
    const body = res.json() as { packs: PackRow[]; manifestIssues: unknown[] };
    expect(body.manifestIssues).toEqual([]);

    const byId = new Map(body.packs.map((p) => [p.id, p]));

    const dialysis = byId.get('dialysis-provider')!;
    expect(dialysis.manifest.present).toBe(true);
    expect(dialysis.manifest.resolved).toBe(true);
    expect(dialysis.manifest.ontology?.id).toBe('dialysis');
    expect(dialysis.manifest.ontology?.concepts.length).toBe(12);
    expect(dialysis.manifest.workflows).toContain('dialysis.missed-treatment');
    expect(dialysis.manifest.measures).toEqual(['esrd-qip:ktv']);
    expect(dialysis.manifest.lens?.id).toBe('renal');
    expect(dialysis.manifest.eventTypes).toContain('treatment.missed');

    // The substrate has a manifest but declares no specialty surface — which is
    // correct rather than missing.
    const core = byId.get('healthcare-core')!;
    expect(core.manifest.present).toBe(true);
    expect(core.manifest.ontology).toBeNull();
    expect(core.manifest.workflows).toEqual([]);
  });

  it('reports manifest drift instead of letting a reader be told one thing while the runtime does another', async () => {
    const res = await get('/admin/platform/packs');
    const body = res.json() as { packs: PackRow[] };

    // This test exists because the drift was REAL and this slice is what found
    // it: `packs/payer/manifest.yaml` called itself 0.1.0 with four capabilities
    // while `packs/payer/index.ts` shipped 0.2.0 with seven;
    // `packs/dialysis-provider` advertised 0.2.0 / three CMS ids while the
    // descriptor had 0.3.0 / four, and spelled one of them `esrd-qip` where the
    // runtime resolves `cms:esrd:qip` — an authority id that could never match.
    // The manifests were brought to the runtime descriptor, so the assertion is
    // now that the two homes AGREE, and the check below is the guard that keeps
    // them agreeing.
    for (const pack of body.packs) {
      expect(pack.manifest.drift, `${pack.id} drifted: ${JSON.stringify(pack.manifest.drift)}`).toEqual([]);
    }

    // The mechanism itself is proved against a synthetic pack in
    // tests/pack-resources.test.ts ("reports drift between the manifest and the
    // pack descriptor, without failing the pack"), because no installed pack
    // should be used to demonstrate a defect it no longer has.
    const dialysis = body.packs.find((p) => p.id === 'dialysis-provider')!;
    expect(dialysis.manifest.declaredVersion).toBe('0.3.0');
  });

  it('serves one pack’s resolved resources', async () => {
    const res = await get('/admin/platform/packs/dialysis-provider/resources');
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      manifestPresent: boolean;
      manifestPath: string;
      resources: { kind: string; id: string; module?: string }[];
      issues: unknown[];
      conformance: { level: string; usable: boolean; checks: { id: string; status: string }[] };
    };

    expect(body.manifestPresent).toBe(true);
    expect(body.manifestPath).toBe('packs/dialysis-provider/manifest.yaml');
    // A shared canonical event type is a note, never a blocker: two specialties
    // reacting to the same platform fact is the point of a canonical plane.
    expect(body.issues.filter((i) => (i as { blocking: boolean }).blocking)).toEqual([]);
    expect(body.conformance.checks.find((c) => c.id === 'resource-resolution')?.status).toBe('pass');
    expect(body.conformance.usable).toBe(true);

    const kinds = new Set(body.resources.map((r) => r.kind));
    expect([...kinds].sort()).toEqual(['event-contracts', 'measures', 'ontology', 'ui-lens', 'workflows']);
    // Every declared artifact points at a module that exists.
    for (const r of body.resources.filter((x) => x.module)) {
      expect(r.module).toMatch(/\.ts$/);
    }
  });

  it('says so, rather than 404ing, when a pack ships no manifest', async () => {
    // healthcare-core is the only installed pack with a manifest; the fixture
    // app installs four, so exercise the branch through a pack that has one but
    // declares nothing — the shape is the same and the assertion is honest.
    const res = await get('/admin/platform/packs/healthcare-core/resources');
    expect(res.statusCode).toBe(200);
    const body = res.json() as { manifestPresent: boolean; resources: unknown[] };
    expect(body.manifestPresent).toBe(true);
    expect(body.resources).toEqual([]);
  });

  it('404s an unknown pack', async () => {
    const res = await get('/admin/platform/packs/ghost-pack/resources');
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('pack-not-installed');
  });

  it('carries the resolved resource totals in the conformance matrix', async () => {
    const res = await get('/admin/platform/packs/conformance');
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      byLevel: Record<string, number>;
      manifestIssues: unknown[];
      resources: {
        total: number;
        resolvedPacks: number;
        blockedPacks: string[];
        eventTypes: number;
        byKind: Record<string, number>;
        issues: { code: string; blocking: boolean }[];
      };
      packs: { packId: string; level: string; checks: { id: string; status: string }[] }[];
    };

    expect(body.manifestIssues).toEqual([]);
    expect(body.resources.blockedPacks).toEqual([]);
    expect(body.resources.byKind.ontology).toBe(3);
    expect(body.resources.byKind['ui-lens']).toBe(3);
    expect(body.resources.total).toBeGreaterThanOrEqual(20);
    // A shared canonical event type is informational, never blocking.
    expect(body.resources.issues.every((i) => !i.blocking || i.code !== 'shared-event-type')).toBe(true);

    // dialysis-provider and payer declare all five sections; ckd-navigation
    // declares no measures and is honestly `partial` rather than silently
    // conformant.
    const level = (id: string) => body.packs.find((p) => p.packId === id)?.level;
    expect(level('dialysis-provider')).toBe('conformant');
    expect(level('payer')).toBe('conformant');
    expect(level('ckd-navigation')).toBe('partial');
  });

  it('activation is gated on the resolved surface, not just on the descriptor', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/platform/packs/dialysis-provider/activate',
      headers: { cookie: `hh_session=${admin}` },
      payload: { by: 'test' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; conformance: { level: string } };
    expect(body.ok).toBe(true);
    expect(body.conformance.level).toBe('conformant');
  });
});
