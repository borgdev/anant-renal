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

// Feature flags — deterministic, evaluated per-context, no external calls.

export type FlagRule =
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'percentage'; readonly percent: number; readonly saltHash: (key: string) => number }
  | { readonly kind: 'attribute'; readonly attribute: string; readonly allowedValues: readonly string[] };

export interface FeatureFlag {
  readonly id: string;
  readonly description: string;
  readonly defaultValue: boolean;
  readonly rules: readonly FlagRule[];
}

export interface FlagContext {
  readonly subjectRef: string;
  readonly attributes: Readonly<Record<string, string>>;
}

export class FeatureFlagRegistry {
  private readonly flags = new Map<string, FeatureFlag>();

  register(flag: FeatureFlag): void { this.flags.set(flag.id, flag); }

  evaluate(id: string, ctx: FlagContext): boolean {
    const f = this.flags.get(id);
    if (!f) return false;
    for (const rule of f.rules) {
      if (rule.kind === 'boolean') return rule.value;
      if (rule.kind === 'attribute') {
        const v = ctx.attributes[rule.attribute];
        if (typeof v === 'string' && rule.allowedValues.includes(v)) return true;
      }
      if (rule.kind === 'percentage') {
        const bucket = rule.saltHash(id + ':' + ctx.subjectRef) % 100;
        if (bucket < rule.percent) return true;
      }
    }
    return f.defaultValue;
  }
}

/** Deterministic salted hash for percentage rollout — FNV-1a 32-bit. */
export function fnv1aHash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h;
}
