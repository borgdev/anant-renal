// research-pharma pack — public clinical-research and pharma pipelines that
// power trial matching, new-drug surveillance, pharmacovigilance signal
// detection, and evidence-linked guideline synthesis.

import type { DomainPack } from '../../src/control-plane/pack-registry.js';

export const researchPharmaPack: DomainPack = Object.freeze({
  id: 'research-pharma',
  version: '1.0.0',
  extends: [{ id: 'healthcare-core', versionRange: '^0.2.0' }],
  appliesTo: { organizationKinds: ['provider', 'payer', 'health-system', 'practice', 'pharmacy'] },
  capabilities: ['clinicaltrials-gov', 'dailymed', 'openfda', 'faers', 'pubmed', 'rxnav', 'trial-matching', 'new-drug-surveillance', 'pharmacovigilance-signal-detection'],
  cmsUniverse: [],
  requiredControls: ['audit-provenance', 'attribution-nlm', 'attribution-fda'],
});
