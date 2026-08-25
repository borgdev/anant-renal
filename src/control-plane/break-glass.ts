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

// Break-glass emergency-access ledger. The AccessEvaluator already accepts
// an emergency flag; break-glass adds an *append-only ledger* that captures
// the reason, the elevated scope, the duration, and the post-event review
// status. Zero-trust posture requires that every emergency grant be
// justifiable and reviewable.

export interface BreakGlassGrant {
  readonly id: string;
  readonly requestedAt: string;
  readonly actorRef: string;
  readonly patientRef: string;
  readonly reason: string;
  readonly clinicalNecessityStatement: string;
  readonly elevatedScopeIds: readonly string[];
  readonly maxDurationMinutes: number;
  readonly expiresAt: string;
  readonly approvedBy?: string; // if pre-approval required
  readonly reviewedAt?: string;
  readonly reviewOutcome?: 'appropriate' | 'requires-training' | 'policy-violation';
  readonly reviewerRef?: string;
}

export class BreakGlassLedger {
  private readonly entries = new Map<string, BreakGlassGrant>();

  request(input: Omit<BreakGlassGrant, 'id' | 'expiresAt'>): BreakGlassGrant {
    const requestedMs = Date.parse(input.requestedAt);
    const expiresAt = new Date(requestedMs + input.maxDurationMinutes * 60000).toISOString();
    const grant: BreakGlassGrant = {
      id: `bg:${input.actorRef}:${input.patientRef}:${input.requestedAt}`,
      expiresAt,
      ...input,
    };
    this.entries.set(grant.id, grant);
    return grant;
  }

  review(id: string, reviewerRef: string, outcome: NonNullable<BreakGlassGrant['reviewOutcome']>, at: string): BreakGlassGrant {
    const e = this.entries.get(id);
    if (!e) throw new Error(`Break-glass grant not found: ${id}`);
    const updated: BreakGlassGrant = { ...e, reviewerRef, reviewOutcome: outcome, reviewedAt: at };
    this.entries.set(id, updated);
    return updated;
  }

  active(now: string): readonly BreakGlassGrant[] {
    const t = Date.parse(now);
    return Array.from(this.entries.values()).filter((e) => Date.parse(e.expiresAt) > t && !e.reviewedAt);
  }

  unreviewed(): readonly BreakGlassGrant[] {
    return Array.from(this.entries.values()).filter((e) => !e.reviewedAt);
  }

  list(): readonly BreakGlassGrant[] { return Array.from(this.entries.values()); }
}
