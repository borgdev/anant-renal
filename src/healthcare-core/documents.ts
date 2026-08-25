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

// Document ingestion + policy-to-rule-candidate compiler.
//
// Regulatory + payer + facility policy content arrives as documents (PDFs,
// DOCX, HTML). The harness models a document as:
//   - source-typed
//   - versioned (semver-ish or CMS revision code)
//   - effective-dated
//   - authority-ranked (CFR > CMS Manual > payer bulletin > facility SOP)
//
// After OCR/plain-text extraction, a compiler scans the text for
// obligation-shaped sentences ("must", "shall", "may not", numeric thresholds,
// timeframes) and emits *rule candidates* — never live rules. A human or
// downstream agent must approve candidates before they enter a pack.

export type DocumentAuthorityKind =
  | 'statute' // e.g. Social Security Act
  | 'regulation' // CFR
  | 'cms-manual'
  | 'cms-transmittal'
  | 'cms-guidance'
  | 'payer-policy'
  | 'facility-sop'
  | 'clinical-guideline'
  | 'internal-standard';

export interface IngestedDocument {
  readonly id: string;
  readonly authority: DocumentAuthorityKind;
  readonly title: string;
  readonly citation?: string; // e.g. "42 CFR Part 494"
  readonly version: string;
  readonly effectiveFrom: string;
  readonly effectiveTo?: string;
  readonly steward: string; // e.g. "CMS", "HHS OIG", "Aetna"
  readonly url?: string;
  readonly text: string; // extracted plain text
  readonly ingestedAt: string;
  readonly sha256?: string; // integrity hash of the source binary
}

export interface CompiledRuleCandidate {
  readonly id: string;
  readonly documentId: string;
  readonly excerpt: string;
  readonly obligationVerb: string; // "must", "shall", "may not", etc.
  readonly numericHints: readonly { readonly value: number; readonly unit?: string }[];
  readonly timeframeHints: readonly string[];
  readonly authority: DocumentAuthorityKind;
  readonly effectiveFrom: string;
  readonly approvalStatus: 'candidate' | 'approved' | 'rejected';
}

const obligationVerbs = ['must', 'shall', 'may not', 'must not', 'shall not', 'is required to', 'is prohibited from'];
const numRe = /(\d+(?:\.\d+)?)(?:\s*(hours?|minutes?|days?|weeks?|months?|years?|mg|mL|mEq|mmHg|kg|percent|%))?/g;
const timeframeRe = /(within \d+\s*(?:hours?|days?|business days?|weeks?|months?)|per (?:day|week|month|treatment)|every \d+\s*(?:hours?|days?|weeks?|months?))/gi;

export function extractObligations(text: string): { sentence: string; verb: string }[] {
  const sentences = text.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/);
  const results: { sentence: string; verb: string }[] = [];
  for (const s of sentences) {
    const lower = s.toLowerCase();
    for (const v of obligationVerbs) {
      if (lower.includes(v)) {
        results.push({ sentence: s.trim(), verb: v });
        break;
      }
    }
  }
  return results;
}

export function compileRuleCandidates(doc: IngestedDocument): CompiledRuleCandidate[] {
  const obligations = extractObligations(doc.text);
  return obligations.map((o, i) => {
    const nums: { value: number; unit?: string }[] = [];
    let m: RegExpExecArray | null;
    numRe.lastIndex = 0;
    while ((m = numRe.exec(o.sentence)) !== null) {
      const value = Number(m[1]);
      if (Number.isFinite(value)) {
        const entry: { value: number; unit?: string } = { value };
        if (m[2]) entry.unit = m[2];
        nums.push(entry);
      }
    }
    const timeframes: string[] = [];
    timeframeRe.lastIndex = 0;
    while ((m = timeframeRe.exec(o.sentence)) !== null) {
      if (m[1]) timeframes.push(m[1]);
    }
    return {
      id: `rc:${doc.id}:${i}`,
      documentId: doc.id,
      excerpt: o.sentence.length > 400 ? o.sentence.slice(0, 400) + '…' : o.sentence,
      obligationVerb: o.verb,
      numericHints: nums,
      timeframeHints: timeframes,
      authority: doc.authority,
      effectiveFrom: doc.effectiveFrom,
      approvalStatus: 'candidate',
    };
  });
}

/** Authority ranking used to break conflicts when multiple rules apply. */
export const authorityRank: Record<DocumentAuthorityKind, number> = {
  statute: 100,
  regulation: 90,
  'cms-manual': 80,
  'cms-transmittal': 75,
  'cms-guidance': 70,
  'payer-policy': 60,
  'clinical-guideline': 50,
  'facility-sop': 40,
  'internal-standard': 20,
};
