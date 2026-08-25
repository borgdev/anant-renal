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
import { PackRegistry, satisfies } from '../src/control-plane/index.js';
import { healthcareCorePack, dialysisProviderPack, ckdNavigationPack, payerPack, cmsUniversePack } from '../packs/index.js';

describe('PackRegistry', () => {
  it('resolves dependencies in order', () => {
    const r = new PackRegistry();
    r.register(healthcareCorePack);
    r.register(dialysisProviderPack);
    r.register(ckdNavigationPack);
    r.register(payerPack);
    r.register(cmsUniversePack);
    expect(r.all().map((p) => p.id)).toContain('dialysis-provider');
    expect(r.resolve('dialysis-provider').id).toBe('dialysis-provider');
  });

  it('fails on missing dependency', () => {
    const r = new PackRegistry();
    expect(() => r.register(dialysisProviderPack)).toThrow();
  });

  it('satisfies caret ranges', () => {
    expect(satisfies('0.2.0', '^0.2.0')).toBe(true);
    expect(satisfies('0.3.0', '^0.2.0')).toBe(false);
    expect(satisfies('1.2.3', '^1.2.0')).toBe(true);
    expect(satisfies('2.0.0', '^1.2.0')).toBe(false);
  });
});
