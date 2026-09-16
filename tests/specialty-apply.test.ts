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

// G6 — the `applied` gate, enforced rather than reported.
//
// The load-bearing test in this file is the one that goes through a REAL Fastify
// request. `applied` is enforced inside `PackRouteDeps.patients`, which is
// synchronous and takes no arguments, so the viewer's scopes travel in an
// AsyncLocalStorage scope established by a synchronous `onRequest` hook that
// wraps `done()`. That trick is the whole mechanism, and if it did not hold, the
// gate would resolve every pack as "no viewer in scope" and enforce NOTHING while
// reporting success — a gate that cannot fail is worse than no gate, and only an
// end-to-end assertion can tell the difference.
//
// So `viewerKnown` is asserted, not assumed, and the scoped binding below uses an
// EXPLICIT scope rather than `scope:*`. A wildcard binding matches every viewer,
// so it would produce the same answer whether the viewer was carried or not.

import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { LocalUserStore } from '../src/server/auth/users.js';
import { SessionManager, SESSION_COOKIE } from '../src/server/auth/session.js';
import { specialtyBindingId, type SpecialtyBindingLike } from '../src/control-plane/specialty-bindings.js';
import {
  appliedPatients,
  applyDecisionFor,
  registerSpecialtyApplyGate,
  runWithViewerScope,
  setSpecialtyBindingSnapshot,
} from '../src/server/specialty-apply.js';

const PACK = 'demo-pack';
const FACILITY_A = 'facility:a';
const FACILITY_B = 'facility:b';

const PATIENTS = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }];

function binding(overrides: Partial<SpecialtyBindingLike> & { scope: string }): SpecialtyBindingLike {
  // Destructured rather than spread over a literal that already sets `scope`:
  // that is TS2783, the same "second spread silently replaces the first" shape
  // as the anemia fixture — caught by the compiler here, by
  // tests/spread-collisions.test.ts in the places the compiler cannot see.
  const { scope, ...rest } = overrides;
  return {
    id: specialtyBindingId(scope, PACK),
    scope,
    packId: PACK,
    applied: false,
    show: false,
    entitled: true,
    ...rest,
  };
}

/** A real app whose one specialty endpoint reports the gate's own decision. */
async function gateApp(scopeIds: string[]) {
  const users = new LocalUserStore();
  users.create({ username: 'scoped', password: 'a-long-enough-password', role: 'md', displayName: 'Scoped', scopeIds });
  const sessions = new SessionManager();
  const token = sessions.create('scoped');
  const app = Fastify();
  await registerSpecialtyApplyGate(app, {
    users,
    sessions,
    // Never consulted: `setSpecialtyBindingSnapshot` marks the snapshot primed,
    // so the lazy primer stands down. That is deliberate — this file is about the
    // gate, not about the workspace read that feeds it.
    bindings: async () => [],
  });
  app.get('/admin/swarm/probe', async () => ({
    decision: applyDecisionFor(PACK),
    patients: appliedPatients(PACK, PATIENTS).length,
  }));
  await app.ready();
  return { app, cookie: `${SESSION_COOKIE}=${token}` };
}

