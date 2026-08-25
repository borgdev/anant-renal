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

// M20 Admin: knowledge sources, credentials, sync, artifacts, provenance.
// Wires the KnowledgeLayer bootstrapped in bootstrap.ts into REST endpoints
// the admin UI + agents call.

import type { FastifyInstance } from 'fastify';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { KnowledgeLayer } from '../knowledge/index.js';
import { buildKnowledgeToolBus, type ToolResult } from '../knowledge/agents/tool-bus.js';
import { runAgentTurn, type AgentStrategy } from '../knowledge/agents/runner.js';
import { validateAgentSpec, type AgentSpec, type PlanNode } from '../agents/index.js';
import { AgentAuthoringService } from './agent-authoring.js';
import { AgentRunStore, type AgentRunRecord } from './agent-run-store.js';
import { randomUUID } from 'node:crypto';

/** Capture measure scores + citations from a tool result into a run record. */
function captureToolResult(run: AgentRunRecord, name: string, args: Record<string, unknown>, result: ToolResult): void {
  if (name === 'evaluate_measure' && result.ok && result.data) {
    const d = result.data as { patients?: Array<{ met?: boolean }> };
    run.measureScores.push({ measureId: String(args['measureId'] ?? 'unknown'), met: d.patients?.[0]?.met ?? false });
  }
  for (const c of result.citations ?? []) {
    if (!run.citations.some((x) => x.sourceId === c.sourceId && x.artifactId === c.artifactId)) {
      run.citations.push({ sourceId: c.sourceId, ...(c.artifactId ? { artifactId: c.artifactId } : {}) });
    }
  }
}

