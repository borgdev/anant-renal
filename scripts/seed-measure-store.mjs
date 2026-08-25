#!/usr/bin/env node

/******************************************************************************
 *
 * Copyright (c) 2026 AnantHQ Inc.
 * All Rights Reserved.
 *
 * This software is licensed, not sold.
 *
 * The contents of this file constitute confidential and proprietary
 * information belonging exclusively to Unison Software Technologies Pvt. Ltd.
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

// Seed the dev measure store (.harness/measures) with the local m21 fixture so the
// CQL score endpoint (/admin/liquid/score) returns REAL results in dev — no network,
// no VSAC, no GitHub. Mirrors exactly what tests/liquid-cql.test.ts evaluates.
//
//   node scripts/seed-measure-store.mjs [--store <dir>]
//   npm run measures:seed
//
// The loader (src/measures/store-loader.ts) expects:
//   root/<slug>/manifest.json
//   root/<slug>/measure/<file>.json      (raw FHIR-ish Measure JSON)
//   root/<slug>/library/<file>.json      (raw Library JSON with base64 content[])

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const root = arg('store') ?? join(process.cwd(), '.harness', 'measures');
const fixtureDir = join(process.cwd(), 'tests', 'fixtures', 'm21');
const elm = JSON.parse(readFileSync(join(fixtureDir, 'm21-basic-library.elm.json'), 'utf8'));
const slug = 'm21-local';
const now = new Date().toISOString();
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');

const measure = {
  resourceType: 'Measure',
  id: 'M21Basic', name: 'M21Basic', title: 'M21 Basic Blood Pressure Screen', version: '1.0.0',
  status: 'active', effectivePeriod: { start: '2025-01-01', end: '2025-12-31' },
  library: ['urn:test:M21Basic'],
  // Populations are read from `raw.group` by the MeasureEvaluator (cql-execution).
  group: [{
    population: [
      { code: { coding: [{ code: 'initial-population' }] }, criteria: { expression: 'Initial Population' } },
      { code: { coding: [{ code: 'denominator' }] }, criteria: { expression: 'Denominator' } },
      { code: { coding: [{ code: 'denominator-exclusion' }] }, criteria: { expression: 'Denominator Exclusions' } },
      { code: { coding: [{ code: 'numerator' }] }, criteria: { expression: 'Numerator' } },
    ],
  }],
};
const library = {
  id: 'M21Basic/1.0.0', name: 'M21Basic', version: '1.0.0', url: 'urn:test:M21Basic',
  content: [{ contentType: 'application/elm+json', data: b64(elm) }],
};
const manifest = {
  repo: 'test-fixture/m21', branch: 'main', commitSha: 'local', syncedAt: now,
  measures: [{ id: 'ecqm:M21Basic/1.0.0', cmsId: 'M21-BASIC', version: '1.0.0', blobSha: 'local', contentHash: 'local', path: 'measure/m21-basic.json' }],
  libraries: [{ id: 'M21Basic/1.0.0', name: 'M21Basic', version: '1.0.0', blobSha: 'local', contentHash: 'local', path: 'library/m21-basic.json' }],
};

const dir = join(root, slug);
mkdirSync(join(dir, 'measure'), { recursive: true });
mkdirSync(join(dir, 'library'), { recursive: true });
writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
writeFileSync(join(dir, 'measure', 'm21-basic.json'), JSON.stringify(measure, null, 2));
writeFileSync(join(dir, 'library', 'm21-basic.json'), JSON.stringify(library, null, 2));

console.log(JSON.stringify({ ok: true, root: dir, measureId: 'ecqm:M21Basic/1.0.0', measureCount: 1, libraryCount: 1 }, null, 2));
