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

/**
 * Two spreads under the same key in one object literal REPLACE, they do not
 * merge.
 *
 *   { ...(a ? { events: x } : {}), ...(b ? { events: y } : {}) }
 *
 * TypeScript is happy, `exactOptionalPropertyTypes` is happy, and the first value
 * is gone. Nothing errors and nothing warns. It cost real debugging time: the
 * anemia fixture's `events` override was silently dropped by a sibling
 * `patients` spread under the same key, the ESA twin fell back to patient state,
 * and the only symptom was `provenance.derivedFrom === 'patient-state'` in one
 * assertion.
 *
 * It is also easy to write *deliberately* and get away with it — two spreads that
 * both set `outcome` read as "a complication outranks a short session", but that
 * reading lives only in the line ORDER. Reordering those lines changes what the
 * chart records, with nothing in the code to say which reading was meant. That
 * instance is now a single expression that states the precedence.
 *
 * So: no same-key spread collisions, anywhere. The fix is never an allow-list
 * entry — it is to hoist the decision into a named value, which is where a
 * precedence rule belongs.
 *
 * This is a source-level audit because the type system cannot see the problem.
 * It uses the TypeScript compiler (already a devDependency) rather than a regex,
 * and it understands the two shapes the codebase actually uses:
 *
 *   1. `...(cond ? { KEY: v } : {})`
 *   2. `...(cond ? { KEY: v } : { OTHER: w })`   — the true branch wins the key
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const ROOT = join(__dirname, '..');
const SCANNED = ['src', 'packs', 'exec-app/src'];

/** Keys an expression sets, as far as can be told syntactically. */
function keysOf(node: ts.Node): string[] {
  const keys: string[] = [];
  if (ts.isParenthesizedExpression(node)) return keysOf(node.expression);
  if (ts.isObjectLiteralExpression(node)) {
    for (const p of node.properties) {
      if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) {
        const n = p.name;
        if (ts.isIdentifier(n) || ts.isStringLiteral(n)) keys.push(n.text);
      }
    }
  }
  // `cond ? { K: v } : { OTHER: w }` — only the true branch contributes a key to
  // the enclosing literal's collision surface in a way that silently loses data.
  if (ts.isConditionalExpression(node)) keys.push(...keysOf(node.whenTrue));
  return keys;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'target' || entry.startsWith('.')) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(entry)) out.push(p);
  }
  return out;
}

interface Collision {
  readonly file: string;
  readonly key: string;
  readonly line: number;
  readonly alsoAt: number;
}

function findCollisions(): Collision[] {
  const found: Collision[] = [];
  for (const dir of SCANNED) {
    for (const file of sourceFiles(join(ROOT, dir))) {
      const text = readFileSync(file, 'utf8');
      // Cheap pre-filter: without a conditional spread there is nothing to find.
      if (!text.includes('...(')) continue;
      const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);

      const visit = (node: ts.Node): void => {
        if (ts.isObjectLiteralExpression(node)) {
          const seen = new Map<string, ts.Node>();
          for (const prop of node.properties) {
            const keys = keysOf(ts.isSpreadAssignment(prop) ? prop.expression : prop);
            for (const key of keys) {
              const prior = seen.get(key);
              // A plain property repeating a spread's key is a loud duplicate; the
              // silent case is two SPREADS, which is what this guards.
              if (prior && ts.isSpreadAssignment(prop) && ts.isSpreadAssignment(prior)) {
                found.push({
                  file: relative(ROOT, file),
                  key,
                  line: sf.getLineAndCharacterOfPosition(prop.getStart(sf)).line + 1,
                  alsoAt: sf.getLineAndCharacterOfPosition(prior.getStart(sf)).line + 1,
                });
              }
              seen.set(key, prop);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
  }
  return found;
}

describe('no object literal sets the same key from two spreads', () => {
  it('finds no silent last-spread-wins collisions', () => {
    const collisions = findCollisions();
    const detail = collisions
      .map((c) => `${c.file}:${c.line} sets "${c.key}" which line ${c.alsoAt} also spreads`)
      .join('\n');

    expect(
      collisions,
      collisions.length === 0
        ? ''
        : `Two spreads under one key REPLACE rather than merge.\n${detail}\n\n` +
          'Fix by hoisting the decision into one named value (see the precedence fix in\n' +
          'effect-reducer.ts) — not by adding an exception here.',
    ).toEqual([]);
  });

  it('detects the shape it claims to detect', () => {
    // A guard that cannot fail is worse than none, so prove the detector fires on
    // the exact code that shipped the bug.
    const src = `
      const f = (a: boolean, b: boolean) => ({
        ...(a ? { events: 1 } : {}),
        ...(b ? { events: 2 } : {}),
      });
    `;
    const sf = ts.createSourceFile('probe.ts', src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    let hits = 0;
    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        const seen = new Set<string>();
        for (const prop of node.properties) {
          for (const key of keysOf(ts.isSpreadAssignment(prop) ? prop.expression : prop)) {
            if (seen.has(key) && ts.isSpreadAssignment(prop)) hits += 1;
            seen.add(key);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    expect(hits).toBe(1);
  });
});
