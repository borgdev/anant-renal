import type { DomainPack } from '../../src/control-plane/pack-registry.js';

export const healthcareCorePack: DomainPack = Object.freeze({
  id: 'healthcare-core',
  version: '0.2.0',
  extends: [],
  appliesTo: {
    organizationKinds: ['provider', 'payer', 'health-system', 'practice'],
  },
  capabilities: [
    'organization-and-scope-model',
    'phi-aware-access',
    'document-provenance',
    'connector-lineage',
    'temporal-hypergraph',
    'quality-and-evidence',
    'simulation',
    'replay',
  ],
  cmsUniverse: [],
  requiredControls: ['access-policy', 'audit-provenance', 'data-quality', 'simulation-suite', 'observability-dashboard'],
});
