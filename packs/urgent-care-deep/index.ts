// urgent-care-deep pack — 40 urgent-care agents covering fast-track
// registration, ESI triage, CC-based order sets, POC testing workflows,
// clinical decision rules (Ottawa, CCR, PERC, HEART, NEXUS, PECARN),
// safety (sepsis, stroke, STEMI, hypoxia, anaphylaxis), procedures
// (laceration, splint, FB removal), documentation, EMTALA transfers,
// occupational health (DOT, workmans comp, sports), quality (72h
// return, daily huddle).

import type { DomainPack } from '../../src/control-plane/pack-registry.js';

export const urgentCareDeepPack: DomainPack = Object.freeze({
  id: 'urgent-care-deep',
  version: '1.0.0',
  extends: [{ id: 'healthcare-core', versionRange: '^0.2.0' }],
  appliesTo: { organizationKinds: ['provider', 'practice', 'health-system'], facilityKinds: ['urgent-care'] },
  capabilities: [
    'walkin-registration',
    'esi-triage',
    'clinical-decision-rules',
    'poc-testing',
    'emtala-transfers',
    'occupational-health',
    'nsa-good-faith-estimate',
  ],
  cmsUniverse: [],
  requiredControls: ['audit-provenance', 'phi-handling', 'access-policy', 'emtala-compliance'],
});
