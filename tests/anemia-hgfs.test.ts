/******************************************************************************
 * Anemia/ESA → HGFS projector seam — P2.
 *
 * Asserts the simplicial projection the HGFS adapter will persist per tenant:
 * anant.patient.esa (dose delta), anant.lab, anant.cds.epo, anant.cds.epo.for,
 * anant.esa.tri (patient, model-version, rec) and the anant.esa.loop polygon —
 * plus the medical-role RBAC on recommendation/delta reads.
 ******************************************************************************/

import { describe, it, expect } from 'vitest';
import {
  InMemoryHgfsSimplicialStore, canReadEsaType, projectEsaSimplexes,
  type EsaSimplexInput,
} from '../src/hgfs/esa-projector.js';

const INPUT: EsaSimplexInput = {
  tenantId: 'tenant-riverbend',
  patientId: 'p-esa-1',
  facilityId: 'fac-1',
  currentDose: 8000,
  recommendedDose: 9500,
  blocked: false,
  guardrailFlags: [],
  latent: { l1: -0.25, l2: -0.71, polarRadius: 0.75, polarAngleRad: -1.9 },
  relevance: [{ id: 'priorEpo', relevance: 0.9559 }, { id: 'hgb', relevance: 0.0366 }],
  modelId: 'anemia.esa-dose-v1',
  modelVersion: '1.0.0',
  hgb: 9.4,
  mcv: 92,
  ferritin: 640,
  decision: 'approved',
  ordered: true,
  administered: true,
  hgbVerified: true,
};

describe('anemia → HGFS projector seam', () => {
  it('projects the expected vertices/edges/triangle/polygon for a tenant', () => {
    const els = projectEsaSimplexes(INPUT);
    const types = els.map((e) => e.type);
    expect(types).toContain('anant.patient.esa');
    expect(types).toContain('anant.lab');      // hgb + mcv + ferritin
    expect(els.filter((e) => e.type === 'anant.lab')).toHaveLength(3);
    expect(types).toContain('anant.cds.epo');
    expect(types).toContain('anant.cds.epo.for');
    expect(types).toContain('anant.esa.tri');
    expect(types).toContain('anant.esa.loop');

    const patient = els.find((e) => e.type === 'anant.patient.esa');
    expect(patient?.attrs.delta).toBe(1500); // recommended 9500 − current 8000
    expect(patient?.attrs.decision).toBe('approved');

    const cds = els.find((e) => e.type === 'anant.cds.epo');
    expect((cds?.attrs.latent as { l1: number; l2: number })).toMatchObject({ l1: -0.25, l2: -0.71 });
    expect(cds?.attrs.recommendedDose).toBe(9500);
    expect(cds?.attrs.modelVersion).toBe('1.0.0');
    expect((cds?.attrs.relevance as Array<{ id: string; relevance: number }>)[0]).toMatchObject({ id: 'priorEpo', relevance: 0.9559 });

    const tri = els.find((e) => e.kind === 'triangle');
    expect(tri?.ends).toHaveLength(3); // (patient, model-version, recommendation)

    const loop = els.find((e) => e.kind === 'polygon');
    expect(loop?.type).toBe('anant.esa.loop');
    expect(loop?.ends).toContain('anant:' + INPUT.tenantId + ':lab:hgb:p-esa-1');
    expect(loop?.attrs.hgbVerified).toBe(true);
  });

  it('projection is deterministic per tenant and overwrites in place', async () => {
    const store = new InMemoryHgfsSimplicialStore();
    const a = projectEsaSimplexes(INPUT);
    const b = projectEsaSimplexes({ ...INPUT, hgb: 10.2, recommendedDose: 9000 });
    expect(a.map((e) => e.id)).toEqual(b.map((e) => e.id)); // same ids (new values)
    for (const e of b) await store.put(e);
    const listed = await store.list('tenant-riverbend');
    expect(listed).toHaveLength(b.length);
    const again = await store.list('tenant-riverbend');
    expect(again).toHaveLength(b.length); // overwrite, no duplicates
    const delta = (await store.list('tenant-riverbend', { type: 'anant.patient.esa' }))[0];
    expect(delta?.attrs.delta).toBe(1000);
  });

  it('store round-trips per tenant + clear', async () => {
    const store = new InMemoryHgfsSimplicialStore();
    for (const e of projectEsaSimplexes(INPUT)) await store.put(e);
    for (const e of projectEsaSimplexes({ ...INPUT, tenantId: 'tenant-other', patientId: 'p2' })) await store.put(e);
    expect((await store.list('tenant-riverbend')).length).toBe(9); // 1 patient.esa + 3 labs + 1 cds + 1 edge + 1 model + 1 tri + 1 loop
    expect((await store.list('tenant-other')).length).toBeGreaterThan(0);
    const removed = await store.clear('tenant-riverbend');
    expect(removed).toBeGreaterThan(0);
    expect((await store.list('tenant-riverbend'))).toHaveLength(0);
    expect((await store.list('tenant-other')).length).toBeGreaterThan(0);
  });

  it('RBAC — only the medical role reads recommendation + dose delta chain', () => {
    expect(canReadEsaType('anant.cds.epo', 'medical')).toBe(true);
    expect(canReadEsaType('anant.cds.epo', 'operations')).toBe(false);
    expect(canReadEsaType('anant.patient.esa', 'medical')).toBe(true);
    expect(canReadEsaType('anant.patient.esa', 'readonly')).toBe(false);
    expect(canReadEsaType('anant.esa.tri', 'medical')).toBe(true);
    expect(canReadEsaType('anant.esa.tri', 'operations')).toBe(false);
    // Base lab vertices are readable at the operations scope.
    expect(canReadEsaType('anant.lab', 'operations')).toBe(true);
  });
});
