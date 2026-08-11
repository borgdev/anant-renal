import type { DomainPack } from '../../src/control-plane/pack-registry.js';

export * from './ontology.js';
export * from './cycles.js';
export * from './data-quality.js';
export * as missedTreatment from './missed-treatment/index.js';
export * as labs from './labs/index.js';
export * as scheduling from './scheduling/index.js';
export * as hospitalization from './hospitalization/index.js';
export * as vascularAccess from './vascular-access/index.js';
export * as measures from './measures/esrd-qip.js';
export { dialysisReplayReducer } from './replay-reducer.js';

export const dialysisProviderPack: DomainPack = Object.freeze({
  id: 'dialysis-provider',
  version: '0.2.0',
  extends: [{ id: 'healthcare-core', versionRange: '^0.2.0' }],
  appliesTo: {
    organizationKinds: ['provider', 'health-system'],
    facilityKinds: ['outpatient-dialysis', 'home-dialysis'],
  },
  capabilities: [
    'treatment-operations',
    'missed-treatment-recovery',
    'scheduling-recovery',
    'hospitalization-transition',
    'lab-review',
    'vascular-access-surveillance',
    'qapi',
    'esrd-quality-reporting',
  ],
  cmsUniverse: [
    { id: 'esrd-conditions-for-coverage', title: 'ESRD Conditions for Coverage', authority: 'CMS' },
    { id: 'esrd-qip', title: 'ESRD Quality Incentive Program', authority: 'CMS' },
    { id: 'esrd-pps', title: 'ESRD Prospective Payment System', authority: 'CMS' },
  ],
  requiredControls: ['access-policy', 'audit-provenance', 'data-quality', 'simulation-suite', 'observability-dashboard'],
});
