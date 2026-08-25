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
