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

// Dose parsing (F4.4, partial). The effect payload still carries `dose` as a
// string, but the write path no longer scrapes digits out of it.
//
// The old parse was `Number(effect.dose.replace(/[^0-9.]/g, '')) || undefined`.
// It cannot fail, which is exactly the problem — it always returns SOMETHING:
//
//   '1-2 tabs'        -> 12        (digits concatenated across the range)
//   '0.5 mg x 2'      -> 0.52      (ditto)
//   'q12h'            -> 12        (a frequency read as the dose)
//   'two tablets'     -> undefined (units silently stripped, dose dropped)
//
// A medication order requires an exact quantity, so a dose the write path
// cannot read is now a REFUSED write, not a guess.
//
// The full fix (a structured `DoseSpec` on the effect payload, so no parse is
// needed at all) is F4.4-proper and is tracked separately.

export interface DoseSpec {
  readonly amount: number;
  /** UCUM-ish unit as written by the emitter. Absent when the emitter gave a bare number. */
  readonly unit?: string;
}

export type DoseParse =
  | { readonly ok: true; readonly dose: DoseSpec }
  | { readonly ok: false; readonly reason: string; readonly input: string };

/** A number, optionally followed by a unit. Deliberately strict — no ranges, no "1-2 tabs". */
const DOSE_PATTERN = /^([0-9]*\.?[0-9]+)\s*([A-Za-zµμ%/][A-Za-z0-9µμ%/]*)?$/;

/**
 * Read a dose string exactly, or refuse it.
 *
 * Accepts `800 mg`, `800mg`, `0.25 mcg`, `10000` (bare number, no unit).
 * Rejects `1-2 tabs`, `~500`, `800 mg daily`, `'two tablets'`.
 */
export function parseDose(text: string): DoseParse {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, reason: 'empty-dose', input: text };

  const match = DOSE_PATTERN.exec(trimmed);
  if (!match) return { ok: false, reason: 'unparseable-dose', input: text };

  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return { ok: false, reason: 'dose-not-numeric', input: text };

  const unit = match[2];
  return { ok: true, dose: unit ? { amount, unit } : { amount } };
}

/** A dose the write path would not accept. Refuses the write rather than guessing. */
export class UnparseableDoseError extends Error {
  readonly input: string;
  readonly reason: string;
  constructor(input: string, reason: string) {
    super(
      `Refusing to write dose ${JSON.stringify(input)} (${reason}). The dose must be a number optionally ` +
        `followed by a unit (e.g. "800 mg"); correct the emitter rather than letting the write path guess.`,
    );
    this.name = 'UnparseableDoseError';
    this.input = input;
    this.reason = reason;
  }
}

/** Parse or throw. Used on the write path. */
export function requireDose(text: string): DoseSpec {
  const parsed = parseDose(text);
  if (!parsed.ok) throw new UnparseableDoseError(parsed.input, parsed.reason);
  return parsed.dose;
}
