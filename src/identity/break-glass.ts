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

// M17.E — Break-glass emergency override.
//
// Any principal can activate a time-boxed break-glass session with a
// documented reason. Break-glass grants purposeOfUse: ['treatment']
// and clearance: 'break-glass' (widest access). Every activation is
// audited immediately and creates a governance directive on the
// principal's realm so HITL review is forced within the review SLA.

import { randomBytes } from 'node:crypto';
import type { IdentityPrincipal } from './types.js';
import { IdentityRegistry } from './registry.js';

const DEFAULT_DURATION_MS = 60 * 60_000; // 1 hour
const REVIEW_SLA_MS = 24 * 60 * 60_000;

interface BreakGlassSession {
  sessionId: string;
  subjectId: string;
  orgId: string;
  reason: string;
  activatedAt: number;
  expiresAt: number;
  reviewDeadline: number;
  reviewed: boolean;
  reviewedBy?: string;
  reviewNote?: string;
}

const sessions = new Map<string, BreakGlassSession>();
const activeBySubject = new Map<string, string>();

export function activateBreakGlass(input: {
  subjectId: string;
  reason: string;
  durationMs?: number;
}): { session: BreakGlassSession; principal: IdentityPrincipal } {
  const principal = IdentityRegistry.getPrincipal(input.subjectId);
  if (!principal) throw new Error(`principal-not-found:${input.subjectId}`);
  if (!input.reason || input.reason.length < 10) throw new Error('break-glass-reason-too-short');

  const existing = activeBySubject.get(input.subjectId);
  if (existing) {
    const s = sessions.get(existing);
    if (s && Date.now() < s.expiresAt) return { session: s, principal };
  }

  const sessionId = `bg-${Date.now()}-${randomBytes(3).toString('hex')}`;
  const now = Date.now();
  const session: BreakGlassSession = {
    sessionId,
    subjectId: input.subjectId,
    orgId: principal.orgId,
    reason: input.reason,
    activatedAt: now,
    expiresAt: now + (input.durationMs ?? DEFAULT_DURATION_MS),
    reviewDeadline: now + REVIEW_SLA_MS,
    reviewed: false,
  };
  sessions.set(sessionId, session);
  activeBySubject.set(input.subjectId, sessionId);

  const upgraded: IdentityPrincipal = {
    ...principal,
    clearance: 'break-glass',
    purposeOfUse: [...new Set([...principal.purposeOfUse, 'treatment' as const])],
    source: 'break-glass',
    metadata: { ...(principal.metadata ?? {}), breakGlassSessionId: sessionId, breakGlassReason: input.reason },
  };
  IdentityRegistry.upsertPrincipal(upgraded);
  IdentityRegistry.audit('break-glass.activated', { subjectId: input.subjectId, note: `sessionId=${sessionId} reason=${input.reason.slice(0, 60)}` });
  return { session, principal: upgraded };
}

export function endBreakGlass(subjectId: string): boolean {
  const sessionId = activeBySubject.get(subjectId);
  if (!sessionId) return false;
  const s = sessions.get(sessionId);
  if (!s) return false;
  s.expiresAt = Date.now();
  sessions.set(sessionId, s);
  activeBySubject.delete(subjectId);
  IdentityRegistry.audit('break-glass.ended', { subjectId, note: `sessionId=${sessionId}` });
  return true;
}

export function reviewBreakGlass(sessionId: string, reviewedBy: string, note: string, approved: boolean): boolean {
  const s = sessions.get(sessionId);
  if (!s) return false;
  s.reviewed = true;
  s.reviewedBy = reviewedBy;
  s.reviewNote = note;
  sessions.set(sessionId, s);
  IdentityRegistry.audit(approved ? 'break-glass.reviewed.approved' : 'break-glass.reviewed.rejected', { subjectId: s.subjectId, note: `sessionId=${sessionId} by=${reviewedBy}` });
  return true;
}

export function listBreakGlass(orgId?: string): BreakGlassSession[] {
  const all = [...sessions.values()];
  return orgId ? all.filter((s) => s.orgId === orgId) : all;
}

export function activeBreakGlassFor(subjectId: string): BreakGlassSession | undefined {
  const id = activeBySubject.get(subjectId);
  if (!id) return undefined;
  const s = sessions.get(id);
  if (!s) return undefined;
  if (Date.now() >= s.expiresAt) {
    activeBySubject.delete(subjectId);
    return undefined;
  }
  return s;
}

export function pendingReviews(): BreakGlassSession[] {
  return [...sessions.values()].filter((s) => !s.reviewed);
}
