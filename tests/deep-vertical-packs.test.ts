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
