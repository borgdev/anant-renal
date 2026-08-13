// M20 Admin: knowledge sources, credentials, sync, artifacts, provenance.
// Wires the KnowledgeLayer bootstrapped in bootstrap.ts into REST endpoints
// the admin UI + agents call.

import type { FastifyInstance } from 'fastify';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { KnowledgeLayer } from '../knowledge/index.js';

export interface KnowledgeRoutesDeps {
  layer: KnowledgeLayer;
  storeDir: string;
}

export async function registerKnowledgeRoutes(app: FastifyInstance, deps: KnowledgeRoutesDeps): Promise<void> {
  const { layer, storeDir } = deps;

  // ---------- Sources ----------
  app.get<{ Querystring: { category?: string; tier?: string; publisher?: string; clinicalDomain?: string } }>('/admin/knowledge/sources', async (req) => {
    const filter: {
      category?: import('../knowledge/types.js').SourceCategory;
      tier?: import('../knowledge/types.js').AccessTier;
      publisher?: string;
      clinicalDomain?: string;
    } = {};
    if (req.query.category) filter.category = req.query.category as import('../knowledge/types.js').SourceCategory;
    if (req.query.tier) filter.tier = req.query.tier as import('../knowledge/types.js').AccessTier;
    if (req.query.publisher) filter.publisher = req.query.publisher;
    if (req.query.clinicalDomain) filter.clinicalDomain = req.query.clinicalDomain;
    const sources = layer.sources.list(filter);
    return {
      sources: sources.map((s) => {
        const bound = layer.adapters.adapterFor(s.id);
        const secretsSet = layer.secrets.list(s.id).filter((r) => r.hasValue);
        const manifestPath = join(storeDir, s.id, 'manifest.json');
        const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
        return {
          id: s.id, name: s.name, category: s.category, tier: s.tier, publisher: s.publisher, cadence: s.cadence,
          clinicalDomains: s.clinicalDomains, homepage: s.homepage, license: s.license,
          adapter: bound?.kind ?? null,
          credentialsRequired: s.requires?.credentialSetup?.fields ?? [],
          credentialsSet: secretsSet.map((r) => r.key),
          lastSyncedAt: manifest?.lastSyncedAt ?? null,
          upstreamVersion: manifest?.upstreamVersion ?? null,
          artifactCount: manifest?.artifactIndex?.length ?? 0,
        };
      }),
    };
  });

  app.get<{ Params: { sourceId: string } }>('/admin/knowledge/sources/:sourceId', async (req, reply) => {
    const spec = layer.sources.get(req.params.sourceId);
    if (!spec) return reply.code(404).send({ error: 'unknown source' });
    const manifestPath = join(storeDir, spec.id, 'manifest.json');
    const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
    return { spec, manifest };
  });

  // ---------- Subscriptions (pack ⇄ source) ----------
  app.get('/admin/knowledge/subscriptions', async () => ({ subscriptions: layer.sources.allSubscriptions() }));
  app.get<{ Params: { packId: string } }>('/admin/knowledge/subscriptions/pack/:packId', async (req) => ({
    subscriptions: layer.sources.subscriptionsForPack(req.params.packId),
    bill: layer.sources.bill(req.params.packId),
  }));
  app.get<{ Params: { sourceId: string } }>('/admin/knowledge/subscriptions/source/:sourceId', async (req) => ({
    fanout: layer.sources.fanout(req.params.sourceId),
  }));
  app.get('/admin/knowledge/reach', async () => ({ table: layer.sources.reachTable() }));

  // ---------- Credentials ----------
  app.get('/admin/knowledge/credentials', async () => ({ credentials: layer.secrets.list() }));
  app.get<{ Params: { sourceId: string } }>('/admin/knowledge/credentials/:sourceId', async (req) => ({
    credentials: layer.secrets.list(req.params.sourceId),
    spec: layer.sources.get(req.params.sourceId)?.requires?.credentialSetup ?? null,
  }));
  app.post<{ Params: { sourceId: string }; Body: { key: string; value: string; updatedBy?: string } }>('/admin/knowledge/credentials/:sourceId', async (req) => {
    layer.secrets.set(req.params.sourceId, req.body.key, req.body.value, req.body.updatedBy);
    return { ok: true };
  });
  app.delete<{ Params: { sourceId: string; key: string } }>('/admin/knowledge/credentials/:sourceId/:key', async (req) => {
    layer.secrets.clear(req.params.sourceId, req.params.key);
    return { ok: true };
  });

  // Test — run adapter.testCredentials if available; otherwise a no-secret probe.
  app.post<{ Params: { sourceId: string } }>('/admin/knowledge/test-credential/:sourceId', async (req, reply) => {
    const spec = layer.sources.get(req.params.sourceId);
    if (!spec) return reply.code(404).send({ error: 'unknown source' });
    const adapter = layer.adapters.adapterFor(req.params.sourceId);
    if (!adapter) return reply.code(400).send({ error: 'no adapter bound' });
    const bundle = layer.secrets.bundleFor(req.params.sourceId);
    if (adapter.testCredentials) {
      const r = await adapter.testCredentials({ spec, secrets: bundle });
      return r;
    }
    return { ok: true, message: 'No dedicated credential test; a sync run will validate.' };
  });

  // ---------- Sync ----------
  app.post<{ Params: { sourceId: string }; Body?: { actor?: string; concurrency?: number; filterIds?: string[]; overridesConfig?: Record<string, unknown>; packHint?: string } }>('/admin/knowledge/sync/:sourceId', async (req, reply) => {
    const body = req.body ?? {};
    const runOpts: import('../knowledge/index.js').RunSyncOptions = { sourceId: req.params.sourceId };
    if (body.actor) runOpts.actor = body.actor;
    if (body.concurrency !== undefined) runOpts.concurrency = body.concurrency;
    if (body.filterIds) runOpts.filterIds = body.filterIds;
    if (body.overridesConfig) runOpts.overridesConfig = body.overridesConfig;
    if (body.packHint) runOpts.packHint = body.packHint;
    const r = await layer.engine.run(runOpts);
    if (!r.ok) return reply.code(400).send({ ok: false, error: r.error });
    return {
      ok: true,
      summary: r.summary,
      events: r.events.slice(-50),
    };
  });

  // ---------- Artifacts ----------
  app.get<{ Params: { sourceId: string }; Querystring: { limit?: string; offset?: string; q?: string } }>('/admin/knowledge/artifacts/:sourceId', async (req, reply) => {
    const spec = layer.sources.get(req.params.sourceId);
    if (!spec) return reply.code(404).send({ error: 'unknown source' });
    const dir = join(storeDir, req.params.sourceId, 'artifacts');
    if (!existsSync(dir)) return { artifacts: [], total: 0 };
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    const q = req.query.q?.toLowerCase();
    const offset = Math.max(0, Number(req.query.offset ?? '0'));
    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? '25')));
    const filtered = q ? files.filter((f) => f.toLowerCase().includes(q)) : files;
    const slice = filtered.slice(offset, offset + limit).map((f) => {
      const raw = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      return { id: raw.id, title: raw.title, summary: raw.summary, updatedAt: raw.updatedAt, upstream: raw.upstream };
    });
    return { total: filtered.length, artifacts: slice };
  });

  app.get<{ Params: { sourceId: string; artifactId: string } }>('/admin/knowledge/artifacts/:sourceId/:artifactId', async (req, reply) => {
    const safe = req.params.artifactId.replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = join(storeDir, req.params.sourceId, 'artifacts', `${safe}.json`);
    if (!existsSync(path)) return reply.code(404).send({ error: 'not found' });
    return JSON.parse(readFileSync(path, 'utf8'));
  });

  // ---------- Scheduler ----------
  app.get('/admin/knowledge/schedule/due', async () => ({ due: layer.scheduler.dueSources() }));
  app.post('/admin/knowledge/schedule/run-due', async () => ({ results: await layer.scheduler.runDueOnce('admin-ui') }));
}
