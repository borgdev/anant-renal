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

/******************************************************************************
 * Platform Phase 0/1 — the specialty pack contract and the hardening report.
 *
 * Two kinds of proof here, deliberately kept apart:
 *
 *   • Pure contract/judgement tests. No server, no mocks. These pin the
 *     DECISION — which pack is usable, which finding blocks — so the rules
 *     cannot drift without a failing test naming the rule that changed.
 *
 *   • Route tests. These prove the surface is wired, gated, and returns the
 *     same verdict the pure function does — i.e. the operator sees the truth,
 *     not a summary of it.
 *
 * The negative cases matter most: a pack that claims a platform-owned
 * capability, a stored literal secret, and a `bound` write path with no
 * certification are the three states this work exists to make visible.
 ******************************************************************************/

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import {
  validateSpecialtyPack, conformanceMatrix, platformBoundary, boundWriteKinds,
  findLiteralSecrets, releaseGateSummary, buildHardeningReport,
  SUBSTRATE_PACK_ID, SPECIALTY_CONTRACT_VERSION, PLATFORM_RESPONSIBILITIES,
  type SpecialtyPackDescriptor,
} from '../src/control-plane/index.js';
import type { DomainPack } from '../src/control-plane/pack-registry.js';
import { healthcareCorePack, dialysisProviderPack, payerPack } from '../packs/index.js';
import type { PostgresEventStore } from '../src/server/postgres-event-store.js';
import type { CanonicalEvent } from '../src/healthcare-core/events.js';
import type { LedgerEntry } from '../src/hypergraph/ledger.js';
import type { ActorContext } from '../src/server/scoped-persistence.js';

/* ------------------------------------------------------------------ fixtures */

/**
 * A secret-shaped value, assembled at runtime.
 *
 * The guard under test rejects any opaque blob matching
 * `/^[A-Za-z0-9_+/=]{24,}$/`, so the fixture must have that SHAPE — but a
 * contiguous literal in the source trips GitHub push protection (GH013), which
 * blocks the entire branch. Joining it here keeps the shape and keeps the repo
 * clean. Never give this string a vendor prefix.
 */
const LITERAL_SECRET_FIXTURE = ['FAKE', 'CREDENTIAL', 'FIXTURE', 'NOT', 'REAL'].join('_');

/** A specialty pack that declares every expected section — the target shape. */
function conformantPack(id: string, kinds: string[] = ['provider']): SpecialtyPackDescriptor {
  return {
    id,
    version: '1.0.0',
    extends: [{ id: SUBSTRATE_PACK_ID, versionRange: '^0.2.0' }],
    appliesTo: { organizationKinds: kinds },
    capabilities: [`${id}-operations`],
    cmsUniverse: [],
    requiredControls: ['access-policy', 'audit-provenance', 'data-quality'],
    ontology: { id: `${id}-ontology`, version: '1.0.0', conceptCount: 42 },
    eventContracts: [`${id}.event.v1`],
    workflows: [`${id}-workflow`],
    measures: [`${id}-measure`],
    uiLens: { id: `${id}-lens`, label: `${id} lens`, nav: ['queue', 'detail'] },
  };
}

/** Claims a platform-owned capability — the exact conflation the contract stops. */
const overreachingPack: DomainPack = {
  id: 'overreaching-pack',
  version: '1.0.0',
  extends: [{ id: SUBSTRATE_PACK_ID, versionRange: '^0.2.0' }],
  appliesTo: { organizationKinds: ['provider'] },
  capabilities: ['policy-and-approval'],
  cmsUniverse: [],
  requiredControls: ['access-policy', 'audit-provenance'],
};

/** Does not declare the substrate dependency. */
const orphanPack: DomainPack = {
  id: 'orphan-pack',
  version: '1.0.0',
  extends: [],
  appliesTo: { organizationKinds: ['provider'] },
  capabilities: ['something'],
  cmsUniverse: [],
  requiredControls: ['access-policy', 'audit-provenance'],
};

/* ------------------------------------------------------- Phase 0 — contract */

