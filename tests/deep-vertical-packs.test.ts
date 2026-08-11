import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { validateAgentSpec, AgentRegistry } from '../src/agents/index.js';

const PACKS: readonly { id: string; dir: string; expected: number }[] = [
  { id: 'dialysis-deep', dir: 'packs/dialysis-deep/agents', expected: 60 },
  { id: 'primary-care-deep', dir: 'packs/primary-care-deep/agents', expected: 50 },
  { id: 'urgent-care-deep', dir: 'packs/urgent-care-deep/agents', expected: 40 },
];

describe('Deep vertical packs (M5)', () => {
  for (const pack of PACKS) {
    it(`${pack.id} ships ${pack.expected} agents`, () => {
      const files = readdirSync(pack.dir).filter((f) => f.endsWith('.yaml'));
      expect(files.length).toBe(pack.expected);
    });

    it(`${pack.id} — all agent specs validate + register uniquely`, () => {
      const reg = new AgentRegistry();
      const files = readdirSync(pack.dir).filter((f) => f.endsWith('.yaml'));
      for (const f of files) {
        const raw = parseYaml(readFileSync(`${pack.dir}/${f}`, 'utf8'));
        const spec = validateAgentSpec(raw);
        expect(spec.packId).toBe(pack.id);
        reg.register(spec);
      }
      expect(reg.list().length).toBe(pack.expected);
    });
  }

  it('total deep-vertical agent count is 150', () => {
    const total = PACKS.reduce((n, p) => n + readdirSync(p.dir).filter((f) => f.endsWith('.yaml')).length, 0);
    expect(total).toBe(150);
  });
});
