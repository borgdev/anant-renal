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

// G3 — the cross-pack hand-off, from declaration to firing.
//
// The gap was not that the workflows were missing. Three were defined and none of
// them ran: `CrossPackRouter` was constructed only in a test, so a reader of
// `cross-pack-workflows.ts` saw an orchestration plane and a reader of the running
// system saw nothing. This file holds the properties that make the difference:
// which hand-offs run is decided by the packs, and a firing says what it did.
//
// The third workflow is the interesting one, and it is NOT a failure. It triggers
// on `oncology.plan-approved`, which is not a canonical event type in
// `src/healthcare-core/events.ts` and is declared by no pack's event contracts.
// Built from declarations, it therefore does not run — and the honest report says
// why rather than leaving a reader to assume all three are live.

import { describe, expect, it, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  crossPackParticipations,
  crossPackRouterFromManifests,
  handleCrossPackEvent,
  recentCrossPackFirings,
  resetCrossPackFirings,
  seedCrossPackWorkflows,
  type CrossPackWorkflow,
} from '../src/control-plane/cross-pack-workflows.js';
import { loadPackManifests, type PackManifest } from '../src/control-plane/pack-manifest.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const installed = (): readonly PackManifest[] => loadPackManifests(REPO_ROOT).manifests;

/** A manifest in memory — the invariants are about the SET, so a fixture states exactly what it reasons about. */
function manifest(id: string, workflows: readonly { id: string; crossPackWith?: readonly string[] }[]): PackManifest {
  return {
    id,
    version: '1.0.0',
    extends: [],
    appliesTo: { organizationKinds: ['provider'] },
    capabilities: ['x'],
    cmsUniverse: [],
    requiredControls: ['access-policy'],
    specialty: { workflows },
    entry: 'index.ts',
    path: `packs/${id}/manifest.yaml`,
  };
}

beforeEach(() => resetCrossPackFirings());

describe('G3 — the installed packs decide which hand-offs run', () => {
  it('runs the two the packs mutually declare, and reports the third', () => {
    const { running, notRunning } = crossPackRouterFromManifests(installed());
    expect([...running].sort()).toEqual([
      'x:denied-auth->reschedule+appeal',
      'x:hospitalization->payer-auth',
    ]);
    // THREE declarations, two running. The third is named rather than omitted —
    // "a hand-off nobody declared" and "a declared hand-off that cannot run" are
    // different problems and an operator needs to know which one they have.
    expect(notRunning).toHaveLength(1);
    expect(notRunning[0]?.workflowId).toBe('x:oncology-plan->prior-auth');
    expect(notRunning[0]?.code).toBe('undeclared');
    expect(notRunning[0]?.detail).toMatch(/no pack declares/);
  });

  it('does NOT run a workflow only one side declared', () => {
    // The one-sided case the contract already refuses — here through the router,
    // so a hand-off cannot run merely because platform code defines it.
    //
    // `definitions` is narrowed to the one under test on purpose: the fixtures
    // declare one workflow, so the other two SEED definitions are legitimately
    // undeclared in this set and would otherwise appear in `notRunning` for a
    // reason that has nothing to do with what is being asserted.
    const { running, notRunning } = crossPackRouterFromManifests(
      [manifest('dialysis-provider', [{ id: 'x:hospitalization->payer-auth', crossPackWith: ['payer', 'care-management'] }])],
      [seedCrossPackWorkflows.find((w) => w.id === 'x:hospitalization->payer-auth')!],
    );
    expect(running).toEqual([]);
    expect(notRunning.map((i) => i.code)).toEqual(['partial-participation']);
    expect(notRunning[0]?.detail).toMatch(/not every participant agreed/);
  });

  it('runs a hand-off whose participants all declare it, from fixtures alone', () => {
    const { running, notRunning } = crossPackRouterFromManifests([
      manifest('a', [{ id: 'x:a->b', crossPackWith: ['b'] }]),
      manifest('b', [{ id: 'x:a->b', crossPackWith: ['a'] }]),
    ], [{
      id: 'x:a->b',
      trigger: { eventType: 'hospitalization.admitted', sourcePackId: 'a' },
      requiredScopes: [],
      actions: [{ kind: 'notify-pack', packId: 'b', workflowId: 'b.do-something', payload: {} }],
    }]);
    expect(running).toEqual(['x:a->b']);
    expect(notRunning).toEqual([]);
  });

  it('reports a declaration the platform has no definition for', () => {
    // The mirror of the third workflow: a pack can declare participation in
    // something the platform cannot execute, and that must be visible too.
    const { running, notRunning } = crossPackRouterFromManifests(
      [manifest('a', [{ id: 'x:a->ghost', crossPackWith: ['a'] }])],
      [],
    );
    expect(running).toEqual([]);
    expect(notRunning.map((i) => i.code)).toEqual(['no-definition']);
  });

  it('reads participation out of the manifests in one direction only', () => {
    // `crossPackParticipations` is the pure half, so a caller cannot hand the
    // router a set the contract never saw.
    const participations = crossPackParticipations(installed());
    const hospitalization = participations.find((p) => p.workflowId === 'x:hospitalization->payer-auth');
    expect([...(hospitalization?.declaredBy.keys() ?? [])].sort()).toEqual(['care-management', 'dialysis-provider', 'payer']);
    // The frozen seed is unchanged and still carries all three definitions — the
    // point is that a DEFINITION is not a declaration.
    expect(seedCrossPackWorkflows.map((w) => w.id)).toHaveLength(3);
  });
});