describe('G6 — the applied gate is ENFORCED at the patient seam', () => {
  it('carries the viewer into the handler (the sync onRequest hook is load-bearing)', async () => {
    setSpecialtyBindingSnapshot([binding({ scope: FACILITY_A })]);
    const { app, cookie } = await gateApp(['facility:a']);
    const res = await app.inject({ method: 'GET', url: '/admin/swarm/probe', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { decision: { viewerKnown: boolean; applied: boolean; reason: string } };
    // If the AsyncLocalStorage scope did not reach the handler, this is false and
    // the gate is enforcing nothing at all.
    expect(body.decision.viewerKnown).toBe(true);
    expect(body.decision.applied).toBe(false);
    expect(body.decision.reason).toBe('binding');
    await app.close();
  });

  it('empties the projection for a pack the configuration does not apply', async () => {
    setSpecialtyBindingSnapshot([binding({ scope: FACILITY_A })]);
    const { app, cookie } = await gateApp(['facility:a']);
    const res = await app.inject({ method: 'GET', url: '/admin/swarm/probe', headers: { cookie } });
    // Not "fewer patients" — NONE. A specialty that is installed but not applied
    // must not compute against patients the configuration excluded.
    expect((res.json() as { patients: number }).patients).toBe(0);
    await app.close();
  });

  it('the SAME snapshot resolves differently for a different viewer', async () => {
    // The proof that this is scope resolution and not a global switch: one
    // snapshot, two viewers, opposite answers. With a wildcard binding this test
    // would pass even if the viewer were never carried.
    setSpecialtyBindingSnapshot([binding({ scope: FACILITY_A })]);
    const a = await gateApp(['facility:a']);
    const b = await gateApp(['facility:b']);
    const run = async (app: Fastify.FastifyInstance, cookie: string) =>
      (await app.inject({ method: 'GET', url: '/admin/swarm/probe', headers: { cookie } })).json() as {
        decision: { applied: boolean; reason: string }; patients: number;
      };
    const forA = await run(a.app, a.cookie);
    const forB = await run(b.app, b.cookie);
    expect(forA.decision.applied).toBe(false);
    expect(forA.patients).toBe(0);
    // No binding mentions facility B, so the pack keeps the install default.
    // Absence of a binding means "not configured", never "off" — the other
    // reading would dark every specialty the moment one binding was written.
    expect(forB.decision.applied).toBe(true);
    expect(forB.decision.reason).toBe('no-binding');
    expect(forB.patients).toBe(PATIENTS.length);
    await a.app.close();
    await b.app.close();
  });

  it('an empty snapshot applies every pack — arming the gate changes nothing', async () => {
    setSpecialtyBindingSnapshot([]);
    const { app, cookie } = await gateApp(['facility:a']);
    const res = await app.inject({ method: 'GET', url: '/admin/swarm/probe', headers: { cookie } });
    const body = res.json() as { decision: { applied: boolean; viewerKnown: boolean }; patients: number };
    expect(body.decision.applied).toBe(true);
    expect(body.decision.viewerKnown).toBe(true);
    expect(body.patients).toBe(PATIENTS.length);
    await app.close();
  });

  it('an unauthenticated caller is reported as an unknown viewer, not as permitted', async () => {
    setSpecialtyBindingSnapshot([binding({ scope: FACILITY_A })]);
    const { app } = await gateApp(['facility:a']);
    const res = await app.inject({ method: 'GET', url: '/admin/swarm/probe' });
    const body = res.json() as { decision: { viewerKnown: boolean } };
    // No cookie, so there is no viewer to resolve against. `viewerKnown` is a
    // separate field precisely so this is not reported as "applied: true, all
    // good" — the two facts are different and only one of them is a permission.
    expect(body.decision.viewerKnown).toBe(false);
    await app.close();
  });
});

describe('G6 — the gate outside a request', () => {
  it('resolves against an explicit viewer scope in-process', () => {
    setSpecialtyBindingSnapshot([binding({ scope: FACILITY_A })]);
    const inside = runWithViewerScope(['facility:a'], () => applyDecisionFor(PACK));
    const outside = runWithViewerScope(['facility:b'], () => applyDecisionFor(PACK));
    expect(inside.applied).toBe(false);
    expect(outside.applied).toBe(true);
  });

  it('reports a pack nothing was said about as applied, never as unknown', () => {
    setSpecialtyBindingSnapshot([]);
    const decision = runWithViewerScope(['facility:a'], () => applyDecisionFor('never-mentioned'));
    expect(decision.applied).toBe(true);
    expect(decision.appliedScopes).toEqual(['scope:*']);
  });
});
