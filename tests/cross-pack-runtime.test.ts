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

// Cross-pack step 4 — the two actions that had no implementation.
//
// `x:hospitalization->payer-auth` declares three actions. `audit` ran; the other
// two were reported `executed: false` with the reason "needs the coordinator and
// a pack queue that do not exist yet", so a hand-off could be declared, validated,
// listed on the route, and inert. These tests are about the difference between a
// hand-off that is DECLARED and one that ARRIVED.
//
// The property that matters most here is the one that is easy to lose while
// implementing: `executed: true` has to mean "the write landed". Reporting success
// for a queue entry that was not written is the same defect as the one being
// fixed, one layer in and harder to see, because the log now says it worked.

import { describe, expect, it, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  crossPackRouterFromManifests,
  handleCrossPackEvent,
  resetCrossPackFirings,
} from '../src/control-plane/cross-pack-workflows.js';
import {
  CrossPackRuntime,
  CASE_KIND,
  NOTIFICATION_KIND,
  type CrossPackPersistence,
} from '../src/control-plane/cross-pack-runtime.js';
import { loadPackManifests, type PackManifest } from '../src/control-plane/pack-manifest.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const installed = (): readonly PackManifest[] => loadPackManifests(REPO_ROOT).manifests;

/** A `swarm_workspace`-shaped store, in memory. The runtime only needs the two
 *  methods it actually calls, which is why the seam is structural. */
function memoryPersistence(): CrossPackPersistence & { rows: Map<string, string> } {
  const rows = new Map<string, string>();
  const key = (kind: string, id: string): string => `${kind}::${id}`;
  return {
    rows,
    async saveWorkspace(row) {
      rows.set(key(row.kind, row.id), row.entityJson);
    },
    async listWorkspace(kind) {
      return [...rows.entries()]
        .filter(([k]) => (kind ? k.startsWith(`${kind}::`) : true))
        .map(([k, entityJson]) => {
          const [rowKind = '', id = ''] = k.split('::');
          return { kind: rowKind, id, entityJson, createdAt: '', updatedAt: '' };
        });
    },
  };
}

/** Deterministic ids, so a test can name the record it expects back. */
function ids(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `id-${n}`;
  };
}

beforeEach(() => {
  resetCrossPackFirings();
});

describe('step 4 — notify-pack reaches the target pack', () => {
  it('enqueues the hand-off for the target pack and reports it executed', async () => {
    // The whole point: `executed: true` because the queue entry exists, not
    // because a handler was registered.
    const { router } = crossPackRouterFromManifests(installed());
    const runtime = new CrossPackRuntime({ nextId: ids() });
    const fired = await handleCrossPackEvent(
      router,
      { type: 'hospitalization.admitted', id: 'evt-1' },
      runtime.handlers(),
    );
    const notify = fired[0]?.outcomes.find((o) => o.kind === 'notify-pack');
    expect(notify?.executed).toBe(true);

    // And the entry is really there, addressed to the pack that must act.
    const payer = runtime.notifications('payer');
    expect(payer).toHaveLength(1);
    expect(payer[0]?.workflowId).toBe('utilization-management.re-review');
    expect(payer[0]?.handoffId).toBe('x:hospitalization->payer-auth');
    expect(payer[0]?.state).toBe('pending');
    // Carrying the event that caused it: a hand-off with no cause attached is not
    // actionable by the pack that receives it.
    expect(payer[0]?.eventId).toBe('evt-1');
    expect(payer[0]?.eventType).toBe('hospitalization.admitted');
  });

  it('keeps each pack to its own queue, and routes the case separately', async () => {
    // A target pack polling everything would make "who was told" unanswerable.
    //
    // The second assertion is the more interesting one: inside a SINGLE hand-off
    // the queue entry and the case can go to different packs — a denied auth asks
    // the PROVIDER to reschedule while opening an appeals case on the PAYER side.
    // A runtime that keyed both on one pack would get that backwards and would
    // still look correct in every single-action test.
    const { router } = crossPackRouterFromManifests(installed());
    const runtime = new CrossPackRuntime({ nextId: ids() });
    await handleCrossPackEvent(router, { type: 'hospitalization.admitted' }, runtime.handlers());
    await handleCrossPackEvent(router, { type: 'prior-auth.denied' }, runtime.handlers());

    expect(runtime.notifications('payer').map((n) => n.handoffId))
      .toEqual(['x:hospitalization->payer-auth']);
    expect(runtime.notifications('dialysis-provider').map((n) => n.workflowId))
      .toEqual(['scheduling.recovery']);
    // Nothing was addressed to a pack that declares none of these hand-offs.
    expect(runtime.notifications('oncology-provider')).toEqual([]);
    // And the unfiltered view is the whole truth, not a pack's slice of it.
    expect(runtime.notifications()).toHaveLength(2);

    // The two hand-offs route their CASES to different packs again: care-management
    // from the hospitalization, payer from the denial.
    expect(runtime.cases({ packId: 'care-management' }).map((c) => c.caseKind)).toEqual(['transitions-of-care']);
    expect(runtime.cases({ packId: 'payer' }).map((c) => c.caseKind)).toEqual(['appeals-internal-first']);
  });

  it('claims a queue entry rather than deleting it', async () => {
    // A queue you can only empty has no answer to "was this picked up?" — and the
    // difference between piling up and being worked is the only thing the queue is
    // for.
    const { router } = crossPackRouterFromManifests(installed());
    const runtime = new CrossPackRuntime({ nextId: ids() });
    await handleCrossPackEvent(router, { type: 'hospitalization.admitted' }, runtime.handlers());
    const id = runtime.notifications('payer')[0]!.id;

    const claimed = await runtime.claim(id);
    expect(claimed?.state).toBe('claimed');
    expect(claimed?.claimedAt).toBeTruthy();
    expect(runtime.notifications('payer')).toHaveLength(1);
    expect(runtime.notifications('payer', 'pending')).toEqual([]);
    expect(runtime.notifications('payer', 'claimed')).toHaveLength(1);
    // Claiming twice is not an error and does not move the timestamp.
    expect((await runtime.claim(id))?.claimedAt).toBe(claimed?.claimedAt);
  });
});

