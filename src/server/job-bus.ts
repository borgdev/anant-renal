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

// Pluggable durable-job bus.
//
// Agents, event dispatch, and metering all speak this port. Drivers land
// underneath: BullMQ (Redis, single region), Kafka (multi-region, partitioned
// replay), and InProcess (synchronous, tests). Selection happens at boot via
// HH_JOBBUS_DRIVER, and no runtime code changes when the driver flips.
//
// Semantics every driver must honor:
//   • at-least-once delivery, idempotent handlers via `idempotencyKey`
//   • FIFO within a partition key (defaults to `${scopeId}:${subjectId}`)
//   • dead-letter queue after `maxAttempts` with exponential backoff
//   • `replay(kind, fromCursor?)` reprocesses history without dropping live traffic
//   • trace-id propagation through the job envelope

export interface DurableJobHandler<T = unknown> {
  readonly kind: string;
  handle(payload: T, ctx: JobContext): Promise<void>;
  compensate?(payload: T, ctx: JobContext, error: Error): Promise<void>;
}

export interface JobContext {
  readonly traceId: string;
  readonly attempt: number;
  readonly enqueuedAt: string;
  readonly idempotencyKey: string;
  readonly partitionKey?: string;
}

export interface EnqueueOptions {
  readonly idempotencyKey: string;
  readonly traceId?: string;
  readonly partitionKey?: string;
  readonly delayMs?: number;
  readonly maxAttempts?: number;
  readonly backoffBaseMs?: number;
}

export interface JobHandle {
  readonly jobId: string;
  readonly kind: string;
  readonly enqueuedAt: string;
}

export interface JobBus {
  registerHandler<T>(handler: DurableJobHandler<T>): void;
  enqueue<T>(kind: string, payload: T, opts: EnqueueOptions): Promise<JobHandle>;
  start(): Promise<void>;
  stop(): Promise<void>;
  deadLetterSize(): Promise<number>;
  replay(kind: string, opts?: { fromCursor?: string; maxItems?: number }): Promise<number>;
  driverName(): 'bullmq' | 'kafka' | 'inprocess';
}

export class JobBusError extends Error {
  constructor(message: string) { super(message); this.name = 'JobBusError'; }
}
