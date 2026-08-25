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

// Default durable JobBus handlers (Phase 0 wiring).
//
// The JobBus port existed but nothing registered handlers in production; these
// bridge the bus to the rest of the platform so durable work actually flows.

import type { CanonicalEvent } from '../healthcare-core/events.js';
import type { JobBus } from './job-bus.js';
import type { EventOutbox } from './event-outbox.js';
import type { EventBroker } from './event-broker.js';
import type { RetentionService } from './retention.js';
import type { AlertService, MetricSnapshot } from './alerts.js';

/** Durable handler that forwards a canonical event to the broker via the outbox. */
export function registerEventFanoutHandler(bus: JobBus, outbox: EventOutbox, broker: EventBroker): void {
  bus.registerHandler<{ event: CanonicalEvent }>({
    kind: 'event.fanout',
    handle: async (payload) => {
      await outbox.enqueue(payload.event);
      await outbox.flush(broker);
    },
  });
}

/** Durable liveness handler — proves the register→enqueue→handle loop is live. */
export function registerHeartbeatHandler(bus: JobBus, log: (message: string) => void): void {
  bus.registerHandler<{ at: string }>({
    kind: 'system.heartbeat',
    handle: async (payload) => { log(`[job-bus] heartbeat @ ${payload.at}`); },
  });
}

// ---- Real durable handlers (Phase 0 completion) ----

/** Durable handler that backs up a realm snapshot to the durable store. */
export interface SnapshotBackupJob { realmId: string; at: string; }
export function registerSnapshotBackupHandler(bus: JobBus, backup: (realmId: string) => Promise<void>): void {
  bus.registerHandler<SnapshotBackupJob>({
    kind: 'snapshot.backup',
    handle: async (payload) => { await backup(payload.realmId); },
  });
}

/** Durable handler that runs a knowledge source sync; throws on failure → DLQ. */
export interface KnowledgeSyncJob { sourceId: string; actor?: string; }
export function registerKnowledgeSyncHandler(
  bus: JobBus,
  sync: (sourceId: string, actor?: string) => Promise<{ ok: boolean; error?: string }>,
): void {
  bus.registerHandler<KnowledgeSyncJob>({
    kind: 'knowledge.sync',
    handle: async (payload) => {
      const r = await sync(payload.sourceId, payload.actor);
      if (!r.ok) throw new Error(`knowledge.sync ${payload.sourceId}: ${r.error ?? 'failed'}`);
    },
  });
}

/** Durable handler that invokes an agent on a trigger (resolved via the runtime). */
export interface AgentTriggerJob {
  agentId: string;
  scopeId: string;
  facilityId?: string;
  triggerType: string;
  triggerDetail: Record<string, unknown>;
  inputs: Record<string, unknown>;
}
export type AgentInvoke = (payload: AgentTriggerJob) => Promise<void>;
export function registerAgentTriggerHandler(bus: JobBus, invoke: AgentInvoke): void {
  bus.registerHandler<AgentTriggerJob>({
    kind: 'agent.trigger',
    handle: async (payload) => { await invoke(payload); },
  });
}

// ---- Phase 4 — retention + alert evaluation ----

/** Durable handler that applies retention policies (purges expired rows). */
export function registerRetentionPurgeHandler(bus: JobBus, retention: RetentionService): void {
  bus.registerHandler<{ at?: string }>({
    kind: 'retention.purge',
    handle: async () => { await retention.purge(); },
  });
}

/** Durable handler that evaluates alert rules against a metric snapshot. */
export function registerAlertEvaluateHandler(bus: JobBus, alerts: AlertService, sample: () => Promise<MetricSnapshot>): void {
  bus.registerHandler<{ at?: string }>({
    kind: 'alert.evaluate',
    handle: async () => { await alerts.evaluate(await sample()); },
  });
}


