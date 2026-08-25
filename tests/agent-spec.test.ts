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
import { validateAgentSpec, AgentSpecError } from '../src/agents/spec.js';

const minimalSpec = {
  id: 'demo',
  version: '1.0.0',
  packId: 'test-pack',
  displayName: 'Demo Agent',
  scope: 'facility',
  trigger: { kind: 'manual' },
  plan: { type: 'step', step: { id: 's1', skill: 'llm.call', inputs: { prompt: 'hi' } } },
  governance: { phiHandling: 'none', purposeOfUse: ['operations'], clearanceRequired: 'internal' },
  billing: {},
};

describe('validateAgentSpec', () => {
  it('accepts a minimal spec and applies defaults', () => {
    const spec = validateAgentSpec(minimalSpec);
    expect(spec.id).toBe('demo');
    expect(spec.governance.hitlGates).toEqual([]);
    expect(spec.governance.breakGlassAllowed).toBe(false);
    expect(spec.billing.baseFeeUsd).toBe(0);
  });

  it('rejects bad version', () => {
    expect(() => validateAgentSpec({ ...minimalSpec, version: '1.0' })).toThrow(AgentSpecError);
  });

  it('accepts nested plan graph (sequence with parallel branch)', () => {
    const spec = validateAgentSpec({
      ...minimalSpec,
      plan: {
        type: 'sequence',
        children: [
          { type: 'step', step: { id: 'a', skill: 'llm.call', inputs: {} } },
          {
            type: 'parallel',
            children: [
              { type: 'step', step: { id: 'b', skill: 'sql.query', inputs: {} } },
              { type: 'step', step: { id: 'c', skill: 'http.call', inputs: {} } },
            ],
          },
          {
            type: 'conditional',
            when: 'state.a.ok === true',
            then: { type: 'step', step: { id: 'd', skill: 'hitl.approve', inputs: {} } },
          },
        ],
      },
    });
    expect(spec.plan.type).toBe('sequence');
  });

  it('rejects wrong purpose enum', () => {
    expect(() => validateAgentSpec({ ...minimalSpec, governance: { ...minimalSpec.governance, purposeOfUse: ['bogus'] } })).toThrow(AgentSpecError);
  });
});
