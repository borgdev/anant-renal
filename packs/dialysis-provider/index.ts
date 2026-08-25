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

import type { DomainPack } from '../../src/control-plane/pack-registry.js';

export * from './ontology.js';
export * from './cycles.js';
export * from './data-quality.js';
export * as missedTreatment from './missed-treatment/index.js';
export * as labs from './labs/index.js';
export * as scheduling from './scheduling/index.js';
export * as hospitalization from './hospitalization/index.js';
export * as vascularAccess from './vascular-access/index.js';
export * as nutrition from './nutrition/index.js';
export * as medication from './medication/index.js';
export * as protocolCompliance from './protocol-compliance/index.js';
export * as transport from './transport/index.js';
export * as qapiEvidence from './qapi-evidence/index.js';
export * as measures from './measures/esrd-qip.js';
export { dialysisReplayReducer } from './replay-reducer.js';

export const dialysisProviderPack: DomainPack = Object.freeze({
  id: 'dialysis-provider',
  version: '0.3.0',
  extends: [{ id: 'healthcare-core', versionRange: '^0.2.0' }],
  appliesTo: {
    organizationKinds: ['provider', 'health-system'],
    facilityKinds: ['outpatient-dialysis', 'home-dialysis'],
  },
  capabilities: [
    'treatment-operations',
    'missed-treatment-recovery',
    'scheduling-recovery',
    'hospitalization-transition',
    'lab-review',
    'vascular-access-surveillance',
    'nutrition-dry-weight',
    'medication-management',
    'protocol-compliance',
    'transport-barrier',
    'qapi',
    'qapi-evidence-packet',
    'esrd-quality-reporting',
  ],
  cmsUniverse: [
    { id: 'cms:esrd:cfc:494', title: 'ESRD Conditions for Coverage', authority: 'CMS' },
    { id: 'cms:esrd:qip', title: 'ESRD Quality Incentive Program', authority: 'CMS' },
    { id: 'cms:esrd:pps', title: 'ESRD Prospective Payment System', authority: 'CMS' },
    { id: 'cms:nhsn-linkage', title: 'CDC NHSN Dialysis Event', authority: 'CDC' },
  ],
  requiredControls: [
    'access-policy',
    'audit-provenance',
    'data-quality',
    'simulation-suite',
    'observability-dashboard',
    'qapi-plan',
    'break-glass-ledger',
  ],
});
