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

import type { NavTarget } from "./types";

export type WorkflowTone = "neutral" | "mint" | "amber" | "red" | "blue" | "violet";
export type WorkflowStepState = "done" | "current" | "pending" | "blocked";

export type WorkflowDetail = {
  id: string;
  kind: string;
  title: string;
  summary: string;
  status: string;
  tone?: WorkflowTone;
  owner: string;
  scope: string;
  due?: string;
  metrics?: Array<{ label: string; value: string; detail?: string }>;
  evidence?: Array<{ label: string; value: string; source?: string }>;
  activity?: Array<{ time: string; title: string; detail: string; state?: WorkflowStepState }>;
  steps?: Array<{ label: string; detail: string; state: WorkflowStepState }>;
  control?: string;
  primary?: { label: string; target: NavTarget };
  security?: {
    serverAssembled: true;
    role: string;
    scope: string;
    purpose: string;
    redactions: string[];
    policyVersion: string;
    configurationVersion: string;
    traceId: string;
  };
};

export type OpenWorkflowDetail = (detail: WorkflowDetail) => void;
