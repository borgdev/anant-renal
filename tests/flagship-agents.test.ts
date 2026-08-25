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

describe('Flagship agents pack', () => {
  const dir = 'packs/flagship-agents/agents';
  const files = readdirSync(dir).filter((f) => f.endsWith('.yaml'));

  it('ships 20 flagship agents', () => {
    expect(files.length).toBe(20);
  });

  it('all specs validate + register cleanly', () => {
    const reg = new AgentRegistry();
    for (const f of files) {
      const raw = parseYaml(readFileSync(`${dir}/${f}`, 'utf8'));
      const spec = validateAgentSpec(raw);
      expect(spec.id).toBe(f.replace(/\.yaml$/, ''));
      reg.register(spec);
    }
    expect(reg.list().length).toBe(20);
  });

  it('covers key lifecycle stages', () => {
    const stages = new Set<string>();
    for (const f of files) {
      const raw = parseYaml(readFileSync(`${dir}/${f}`, 'utf8')) as { labels?: { lifecycleStage?: string } };
      if (raw.labels?.lifecycleStage) stages.add(raw.labels.lifecycleStage);
    }
    for (const s of ['pre-registration', 'onboarding', 'active-care', 'transition-of-care', 'transplant-workup', 'post-transplant', 'palliative', 'hospice']) {
      expect(stages.has(s)).toBe(true);
    }
  });
});
