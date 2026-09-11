/*
 * Copyright (c) 2026 AnantHQ Inc. All rights reserved.
 *
 * Operator-console setup surface — /admin/platform/*.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The API guard (api-auth.ts) scopes by URL PREFIX, and the prefixes were
 * shaped by console rather than by domain:
 *
 *   /admin/swarm/*   -> exec roles   (admin | md | safety)
 *   everything else  -> ops roles    (admin + nurse/pharmacist/coder/auditor/...)
 *
 * Setup endpoints only ever existed under the swarm prefix, so the operator
 * console's pages called an exec-scoped API and were 403 for every ops role
 * except `admin` — the one role in both consoles, which is why it went
 * unnoticed. `renderPlatformConfig` then swallowed that 403 and rendered
 * hardcoded defaults, showing an escalation threshold of 5000bp when the real
 * policy was 8200bp.
 *
 * This module is the fix for the setup half of that: the SAME durable workspace
 * documents, exposed under the ops-scoped prefix. No second store, no second
 * rule — `getSwarmWorkspace()` is the single source, exactly as the swarm
 * family uses.
 *
 * The swarm twins are deliberately left in place: the exec console still calls
 * them, and they are removed in the later slice that also removes exec's
 * setup pages. Until then one document has two spellings (documented in
 * docs/platform-config-consolidation.md, Decision B).
 *
 * WHAT BELONGS HERE
 * -----------------
 * Setup only: organization profile, integration contract, action policy,
 * release lifecycle, release gate, and the configuration-object catalog. The
 * exec's runtime evidence (events, traces, models, drift, authority, audits,
 * reviews, facility simulations, knowledge notes) does NOT — that is operational
 * review, which the charter assigns to the executive console.
 ******************************************************************************/

import type { FastifyInstance } from 'fastify';
import {
  getSwarmWorkspace,
  projectTopology,
} from './swarm-routes.js';
import type {
  SwarmWorkspaceStore,
  WorkspaceDoc,
  WorkspaceKind,
} from '../swarm/workspace.js';
import {
  applyRedOverrides,
  demoReleaseInput,
  evaluateRelease,
} from '../swarm/release.js';

/** The catalog kinds the operator console may read and write. Mirrors the
 *  swarm catalog surface — the exec console imports these same datasets. */
export const CONFIG_OBJECT_KINDS: readonly string[] = [
  'agent-manifest', 'measure-pack', 'public-source', 'domain-pack', 'operating-model', 'ecosystem',
  'runtime-policy', 'public-benchmark', 'federal-fact', 'green-team-check', 'source-mapping',
  'facility-station', 'assessment-response', 'outcome-episode-story', 'patient-timeline',
];

/** Kinds stored as ONE document rather than a list of rows. */
export const CONFIG_OBJECT_SINGLE: readonly string[] = [
  'operating-model', 'ecosystem', 'runtime-policy', 'public-benchmark', 'domain-pack',
];

function shortHash(input: string): string {
  let h = 0xdeadbeef;
  for (let i = 0; i < input.length; i += 1) h = Math.imul(h ^ input.charCodeAt(i), 2654435761);
  return (h >>> 0).toString(16).padStart(8, '0');
}

