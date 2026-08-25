/******************************************************************************
 *
 * Copyright (c) 2026 AnantHQ Inc.
 * All Rights Reserved.
 *
 * This software is licensed, not sold.
 *
 * The contents of this file constitute confidential and proprietary
 * information belonging exclusively to Unison Software Technologies Pvt. Ltd.
 *
 * This source code incorporates proprietary algorithms, software architecture,
 * business logic, computational methods, optimization techniques,
 * workflows, data structures, APIs, and implementation details that are
 * protected by copyright law, patent law, trade secret law, and
 * international intellectual property treaties.
 *
 * Except as expressly permitted by a written license agreement,
 * no person or organization may:
 *
 *   • Copy or reproduce this software.
 *   • Modify or create derivative works.
 *   • Reverse engineer, decompile, or disassemble.
 *   • Benchmark or publicly disclose performance.
 *   • Redistribute, sublicense, lease, rent, or sell.
 *   • Use this software for competitive analysis.
 *   • Disclose any implementation details.
 *
 * Any unauthorized use is strictly prohibited and may result in
 * civil damages, injunctive relief, criminal prosecution,
 * and all other remedies available under applicable law.
 *
 ******************************************************************************/

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
