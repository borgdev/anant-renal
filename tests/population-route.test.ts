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

// S3 — creating a realm from a generated population over HTTP.
//
// The assertion that matters most here is the FAILURE one. A population-born realm whose
// artifact is missing must not be left registered: an empty realm looks like a healthy
// world with no patients, so every cohort, denominator and protocol gate would read zero
// with nothing to say the population was absent rather than empty. The route removes the
// realm and returns 422 instead.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/server/app.js';
import { RealmRegistry } from '../src/realm/index.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import { configHashOf, POPULATION_MANIFEST_VERSION, writeManifest } from '../src/population/synthea/manifest.js';
import type { PopulationManifest } from '../src/population/synthea/manifest.js';

const REALM = 'realm:pop-route';

const roots: string[] = [];

afterEach(() => {
  RealmRegistry.remove(REALM);
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

type Obj = Record<string, unknown>;

const labObs = (id: string, subject: string, code: string, value: number, at: string): Obj => ({
  resourceType: 'Observation', id, subject: { reference: `Patient/${subject}` }, status: 'final',
  category: [{ coding: [{ code: 'laboratory' }] }], code: { coding: [{ code }] }, effectiveDateTime: at, valueQuantity: { value },
});

function bundles(): Obj[] {
  return [
    {
      resourceType: 'Bundle', type: 'collection',
      entry: [
        { resource: { resourceType: 'Patient', id: 'syn-a', gender: 'female', birthDate: '1958-04-11' } },
        { resource: { resourceType: 'Condition', id: 'c-a', subject: { reference: 'Patient/syn-a' }, code: { coding: [{ display: 'End-stage renal disease (disorder)' }] } } },
        { resource: labObs('l-a', 'syn-a', '718-7', 8.5, '2026-05-20T09:00:00Z') },
      ],
    },
    {
      resourceType: 'Bundle', type: 'collection',
      entry: [
        { resource: { resourceType: 'Patient', id: 'syn-b', gender: 'male', birthDate: '1971-09-30' } },
        { resource: { resourceType: 'Condition', id: 'c-b', subject: { reference: 'Patient/syn-b' }, code: { coding: [{ display: 'Diabetes mellitus type 2 (disorder)' }] } } },
        { resource: labObs('l-b', 'syn-b', '718-7', 11.2, '2026-05-18T09:00:00Z') },
      ],
    },
  ];
}

/** Write a population artifact for `realmId` and return the root. */
function writePopulation(realmId: string = REALM, files: Obj[] = bundles()): string {
  const root = mkdtempSync(join(tmpdir(), 'hh-pop-route-'));
  roots.push(root);
  const fhir = join(root, realmId, 'fhir');
  mkdirSync(fhir, { recursive: true });
  const config = { generatorVersion: 'synthea-7-test', population: files.length, seed: 424242, referenceDate: '20260601' };
  const manifest: PopulationManifest = {
    manifestVersion: POPULATION_MANIFEST_VERSION, realmId, generator: 'synthea-reference', config,
    configHash: configHashOf(config), outputDigest: 'd', patientDigest: 'd', patientCount: files.length,
    nonReproducible: [], generatedAt: '2026-06-01T00:00:00.000Z', fileCount: files.length, argv: [],
    records: { total: files.length, alive: files.length, dead: 0 },
  };
  writeManifest(root, manifest);
  files.forEach((b, i) => writeFileSync(join(fhir, `patient-${i}.json`), JSON.stringify(b), 'utf8'));
  return root;
}

function makeApp() {
  return buildApp({
    store: {
      applyMigrations: async () => undefined,
      appendEvent: async () => undefined,
      queryEvents: async () => [],
      appendLedger: async () => undefined,
      queryLedger: async () => [],
      appendAudit: async () => undefined,
      withTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn({}),
      saveFhirResource: async () => undefined,
    } as never,
    telemetry: new Telemetry('test', new InMemorySink()),
    packs: [healthcareCorePack],
    authenticate: async () => ({ actorRef: 'user:test', scopeIds: ['scope:*'], purposeOfUse: 'operations', clearance: 'phi' }),
    checkHealth: async () => ({ db: true, redis: true }),
  });
}

const FACILITY = { facilityId: 'fac-pop', facilityKind: 'dialysis' as const, facilityName: 'Population Clinic', units: ['A', 'B'] };

describe('POST /admin/realms from a generated population (S3)', () => {
  it('creates the realm, seeds it, and reports what it did', async () => {
    const app = await makeApp();
    try {
      const root = writePopulation();
      const res = await app.inject({
        method: 'POST',
        url: '/admin/realms',
        payload: { id: REALM, mode: 'sim', trajectoryEngine: 'liquid', population: { ...FACILITY, root } },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as { id: string; population: { guard: { verdict: string }; patients: { seeded: number }; prime: { seeded: number; engine: string } } };
      expect(body.id).toBe(REALM);
      expect(body.population.guard.verdict).toBe('fresh');
      expect(body.population.patients.seeded).toBe(2);
      expect(body.population.prime.engine).toBe('liquid');
      expect(body.population.prime.seeded).toBe(2);

      const realm = RealmRegistry.get(REALM)!;
      const patients = realm.graph.listKind('patient');
      expect(patients.map((p) => p.id).sort()).toEqual(['realm-pop-route-pt-0001', 'realm-pop-route-pt-0002']);
      const a = patients.find((p) => p.id === 'realm-pop-route-pt-0001')!.state as Obj;
      expect(a['problemList']).toEqual(['ESRD']);
      expect(a['labs']).toMatchObject({ HGB: 8.5 });
      expect(a['unitId']).toBe('fac-pop-A');
      expect(a['admitted']).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('returns 422 and REMOVES the realm when the artifact is incomplete', async () => {
    // A second, distinct failure path: the manifest exists but the FHIR output it
    // describes does not. `partial-population` is NOT reachable over HTTP, because the
    // route creates the realm immediately before seeding it — that guard is only
    // reachable by seeding a realm that already holds some of the population, and it is
    // covered directly in `tests/population-seed.test.ts`.
    const app = await makeApp();
    try {
      const root = writePopulation();
      rmSync(join(root, REALM, 'fhir'), { recursive: true, force: true });
      const res = await app.inject({
        method: 'POST',
        url: '/admin/realms',
        payload: { id: REALM, mode: 'sim', population: { ...FACILITY, root } },
      });
      expect(res.statusCode).toBe(422);
      expect((res.json() as { error: string }).error).toMatch(/population-incomplete/);
      expect(RealmRegistry.get(REALM)).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('returns 422 and REMOVES the realm when the population is missing', async () => {
    const app = await makeApp();
    try {
      const empty = mkdtempSync(join(tmpdir(), 'hh-pop-empty-'));
      roots.push(empty);
      const res = await app.inject({
        method: 'POST',
        url: '/admin/realms',
        payload: { id: REALM, mode: 'sim', population: { ...FACILITY, root: empty } },
      });

      expect(res.statusCode).toBe(422);
      expect((res.json() as { error: string }).error).toMatch(/population-not-found/);
      // The decisive assertion.
      expect(RealmRegistry.get(REALM)).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('returns 400 when both patient sources are supplied', async () => {
    const app = await makeApp();
    try {
      const root = writePopulation();
      const res = await app.inject({
        method: 'POST',
        url: '/admin/realms',
        payload: {
          id: REALM, mode: 'sim',
          seed: { facilityId: 'fac-s', kind: 'dialysis', name: 'Static', units: ['A'], patientCount: 4 },
          population: { ...FACILITY, root },
        },
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toBe('seed-and-population-are-mutually-exclusive');
      expect(RealmRegistry.get(REALM)).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('still creates a realm from the static seed when no population is given', async () => {
    // The population source is additive; the established path must not move.
    const app = await makeApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/realms',
        payload: { id: REALM, mode: 'sim', seed: { facilityId: 'fac-s', kind: 'dialysis', name: 'Static', units: ['A'], patientCount: 4 } },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { population?: unknown }).population).toBeUndefined();
      expect(RealmRegistry.get(REALM)!.graph.listKind('patient')).toHaveLength(4);
    } finally {
      await app.close();
    }
  });
});