describe('step 4 — open-case opens something durable', () => {
  it('opens a case with an id, an owner and the workflow SLA', async () => {
    const { router } = crossPackRouterFromManifests(installed());
    const runtime = new CrossPackRuntime({ nextId: ids() });
    const fired = await handleCrossPackEvent(
      router,
      { type: 'hospitalization.admitted', id: 'evt-9' },
      runtime.handlers(),
    );
    expect(fired[0]?.outcomes.find((o) => o.kind === 'open-case')?.executed).toBe(true);

    const opened = runtime.cases({ packId: 'care-management' });
    expect(opened).toHaveLength(1);
    expect(opened[0]?.caseKind).toBe('transitions-of-care');
    expect(opened[0]?.state).toBe('open');
    expect(opened[0]?.eventId).toBe('evt-9');
    // The SLA belongs to the hand-off, not the individual case: a workflow that
    // promises a re-review in 24 hours promises it for every case it opens.
    expect(opened[0]?.slaHours).toBe(24);
  });

  it('closes explicitly, because a case nobody answered is not an answered one', async () => {
    const { router } = crossPackRouterFromManifests(installed());
    const runtime = new CrossPackRuntime({ nextId: ids() });
    await handleCrossPackEvent(router, { type: 'hospitalization.admitted' }, runtime.handlers());
    const id = runtime.cases()[0]!.id;

    expect((await runtime.closeCase(id))?.state).toBe('closed');
    expect(runtime.cases({ state: 'open' })).toEqual([]);
    expect(runtime.cases({ state: 'closed' })).toHaveLength(1);
    expect(await runtime.closeCase('no-such-case')).toBeUndefined();
  });

  it('keeps the case log across a restart', async () => {
    // Persisting without refilling would be worse than not persisting: the record
    // would exist in the database and be invisible on every screen, so a case
    // would look like it had been silently dropped.
    const { router } = crossPackRouterFromManifests(installed());
    const store = memoryPersistence();

    const first = new CrossPackRuntime({ persistence: store, nextId: ids() });
    await handleCrossPackEvent(router, { type: 'hospitalization.admitted' }, first.handlers());
    const caseId = first.cases()[0]!.id;
    expect(store.rows.size).toBe(2);

    // A fresh process: nothing in memory, everything in the store.
    const second = new CrossPackRuntime({ persistence: store });
    expect(second.cases()).toEqual([]);
    const hydrated = await second.hydrate();
    expect(hydrated).toEqual({ notifications: 1, cases: 1 });
    expect(second.getCase(caseId)?.state).toBe('open');
    expect(second.notifications('payer')).toHaveLength(1);
  });

  it('reports a memory-only runtime instead of implying durability', async () => {
    const runtime = new CrossPackRuntime();
    expect(runtime.durable).toBe(false);
    expect(await runtime.hydrate()).toEqual({ notifications: 0, cases: 0 });
  });
});

