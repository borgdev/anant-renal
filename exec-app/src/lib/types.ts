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

export type NavigationId =
  | "my-work"
  | "ecosystem"
  | "agents"
  | "command"
  | "patient"
  | "anemia"
  | "adequacy"
  | "fluid"
  | "vascular-access"
  | "mbd"
  | "nutrition"
  | "infection"
  | "protocol-assurance"
  | "next-session"
  | "round-digest"
  | "protocols"
  | "intelligence"
  | "assessments"
  | "facility"
  | "cms"
  | "executive"
  | "assurance"
  | "platform";

export type OutcomeStatus = "new" | "review" | "ready" | "resolved";

export interface OutcomeEpisode {
  id: string;
  title: string;
  patient: string;
  patientId: string;
  facility: string;
  status: OutcomeStatus;
  urgency: "critical" | "high" | "watch";
  due: string;
  confidence: number;
  signals: string[];
  recommendation: string;
  owner: string;
  evidenceCount: number;
  actionClass: "A" | "B" | "C" | "D";
}

export interface TraceSpan {
  id: string;
  label: string;
  system: string;
  duration: string;
  status: "ok" | "review" | "blocked";
  detail: string;
}

export interface GraphNode {
  id: string;
  label: string;
  type: "enterprise" | "division" | "region" | "facility" | "patient" | "assessment" | "signal" | "cluster" | "cell" | "policy" | "action" | "intervention" | "outcome" | "measure" | "source";
  x: number;
  y: number;
  z: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  relation: string;
}
