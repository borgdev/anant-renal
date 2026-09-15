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

// The release gate reads pack-level evidence (Phase 3, deliverable 6).
//
// Two things are being guarded here, and they pull in opposite directions:
//
//   a release must not go active on top of a pack that cannot host itself, and
//   a gate that did NOT run must never report `passed`.
//
// The second is the one that is easy to get wrong and expensive to discover: an
// unevaluated gate rendered green is indistinguishable from a verified one, and
// the whole release gate exists to make that distinction visible.

import { describe, it, expect } from 'vitest';
import { SwarmWorkspaceStore, type ConfigRelease, type ReleaseGateCheck } from '../src/swarm/workspace.js';

/** A store with no persistence — the gate logic is what is under test. */
function store(): SwarmWorkspaceStore {
  return new SwarmWorkspaceStore(undefined, () => '2026-09-15T00:00:00.000Z');
}

async function draft(s: SwarmWorkspaceStore, version: string): Promise<string> {
  const release = await s.createReleaseDraft({ version, changeSummary: 'test', createdBy: 'release-approver' });
  return release.id;
}

const gateFor = (checks: ReleaseGateCheck[] | undefined, name: string): ReleaseGateCheck | undefined =>
  (checks ?? []).find((c) => c.name === name);

describe('the pack-contract gate', () => {
  it('is absent when no provider is wired, rather than green on nothing', async () => {
    const s = store();
    const id = await draft(s, 'no-provider.draft');
    await s.validateRelease(id);

    const release = await s.get<ConfigRelease>('config-release', id);
    // The gate did not run. It must not be reported as a pass — an operator
    // reading `Pack contracts: passed` cannot tell an unevaluated gate from a
    // verified one, which is exactly the confusion the gate exists to remove.
    expect(gateFor(release?.checks, 'Pack contracts')).toBeUndefined();
    // The other five gates still ran.
    expect(release?.checks?.some((c) => c.name === 'Schema/contract')).toBe(true);
  });

  it('fails validation when a pack’s declared surface does not resolve', async () => {
    const s = store();
    s.setPackConformanceProvider(() => [
      { packId: 'ghost-pack', detail: 'ontology "ghost" names module "ontology.ts", which does not exist' },
    ]);
    const id = await draft(s, 'blocked.draft');
    const release = await s.validateRelease(id);

    expect(release?.status).toBe('failed');
    const gate = gateFor(release?.checks, 'Pack contracts');
    expect(gate?.passed).toBe(false);
    expect(gate?.observed).toContain('ghost-pack');
    expect(gate?.observed).toContain('does not exist');
  });

  it('passes when every pack resolves, and names what it checked', async () => {
    const s = store();
    s.setPackConformanceProvider(() => []);
    const id = await draft(s, 'clean.draft');
    const release = await s.validateRelease(id);

    const gate = gateFor(release?.checks, 'Pack contracts');
    expect(gate?.passed).toBe(true);
    expect(gate?.observed).toBe('every installed pack resolves its declared surface');
  });

  it('distinguishes a provider that reports a clean set from one that is unwired', async () => {
    const wired = store();
    wired.setPackConformanceProvider(() => []);
    const unwired = store();

    const a = await wired.validateRelease(await draft(wired, 'a.draft'));
    const b = await unwired.validateRelease(await draft(unwired, 'b.draft'));

    expect(a?.checks?.length).toBe(6);
    expect(b?.checks?.length).toBe(5);
  });

  it('does not let a provider that throws read as clean', async () => {
    const s = store();
    s.setPackConformanceProvider(() => { throw new Error('manifest directory unreadable'); });
    const id = await draft(s, 'throwing.draft');
    const release = await s.validateRelease(id);

    // A resolution failure is a failure to establish that the packs are hostable.
    // Treating it as "no blocks" would invert the gate at the worst moment.
    expect(release?.status).toBe('failed');
    const gate = gateFor(release?.checks, 'Pack contracts');
    expect(gate?.passed).toBe(false);
    expect(gate?.observed).toContain('unreadable');
  });

  it('refuses to promote a canary to active on top of an unresolved pack', async () => {
    const s = store();
    s.setPackConformanceProvider(() => []); // clean at validation time
    const id = await draft(s, 'canary.draft');
    await s.validateRelease(id);
    await s.approveRelease(id);
    await s.startCanary(id, { scopes: ['1% of cohort'] });

    // The drift appears between the canary starting and promotion — the exact
    // window a real deployment lives in.
    s.setPackConformanceProvider(() => [{ packId: 'payer', detail: 'manifest drift: version, capabilities' }]);

    const promoted = await s.promoteCanary(id, { by: 'release-approver', health: true });
    expect(promoted?.status).toBe('failed');
    const gate = gateFor(promoted?.checks, 'Pack contracts');
    expect(gate?.passed).toBe(false);
    expect(gate?.observed).toContain('payer');

    // Nothing was activated, and no dossier claiming activation was written.
    expect(promoted?.activatedAt).toBeUndefined();
    expect(promoted?.dossier).toBeUndefined();
    // `activeRelease()` falls back to the newest release when none is active (it
    // answers "what would be in force"), so the assertion is that nothing is
    // actually in the active state.
    const inForce = await s.activeRelease();
    expect(inForce?.status).not.toBe('active');
  });

  it('promotes normally when the packs still resolve', async () => {
    const s = store();
    s.setPackConformanceProvider(() => []);
    const id = await draft(s, 'ok.draft');
    await s.validateRelease(id);
    await s.approveRelease(id);
    await s.startCanary(id, { scopes: ['1% of cohort'] });
    const promoted = await s.promoteCanary(id, { by: 'release-approver', health: true });

    expect(promoted?.status).toBe('active');
    expect(gateFor(promoted?.dossier?.gates, 'Pack contracts')?.passed).toBe(true);
    expect(promoted?.dossier?.gates.length).toBe(6);
  });
});
