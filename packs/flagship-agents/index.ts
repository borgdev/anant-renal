// flagship-agents pack — 20 cross-setting agents demonstrating the runtime
// spine end-to-end. Agents live as YAML under `packs/flagship-agents/agents/`
// and load into the AgentRegistry via `loadSpecsFromDisk`.

import type { DomainPack } from '../../src/control-plane/pack-registry.js';

export const flagshipAgentsPack: DomainPack = Object.freeze({
  id: 'flagship-agents',
  version: '1.0.0',
  extends: [{ id: 'healthcare-core', versionRange: '^0.2.0' }],
  appliesTo: { organizationKinds: ['provider', 'payer', 'health-system', 'practice'] },
  capabilities: [
    'cross-setting-agents',
    'reference-implementation',
    'lifecycle-spanning-workflows',
  ],
  cmsUniverse: [],
  requiredControls: ['access-policy', 'audit-provenance', 'phi-handling', 'billing-metering'],
});
