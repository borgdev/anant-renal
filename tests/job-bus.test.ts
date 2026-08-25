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

import { describe, expect, it } from 'vitest';
import { InProcessJobBus } from '../src/server/inprocess-job-bus.js';
import type { DurableJobHandler } from '../src/server/job-bus.js';

describe('InProcessJobBus', () => {
  it('executes a handler and yields success', async () => {
    const bus = new InProcessJobBus();
    const seen: unknown[] = [];
    const handler: DurableJobHandler<{ v: number }> = {
      kind: 'test.ok',
      handle: async (p) => { seen.push(p.v); },
    };
    bus.registerHandler(handler);
    await bus.start();
    await bus.enqueue('test.ok', { v: 1 }, { idempotencyKey: 'k1' });
    await bus.enqueue('test.ok', { v: 2 }, { idempotencyKey: 'k2' });
    expect(seen).toEqual([1, 2]);
    await bus.stop();
  });

  it('deduplicates by idempotencyKey', async () => {
    const bus = new InProcessJobBus();
    let calls = 0;
    bus.registerHandler({ kind: 'dup', handle: async () => { calls++; } });
    await bus.start();
    await bus.enqueue('dup', {}, { idempotencyKey: 'same' });
    await bus.enqueue('dup', {}, { idempotencyKey: 'same' });
    expect(calls).toBe(1);
    await bus.stop();
  });

  it('retries then dead-letters after maxAttempts', async () => {
    const bus = new InProcessJobBus();
    let calls = 0;
    let compensated = false;
    bus.registerHandler({
      kind: 'fail',
      handle: async () => { calls++; throw new Error('boom'); },
      compensate: async () => { compensated = true; },
    });
    await bus.start();
    await bus.enqueue('fail', {}, { idempotencyKey: 'f1', maxAttempts: 3 });
    expect(calls).toBe(3);
    expect(compensated).toBe(true);
    expect(await bus.deadLetterSize()).toBe(1);
    await bus.stop();
  });

  it('replay reruns handler over prior jobs of a kind', async () => {
    const bus = new InProcessJobBus();
    const seen: number[] = [];
    bus.registerHandler({ kind: 'r', handle: async (p) => { seen.push((p as { v: number }).v); } });
    await bus.start();
    await bus.enqueue('r', { v: 1 }, { idempotencyKey: 'a' });
    await bus.enqueue('r', { v: 2 }, { idempotencyKey: 'b' });
    expect(seen).toEqual([1, 2]);
    const replayed = await bus.replay('r');
    expect(replayed).toBe(2);
    expect(seen).toEqual([1, 2, 1, 2]);
    await bus.stop();
  });

  it('drives partitioned ordering (serial per partitionKey)', async () => {
    const bus = new InProcessJobBus();
    const order: string[] = [];
    bus.registerHandler({ kind: 'p', handle: async (p) => { order.push((p as { l: string }).l); } });
    await bus.start();
    // Two partitions; each internally FIFO. Order across partitions is not
    // guaranteed but within a partition it must be preserved.
    await bus.enqueue('p', { l: 'a1' }, { idempotencyKey: 'a1', partitionKey: 'A' });
    await bus.enqueue('p', { l: 'a2' }, { idempotencyKey: 'a2', partitionKey: 'A' });
    await bus.enqueue('p', { l: 'b1' }, { idempotencyKey: 'b1', partitionKey: 'B' });
    const aIdx = [order.indexOf('a1'), order.indexOf('a2')];
    expect(aIdx[0]).toBeLessThan(aIdx[1]!);
    await bus.stop();
  });

  it('driverName is "inprocess"', () => {
    expect(new InProcessJobBus().driverName()).toBe('inprocess');
  });
});