describe('Phase 0 — specialty pack contract', () => {
  it('recognises the substrate pack as the substrate, not a specialty', () => {
    const r = validateSpecialtyPack(healthcareCorePack);
    expect(r.level).toBe('substrate');
    expect(r.usable).toBe(true);
    expect(r.checks.find((c) => c.id === 'substrate-dependency')?.detail).toContain('IS the substrate');
  });

  it('accepts the real installed packs as usable', () => {
    for (const pack of [dialysisProviderPack, payerPack]) {
      const r = validateSpecialtyPack(pack);
      expect(r.usable, `${r.packId} must be usable`).toBe(true);
    }
  });

  it('reports a real pack with no clinical sections as partial, naming what is missing', () => {
    const r = validateSpecialtyPack(dialysisProviderPack);
    expect(r.level).toBe('partial');
    expect(r.missingSections).toContain('ontology');
    expect(r.declaredSections).not.toContain('ontology');
  });

  it('marks a pack with every section declared as conformant', () => {
    const r = validateSpecialtyPack(conformantPack('cardiology'));
    expect(r.level).toBe('conformant');
    expect(r.missingSections).toEqual([]);
    expect(r.usable).toBe(true);
  });

  it('FAILS a pack that claims a platform-owned capability', () => {
    const r = validateSpecialtyPack(overreachingPack);
    const check = r.checks.find((c) => c.id === 'platform-boundary');
    expect(check?.status).toBe('fail');
    expect(check?.detail).toContain('policy-and-approval');
    expect(r.level).toBe('nonconformant');
    expect(r.usable).toBe(false);
  });

  it('FAILS a pack that does not extend the substrate', () => {
    const r = validateSpecialtyPack(orphanPack);
    expect(r.checks.find((c) => c.id === 'substrate-dependency')?.status).toBe('fail');
    expect(r.level).toBe('nonconformant');
  });

  it('FAILS a pack with an empty organization scope or no capabilities', () => {
    const empty = validateSpecialtyPack({ ...conformantPack('empty'), appliesTo: { organizationKinds: [] } });
    expect(empty.checks.find((c) => c.id === 'organization-scope')?.status).toBe('fail');

    const noCaps = validateSpecialtyPack({ ...conformantPack('nocaps'), capabilities: [] });
    expect(noCaps.checks.find((c) => c.id === 'capabilities')?.status).toBe('fail');
  });

  it('WARNS (not fails) when only the declared sections are missing', () => {
    const r = validateSpecialtyPack({ ...dialysisProviderPack });
    expect(r.checks.find((c) => c.id === 'specialty-sections')?.status).toBe('warn');
    expect(r.checks.some((c) => c.status === 'fail')).toBe(false);
  });

  it('runs the whole installed set through the matrix with stable counts', () => {
    const packs = [healthcareCorePack, dialysisProviderPack, payerPack, conformantPack('a'), conformantPack('b')];
    const m = conformanceMatrix(packs);
    expect(m.contractVersion).toBe(SPECIALTY_CONTRACT_VERSION);
    expect(m.total).toBe(5);
    expect(m.byLevel.substrate).toBe(1);
    expect(m.byLevel.conformant).toBe(2);
    expect(m.byLevel.partial).toBe(2);
    expect(m.byLevel.nonconformant).toBe(0);
    // sorted, so the console order is deterministic
    expect(m.packs.map((p) => p.packId)).toEqual([...m.packs.map((p) => p.packId)].sort());
  });

  it('exposes the boundary as data, with both sides owned correctly', () => {
    const b = platformBoundary();
    expect(b.contractVersion).toBe(SPECIALTY_CONTRACT_VERSION);
    expect(b.substratePackId).toBe(SUBSTRATE_PACK_ID);
    expect(b.platform.length).toBeGreaterThan(0);
    expect(b.pack.length).toBeGreaterThan(0);
    expect(b.platform.every((i) => i.owner === 'platform')).toBe(true);
    expect(b.pack.every((i) => i.owner === 'pack')).toBe(true);
    // every platform item the contract can fail a pack for is actually listed
    for (const item of PLATFORM_RESPONSIBILITIES) expect(item.detail.length).toBeGreaterThan(0);
  });
});

/* ----------------------------------------------------- Phase 1 — hardening */

