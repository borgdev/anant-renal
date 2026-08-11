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
