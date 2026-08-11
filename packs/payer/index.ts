import type { DomainPack } from '../../src/control-plane/pack-registry.js';

export * from './ontology.js';
export * from './prior-auth.js';
export * from './utilization-management.js';
export * from './claims-operations.js';
export * from './appeals.js';
export * from './care-management.js';
export * from './network-and-benefits.js';
export * from './cms-0057-f.js';

export const payerPack: DomainPack = Object.freeze({
  id: 'payer',
  version: '0.2.0',
  extends: [{ id: 'healthcare-core', versionRange: '^0.2.0' }],
  appliesTo: { organizationKinds: ['payer'] },
  capabilities: [
    'prior-authorization',
    'utilization-management',
    'appeals',
    'claims-operations',
    'care-management',
    'network-and-benefits',
    'cms-0057-f-interoperability',
  ],
  cmsUniverse: [
    { id: 'cms:0057-f', title: 'CMS-0057-F Advancing Interoperability and Prior Authorization', authority: 'CMS' },
    { id: 'cms:esrd:qip', title: 'ESRD Quality Incentive Program', authority: 'CMS' },
  ],
  requiredControls: ['access-policy', 'audit-provenance', 'data-quality', 'simulation-suite', 'appeals-ledger', 'sla-monitor'],
});
