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

// Phase 0 completion — JobBus handlers, AgentScheduler, and broker telemetry.

import { describe, expect, it } from 'vitest';
import { InProcessJobBus } from '../src/server/inprocess-job-bus.js';
import { InProcessEventBroker } from '../src/server/inprocess-event-broker.js';
import {
  registerSnapshotBackupHandler, registerKnowledgeSyncHandler, registerAgentTriggerHandler,
  type AgentTriggerJob,
} from '../src/server/job-handlers.js';
import { AgentScheduler } from '../src/agents/scheduler.js';
import { withEventBrokerTelemetry } from '../src/server/broker-telemetry.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import { EVENT_TOPIC_EVENTS } from '../src/server/event-broker.js';

describe('Phase 0 — JobBus handlers', () => {
  it('snapshot.backup invokes the injected backup fn', async () => {
    const bus = new InProcessJobBus();
    await bus.start();
    const backedUp: string[] = [];
    registerSnapshotBackupHandler(bus, async (realmId) => { backedUp.push(realmId); });
    await bus.enqueue('snapshot.backup', { realmId: 'realm:r1', at: new Date().toISOString() }, { idempotencyKey: 'b1' });
    expect(backedUp).toEqual(['realm:r1']);
    await bus.stop();
  });

  it('knowledge.sync runs the sync fn and dead-letters on failure', async () => {
    const bus = new InProcessJobBus();
    await bus.start();
    const calls: string[] = [];
    registerKnowledgeSyncHandler(bus, async (sourceId) => { calls.push(sourceId); return { ok: false, error: 'boom' }; });
    await bus.enqueue('knowledge.sync', { sourceId: 'nlm.rxnorm' }, { idempotencyKey: 'k1', maxAttempts: 1 });
    expect(calls).toEqual(['nlm.rxnorm']);
    expect(await bus.deadLetterSize()).toBe(1);
    await bus.stop();
  });

  it('AgentScheduler enqueues a durable agent.trigger that reaches the handler', async () => {
    const bus = new InProcessJobBus();
    await bus.start();
    const got: AgentTriggerJob[] = [];
    registerAgentTriggerHandler(bus, async (p) => { got.push(p); });
    const sched = new AgentScheduler({ bus, scopeId: 'scope:f1', facilityId: 'f1' });
    await sched.enqueueTrigger('eligibility-check', 'event: referral.received', { patientId: 'p1' }, { from: 'f2' });
    expect(got).toHaveLength(1);
    expect(got[0]?.agentId).toBe('eligibility-check');
    expect(got[0]?.scopeId).toBe('scope:f1');
    expect(got[0]?.facilityId).toBe('f1');
    expect(got[0]?.triggerType).toBe('event: referral.received');
    await bus.stop();
  });
});

describe('Phase 0 — broker telemetry decorator', () => {
  it('emits a publish span + counter and still delivers', async () => {
    const sink = new InMemorySink();
    const telemetry = new Telemetry('test', sink, 'debug');
    const raw = new InProcessEventBroker();
    await raw.start();
    const broker = withEventBrokerTelemetry(raw, telemetry);
    const got: string[] = [];
    await broker.subscribe(
      { topic: EVENT_TOPIC_EVENTS, source: 'test', eventType: 'patient.registered', subjectPath: 'subjectId' },
      async (m) => { got.push(m.value); },
    );
    await broker.publish({ topic: EVENT_TOPIC_EVENTS, event: { id: 'te-1', type: 'patient.registered', occurredAt: new Date().toISOString(), scopeId: 's', subjectId: 'p', facilityId: 'f', payload: {}, provenance: { sourceId: 't', observedAt: new Date().toISOString(), ingestedAt: new Date().toISOString() }, classification: 'phi' } });
    expect(got).toHaveLength(1);
    const spans = sink.records.filter((r) => r.kind === 'span' && r.name.startsWith('broker.publish'));
    const metrics = sink.records.filter((r) => r.kind === 'metric' && r.name === 'broker.event.out');
    expect(spans).toHaveLength(1);
    expect(metrics).toHaveLength(1);
    await broker.stop();
  });
});
