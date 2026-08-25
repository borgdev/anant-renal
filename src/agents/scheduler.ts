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

// AgentScheduler — enqueues agent trigger work on the durable JobBus.
//
// The AgentRuntime docs say: "A trigger arrives on the bus, a handler resolves
// the spec via the registry, then calls invoke. Cron triggers are scheduled by
// a separate scheduler that also enqueues via the bus." This is that scheduler.
// `registerAgentTriggerHandler` (src/server/job-handlers.ts) is the consumer.

import type { JobBus, JobHandle } from '../server/job-bus.js';

export interface AgentSchedulerOptions {
  readonly bus: JobBus;
  readonly scopeId: string;
  readonly facilityId?: string;
}

export class AgentScheduler {
  constructor(private readonly opts: AgentSchedulerOptions) {}

  /** Enqueue a durable `agent.trigger` job (idempotent per agent + trigger + instant). */
  async enqueueTrigger(
    agentId: string,
    triggerType: string,
    inputs: Record<string, unknown>,
    triggerDetail: Record<string, unknown> = {},
  ): Promise<JobHandle> {
    return this.opts.bus.enqueue('agent.trigger', {
      agentId,
      scopeId: this.opts.scopeId,
      ...(this.opts.facilityId ? { facilityId: this.opts.facilityId } : {}),
      triggerType,
      triggerDetail,
      inputs,
      at: new Date().toISOString(),
    }, {
      idempotencyKey: `agent:${agentId}:${triggerType}:${Date.now()}`,
      partitionKey: `${this.opts.scopeId}:${agentId}`,
    });
  }
}
