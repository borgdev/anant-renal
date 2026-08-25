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
export * from './prior-auth.js';
export * from './utilization-management.js';
export * from './claims-operations.js';
export * from './appeals.js';
export * from './care-management.js';
export * from './network-and-benefits.js';
export * from './cms-0057-f.js';

export const payerPack: DomainPack = Object.freeze({
  id: 'payer',
  version: '0.2.0',
  extends: [{ id: 'healthcare-core', versionRange: '^0.2.0' }],
  appliesTo: { organizationKinds: ['payer'] },
  capabilities: [
    'prior-authorization',
    'utilization-management',
    'appeals',
    'claims-operations',
    'care-management',
    'network-and-benefits',
    'cms-0057-f-interoperability',
  ],
  cmsUniverse: [
    { id: 'cms:0057-f', title: 'CMS-0057-F Advancing Interoperability and Prior Authorization', authority: 'CMS' },
    { id: 'cms:esrd:qip', title: 'ESRD Quality Incentive Program', authority: 'CMS' },
  ],
  requiredControls: ['access-policy', 'audit-provenance', 'data-quality', 'simulation-suite', 'appeals-ledger', 'sla-monitor'],
});
