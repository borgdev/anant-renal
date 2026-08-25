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
import { ModelRouter, DeterministicModelAdapter, ToolRegistry, HarnessRuntime } from '../src/agentic/index.js';
import { AccessEvaluator, AuditLedger } from '../src/control-plane/index.js';
import { OrganizationDirectory } from '../src/kernel/index.js';

describe('ModelRouter', () => {
  it('picks preferred adapter first', async () => {
    const router = new ModelRouter();
    router.register(new DeterministicModelAdapter());
    router.prefer('intent-parse', 'deterministic-local');
    const out = await router.invoke({ task: 'intent-parse', prompt: 'hello', context: {} });
    expect(out.output.startsWith('[intent-parse]')).toBe(true);
  });
});

describe('ToolRegistry', () => {
  it('blocks unauthorized calls and audits them', async () => {
    const dir = new OrganizationDirectory();
    dir.registerOrganization({ id: 'org:a', kind: 'provider', name: 'A', attributes: {} });
    dir.registerPerson({ id: 'person:1', organizationId: 'org:a', displayName: 'P', roles: ['viewer'], attributes: {} });
    dir.registerScope({ id: 'scope:root', kind: 'organization', organizationId: 'org:a', memberIds: ['person:1'], attributes: {} });
    const audit = new AuditLedger();
    const evaluator = new AccessEvaluator(dir, [], []);
    const reg = new ToolRegistry(evaluator, audit);
    reg.register({
      name: 'demo.echo',
      description: 'echo',
      resourceType: 'demo',
      inputSchema: {},
      invoke: async (input) => input,
    });
    const result = await reg.invoke({
      toolName: 'demo.echo',
      input: { hi: 1 },
      request: {
        subject: { id: 'person:1', organizationId: 'org:a', roles: ['viewer'], attributes: {} },
        resource: { id: 'r1', type: 'demo', scopeId: 'scope:root', scopeKind: 'organization', ownerOrganizationId: 'org:a', classification: 'internal', attributes: {} },
        action: 'execute',
        environment: { purposeOfUse: 'demo', managedDevice: true, sessionAgeMinutes: 5, mfaAgeMinutes: 5, now: '2026-08-01' },
      },
      ctx: { traceId: 'trace:1', actorId: 'person:1', scopeId: 'scope:root' },
    });
    expect(result.ok).toBe(false);
    expect(audit.all().length).toBeGreaterThan(0);
  });

  it('runs authorized calls and returns output', async () => {
    const dir = new OrganizationDirectory();
    dir.registerOrganization({ id: 'org:a', kind: 'provider', name: 'A', attributes: {} });
    dir.registerPerson({ id: 'person:1', organizationId: 'org:a', displayName: 'P', roles: ['runner'], attributes: {} });
    dir.registerScope({ id: 'scope:root', kind: 'organization', organizationId: 'org:a', memberIds: ['person:1'], attributes: {} });
    const evaluator = new AccessEvaluator(dir, [{ role: 'runner', actions: ['execute'], resourceTypes: ['demo'] }], []);
    const audit = new AuditLedger();
    const reg = new ToolRegistry(evaluator, audit);
    reg.register({
      name: 'demo.echo',
      description: 'echo',
      resourceType: 'demo',
      inputSchema: {},
      invoke: async (input) => ({ echoed: input }),
    });
    const result = await reg.invoke({
      toolName: 'demo.echo',
      input: { hi: 1 },
      request: {
        subject: { id: 'person:1', organizationId: 'org:a', roles: ['runner'], attributes: {} },
        resource: { id: 'r1', type: 'demo', scopeId: 'scope:root', scopeKind: 'organization', ownerOrganizationId: 'org:a', classification: 'internal', attributes: {} },
        action: 'execute',
        environment: { purposeOfUse: 'demo', managedDevice: true, sessionAgeMinutes: 5, mfaAgeMinutes: 5, now: '2026-08-01' },
      },
      ctx: { traceId: 'trace:1', actorId: 'person:1', scopeId: 'scope:root' },
    });
    expect(result.ok).toBe(true);
    expect((result.output as { echoed: { hi: number } }).echoed.hi).toBe(1);
  });
});

describe('HarnessRuntime', () => {
  it('runs the first matching recipe', async () => {
    const dir = new OrganizationDirectory();
    dir.registerOrganization({ id: 'org:a', kind: 'provider', name: 'A', attributes: {} });
    const evaluator = new AccessEvaluator(dir, [], []);
    const audit = new AuditLedger();
    const registry = new ToolRegistry(evaluator, audit);
    const models = new ModelRouter();
    models.register(new DeterministicModelAdapter());
    const runtime = new HarnessRuntime({
      id: 'test-harness',
      registry,
      models,
      recipes: [{ id: 'hi', matches: () => true, plan: async () => ({ toolCalls: [], output: 'ok', reasoning: 'r' }) }],
      buildAccessRequest: () => ({} as never),
    });
    const plan = await runtime.plan({ scopeId: 'scope:root', actorId: 'p1', input: 'hi', context: {} });
    expect(plan.output).toBe('ok');
  });
});
