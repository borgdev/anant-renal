// Starter policy templates. Ships as static JSON envelopes so the ingestion
// pipeline can round-trip them today without needing PDF/OCR upstream.
// Documents included:
//   - CMS ESRD Conditions for Coverage (42 CFR 494, SOM Appendix H)
//   - CDC Standard Precautions (2007, updated 2024)
//   - OSHA Bloodborne Pathogens Standard (29 CFR 1910.1030)
//   - TJC National Patient Safety Goals (Hospital 2025)

import type { DomainPack } from '../../src/control-plane/pack-registry.js';

export const policyTemplatesPack: DomainPack = Object.freeze({
  id: 'policy-templates',
  version: '1.0.0',
  extends: [{ id: 'healthcare-core', versionRange: '^0.2.0' }],
  appliesTo: { organizationKinds: ['provider', 'payer', 'health-system', 'practice'] },
  capabilities: ['policy-graph-seed', 'cms-som-appendices', 'tjc-npsg', 'cdc-precautions', 'osha-bbp'],
  cmsUniverse: [
    { id: '42-cfr-494', title: 'ESRD Conditions for Coverage', authority: 'CMS', effectiveFrom: '2008-10-14' },
    { id: '29-cfr-1910-1030', title: 'OSHA Bloodborne Pathogens Standard', authority: 'OSHA', effectiveFrom: '1991-12-06' },
    { id: 'cdc-standard-precautions', title: 'CDC Standard Precautions', authority: 'CDC', effectiveFrom: '2007-06-01' },
    { id: 'tjc-npsg-hospital-2025', title: 'TJC National Patient Safety Goals (Hospital)', authority: 'TJC', effectiveFrom: '2025-01-01' },
  ],
  requiredControls: ['audit-provenance', 'access-policy'],
});

export const STARTER_POLICY_FILES = [
  'cms-esrd-conditions-for-coverage.json',
  'cdc-standard-precautions.json',
  'osha-bloodborne-pathogens.json',
  'tjc-national-patient-safety-goals.json',
] as const;
