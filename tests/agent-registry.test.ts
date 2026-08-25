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

import { describe, expect, it } from 'vitest';
import { AgentRegistry } from '../src/agents/registry.js';
import { validateAgentSpec } from '../src/agents/spec.js';

function spec(id: string, version: string) {
  return validateAgentSpec({
    id, version, packId: 'p', displayName: id, scope: 'facility',
    trigger: { kind: 'manual' },
    plan: { type: 'step', step: { id: 's', skill: 'llm.call', inputs: {} } },
    governance: { phiHandling: 'none', purposeOfUse: ['operations'], clearanceRequired: 'internal' },
    billing: {},
  });
}

describe('AgentRegistry', () => {
  it('registers, tracks latest by semver, and looks up by version', () => {
    const r = new AgentRegistry();
    r.register(spec('a', '1.0.0'));
    r.register(spec('a', '1.2.0'));
    r.register(spec('a', '1.1.0'));
    expect(r.get('a')?.version).toBe('1.2.0');
    expect(r.get('a', '1.0.0')?.version).toBe('1.0.0');
  });

  it('lists all versions and filters by scope', () => {
    const r = new AgentRegistry();
    r.register(spec('a', '1.0.0'));
    r.register(spec('b', '2.0.0'));
    expect(r.list().length).toBe(2);
    expect(r.list('facility').length).toBe(2);
    expect(r.list('org').length).toBe(0);
  });

  it('unregister removes a version', () => {
    const r = new AgentRegistry();
    r.register(spec('a', '1.0.0'));
    r.register(spec('a', '1.1.0'));
    r.unregister('a', '1.1.0');
    expect(r.get('a')?.version).toBe('1.0.0');
  });
});
