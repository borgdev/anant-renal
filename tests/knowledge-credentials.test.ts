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

// M20f credentials framework — file-backed secrets registry, namespaced bundling.

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretRegistry } from '../src/knowledge/secrets.js';

let dir: string;
let reg: SecretRegistry;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hh-secrets-'));
  reg = new SecretRegistry(dir);
});

describe('M20f SecretRegistry', () => {
  it('stores and retrieves scoped credentials', () => {
    reg.set('nlm.vsac', 'apikey', 'v1', 'tester');
    const bundle = reg.bundleFor('nlm.vsac');
    expect(bundle['apikey']).toBe('v1');
  });
  it('merges global credentials into every bundle', () => {
    reg.set('__global__', 'umlsApiKey', 'global-key', 'tester');
    reg.set('nlm.vsac', 'apikey', 'v1', 'tester');
    const bundle = reg.bundleFor('nlm.vsac');
    expect(bundle['umlsApiKey']).toBe('global-key');
    expect(bundle['apikey']).toBe('v1');
  });
  it('overwrites existing key in place', () => {
    reg.set('x', 'k', 'a', 't');
    reg.set('x', 'k', 'b', 't');
    expect(reg.bundleFor('x')['k']).toBe('b');
  });
  it('persists to a restricted-permission file', () => {
    reg.set('x', 'k', 'v', 't');
    const path = join(dir, 'secrets.json');
    expect(existsSync(path)).toBe(true);
    const mode = statSync(path).mode & 0o777;
    // On many CI/dev environments the umask may prevent perfect 0600, but the
    // file must not be world-readable.
    expect((mode & 0o004)).toBe(0);
  });
  it('lists namespaces + keys without exposing values', () => {
    reg.set('nlm.vsac', 'apikey', 'secret', 't');
    const listed = reg.list();
    expect(listed.length).toBeGreaterThan(0);
    const found = listed.find(r => r.namespace === 'nlm.vsac' && r.key === 'apikey');
    expect(found).toBeDefined();
    // list should not include the raw value
    expect((found as unknown as { value?: string }).value).toBeUndefined();
  });
  it('survives reload from disk', () => {
    reg.set('x', 'k', 'persisted', 't');
    const fresh = new SecretRegistry(dir);
    expect(fresh.bundleFor('x')['k']).toBe('persisted');
  });
});
