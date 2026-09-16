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

// Pack route contributions (Phase 3/G1).
//
// The load-bearing test in this file is the namespace one. `api-auth.ts` decides
// who may call an endpoint by URL PREFIX, so a pack free to choose its own path
// could register one the guard classifies as another console's — or one outside
// /admin/ that never reaches the guard at all. That is the difference between a
// plugin and a hole, and it is asserted as behaviour rather than described.

import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import {
  validatePackContributions,
  blockingContributionIssues,
  registerPackRoutes,
  SCOPE_NAMESPACES,
  type PackRouteContribution,
  type PackRouteDeps,
  type PackRouteExtra,
  type PackWithContributions,
} from '../src/control-plane/pack-contributions.js';
import { roleAllowsConsole } from '../src/server/console-gate.js';

/** A contribution that registers one readable route per declared prefix. */
function contribution(over: Partial<PackRouteContribution> = {}): PackRouteContribution {
  const prefixes = over.prefixes ?? ['/admin/swarm/thing'];
  const extra = over.register;
  return {
    id: over.id ?? 'thing',
    scope: over.scope ?? 'exec',
    prefixes,
    // Composed explicitly rather than spread: spreading `...over` last would
    // REPLACE this register with the caller's, so a test that passed its own
    // registered no route and read as a 404 from the router.
    register(app, deps) {
      for (const prefix of prefixes) {
        app.get(`${prefix}/probe`, async () => ({ ok: true, workspace: typeof deps.workspace }));
      }
      extra?.(app, deps);
    },
  };
}

function pack(id: string, routes: readonly PackRouteContribution[]): PackWithContributions {
  return {
    id,
    version: '1.0.0',
    extends: [{ id: 'healthcare-core', versionRange: '^0.2.0' }],
    appliesTo: { organizationKinds: ['provider'] },
    capabilities: ['x'],
    cmsUniverse: [],
    requiredControls: ['access-policy'],
    routes,
  };
}

const deps: PackRouteDeps = {
  workspace: () => { throw new Error('not used'); },
  coordinator: () => { throw new Error('not used'); },
  patients: () => [],
  events: () => [],
  extra: {},
};

/** The platform is allowed to resolve deps per pack; most tests do not care. */
const sameDeps = (): PackRouteDeps => deps;

describe('the scope namespace table is the guard’s own boundary', () => {
  it('maps each scope to the prefix api-auth classifies as that console', () => {
    // If this drifts from api-auth.ts, a pack's declared scope stops meaning what
    // it says — so the assertion is made against the console gate itself.
    for (const [scope, namespace] of Object.entries(SCOPE_NAMESPACES)) {
      const execOnly = !roleAllowsConsole('nurse', 'exec');
      const opsOnly = !roleAllowsConsole('md', 'ops');
      if (scope === 'exec') {
        expect(execOnly, 'a nurse must not be an exec-console role').toBe(true);
        expect(opsOnly, 'an md must not be an ops-console role').toBe(true);
        expect(namespace).toBe('/admin/swarm/');
      } else {
        expect(namespace).toBe('/admin/platform/');
      }
    }
  });
});

describe('a pack cannot choose its own authority', () => {
  it('refuses an exec-scoped contribution that registers under the ops namespace', () => {
    const registry = validatePackContributions([
      pack('a-pack', [contribution({ scope: 'exec', prefixes: ['/admin/platform/thing'] })]),
    ]);
    const issue = registry.issues[0];
    expect(issue?.code).toBe('prefix-outside-scope-namespace');
    expect(issue?.blocking).toBe(true);
    // The message has to explain the consequence, not just the mismatch.
    expect(issue?.detail).toContain('/admin/swarm/');
    expect(issue?.detail).toContain('another console');
  });

  it('refuses a prefix outside /admin/ entirely', () => {
    // Such a path never reaches the auth guard at all, which makes it worse than
    // the wrong console: it is no console.
    const registry = validatePackContributions([
      pack('a-pack', [contribution({ prefixes: ['/api/payer', '/health'] })]),
    ]);
    expect(registry.issues.map((i) => i.code)).toEqual(['invalid-prefix', 'invalid-prefix']);
    expect(registry.issues[0]?.detail).toContain('never reach the auth guard');
  });

  it('refuses a contribution that declares no prefixes', () => {
    const registry = validatePackContributions([pack('a-pack', [contribution({ prefixes: [] })])]);
    expect(registry.issues[0]?.code).toBe('missing-prefix');
    expect(registry.issues[0]?.detail).toContain('cannot prove its paths are guarded');
  });

  it('accepts each scope in its own namespace', () => {
    const registry = validatePackContributions([
      pack('a-pack', [contribution({ id: 'a', scope: 'exec', prefixes: ['/admin/swarm/a'] })]),
      pack('b-pack', [contribution({ id: 'b', scope: 'ops', prefixes: ['/admin/platform/b'] })]),
    ]);
    expect(registry.issues).toEqual([]);
    expect(registry.contributingPacks).toEqual(['a-pack', 'b-pack']);
  });
});

