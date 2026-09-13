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

export type SubjectType = "patient" | "facility" | "cohort" | "submission";
export type ActionClass = "A" | "B" | "C" | "D";
export type RuntimeRole = "evp" | "dvp" | "rod" | "fa" | "medical" | "quality" | "finance" | "biomed";

export interface CanonicalEvent {
  eventId: string;
  eventType: string;
  schemaVersion: string;
  tenantId: string;
  subject: { type: SubjectType; id: string };
  purpose: string;
  validTime: string;
  recordedTime: string;
  correlationId?: string;
  causationId?: string;
  source: { system: string; resource: string; version?: string };
  integrity: { algorithm: "sha256"; contentHash: string };
  classification?: string[];
  payload: Record<string, unknown>;
}

export interface ReplayEventSeed extends Omit<CanonicalEvent, "integrity"> {
  integrity?: CanonicalEvent["integrity"];
}

export interface CellProposal {
  agentId: string;
  proposalType: string;
  summary: string;
  confidenceBasisPoints: number;
  action: string;
  actionClass: ActionClass;
  ownerRole: RuntimeRole;
  conflictGroup?: string;
  abstentionReason?: string;
}

export interface RuntimeNba {
  id: string;
  episodeId?: string;
  rank: number;
  title: string;
  outcome: string;
  scopeId: string;
  ownerRole: RuntimeRole;
  dueAt: string;
  valueLabel: string;
  confidenceBasisPoints: number;
  actionClass: ActionClass;
  evidenceCount: number;
  agentIds: string[];
  audience: RuntimeRole[];
  status: "queued" | "review" | "blocked";
  policyReasons: string[];
}

export interface RuntimeInsight {
  id: string;
  episodeId?: string;
  title: string;
  summary: string;
  scopeId: string;
  confidenceBasisPoints: number;
  state: string;
  agentIds: string[];
  conflicts: string[];
}
