/******************************************************************************
 *
 * Copyright (c) 2026 AnantHQ Inc.
 * All Rights Reserved.
 *
 * This software is licensed, not sold.
 *
 * The contents of this file constitute confidential and proprietary
 * information belonging exclusively to AnantHQ Inc.
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

// The WorkspaceKind union and the runtime WORKSPACE_KINDS array are two lists of
// the same thing, and only the ARRAY is walked by `hydrate()`. So a kind that is
// in the union but not the array is a kind that is written durably and never
// loaded back — the row exists, the API returns undefined, and nothing errors.
//
// This has happened twice: `cohort-decision` (decisions written, never read, so
// declines were forgotten on restart) and `pack-activation` (the Pack Studio
// forgot which lens was active on every restart). Both were found by hand, long
// after the fact. This test is the machine that finds the third one.
//
// The check reads the source rather than importing a runtime value, because the
// union is a TYPE and has no runtime representation to compare against. That is
// the same reason `docs/design-tokens.md` is machine-checked against the
// stylesheets: a hand-maintained list that nothing verifies becomes fiction.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SOURCE = readFileSync(resolve(process.cwd(), 'src/swarm/workspace.ts'), 'utf8');

/** Members of `export type WorkspaceKind = ... | 'x' | 'y';` */
function unionMembers(): string[] {
  const lines = SOURCE.split('\n');
  const start = lines.findIndex((line) => line.startsWith('export type WorkspaceKind ='));
  expect(start, 'could not find the WorkspaceKind union — did its declaration change?').toBeGreaterThan(-1);

  const out: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i]!;
    // Only member lines, so a quoted token inside a comment cannot be mistaken
    // for a member.
    const member = /^\s*\|\s*'([a-z0-9-]+)'/.exec(line);
    if (member) out.push(member[1]!);
    if (i > start && line.trimEnd().endsWith(';')) break;
  }
  return out;
}

/** Members of `export const WORKSPACE_KINDS: readonly WorkspaceKind[] = [...]` */
function runtimeKinds(): string[] {
  const start = SOURCE.indexOf('export const WORKSPACE_KINDS');
  expect(start, 'could not find WORKSPACE_KINDS').toBeGreaterThan(-1);
  const end = SOURCE.indexOf('];', start);
  const body = SOURCE.slice(start, end);
  return body
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .flatMap((line) => [...line.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]!));
}

describe('workspace kinds: the union and the hydration list stay in step', () => {
  const union = unionMembers();
  const runtime = runtimeKinds();

  it('parses both lists (a guard that silently reads nothing would pass vacuously)', () => {
    expect(union.length).toBeGreaterThan(50);
    expect(runtime.length).toBeGreaterThan(50);
  });

  it('hydrates every kind that can be written', () => {
    const unhydrated = union.filter((kind) => !runtime.includes(kind));
    expect(
      unhydrated,
      `these kinds are in the union but NOT in WORKSPACE_KINDS, so hydrate() never loads them ` +
        `and every read returns undefined after a restart: ${unhydrated.join(', ')}`,
    ).toEqual([]);
  });

  it('declares every kind that is hydrated', () => {
    const undeclared = runtime.filter((kind) => !union.includes(kind));
    expect(undeclared, `hydrated but not a legal kind: ${undeclared.join(', ')}`).toEqual([]);
  });

  it('has no duplicate entries', () => {
    expect(runtime.length).toBe(new Set(runtime).size);
  });

  it('keeps the two kinds whose absence was a real defect', () => {
    // Named individually so a future refactor of this file cannot quietly drop
    // them again: `cohort-decision` forgot declines, `pack-activation` forgot the
    // active lens.
    expect(runtime).toContain('cohort-decision');
    expect(runtime).toContain('pack-activation');
    expect(runtime).toContain('specialty-binding');
  });
});
