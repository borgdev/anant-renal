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
