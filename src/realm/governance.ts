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

// M14.C — Governance / directive ledger
//
// Append-only view over `operator-directive` and `advance-plan` audit effects
// that already live in the effect ledger. This module is a QUERY surface — it
// doesn't create new storage; every entry is derived from the ledger so we can
// never disagree with the underlying reality.
//
// Governance entries can attach counterfactual evidence (recorded separately
// via CounterfactualStore) to give operators a "why" behind an intervention.

import type { Realm } from './realm.js';
import type { EmittedEffect } from './types.js';

export interface DirectiveEntry {
  effectId: string;
  at: string;
  presenceId: string;
  verb: string;
  targetRef?: string;
  payload: Record<string, unknown>;
  originalText: string;
  evidenceId?: string; // optional link into CounterfactualStore
}

export interface PlanAdvanceEntry {
  effectId: string;
  at: string;
  planId: string;
  stepId: string;
  outcome: string;
  note?: string;
  presenceId: string;
}

export interface GovernanceQueryFilter {
  presenceId?: string;
  verb?: string;
  planId?: string;
  since?: string; // ISO
  until?: string;
}

function inWindow(at: string, since?: string, until?: string): boolean {
  if (since && at < since) return false;
  if (until && at > until) return false;
  return true;
}

/** Extract every operator-directive from a realm's ledger, newest last. */
export function listDirectives(realm: Realm, filter: GovernanceQueryFilter = {}): DirectiveEntry[] {
  const out: DirectiveEntry[] = [];
  for (const e of realm.ledger.listAll()) {
    if (e.status === 'rejected') continue;
    if (e.effect.kind !== 'operator-directive') continue;
    const eff = e.effect as { verb: string; targetRef?: string; payload: Record<string, unknown>; originalText: string; evidenceId?: string };
    if (filter.verb && eff.verb !== filter.verb) continue;
    if (filter.presenceId && e.presenceId !== filter.presenceId) continue;
    if (!inWindow(e.realmAt, filter.since, filter.until)) continue;
    const entry: DirectiveEntry = {
      effectId: e.effectId,
      at: e.realmAt,
      presenceId: e.presenceId,
      verb: eff.verb,
      payload: eff.payload,
      originalText: eff.originalText,
    };
    if (eff.targetRef !== undefined) entry.targetRef = eff.targetRef;
    if (eff.evidenceId !== undefined) entry.evidenceId = eff.evidenceId;
    out.push(entry);
  }
  return out;
}

/** Extract every plan-advance event, useful for auditing a plan run. */
export function listPlanAdvances(realm: Realm, filter: GovernanceQueryFilter = {}): PlanAdvanceEntry[] {
  const out: PlanAdvanceEntry[] = [];
  for (const e of realm.ledger.listAll()) {
    if (e.status === 'rejected') continue;
    if (e.effect.kind !== 'advance-plan') continue;
    const eff = e.effect as { planId: string; stepId: string; outcome: string; note?: string };
    if (filter.planId && eff.planId !== filter.planId) continue;
    if (filter.presenceId && e.presenceId !== filter.presenceId) continue;
    if (!inWindow(e.realmAt, filter.since, filter.until)) continue;
    const entry: PlanAdvanceEntry = {
      effectId: e.effectId,
      at: e.realmAt,
      planId: eff.planId,
      stepId: eff.stepId,
      outcome: eff.outcome,
      presenceId: e.presenceId,
    };
    if (eff.note !== undefined) entry.note = eff.note;
    out.push(entry);
  }
  return out;
}

/** Group directives by targeted presence — useful for the "who tuned my agent?" view. */
export function directivesByTarget(realm: Realm): Record<string, DirectiveEntry[]> {
  const grouped: Record<string, DirectiveEntry[]> = {};
  for (const d of listDirectives(realm)) {
    const key = (d.payload as { presenceId?: string }).presenceId ?? d.targetRef ?? '(no-target)';
    (grouped[key] ??= []).push(d);
  }
  return grouped;
}

/** Attach evidence — mutates the underlying effect payload. Best-effort provenance. */
export function attachEvidence(ledgerEntry: EmittedEffect, evidenceId: string): void {
  if (ledgerEntry.effect.kind !== 'operator-directive') throw new Error('attach-evidence-invalid: not a directive');
  (ledgerEntry.effect as { evidenceId?: string }).evidenceId = evidenceId;
}
