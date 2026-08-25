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

// Workflow instances are the durable unit of work in the harness. They are
// idempotent by construction (via `idempotencyKey`) and always carry a trace
// id so audit and observability align. State transitions are explicit; there
// is no ambient state machine.

export type WorkflowState = 'pending' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'quarantined' | 'compensated';

export interface WorkflowException {
  code: string;
  retryable: boolean;
  message: string;
  evidence: Readonly<Record<string, unknown>>;
}

export interface WorkflowInstance {
  id: string;
  definitionId: string;
  idempotencyKey: string;
  state: WorkflowState;
  attempts: number;
  maxAttempts: number;
  traceId: string;
  exception?: WorkflowException;
  scopeId: string;
  createdAt: string;
  updatedAt: string;
}

const LEGAL_TRANSITIONS: Record<WorkflowState, readonly WorkflowState[]> = {
  pending: ['running', 'quarantined'],
  running: ['waiting', 'succeeded', 'failed', 'quarantined'],
  waiting: ['running', 'failed', 'quarantined'],
  succeeded: [],
  failed: ['running', 'compensated'],
  quarantined: ['running', 'compensated'],
  compensated: [],
};

export function canTransition(from: WorkflowState, to: WorkflowState): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export function transition(instance: WorkflowInstance, to: WorkflowState, now: string): WorkflowInstance {
  if (!canTransition(instance.state, to)) {
    throw new Error(`Illegal workflow transition ${instance.state} -> ${to}`);
  }
  return Object.freeze({
    ...instance,
    state: to,
    attempts: to === 'running' ? instance.attempts + 1 : instance.attempts,
    updatedAt: now,
  });
}
