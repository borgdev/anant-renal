/******************************************************************************
 * Anemia/ESA → HGFS projector seam — P2.
 *
 * HGFS is the intended single hypergraph system of record (see
 * docs/hgfs-simplex-mapping.md). Until the HGFS storage adapter lands on the
 * parallel infra track, this module defines the narrow **simplicial** seam it
 * will write to and projects the ESA domain into it:
 *
 *   anant.patient.esa  vertex — one per patient with the monthly dose delta
 *   anant.lab          vertices — Hb / MCV / ferritin …
 *   anant.cds.epo      vertex — latent coords, recommended dose, Rᵢ, model
 *                       version, guardrail verdicts (the "why this dose")
 *   anant.cds.epo.for  edge    — recommendation → patient
 *   anant.esa.tri      triangle — (patient, model-version, recommendation)
 *   anant.esa.loop     polygon  — labs → latent → rec → decision → order →
 *                       administration → Hb verify (the governed closed loop
 *                       as evidence)
 *
 * RBAC (per the doc): only the medical role reads `anant.cds.epo` + the dose
 * delta chain. The seam is dependency-free: an in-memory store satisfies it for
 * tests, and a real HGFS adapter (or the SqlStore-backed one) can satisfy the
 * same interface without touching the projector.
 ******************************************************************************/

export type HgfsRole = 'medical' | 'operations' | 'readonly';

export interface HgfsElement {
  id: string;
  tenantId: string;
  type: string;
  kind: 'vertex' | 'edge' | 'triangle' | 'polygon';
  /** For edge/triangle/polygon — ordered vertex ids. */
  ends?: string[];
  attrs: Record<string, unknown>;
  at: string;
}

export interface HgfsSimplicialStore {
  put(element: HgfsElement): Promise<void>;
  list(tenantId: string, opts?: { type?: string }): Promise<HgfsElement[]>;
  clear(tenantId: string): Promise<number>;
}

/** In-memory simplicial store — satisfies the seam for tests / reference. */
export class InMemoryHgfsSimplicialStore implements HgfsSimplicialStore {
  private elements: HgfsElement[] = [];
  async put(element: HgfsElement): Promise<void> {
    this.elements = this.elements.filter((e) => !(e.tenantId === element.tenantId && e.id === element.id));
    this.elements.push(element);
  }
  async list(tenantId: string, opts: { type?: string } = {}): Promise<HgfsElement[]> {
    return this.elements.filter((e) => e.tenantId === tenantId && (!opts.type || e.type === opts.type));
  }
  async clear(tenantId: string): Promise<number> {
    const before = this.elements.length;
    this.elements = this.elements.filter((e) => e.tenantId !== tenantId);
    return before - this.elements.length;
  }
}

/** RBAC — medical role reads the recommendation + the dose delta chain only. */
export function canReadEsaType(type: string, role: HgfsRole): boolean {
  if (
    type.startsWith('anant.cds.epo')
    || type.startsWith('anant.delta.esa')
    || type === 'anant.esa.tri'
    || type === 'anant.patient.esa' // carries the dose delta
  ) {
    return role === 'medical';
  }
  return true; // lab / model base vertices readable by ops/readonly at the base scope
}

export interface EsaSimplexInput {
  tenantId: string;
  patientId: string;
  facilityId?: string;
  currentDose: number;
  recommendedDose: number | null;
  blocked: boolean;
  guardrailFlags: string[];
  latent: { l1: number; l2: number; polarRadius: number; polarAngleRad: number };
  relevance: Array<{ id: string; relevance: number }>;
  modelId: string;
  modelVersion: string;
  hgb: number;
  mcv?: number;
  ferritin?: number;
  decision?: 'pending' | 'approved' | 'rejected';
  ordered?: boolean;
  administered?: boolean;
  hgbVerified?: boolean;
  at?: string;
}

const NOW = (): string => new Date().toISOString();
const slug = (s: string): string => s.replace(/[^A-Za-z0-9-]/g, '-');

/**
 * Project one ESA recommendation + its governed loop into simplicial elements.
 * Deterministic ids (per tenant) so re-projection overwrites in place.
 */
