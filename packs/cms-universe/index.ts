// CMS-universe pack: turn CMS regulatory programs into executable metadata
// that other packs can bind their measures and workflows to. Each entry has a
// stable id, a citation, and the measures/controls it triggers.

import type { DomainPack } from '../../src/control-plane/pack-registry.js';

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

export const CMS_PROGRAMS: readonly CmsProgram[] = [
  {
    id: 'esrd-conditions-for-coverage',
    title: 'ESRD Conditions for Coverage',
    authority: 'CMS',
    citation: '42 CFR Part 494',
    triggers: {
      measures: ['esrd-qip.ktv-adequacy', 'esrd-qip.missed-treatment-ratio', 'esrd-qip.anemia-management'],
      controls: ['access-policy', 'audit-provenance', 'data-quality'],
    },
    effectiveFrom: '2008-10-14',
  },
  {
    id: 'esrd-qip',
    title: 'ESRD Quality Incentive Program',
    authority: 'CMS',
    citation: '42 CFR §413.177-178',
    triggers: {
      measures: ['esrd-qip.ktv-adequacy', 'esrd-qip.missed-treatment-ratio', 'esrd-qip.anemia-management'],
      controls: ['simulation-suite', 'observability-dashboard'],
    },
  },
  {
    id: 'esrd-pps',
    title: 'ESRD Prospective Payment System',
    authority: 'CMS',
    citation: '42 CFR §413.230',
    triggers: {
      measures: [],
      controls: ['audit-provenance', 'data-quality'],
    },
  },
];

export function programsFor(measureId: string): CmsProgram[] {
  return CMS_PROGRAMS.filter((p) => p.triggers.measures.includes(measureId));
}

export const cmsUniversePack: DomainPack = Object.freeze({
  id: 'cms-universe',
  version: '0.1.0',
  extends: [{ id: 'healthcare-core', versionRange: '^0.2.0' }],
  appliesTo: { organizationKinds: ['provider', 'payer', 'health-system', 'practice'] },
  capabilities: ['executable-regulatory-metadata', 'measure-catalog', 'reporting-obligations'],
  cmsUniverse: CMS_PROGRAMS.map((p) => ({ id: p.id, title: p.title, authority: p.authority, ...(p.effectiveFrom ? { effectiveFrom: p.effectiveFrom } : {}) })),
  requiredControls: ['access-policy', 'audit-provenance'],
});
