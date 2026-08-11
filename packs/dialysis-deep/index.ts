// dialysis-deep pack — 60 specialized ESRD/dialysis agents covering
// adequacy (Kt/V, URR), vascular access, anemia + mineral-bone,
// nutrition, transplant referral, NHSN infection reporting, water
// quality, IDG cadence, home dialysis (PD + HHD), ESRD-QIP scoring,
// SDOH + health equity, palliative + hospice, safety, and formulary.

import type { DomainPack } from '../../src/control-plane/pack-registry.js';

export const dialysisDeepPack: DomainPack = Object.freeze({
  id: 'dialysis-deep',
  version: '1.0.0',
  extends: [{ id: 'healthcare-core', versionRange: '^0.2.0' }, { id: 'dialysis-provider', versionRange: '^0.1.0' }],
  appliesTo: { organizationKinds: ['provider'], facilityKinds: ['dialysis'] },
  capabilities: [
    'esrd-lifecycle-full',
    'esrd-qip-full',
    'nhsn-full',
    'pd-hhd-workflows',
    'vascular-access-management',
    'ckd-transplant-transitions',
  ],
  cmsUniverse: [],
  requiredControls: ['audit-provenance', 'phi-handling', 'access-policy'],
});
