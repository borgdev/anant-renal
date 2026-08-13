// Round-trip tests for M19 entity compiler.

import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compileEntityPack, loadDirectory, loadStructured, loadSqlDdl, loadTabular, loadNarrative, classify } from '../src/entity-compiler/index.js';
import { validateAgentSpec } from '../src/agents/index.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `hh-ec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('M19 entity compiler', () => {
  it('loads structured YAML entities with PHI hints', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'e.yaml'), `entities:\n  - id: patient\n    name: Patient\n    kind: data\n    fields:\n      - { name: patient_id, type: string, primaryKey: true }\n      - { name: mrn, type: string, phi: true }\n`);
    const es = loadStructured(join(dir, 'e.yaml'));
    expect(es).toHaveLength(1);
    expect(es[0]!.id).toBe('patient');
    expect(es[0]!.hints.phi).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('loads SQL DDL with FKs and inline PKs', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 's.sql'), `CREATE TABLE encounter (\n  id VARCHAR(64) PRIMARY KEY,\n  patient_id VARCHAR(64) NOT NULL REFERENCES patient(id)\n);`);
    const es = loadSqlDdl(join(dir, 's.sql'));
    expect(es).toHaveLength(1);
    expect(es[0]!.name).toBe('encounter');
    expect(es[0]!.fields.find((f) => f.name === 'id')?.primaryKey).toBe(true);
    expect(es[0]!.relationships[0]?.toEntity).toBe('patient');
    rmSync(dir, { recursive: true });
  });

  it('loads CSV with data-dictionary companion', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'lab.csv'), 'lab_id,patient_id,value\nlr-1,p-1,3.2\n');
    writeFileSync(join(dir, 'lab.dict.csv'), 'name,type,pk,phi,description\nlab_id,string,true,false,ID\npatient_id,string,false,true,Patient ref\nvalue,number,false,false,\n');
    const es = loadTabular(join(dir, 'lab.csv'));
    expect(es[0]!.fields.find((f) => f.name === 'patient_id')?.phi).toBe(true);
    expect(es[0]!.confidence).toBe('high');
    rmSync(dir, { recursive: true });
  });

  it('loads markdown narrative into workflow + concept', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'p.md'), '## Admission\n\n- step 1\n- step 2\n\n## Sepsis Score\n\nA numeric severity score.\n');
    const es = loadNarrative(join(dir, 'p.md'));
    expect(es.find((e) => e.name === 'Admission')?.kind).toBe('workflow');
    expect(es.find((e) => e.name === 'Sepsis Score')?.kind).toBe('concept');
    rmSync(dir, { recursive: true });
  });

  it('classifier picks correct archetypes', () => {
    const record = classify({ id: 'x', name: 'Patient', kind: 'data', fields: [{ name: 'mrn', type: 'string', phi: true }], relationships: [], hints: { phi: true }, sourceRefs: [], confidence: 'high' });
    expect(record.archetype).toBe('record-steward');
    const catalog = classify({ id: 'x', name: 'Formulary', kind: 'data', fields: [{ name: 'code', type: 'string' }], relationships: [], hints: {}, sourceRefs: [], confidence: 'high' });
    expect(catalog.archetype).toBe('catalog-manager');
    const proc = classify({ id: 'x', name: 'Admission', kind: 'workflow', fields: [], relationships: [], workflow: [{ id: 's1', name: 'a' }, { id: 's2', name: 'b' }], hints: {}, sourceRefs: [], confidence: 'medium' });
    expect(proc.archetype).toBe('procedure-runner');
    const rej = classify({ id: 'x', name: 'Vague', kind: 'concept', fields: [], relationships: [], hints: {}, sourceRefs: [], confidence: 'low' });
    expect(rej.shouldEmit).toBe(false);
  });

  it('end-to-end: mixed-sample compiles to valid AgentSpecs (dry-run)', async () => {
    const { report, agents } = await compileEntityPack({
      inputPath: './examples/entity-packs/mixed-sample',
      packId: 'test-mixed-sample',
      ownerOrg: 'test-org',
      dryRun: true,
    });
    expect(report.entitiesLoaded).toBeGreaterThanOrEqual(6);
    expect(report.agentsGenerated).toBeGreaterThanOrEqual(10);
    // Every generated spec must round-trip validate
    for (const a of agents) expect(() => validateAgentSpec(a)).not.toThrow();
    // Emitted archetypes must be sensible
    const emitted = report.perEntity.map((p) => p.archetype);
    expect(emitted).toContain('record-steward');
    expect(emitted).toContain('catalog-manager');
    expect(emitted).toContain('procedure-runner');
  });

  it('writes pack when not dry-run', async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'e.yaml'), `entities:\n  - id: order\n    name: Order\n    kind: data\n    fields:\n      - { name: order_id, type: string, primaryKey: true }\n      - { name: mrn, type: string, phi: true }\n`);
    const outRoot = makeTmpDir();
    const { report } = await compileEntityPack({
      inputPath: dir, packId: 'ephem-pack', ownerOrg: 'test', outRoot, dryRun: false,
    });
    expect(report.agentsGenerated).toBeGreaterThan(0);
    expect(existsSync(join(outRoot, 'ephem-pack', 'manifest.yaml'))).toBe(true);
    expect(existsSync(join(outRoot, 'ephem-pack', 'agents', 'order-intake.yaml'))).toBe(true);
    rmSync(dir, { recursive: true });
    rmSync(outRoot, { recursive: true });
  });

  it('hybrid policy: rejects entities with no fields or steps', async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'e.yaml'), `entities:\n  - id: vague\n    name: Vague\n    kind: concept\n`);
    const { report } = await compileEntityPack({ inputPath: dir, packId: 'x', ownerOrg: 'x', dryRun: true });
    expect(report.rejected.some((r) => r.entityId === 'vague')).toBe(true);
    rmSync(dir, { recursive: true });
  });
});