describe('step 4 — a write that fails is not reported as a success', () => {
  it('does not fail the whole hand-off when one write misses, but records it', async () => {
    // The event DID fire and the other actions DID run. Rejecting the whole thing
    // because a queue write missed would drop a case that could have been opened —
    // so the failure is recorded and surfaced, and `executed` stays truthful
    // about the in-process record the route reads.
    const { router } = crossPackRouterFromManifests(installed());
    const failing: CrossPackPersistence = {
      async saveWorkspace() { throw new Error('store unavailable'); },
      async listWorkspace() { return []; },
    };
    const runtime = new CrossPackRuntime({ persistence: failing, nextId: ids() });
    const fired = await handleCrossPackEvent(router, { type: 'hospitalization.admitted' }, runtime.handlers());

    // `handlers()` deliberately omits `onAudit` — the audit line belongs to the
    // caller's telemetry — so the actionable pair is what must read as executed.
    const actionable = fired[0]?.outcomes.filter((o) => o.kind !== 'audit') ?? [];
    expect(actionable).toHaveLength(2);
    expect(actionable.every((o) => o.executed)).toBe(true);
    expect(runtime.durableWriteErrors()).toHaveLength(2);
    expect(runtime.durableWriteErrors()[0]).toContain('store unavailable');
    // Still readable in-process, which is why the route does not await SQL.
    expect(runtime.notifications('payer')).toHaveLength(1);
  });

  it('reports an action whose handler THREW as not executed, with the reason', async () => {
    // Distinct from the case above: here the action itself failed, so saying it
    // executed would be a lie about the hand-off rather than a caveat about
    // storage.
    const { router } = crossPackRouterFromManifests(installed());
    const fired = await handleCrossPackEvent(router, { type: 'hospitalization.admitted' }, {
      onAudit: () => { /* ok */ },
      onNotify: () => { throw new Error('pack queue offline'); },
      onOpenCase: () => { /* ok */ },
    });
    const notify = fired[0]?.outcomes.find((o) => o.kind === 'notify-pack');
    expect(notify?.executed).toBe(false);
    expect(notify?.detail).toContain('pack queue offline');
    // The other two still ran: one pack's failure must not drop its siblings.
    expect(fired[0]?.outcomes.find((o) => o.kind === 'audit')?.executed).toBe(true);
    expect(fired[0]?.outcomes.find((o) => o.kind === 'open-case')?.executed).toBe(true);
  });

  it('awaits an async handler before claiming it executed', async () => {
    // The ordering property, and the reason the handlers are allowed to be async:
    // a case reported as open before the write lands is the same defect as a
    // hand-off that does nothing, hidden behind a log line that says it worked.
    const { router } = crossPackRouterFromManifests(installed());
    const runtime = new CrossPackRuntime({ nextId: ids() });
    let settled = false;
    const fired = await handleCrossPackEvent(router, { type: 'hospitalization.admitted' }, {
      onOpenCase: async () => {
        await Promise.resolve();
        await runtime.openCase(
          { kind: 'open-case', packId: 'care-management', caseKind: 'transitions-of-care', payload: {} },
          { id: 'w', trigger: { eventType: 'x', sourcePackId: 'y' }, requiredScopes: [], actions: [] },
          { eventType: 'hospitalization.admitted', at: 'now' },
        );
        settled = true;
      },
    });
    expect(settled).toBe(true);
    expect(fired[0]?.outcomes.find((o) => o.kind === 'open-case')?.executed).toBe(true);
    expect(runtime.cases()).toHaveLength(1);
  });
});

describe('step 4 — the persisted records are the ones the route reads', () => {
  it('stores under the kinds the route queries', async () => {
    const { router } = crossPackRouterFromManifests(installed());
    const store = memoryPersistence();
    const runtime = new CrossPackRuntime({ persistence: store, nextId: ids() });
    await handleCrossPackEvent(router, { type: 'hospitalization.admitted' }, runtime.handlers());
    const kinds = [...store.rows.keys()].map((k) => k.split('::')[0]);
    expect(kinds.sort()).toEqual([CASE_KIND, NOTIFICATION_KIND].sort());
  });
});
