// CMS-universe pack: turn CMS regulatory programs into executable metadata
// that other packs can bind their measures and workflows to. This pack now
// delegates to `CMSSourceRegistry` in healthcare-core and preserves a
// backward-compatible `CMS_PROGRAMS` snapshot for existing consumers.

import type { DomainPack } from '../../src/control-plane/pack-registry.js';
import { seedCMSSources, CMSSourceRegistry, type CMSSource, type CMSMeasureSpec } from '../../src/healthcare-core/cms-source-registry.js';

export interface CmsProgram {
  id: string;
  title: string;
  authority: 'CMS' | 'CDC' | 'FDA';
  citation: string;
  triggers: {
    measures: readonly string[];
    controls: readonly string[];
  };
  effectiveFrom?: string;
}

/** Build the executable registry the harness runs against. */
export function buildCMSRegistry(extraSources: readonly CMSSource[] = [], extraMeasures: readonly CMSMeasureSpec[] = []): CMSSourceRegistry {
  const r = new CMSSourceRegistry();
  for (const s of seedCMSSources) r.registerSource(s);
  for (const s of extraSources) r.registerSource(s);
  for (const m of extraMeasures) r.registerMeasure(m);
  return r;
}

/** Backward-compatible snapshot of CMS programs, derived from the registry. */
export const CMS_PROGRAMS: readonly CmsProgram[] = seedCMSSources.map((s) => ({
  id: s.id,
  title: s.title,
  authority: s.steward as 'CMS' | 'CDC' | 'FDA',
  citation: s.citation,
  triggers: { measures: [], controls: ['audit-provenance', 'data-quality'] },
  effectiveFrom: s.effectiveFrom,
}));

export function programsFor(measureId: string): CmsProgram[] {
  return CMS_PROGRAMS.filter((p) => p.triggers.measures.includes(measureId));
}

export const cmsUniversePack: DomainPack = Object.freeze({
  id: 'cms-universe',
  version: '0.2.0',
  extends: [{ id: 'healthcare-core', versionRange: '^0.2.0' }],
  appliesTo: { organizationKinds: ['provider', 'payer', 'health-system', 'practice'] },
  capabilities: [
    'executable-regulatory-metadata',
    'measure-catalog',
    'reporting-obligations',
    'source-change-detection',
    'authoritative-registry',
  ],
  cmsUniverse: seedCMSSources.map((s) => ({ id: s.id, title: s.title, authority: s.steward, ...(s.effectiveFrom ? { effectiveFrom: s.effectiveFrom } : {}) })),
  requiredControls: ['access-policy', 'audit-provenance', 'source-registry'],
});