export function projectEsaSimplexes(input: EsaSimplexInput): HgfsElement[] {
  const at = input.at ?? NOW();
  const tenant = input.tenantId;
  const patId = `anant:${tenant}:patient:${slug(input.patientId)}`;
  const labHgb = `anant:${tenant}:lab:hgb:${slug(input.patientId)}`;
  const labMcv = input.mcv !== undefined ? `anant:${tenant}:lab:mcv:${slug(input.patientId)}` : null;
  const labFer = input.ferritin !== undefined ? `anant:${tenant}:lab:ferritin:${slug(input.patientId)}` : null;
  const cds = `anant:${tenant}:cds.epo:${slug(input.patientId)}:${slug(input.modelVersion)}`;
  const modelVer = `anant:${tenant}:model:${slug(input.modelId)}:${slug(input.modelVersion)}`;
  const loop = `anant:${tenant}:loop:esa:${slug(input.patientId)}`;

  const delta = input.recommendedDose === null ? 0 : input.recommendedDose - input.currentDose;
  const elements: HgfsElement[] = [
    // anant.patient.esa — the monthly dose delta chain (medical-read).
    {
      id: `anant:${tenant}:patient.esa:${slug(input.patientId)}`, tenantId: tenant, kind: 'vertex',
      type: 'anant.patient.esa', attrs: { patientId: input.patientId, delta, currentDose: input.currentDose, modelVersion: input.modelVersion, decision: input.decision ?? 'pending' }, at,
    },
    // anant.lab vertices
    { id: labHgb, tenantId: tenant, kind: 'vertex', type: 'anant.lab', attrs: { patientId: input.patientId, loinc: '718-7', value: input.hgb, unit: 'g/dL' }, at },
    ...(labMcv && input.mcv !== undefined ? [{ id: labMcv, tenantId: tenant, kind: 'vertex', type: 'anant.lab', attrs: { patientId: input.patientId, loinc: '787-2', value: input.mcv, unit: 'fL' }, at }] as HgfsElement[] : []),
    ...(labFer && input.ferritin !== undefined ? [{ id: labFer, tenantId: tenant, kind: 'vertex', type: 'anant.lab', attrs: { patientId: input.patientId, loinc: '2276-4', value: input.ferritin, unit: 'ng/mL' }, at }] as HgfsElement[] : []),
    // anant.cds.epo — the "why this dose" vertex (medical-read).
    {
      id: cds, tenantId: tenant, kind: 'vertex', type: 'anant.cds.epo',
      attrs: { patientId: input.patientId, latent: input.latent, recommendedDose: input.recommendedDose, currentDose: input.currentDose, relevance: input.relevance, modelId: input.modelId, modelVersion: input.modelVersion, guardrailFlags: input.guardrailFlags, blocked: input.blocked }, at,
    },
    // anant.cds.epo.for — recommendation → patient
    {
      id: `${cds}.for`, tenantId: tenant, kind: 'edge', type: 'anant.cds.epo.for', ends: [cds, patId],
      attrs: { patientId: input.patientId }, at,
    },
    // model-version vertex (triangle corner)
    {
      id: modelVer, tenantId: tenant, kind: 'vertex', type: 'anant.model', attrs: { modelId: input.modelId, modelVersion: input.modelVersion, kind: 'esa-dose' }, at,
    },
    // triangle (patient, model-version, recommendation)
    {
      id: `anant:${tenant}:tri:${slug(input.patientId)}:${slug(input.modelVersion)}`, tenantId: tenant, kind: 'triangle',
      type: 'anant.esa.tri', ends: [patId, modelVer, cds], attrs: { patientId: input.patientId, modelVersion: input.modelVersion }, at,
    },
    // polygon anant.esa.loop — labs → latent → rec → decision → order → admin → verify
    {
      id: loop, tenantId: tenant, kind: 'polygon', type: 'anant.esa.loop',
      ends: [labHgb, cds, patId],
      attrs: { patientId: input.patientId, decision: input.decision ?? 'pending', ordered: input.ordered ?? false, administered: input.administered ?? false, hgbVerified: input.hgbVerified ?? false, modelVersion: input.modelVersion }, at,
    },
  ];
  return elements;
}
