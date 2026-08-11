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