describe('G3 — a firing says what it did', () => {
  const HOSPITALIZATION = seedCrossPackWorkflows.find((w) => w.id === 'x:hospitalization->payer-auth')!;

  it('fires on the declared trigger and executes the audit', () => {
    const { router } = crossPackRouterFromManifests(installed());
    const audited: string[] = [];
    const fired = handleCrossPackEvent(
      router,
      { type: 'hospitalization.admitted', id: 'evt-1' },
      { onAudit: (action) => audited.push(action.action) },
    );
    expect(fired.map((f) => f.workflowId)).toEqual(['x:hospitalization->payer-auth']);
    expect(audited).toEqual(['hospitalization-recorded']);
    // The audit is the one action that must never be skipped: it is the durable
    // record that the hand-off happened at all.
    expect(fired[0]?.outcomes.find((o) => o.kind === 'audit')?.executed).toBe(true);
  });

  it('reports an action with no handler as NOT executed, never as done', () => {
    // The defect this whole gap is about is a hand-off that looks wired and does
    // nothing — so an observability layer that recorded only successes would
    // reproduce it. The reason is carried, not just the fact.
    const { router } = crossPackRouterFromManifests(installed());
    // The audit IS handled here, so what remains unexecuted is exactly the two
    // actions that need machinery the platform does not have yet: a durable case
    // and a queue on the target pack.
    const fired = handleCrossPackEvent(router, { type: 'hospitalization.admitted' }, { onAudit: () => { /* recorded */ } });
    const skipped = fired[0]?.outcomes.filter((o) => !o.executed) ?? [];
    expect(skipped.map((o) => o.kind).sort()).toEqual(['notify-pack', 'open-case']);
    expect(skipped.find((o) => o.kind === 'notify-pack')?.detail).toContain('payer');
    expect(skipped.find((o) => o.kind === 'open-case')?.detail).toContain('transitions-of-care');
    expect(recentCrossPackFirings()).toHaveLength(1);
  });

  it('claims nothing was done when nothing can be', () => {
    // With no handlers at all, every action is unexecuted — including the audit.
    // A caller that supplied nothing must not be told the hand-off was recorded.
    const { router } = crossPackRouterFromManifests(installed());
    const fired = handleCrossPackEvent(router, { type: 'hospitalization.admitted' });
    expect(fired[0]?.outcomes.map((o) => o.kind).sort()).toEqual(['audit', 'notify-pack', 'open-case']);
    expect(fired[0]?.outcomes.every((o) => !o.executed)).toBe(true);
  });

  it('runs an action when a handler is supplied', () => {
    const { router } = crossPackRouterFromManifests(installed());
    const notified: string[] = [];
    const cases: string[] = [];
    handleCrossPackEvent(router, { type: 'hospitalization.admitted' }, {
      onNotify: (action) => notified.push(action.packId),
      onOpenCase: (action) => cases.push(`${action.packId}:${action.caseKind}`),
    });
    expect(notified).toEqual(['payer']);
    expect(cases).toEqual(['care-management:transitions-of-care']);
  });

  it('does not fire on the right event type from the WRONG pack', () => {
    // A canonical event carries no pack id, so the trigger's `sourcePackId` is the
    // declaration of who publishes it. Without this check a payer's event named
    // `hospitalization.admitted` would open a care-management case.
    const { router } = crossPackRouterFromManifests(installed());
    expect(handleCrossPackEvent(router, { type: 'hospitalization.admitted', sourcePackId: 'payer' })).toEqual([]);
    expect(handleCrossPackEvent(router, { type: 'treatment.missed' })).toEqual([]);
    expect(recentCrossPackFirings()).toEqual([]);
  });

  it('is bounded, so a busy stream cannot grow the log without limit', () => {
    const { router } = crossPackRouterFromManifests(installed());
    for (let i = 0; i < 80; i += 1) handleCrossPackEvent(router, { type: 'hospitalization.admitted' });
    expect(recentCrossPackFirings().length).toBeLessThanOrEqual(50);
    // Newest survive.
    expect(recentCrossPackFirings().length).toBe(50);
  });

  it('keeps the frozen definitions intact — a definition is not a declaration', () => {
    const defined: CrossPackWorkflow = HOSPITALIZATION;
    expect(defined.trigger.sourcePackId).toBe('dialysis-provider');
    expect(defined.actions.map((a) => a.kind)).toEqual(['audit', 'notify-pack', 'open-case']);
  });
});
