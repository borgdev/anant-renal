// XLSX loader + end-to-end compile from a real .xlsx fixture.
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { loadXlsx } from '../src/entity-compiler/loaders.js';
import { compileEntityPack } from '../src/entity-compiler/index.js';

const FIX = resolve('examples/entity-packs/mixed-sample/onboarding.xlsx');

beforeAll(() => {
  if (!existsSync(FIX)) {
    execSync('node scripts/build-sample-xlsx.mjs', { stdio: 'inherit' });
  }
});

describe('xlsx loader', () => {
  it('loads three data sheets and one workflow sheet', () => {
    const ents = loadXlsx(FIX);
    const ids = ents.map((e) => e.id).sort();
    expect(ids).toEqual(['dialysissession', 'missedappointment', 'provider', 'wf-admit', 'wf-transfer'].sort());
    // 3 data + 2 workflows (wf-admit, wf-transfer)
    expect(ents.filter((e) => e.kind === 'data').length).toBe(3);
    expect(ents.filter((e) => e.kind === 'workflow').length).toBe(2);
  });

  it('picks up dictionary types, PK, and PHI hints', () => {
    const ents = loadXlsx(FIX);
    const session = ents.find((e) => e.id === 'dialysissession')!;
    const patientId = session.fields.find((f) => f.name === 'patient_id')!;
    expect(patientId.phi).toBe(true);
    expect(patientId.type).toBe('string');
    const sessionId = session.fields.find((f) => f.name === 'session_id')!;
    expect(sessionId.primaryKey).toBe(true);
    const ktv = session.fields.find((f) => f.name === 'kt_v')!;
    expect(ktv.type).toBe('number');
  });

  it('captures relationships from dictionary FKs', () => {
    const ents = loadXlsx(FIX);
    const session = ents.find((e) => e.id === 'dialysissession')!;
    expect(session.relationships.some((r) => r.fromField === 'patient_id' && r.toEntity === 'patient')).toBe(true);
  });

  it('respects _entities metadata: purpose_of_use, facility_kind', () => {
    const ents = loadXlsx(FIX);
    const session = ents.find((e) => e.id === 'dialysissession')!;
    expect(session.hints.facilityKind).toBe('dialysis');
    expect(session.hints.purposeOfUse).toContain('treatment');
  });

  it('parses _workflows into ordered steps with HITL flags', () => {
    const ents = loadXlsx(FIX);
    const admit = ents.find((e) => e.id === 'wf-admit')!;
    expect(admit.kind).toBe('workflow');
    expect(admit.workflow?.length).toBe(5);
    expect(admit.workflow?.find((s) => s.id === 'step-4')?.requiresHitl).toBe(true);
  });

  it('records source refs pointing to the workbook file', () => {
    const ents = loadXlsx(FIX);
    for (const e of ents) {
      const ref = e.sourceRefs[0]!;
      expect(ref.file).toBe('onboarding.xlsx');
      expect(ref.contentHash).toHaveLength(16);
    }
  });

  it('compiles end-to-end from the mixed input (incl. xlsx) into a valid pack (dry-run)', async () => {
    const { report } = await compileEntityPack({
      inputPath: resolve('examples/entity-packs/mixed-sample'),
      packId: 'xlsx-only-clinic',
      outRoot: resolve('/tmp/hh-test-output'),
      ownerOrg: 'test-org',
      dryRun: true,
    });
    // sepsis-score from md still rejected; everything from xlsx should land
    expect(report.entitiesEmitted).toBeGreaterThanOrEqual(5);
    const admit = report.perEntity.find((p) => p.entityId === 'wf-admit');
    expect(admit?.archetype).toBe('procedure-runner');
    // Provider has a 'name' column which matches PHI_HINT, so classifier
    // correctly routes to record-steward. If a user wants pure catalog
    // behavior, they'd flip phi=false in _dictionary for 'name'.
    const provider = report.perEntity.find((p) => p.entityId === 'provider');
    expect(provider?.archetype).toBe('record-steward');
    const session = report.perEntity.find((p) => p.entityId === 'dialysissession');
    expect(session?.archetype).toBe('record-steward');
  });
});
