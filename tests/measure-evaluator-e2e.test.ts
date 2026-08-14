// M21a-c: End-to-end CQL evaluator test on a real FHIR bundle.
// Uses a hand-authored ELM JSON library (dependency-free, no VSAC needed)
// so the whole pipeline — cql-execution + cql-exec-fhir + our Repository +
// our CodeService + our population interpretation — is exercised end-to-end.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeasureEvaluator } from '../src/measures/evaluator.js';
import { ValueSetRegistry } from '../src/measures/value-set-registry.js';
import type { StoredLibrary, StoredMeasure } from '../src/measures/types.js';

const FIXTURES = join(process.cwd(), 'tests/fixtures/m21');

function loadLibrary(): StoredLibrary {
  const elm = JSON.parse(readFileSync(join(FIXTURES, 'm21-basic-library.elm.json'), 'utf8'));
  return {
    id: 'M21Basic/1.0.0',
    name: 'M21Basic',
    version: '1.0.0',
    url: 'urn:test:M21Basic',
    content: { elmJson: elm },
    valueSetRefs: [],
    codeSystemRefs: ['http://snomed.info/sct'],
    upstream: {
      repo: 'test-fixture/m21', path: 'm21-basic-library.elm.json',
      blobSha: 'blob-fixture', commitSha: 'commit-fixture',
      rawUrl: 'file://' + join(FIXTURES, 'm21-basic-library.elm.json'),
      fetchedAt: new Date().toISOString(), contentHash: 'test-fixture-hash',
    },
  };
}

function loadMeasure(): StoredMeasure {
  return {
    id: 'ecqm:M21Basic/1.0.0',
    cmsId: 'M21-BASIC',
    name: 'M21Basic',
    title: 'M21 Basic Blood Pressure Screen',
    version: '1.0.0',
    status: 'active',
    effectivePeriod: { start: '2025-01-01', end: '2025-12-31' },
    libraryRefs: ['urn:test:M21Basic'],
    raw: {
      resourceType: 'Measure',
      group: [{
        population: [
          { code: { coding: [{ code: 'initial-population' }] }, criteria: { expression: 'Initial Population' } },
          { code: { coding: [{ code: 'denominator' }] }, criteria: { expression: 'Denominator' } },
          { code: { coding: [{ code: 'denominator-exclusion' }] }, criteria: { expression: 'Denominator Exclusions' } },
          { code: { coding: [{ code: 'numerator' }] }, criteria: { expression: 'Numerator' } },
        ],
      }],
    },
    upstream: {
      repo: 'test-fixture/m21', path: 'measure.json',
      blobSha: 'blob-fixture', commitSha: 'commit-fixture',
      rawUrl: 'file://' + FIXTURES, fetchedAt: new Date().toISOString(), contentHash: 'measure-fixture',
    },
  };
}

let evaluator: MeasureEvaluator;

beforeAll(() => {
  const measure = loadMeasure();
  const library = loadLibrary();
  const vsr = new ValueSetRegistry(mkdtempSync(join(tmpdir(), 'hh-vsr-')));
  evaluator = new MeasureEvaluator({ measures: [measure], libraries: [library], valueSetRegistry: vsr });
});

describe('M21 measure evaluator end-to-end', () => {
  it('lists the seeded measure', () => {
    expect(evaluator.listMeasures()).toHaveLength(1);
    expect(evaluator.getMeasure('ecqm:M21Basic/1.0.0')).toBeTruthy();
    expect(evaluator.getMeasure('M21-BASIC')).toBeTruthy();
  });

  it('places a patient with resolved hypertension into the numerator', async () => {
    const bundle = JSON.parse(readFileSync(join(FIXTURES, 'bundle-in-numerator.json'), 'utf8'));
    const result = await evaluator.evaluate({ measureId: 'ecqm:M21Basic/1.0.0', bundle });
    expect(result.patients).toHaveLength(1);
    const patient = result.patients[0]!;
    expect(patient.patientId).toBe('pt-num');
    const byCode = Object.fromEntries(patient.populations.map(p => [p.code, p.member]));
    expect(byCode['initial-population']).toBe(true);
    expect(byCode['denominator']).toBe(true);
    expect(byCode['denominator-exclusion']).toBe(false);
    expect(byCode['numerator']).toBe(true);
    expect(patient.met).toBe(true);
  });

  it('marks a hypertensive pregnant patient as denominator-excluded (met=null)', async () => {
    const bundle = JSON.parse(readFileSync(join(FIXTURES, 'bundle-in-denominator-excluded.json'), 'utf8'));
    const result = await evaluator.evaluate({ measureId: 'ecqm:M21Basic/1.0.0', bundle });
    expect(result.patients).toHaveLength(1);
    const patient = result.patients[0]!;
    expect(patient.patientId).toBe('pt-excl');
    const byCode = Object.fromEntries(patient.populations.map(p => [p.code, p.member]));
    expect(byCode['initial-population']).toBe(true);
    expect(byCode['denominator']).toBe(true);
    expect(byCode['denominator-exclusion']).toBe(true);
    expect(byCode['numerator']).toBe(false); // condition not resolved
    // Pregnant patient falls out of denominator via exclusion => met === null
    expect(patient.met).toBeNull();
  });

  it('returns provenance metadata on the result', async () => {
    const bundle = JSON.parse(readFileSync(join(FIXTURES, 'bundle-in-numerator.json'), 'utf8'));
    const result = await evaluator.evaluate({ measureId: 'ecqm:M21Basic/1.0.0', bundle });
    expect(result.provenance.measure.repo).toBe('test-fixture/m21');
    expect(result.provenance.libraries).toHaveLength(1);
    expect(result.provenance.libraries[0]!.contentHash).toBe('test-fixture-hash');
    expect(result.evaluatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