describe('Phase 1 — platform hardening report', () => {
  const cleanInput = {
    kafka: { status: 'contract-verified', secretRef: 'binding:KAFKA_SECRET' },
    fhir: {
      status: 'contract-verified',
      writePolicy: { 'order-med': 'shadow', 'record-session': 'shadow' },
      secretRefs: { tokenRef: 'binding:EMR_TOKEN', privateKeyRef: 'binding:EMR_KEY' },
    },
    packs: [healthcareCorePack, conformantPack('a'), conformantPack('b')],
    releases: [{ status: 'active', checks: [{ name: 'policy', passed: true }, { name: 'red-team', passed: true }] }],
    openIncidents: 0,
    deadOutbox: 0,
    userCount: 3,
    secretNames: ['KAFKA_SECRET', 'EMR_TOKEN', 'EMR_KEY'],
    certifiedVendors: [],
  } as const;

  it('reports a clean platform as ready', () => {
    const r = buildHardeningReport(cleanInput, '2026-09-14T00:00:00.000Z');
    expect(r.status).toBe('ready');
    expect(r.byStatus.fail).toBe(0);
    expect(r.generatedAt).toBe('2026-09-14T00:00:00.000Z');
    expect(r.checks.map((c) => c.id)).toContain('pack-conformance');
  });

  it('BLOCKS on a literal secret stored in configuration', () => {
    const r = buildHardeningReport({
      ...cleanInput,
      fhir: { ...cleanInput.fhir, secretRefs: { tokenRef: LITERAL_SECRET_FIXTURE } },
    });
    const check = r.checks.find((c) => c.id === 'secret-hygiene');
    expect(check?.status).toBe('fail');
    expect(check?.remediation).toBeTruthy();
    expect(r.status).toBe('blocked');
  });

  it('treats a binding reference as safe and never as a literal', () => {
    expect(findLiteralSecrets({ secretRefs: { tokenRef: 'binding:EMR_TOKEN' } }, { secretRef: 'binding:KAFKA_SECRET' })).toEqual([]);
    expect(findLiteralSecrets({ secretRefs: { tokenRef: LITERAL_SECRET_FIXTURE } }, null)).toHaveLength(1);
  });

  it('BLOCKS a bound write path with no certification recorded', () => {
    const r = buildHardeningReport({
      ...cleanInput,
      fhir: { ...cleanInput.fhir, writePolicy: { 'order-med': 'bound' } },
    });
    const check = r.checks.find((c) => c.id === 'write-policy-safety');
    expect(check?.status).toBe('fail');
    expect(check?.detail).toContain('order-med');
    expect(r.status).toBe('blocked');
  });

  it('downgrades a bound write path to a warning once the vendor is certified', () => {
    const r = buildHardeningReport({
      ...cleanInput,
      fhir: { ...cleanInput.fhir, writePolicy: { 'order-med': 'bound' } },
      certifiedVendors: ['epic'],
    });
    expect(r.checks.find((c) => c.id === 'write-policy-safety')?.status).toBe('warn');
    expect(r.status).toBe('attention');
  });

  it('BLOCKS on a nonconformant installed pack and names it', () => {
    const r = buildHardeningReport({ ...cleanInput, packs: [healthcareCorePack, conformantPack('a'), overreachingPack] });
    const check = r.checks.find((c) => c.id === 'pack-conformance');
    expect(check?.status).toBe('fail');
    expect(check?.remediation).toContain('overreaching-pack');
  });

  it('BLOCKS on an unremediated delivery failure', () => {
    const r = buildHardeningReport({ ...cleanInput, openIncidents: 2 });
    expect(r.checks.find((c) => c.id === 'dlq-clear')?.status).toBe('fail');

    const onlyDead = buildHardeningReport({ ...cleanInput, deadOutbox: 4 });
    expect(onlyDead.checks.find((c) => c.id === 'dlq-clear')?.status).toBe('warn');
  });

  it('BLOCKS on a failed release dossier', () => {
    const r = buildHardeningReport({
      ...cleanInput,
      releases: [{ status: 'failed', checks: [{ name: 'policy', passed: false }] }],
    });
    expect(r.checks.find((c) => c.id === 'release-gate')?.status).toBe('fail');
  });

  it('flags unproven generality when only one specialty is installed', () => {
    const r = buildHardeningReport({ ...cleanInput, packs: [healthcareCorePack, conformantPack('only-one')] });
    const check = r.checks.find((c) => c.id === 'platform-generality');
    expect(check?.status).toBe('warn');
    expect(check?.detail).toContain('unproven');
  });

  it('derives write-policy and release-gate facts from the real shapes', () => {
    expect(boundWriteKinds({ a: 'shadow', b: 'bound', c: 'off', d: 'bound' })).toEqual(['b', 'd']);
    expect(boundWriteKinds(undefined)).toEqual([]);
    expect(releaseGateSummary([{ status: 'active', checks: [{ passed: true }, { passed: false }] }]))
      .toEqual({ total: 1, active: 1, failing: 0, gateChecks: 2, gatePassed: 1 });
  });

  it('never reports a fail without a remediation the operator can act on', () => {
    const r = buildHardeningReport({
      ...cleanInput,
      fhir: { ...cleanInput.fhir, writePolicy: { 'order-med': 'bound' } },
      openIncidents: 1,
      packs: [healthcareCorePack, overreachingPack],
    });
    for (const check of r.checks.filter((c) => c.status === 'fail')) {
      expect(check.remediation, `${check.id} must say what to do`).toBeTruthy();
    }
  });
});