describe('collisions', () => {
  it('refuses two packs claiming one contribution id', () => {
    const registry = validatePackContributions([
      pack('a-pack', [contribution({ id: 'shared', prefixes: ['/admin/swarm/a'] })]),
      pack('b-pack', [contribution({ id: 'shared', prefixes: ['/admin/swarm/b'] })]),
    ]);
    expect(registry.issues[0]?.code).toBe('duplicate-contribution-id');
    expect(registry.issues[0]?.packId).toBe('b-pack');
  });

  it('refuses two packs answering one prefix', () => {
    const registry = validatePackContributions([
      pack('a-pack', [contribution({ id: 'a', prefixes: ['/admin/swarm/thing'] })]),
      pack('b-pack', [contribution({ id: 'b', prefixes: ['/admin/swarm/thing'] })]),
    ]);
    const dup = registry.issues.find((i) => i.code === 'duplicate-prefix');
    expect(dup?.detail).toContain('a-pack');
    expect(dup?.detail).toContain('ordering accident');
  });
});

describe('registration', () => {
  it('registers every contribution and hands each one the platform deps', async () => {
    const app = Fastify();
    const seen: string[] = [];
    const registry = await registerPackRoutes(
      app,
      [
        pack('a-pack', [contribution({
          id: 'a',
          prefixes: ['/admin/swarm/a'],
          register: () => { seen.push('a'); },
        })]),
      ],
      () => ({ workspace: () => { throw new Error('x'); }, coordinator: () => { throw new Error('x'); }, patients: () => [], events: () => [], extra: {} }),
    );
    expect(seen).toEqual(['a']);
    expect(registry.contributingPacks).toEqual(['a-pack']);

    const res = await app.inject({ method: 'GET', url: '/admin/swarm/a/probe' });
    expect(res.statusCode).toBe(200);
    expect(res.json().workspace).toBe('function');
    await app.close();
  });

  it('resolves deps PER PACK rather than handing every pack one shared object', async () => {
    // The platform owes different packs different things — every pack needs the
    // patient projection, a few carry a ledger seam that tests inject fixtures
    // through — so resolving per pack is what keeps a pack's own dependencies
    // travelling with the pack instead of accumulating on a shared object until
    // it is the union of everything anyone needed.
    const app = Fastify();
    const seen: Array<{ pack: string; patients: number; extra: PackRouteExtra }> = [];
    const recorder = (pack: string) => ({
      id: pack,
      prefixes: [`/admin/swarm/${pack}`],
      register: (_app: unknown, d: PackRouteDeps) => {
        seen.push({ pack, patients: d.patients().length, extra: d.extra });
      },
    });
    await registerPackRoutes(
      app,
      [pack('a-pack', [contribution(recorder('a'))]), pack('b-pack', [contribution(recorder('b'))])],
      (packId) => ({
        ...deps,
        patients: () => (packId === 'a-pack' ? [{ id: 'p1', realmId: 'r1', state: {} }] : []),
        extra: packId === 'a-pack' ? { ledger: 'a-only' } : {},
      }),
    );
    expect(seen).toEqual([
      { pack: 'a', patients: 1, extra: { ledger: 'a-only' } },
      { pack: 'b', patients: 0, extra: {} },
    ]);
    await app.close();
  });

  it('refuses to register anything when a contribution is invalid', async () => {
    const app = Fastify();
    let registered = false;
    await expect(registerPackRoutes(
      app,
      [
        pack('a-pack', [contribution({
          id: 'a', prefixes: ['/admin/swarm/a'],
          register: () => { registered = true; },
        })]),
        pack('b-pack', [contribution({ id: 'b', scope: 'exec', prefixes: ['/admin/platform/b'] })]),
      ],
      sameDeps,
    )).rejects.toThrow(/pack-route-contribution-invalid/);

    // Fail before the first route, not halfway through the list: a partially
    // registered surface is harder to reason about than a refused boot.
    expect(registered).toBe(false);
    await app.close();
  });

  it('reports blocking issues separately from the whole set', () => {
    const registry = validatePackContributions([pack('a-pack', [contribution({ prefixes: [] })])]);
    expect(blockingContributionIssues(registry)).toHaveLength(1);
    expect(registry.issues).toHaveLength(1);
  });

  it('tolerates a pack that contributes nothing', () => {
    const registry = validatePackContributions([pack('quiet-pack', [])]);
    expect(registry.issues).toEqual([]);
    expect(registry.contributingPacks).toEqual([]);
  });
});

