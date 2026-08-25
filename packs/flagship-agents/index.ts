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

// flagship-agents pack — 20 cross-setting agents demonstrating the runtime
// spine end-to-end. Agents live as YAML under `packs/flagship-agents/agents/`
// and load into the AgentRegistry via `loadSpecsFromDisk`.

import type { DomainPack } from '../../src/control-plane/pack-registry.js';

export const flagshipAgentsPack: DomainPack = Object.freeze({
  id: 'flagship-agents',
  version: '1.0.0',
  extends: [{ id: 'healthcare-core', versionRange: '^0.2.0' }],
  appliesTo: { organizationKinds: ['provider', 'payer', 'health-system', 'practice'] },
  capabilities: [
    'cross-setting-agents',
    'reference-implementation',
    'lifecycle-spanning-workflows',
  ],
  cmsUniverse: [],
  requiredControls: ['access-policy', 'audit-provenance', 'phi-handling', 'billing-metering'],
});