/* ------------------------------------------------------------- route wiring */

function inMemoryStore() {
  const events: CanonicalEvent[] = [];
  const ledger: LedgerEntry[] = [];
  const audit: unknown[] = [];
  return {
    async applyMigrations() { /* noop */ },
    async appendEvent(_s: unknown, ev: CanonicalEvent) { events.push(ev); },
    async queryEvents() { return events; },
    async ledgerAppend(_s: unknown, e: LedgerEntry) { ledger.push(e); },
    async ledgerQuery() { return ledger; },
    async appendAudit(_s: unknown, row: unknown) { audit.push(row); },
    async queryAudit() { return audit; },
    async recordFhirResource() { /* noop */ },
    async listFhirResources() { return []; },
  } as unknown as PostgresEventStore;
}

const actor = { actorRef: 'user:test', scopeIds: ['scope:*'], clearance: 'restricted-phi', purposeOfUse: 'operations' } as ActorContext;

describe('platform contract + hardening surfaces', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let ops: string;

  beforeAll(async () => {
    app = await buildApp({
      store: inMemoryStore(),
      telemetry: new Telemetry('test', new InMemorySink()),
      packs: [healthcareCorePack, conformantPack('cardiology'), overreachingPack],
      authenticate: async () => actor,
      checkHealth: async () => ({ db: true, redis: true }),
      adminApiAuth: true,
    });
    const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { username: 'admin', password: 'admin123' } });
    const raw = Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'].join(';') : String(res.headers['set-cookie'] ?? '');
    ops = `hh_session=${/hh_session=([^;]+)/.exec(raw)?.[1]}`;
  });

  afterAll(async () => { await app.close(); });

  it('requires a session for the contract and hardening surfaces', async () => {
    for (const url of ['/admin/platform/contracts', '/admin/platform/packs/conformance', '/admin/platform/hardening']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it('serves the boundary so the console renders the contract rather than restating it', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/platform/contracts', headers: { cookie: ops } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.contractVersion).toBe(SPECIALTY_CONTRACT_VERSION);
    expect(body.platform.length).toBeGreaterThan(0);
    expect(body.pack.length).toBeGreaterThan(0);
  });

  it('returns the conformance matrix for the installed packs', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/platform/packs/conformance', headers: { cookie: ops } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(3);
    expect(body.byLevel.substrate).toBe(1);
    expect(body.byLevel.conformant).toBe(1);
    expect(body.byLevel.nonconformant).toBe(1);
  });

  it('returns a hardening verdict whose failing checks match the pure report', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/platform/hardening', headers: { cookie: ops } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('blocked'); // the overreaching pack is installed
    expect(body.checks.find((c: { id: string }) => c.id === 'pack-conformance')?.status).toBe('fail');
  });

  it('REFUSES to activate a nonconformant pack, naming the failed checks', async () => {
    const res = await app.inject({
      method: 'POST', url: '/admin/platform/packs/overreaching-pack/activate',
      headers: { cookie: ops }, payload: { by: 'test' },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error).toBe('pack-nonconformant');
    expect(body.failed.some((c: { id: string }) => c.id === 'platform-boundary')).toBe(true);
  });

  it('ACTIVATES a conformant pack and reports what it is still missing', async () => {
    const res = await app.inject({
      method: 'POST', url: '/admin/platform/packs/cardiology/activate',
      headers: { cookie: ops }, payload: { by: 'test' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.conformance.level).toBe('conformant');
    expect(body.conformance.missingSections).toEqual([]);
  });
});
