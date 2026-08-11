import type { DomainPack } from '../../src/control-plane/pack-registry.js';

export * from './ontology.js';
export * from './prior-auth.js';

export const payerPack: DomainPack = Object.freeze({
  id: 'payer',
  version: '0.1.0',
  extends: [{ id: 'healthcare-core', versionRange: '^0.2.0' }],
  appliesTo: { organizationKinds: ['payer'] },
  capabilities: ['prior-authorization', 'utilization-management', 'appeals', 'claims-adjudication-signal'],
  cmsUniverse: [],
  requiredControls: ['access-policy', 'audit-provenance', 'data-quality', 'simulation-suite'],
});