/** Render an AgentSpec's plan graph into a short human-readable summary. */
function summarizePlan(node: PlanNode, depth = 0): string {
  const pad = '  '.repeat(depth);
  switch (node.type) {
    case 'step': return `${pad}→ ${node.step.skill}${node.step.id ? ` (${node.step.id})` : ''}`;
    case 'sequence': return node.children.map((c) => summarizePlan(c, depth + 1)).join('\n');
    case 'parallel': return `${pad}▶ parallel:\n${node.children.map((c) => summarizePlan(c, depth + 1)).join('\n')}`;
    case 'conditional': return `${pad}? if ${node.when}:\n${summarizePlan(node.then, depth + 1)}${node.otherwise ? `\n${pad}  else:\n${summarizePlan(node.otherwise, depth + 1)}` : ''}`;
    case 'loop': return `${pad}↻ while ${node.whileExpr} (max ${node.maxIterations}):\n${summarizePlan(node.body, depth + 1)}`;
    default: return pad;
  }
}

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

  // ---------- M20l Realm Local Corpus (customer-supplied protocols) ----------
  app.post<{ Params: { realmId: string }; Body: { filename: string; mimeType?: string; dataBase64: string } }>('/admin/realms/:realmId/local-corpus', async (req, reply) => {
    if (!req.body?.filename || !req.body?.dataBase64) return reply.status(400).send({ ok: false, error: 'filename+dataBase64 required' });
    const { createHash } = await import('node:crypto');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const buf = Buffer.from(req.body.dataBase64, 'base64');
    const hash = createHash('sha256').update(buf).digest('hex');
    const dir = join(storeDir, '__realm__', req.params.realmId, 'local-corpus');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${hash.slice(0, 16)}__${req.body.filename.replace(/[^a-z0-9._-]/gi, '_')}`);
    writeFileSync(path, buf);
    // TODO M21+: run through entity-compiler; for now record as a realm-scoped artifact.
    return { ok: true, artifactId: hash.slice(0, 16), hash, bytes: buf.length, path };
  });

  // ---------- Realm local-corpus list (uploaded protocols/SOPs) ----------
  app.get<{ Params: { realmId: string } }>('/admin/realms/:realmId/local-corpus', async (req) => {
    const dir = join(storeDir, '__realm__', req.params.realmId, 'local-corpus');
    if (!existsSync(dir)) return { documents: [] };
    const documents = readdirSync(dir).map((f) => {
      const path = join(dir, f);
      const hash = f.split('__')[0] ?? '';
      const filename = f.split('__').slice(1).join('__') || f;
      return { artifactId: hash, filename, path, bytes: statSync(path).size, uploadedAt: statSync(path).mtime.toISOString() };
    }).sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
    return { documents };
  });

  // ---------- Agent runs (D — authoring → runtime → measure feedback) ----------
  app.get<{ Querystring: { agentId?: string; limit?: string } }>('/admin/knowledge/agent/runs', async (req) => ({
    runs: AgentRunStore.list({
      ...(req.query.agentId ? { agentId: req.query.agentId } : {}),
      ...(req.query.limit ? { limit: Number(req.query.limit) } : {}),
    }),
  }));
  app.get<{ Params: { episodeId: string } }>('/admin/knowledge/agent/runs/:episodeId', async (req, reply) => {
    const run = AgentRunStore.get(req.params.episodeId);
    if (!run) return reply.code(404).send({ error: 'run-not-found' });
    return run;
  });

  // ---------- Agent runtime (ReAct + Plan-and-Execute over knowledge tools) ----------
  app.post<{ Body: { question: string; strategy?: AgentStrategy; actor?: string; maxSteps?: number; realmId?: string } }>('/admin/knowledge/agent/turn', async (req, reply) => {
    if (!req.body?.question) return reply.status(400).send({ error: 'question required' });
    const episodeId = AgentRunStore.newEpisode();
    const run: AgentRunRecord = {
      episodeId, at: new Date().toISOString(), actorId: req.body.actor ?? 'admin-ui',
      question: req.body.question, strategy: '', answer: '', citations: [], measureScores: [],
    };
    const tools = buildKnowledgeToolBus({
      layer, storeDir, actorId: run.actorId, episodeId, bus: undefined,
      onToolResult: (name, args, result) => captureToolResult(run, name, args, result),
      ...(req.body.realmId ? { realmId: req.body.realmId } : {}),
    });
    const outcome = await runAgentTurn({
      question: req.body.question,
      tools,
      ...(req.body.strategy ? { overrideStrategy: req.body.strategy } : {}),
      ...(req.body.maxSteps !== undefined ? { maxSteps: req.body.maxSteps } : {}),
      ...(req.body.realmId ? { realmId: req.body.realmId } : {}),
    });
    run.strategy = outcome.strategy;
    run.answer = outcome.answer;
    run.citations = outcome.citations.map((c) => ({ sourceId: c.sourceId, ...(c.artifactId ? { artifactId: c.artifactId } : {}) }));
    AgentRunStore.save(run);
    return { episodeId, recorded: true, ...outcome };
  });

  // A3 — run an authored agent spec (draft or published) as a real knowledge turn.
  // The spec's persona, description, governance and plan render into the run's
  // instructions; the returned episode is a genuine, traceable agent run.
  app.post<{ Body: {
    packId: string; agentId: string; source?: 'draft' | 'published';
    question?: string; realmId?: string; maxSteps?: number; strategy?: AgentStrategy; actor?: string;
  } }>('/admin/knowledge/agent/run-spec', async (req, reply) => {
    const { packId, agentId, source, question, realmId, maxSteps, strategy, actor } = req.body ?? {};
    if (!packId || !agentId) return reply.status(400).send({ error: 'packId+agentId required' });
    const authoring = new AgentAuthoringService();
    let yaml: string | null = null;
    if (source === 'draft') {
      yaml = authoring.getDraft(packId, agentId)?.yaml ?? null;
    } else {
      const p = join('packs', packId, 'agents', `${agentId}.yaml`);
      yaml = existsSync(p) ? readFileSync(p, 'utf8') : null;
    }
    if (!yaml) return reply.status(404).send({ error: 'agent-spec-not-found' });
    let spec: AgentSpec;
    try {
      spec = validateAgentSpec(parseYaml(yaml));
    } catch (e) {
      return reply.status(400).send({ error: 'invalid-agent-spec', message: (e as Error).message });
    }
    const instructions = [
      `You are agent "${spec.displayName}" (${spec.id} v${spec.version})`,
      spec.description,
      `Governance: clearance ${spec.governance.clearanceRequired}; purposeOfUse ${spec.governance.purposeOfUse.join(', ')}; phiHandling ${spec.governance.phiHandling}${spec.governance.hitlGates.length ? `; HITL gates after ${spec.governance.hitlGates.map((g) => g.afterStepId).join(', ')}` : ''}`,
      `Plan:\n${summarizePlan(spec.plan)}`,
    ].filter(Boolean).join('\n');
    const episodeId = AgentRunStore.newEpisode();
    const run: AgentRunRecord = {
      episodeId, at: new Date().toISOString(), actorId: actor ?? 'admin-ui',
      agent: { packId, agentId, source: source ?? 'published', displayName: spec.displayName },
      question: question ?? spec.description, strategy: '', answer: '', citations: [], measureScores: [],
    };
    const tools = buildKnowledgeToolBus({
      layer, storeDir, actorId: run.actorId, episodeId, bus: undefined,
      onToolResult: (name, args, result) => captureToolResult(run, name, args, result),
      ...(realmId ? { realmId } : {}),
    });
    const outcome = await runAgentTurn({
      question: run.question,
      tools,
      instructions,
      ...(strategy ? { overrideStrategy: strategy } : {}),
      ...(maxSteps !== undefined ? { maxSteps } : {}),
      ...(realmId ? { realmId } : {}),
    });
    run.strategy = outcome.strategy;
    run.answer = outcome.answer;
    run.citations = outcome.citations.map((c) => ({ sourceId: c.sourceId, ...(c.artifactId ? { artifactId: c.artifactId } : {}) }));
    AgentRunStore.save(run);
    return {
      episodeId,
      recorded: true,
      spec: { id: spec.id, packId: spec.packId, version: spec.version, displayName: spec.displayName, source: source ?? 'published' },
      ...outcome,
    };
  });
}