export async function registerOpsConfigRoutes(app: FastifyInstance): Promise<void> {
  const ws = (): SwarmWorkspaceStore => {
    const w = getSwarmWorkspace();
    if (!w) throw new Error('swarm-workspace-not-ready');
    return w;
  };

  /* ---------- workspace summary ---------- */
  app.get('/admin/platform/workspace', async () => ({ summary: await ws().summary() }));

  /* ---------- action-boundary policy ----------
   * The red-team suite evaluates THIS policy live, so an unsafe (`allow`) policy
   * fails the suite and blocks a release. It is setup, not a decision. */
  app.get('/admin/platform/policy', async () => ({ policy: await ws().getAdminPolicy() }));
  app.put<{ Body: Record<string, unknown> }>('/admin/platform/policy', async (req, reply) => {
    const body = req.body ?? {};
    const escalation = body.escalationThresholdBasisPoints;
    const min = body.minThresholdBasisPoints;
    const max = body.maxThresholdBasisPoints;
    for (const [name, value] of [['escalationThresholdBasisPoints', escalation], ['minThresholdBasisPoints', min], ['maxThresholdBasisPoints', max]] as const) {
      if (value === undefined) continue;
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0 || n > 10000) {
        return reply.code(400).send({ error: 'invalid-threshold', field: name, allowed: '0..10000 basis points' });
      }
    }
    const policy = await ws().saveAdminPolicy(body);
    return { policy };
  });

  /* ---------- integration contract ----------
   * The bridge URL / cluster / protocol / secret REFERENCE. The secret value
   * itself never enters this surface — only the binding name does. */
  app.put<{ Body: Record<string, unknown> }>('/admin/platform/integrations/kafka', async (req, reply) => {
    const body = req.body ?? {};
    const protocol = body.securityProtocol;
    if (protocol !== undefined && !['SASL_SSL', 'SSL', 'PLAINTEXT'].includes(String(protocol))) {
      return reply.code(400).send({ error: 'invalid-security-protocol', allowed: ['SASL_SSL', 'SSL', 'PLAINTEXT'] });
    }
    const secretRef = body.secretRef === undefined ? undefined : String(body.secretRef);
    if (secretRef !== undefined && /^[A-Za-z0-9_+/=]{24,}$/.test(secretRef)) {
      // A binding REFERENCE is a name like `binding:KAFKA_BRIDGE_TOKEN`. A long
      // opaque blob is a secret that must never be stored here.
      return reply.code(400).send({
        error: 'secret-value-rejected',
        detail: 'Send a secret binding reference (e.g. binding:NAME), never the secret value.',
      });
    }
    const kafka = await ws().saveAdminKafka(body);
    return { kafka };
  });

  /* ---------- release lifecycle (the delete the platform family lacked) ---- */
  app.delete<{ Params: { id: string } }>('/admin/platform/releases/:id', async (req, reply) => {
    const ok = await ws().deleteRelease(req.params.id);
    if (!ok) return reply.code(404).send({ error: 'release-not-found' });
    return { ok: true };
  });

  /* ---------- release gate — the REAL gate model ----------
   * `evaluateRelease` scores green pass rate, red containment, source currency
   * and approvals, with per-check evidence. Deterministic and pure, so it needs
   * no session state and no store. */
  app.get('/admin/platform/release-gate', async () => {
    const input = demoReleaseInput();
    return { input, verdict: evaluateRelease(input) };
  });
  app.post<{ Body: { red?: Array<{ id: string; contained: boolean }>; approvals?: { required?: number; granted?: string[] } } }>(
    '/admin/platform/release-gate/evaluate',
    async (req) => {
      const base = demoReleaseInput();
      const input = demoReleaseInput({
        ...(req.body?.red ? { red: applyRedOverrides(base.red, req.body.red) } : {}),
        ...(req.body?.approvals
          ? { approvals: { required: req.body.approvals.required ?? 2, granted: req.body.approvals.granted ?? [] } }
          : {}),
      });
      return { input, verdict: evaluateRelease(input) };
    },
  );

  /* ---------- configuration objects ----------
   * The static datasets the exec console renders (ontology, runtime policy,
   * domain/measure packs, authority sources, agent manifests, mappings). Durable
   * in Postgres via the swarm_workspace store — the previous UI presented them
   * as YAML FILES that did not exist on disk. */
  const kindOk = (kind: string): boolean => CONFIG_OBJECT_KINDS.includes(kind);
  const isSingle = (kind: string): boolean => CONFIG_OBJECT_SINGLE.includes(kind);

  app.get('/admin/platform/config-objects', async () => ({ catalogs: await ws().catalogs() }));

  app.get<{ Params: { kind: string } }>('/admin/platform/config-objects/:kind', async (req, reply) => {
    const kind = req.params.kind;
    if (!kindOk(kind)) return reply.code(404).send({ error: 'config-object-kind-not-found', allowed: CONFIG_OBJECT_KINDS });
    if (isSingle(kind)) {
      const rows = await ws().list<WorkspaceDoc & { data?: unknown }>(kind as WorkspaceKind);
      return { data: rows[0]?.data ?? null, id: rows[0]?.id ?? null, storage: 'swarm_workspace' };
    }
    return { rows: await ws().listCatalog(kind as WorkspaceKind), storage: 'swarm_workspace' };
  });

  app.post<{ Params: { kind: string }; Body: Record<string, unknown> }>('/admin/platform/config-objects/:kind', async (req, reply) => {
    const kind = req.params.kind;
    if (!kindOk(kind)) return reply.code(404).send({ error: 'config-object-kind-not-found', allowed: CONFIG_OBJECT_KINDS });
    if (isSingle(kind)) {
      const existing = (await ws().list<WorkspaceDoc>(kind as WorkspaceKind))[0];
      const doc = req.body?.data ?? req.body;
      if (existing) await ws().update<WorkspaceDoc & { data?: unknown }>(kind as WorkspaceKind, String(existing.id), { data: doc });
      else await ws().create<WorkspaceDoc & { data?: unknown }>(kind as WorkspaceKind, `${kind}-default`, { data: doc });
      return { ok: true, kind, id: existing ? String(existing.id) : `${kind}-default` };
    }
    const id = String((req.body?.id as string) ?? shortHash(JSON.stringify(req.body ?? {})));
    const row = await ws().create(kind as WorkspaceKind, id, (req.body ?? {}) as Record<string, unknown>);
    return { ok: true, row };
  });

  app.get<{ Params: { kind: string; id: string } }>('/admin/platform/config-objects/:kind/:id', async (req, reply) => {
    const kind = req.params.kind;
    if (!kindOk(kind)) return reply.code(404).send({ error: 'config-object-kind-not-found', allowed: CONFIG_OBJECT_KINDS });
    const row = await ws().get<WorkspaceDoc>(kind as WorkspaceKind, req.params.id);
    if (!row) return reply.code(404).send({ error: 'config-object-not-found' });
    if (isSingle(kind)) return { data: (row as WorkspaceDoc & { data?: unknown }).data ?? null };
    return { row };
  });

  app.put<{ Params: { kind: string; id: string }; Body: Record<string, unknown> }>('/admin/platform/config-objects/:kind/:id', async (req, reply) => {
    const kind = req.params.kind;
    if (!kindOk(kind)) return reply.code(404).send({ error: 'config-object-kind-not-found', allowed: CONFIG_OBJECT_KINDS });
    if (isSingle(kind)) {
      const existing = await ws().get<WorkspaceDoc>(kind as WorkspaceKind, req.params.id);
      if (!existing) return reply.code(404).send({ error: 'config-object-not-found' });
      const doc = (req.body?.data as unknown) ?? req.body;
      await ws().update<WorkspaceDoc & { data?: unknown }>(kind as WorkspaceKind, req.params.id, { data: doc });
      return { ok: true, kind };
    }
    const updated = await ws().update(kind as WorkspaceKind, req.params.id, (req.body ?? {}) as Record<string, unknown>);
    if (!updated) return reply.code(404).send({ error: 'config-object-not-found' });
    return { ok: true, row: updated };
  });

  app.delete<{ Params: { kind: string; id: string } }>('/admin/platform/config-objects/:kind/:id', async (req, reply) => {
    const kind = req.params.kind;
    if (!kindOk(kind)) return reply.code(404).send({ error: 'config-object-kind-not-found', allowed: CONFIG_OBJECT_KINDS });
    const ok = await ws().remove(kind as WorkspaceKind, req.params.id);
    if (!ok) return reply.code(404).send({ error: 'config-object-not-found' });
    return { ok: true };
  });

  /* ---------- read-only topology ----------
   * The operator console renders the projected graph for context (what the
   * configuration is ABOUT). Editing the graph is the intelligence workspace's
   * job in the exec console. */
  app.get('/admin/platform/topology', async () => ({ ...(await projectTopology(ws())) }));
}