describe('the burn-down: packs declare their routes, app.ts stops naming modules', () => {
  it('payer declares its routes on the descriptor', async () => {
    const { payerPack } = await import('../packs/payer/index.js');
    expect(payerPack.routes).toHaveLength(1);
    expect(payerPack.routes?.[0]?.scope).toBe('exec');
    expect(payerPack.routes?.[0]?.prefixes).toEqual(['/admin/swarm/payer']);
  });

  it('dialysis-provider declares every specialty surface it serves', async () => {
    const { dialysisProviderPack } = await import('../packs/dialysis-provider/index.js');
    const declared = (dialysisProviderPack.routes ?? []).flatMap((r) => [...r.prefixes]).sort();
    // The whole burn-down in one assertion: these ten prefixes used to be nine
    // named `await registerXRoutes(...)` calls plus one pack, and the platform
    // knew every one of them. Now the pack declares them and the platform reads
    // the declaration.
    expect(declared).toEqual([
      '/admin/swarm/access',
      '/admin/swarm/adequacy',
      '/admin/swarm/anemia',
      '/admin/swarm/assurance',
      '/admin/swarm/fluid',
      '/admin/swarm/infection',
      '/admin/swarm/mbd',
      '/admin/swarm/next-session',
      '/admin/swarm/nutrition',
      '/admin/swarm/protocols',
      '/admin/swarm/renal',
      '/admin/swarm/rounds',
    ]);
    for (const r of dialysisProviderPack.routes ?? []) expect(r.scope).toBe('exec');
  });

  it('app.ts names no specialty module at all', async () => {
    const { readFileSync } = await import('node:fs');
    const app = readFileSync(new URL('../src/server/app.ts', import.meta.url), 'utf8');
    for (const gone of ['registerPayerRoutes', 'registerRenalRoutes', 'registerAnemiaRoutes', 'registerProtocolRoutes', 'registerAdequacyRoutes', 'registerFluidRoutes', 'registerRoundRoutes', 'registerAccessRoutes', 'registerMbdRoutes', 'registerNutritionRoutes', 'registerInfectionRoutes', 'registerCrossPackAssuranceRoutes']) {
      expect(app, gone).not.toContain(gone);
    }

    // The burn-down's closing assertion, and the strongest form of it: ZERO
    // matches. Phase 3's exit criterion is "renal is no longer a special-case
    // code path in the platform shell", and this is that criterion as a test.
    // A future specialty cannot be added by naming it here without failing this.
    const named = app.match(/await register(Anemia|Renal|Protocol|Adequacy|Fluid|Access|Mbd|Nutrition|Infection|Round|CrossPackAssurance)Routes/g) ?? [];
    expect(named).toEqual([]);
  });
});
