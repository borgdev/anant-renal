// primary-care-deep pack — 50 primary-care agents covering the AWV,
// USPSTF preventive services, chronic disease programs (HTN, DM, CKD, HF,
// COPD, asthma, obesity), behavioral health screening, women's health,
// pediatrics, immunizations, inbox triage, care-coordination, CCM/TCM
// billing, SDOH.

import type { DomainPack } from '../../src/control-plane/pack-registry.js';

export const primaryCareDeepPack: DomainPack = Object.freeze({
  id: 'primary-care-deep',
  version: '1.0.0',
  extends: [{ id: 'healthcare-core', versionRange: '^0.2.0' }],
  appliesTo: { organizationKinds: ['practice', 'health-system', 'provider'], facilityKinds: ['primary-care'] },
  capabilities: [
    'awv',
    'uspstf-preventive',
    'chronic-disease-programs',
    'behavioral-health-screening',
    'ccm-tcm-billing',
    'pediatric-well-child',
    'sdoh-referral',
  ],
  cmsUniverse: [],
  requiredControls: ['audit-provenance', 'phi-handling', 'access-policy'],
});
