// Admin API routes. These back the admin UI screens the operator uses to
// browse packs, agents, assessments, policy graph nodes, ingested manuals,
// research pipelines, and CMS measures. Read-only by design — writes go
// through the pack loader + ingestion pipeline + agent authoring flows,
// which enforce governance.

import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { validateAgentSpec, type AgentSpec } from '../agents/index.js';
import { ALL_CMS_MEASURES } from '../healthcare-core/cms-measure-catalog.js';
import type { CMSMeasureSpec } from '../healthcare-core/cms-source-registry.js';
import { RESEARCH_SOURCES } from '../research/index.js';
import { PHQ9, GAD7, AUDIT_C, BRADEN, MORSE, KDQOL_36_SUMMARY, MNA_SF, CAM_DELIRIUM, FRAIL_SCALE, SDOH_5_DOMAIN, ADL_KATZ, IADL_LAWTON, MOCA_SUMMARY } from '../assessments/index.js';
import { LIFECYCLE_STAGES } from '../lifecycle/index.js';
import { AgentAuthoringService } from './agent-authoring.js';
import { RealmRegistry, populateFacility, type RealmMode, type WorldEffect } from '../realm/index.js';

const authoring = new AgentAuthoringService();

const PACK_ROOTS: readonly { id: string; dir: string }[] = [
  { id: 'flagship-agents', dir: 'packs/flagship-agents/agents' },
  { id: 'dialysis-deep', dir: 'packs/dialysis-deep/agents' },
  { id: 'primary-care-deep', dir: 'packs/primary-care-deep/agents' },
  { id: 'urgent-care-deep', dir: 'packs/urgent-care-deep/agents' },
  { id: 'research-pharma', dir: 'packs/research-pharma/agents' },
  { id: 'dialysis-provider', dir: 'packs/dialysis-provider/agents' },
];

function loadAllAgents(): { packId: string; spec: AgentSpec }[] {
  const out: { packId: string; spec: AgentSpec }[] = [];
  for (const p of PACK_ROOTS) {
    let files: string[];
    try { files = readdirSync(p.dir).filter((f) => f.endsWith('.yaml')); }
    catch { continue; }
    for (const f of files) {
      try {
        const raw = parseYaml(readFileSync(`${p.dir}/${f}`, 'utf8'));
        out.push({ packId: p.id, spec: validateAgentSpec(raw) });
      } catch { /* skip malformed */ }
    }
  }
  return out;
}

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  // Static admin UI shell — served at /admin/ui/*
  const uiRoot = resolve(process.cwd(), 'admin-ui');
  try {
    await app.register(fastifyStatic, { root: uiRoot, prefix: '/admin/ui/', decorateReply: false });
  } catch { /* UI folder missing — API still usable */ }

  // GET /admin/agents — list all agents across all packs with filters
  app.get<{ Querystring: { pack?: string; setting?: string; lifecycleStage?: string; q?: string } }>('/admin/agents', async (req) => {
    const all = loadAllAgents();
    let filtered = all;
    if (req.query.pack) filtered = filtered.filter((a) => a.packId === req.query.pack);
    if (req.query.setting) filtered = filtered.filter((a) => (a.spec.labels as Record<string, unknown> | undefined)?.setting === req.query.setting);
    if (req.query.lifecycleStage) filtered = filtered.filter((a) => (a.spec.labels as Record<string, unknown> | undefined)?.lifecycleStage === req.query.lifecycleStage);
    if (req.query.q) {
      const q = req.query.q.toLowerCase();
      filtered = filtered.filter((a) => a.spec.id.toLowerCase().includes(q) || a.spec.displayName.toLowerCase().includes(q) || (a.spec.description ?? '').toLowerCase().includes(q));
    }
    return {
      count: filtered.length,
      total: all.length,
      agents: filtered.map((a) => ({
        packId: a.packId,
        id: a.spec.id,
        displayName: a.spec.displayName,
        description: a.spec.description,
        setting: (a.spec.labels as Record<string, unknown> | undefined)?.setting,
        lifecycleStage: (a.spec.labels as Record<string, unknown> | undefined)?.lifecycleStage,
        triggerKind: a.spec.trigger.kind,
        triggerEventType: a.spec.trigger.kind === 'event' ? a.spec.trigger.eventType : undefined,
        baseFeeUsd: a.spec.billing?.baseFeeUsd,
        budgetCapMonthlyUsd: a.spec.billing?.budgetCapMonthlyUsd,
      })),
    };
  });

  // GET /admin/agents/:id — full agent spec
  app.get<{ Params: { id: string } }>('/admin/agents/:id', async (req, reply) => {
    const all = loadAllAgents();
    const match = all.find((a) => a.spec.id === req.params.id);
    if (!match) return reply.code(404).send({ error: 'agent-not-found' });
    return { packId: match.packId, spec: match.spec };
  });

  // GET /admin/measures — all CMS measures with filters
  app.get<{ Querystring: { program?: string } }>('/admin/measures', async (req) => {
    let m: readonly CMSMeasureSpec[] = ALL_CMS_MEASURES;
    if (req.query.program) m = m.filter((x) => (x as { programId?: string }).programId === req.query.program);
    return { count: m.length, total: ALL_CMS_MEASURES.length, measures: m };
  });

  // GET /admin/assessments — validated assessment library
  app.get('/admin/assessments', async () => {
    const library = [PHQ9, GAD7, AUDIT_C, MOCA_SUMMARY, BRADEN, MORSE, KDQOL_36_SUMMARY, MNA_SF, CAM_DELIRIUM, FRAIL_SCALE, SDOH_5_DOMAIN, ADL_KATZ, IADL_LAWTON];
    return {
      count: library.length,
      assessments: library.map((a) => ({
        id: a.id,
        title: a.title,
        loinc: a.loinc,
        domain: a.domain,
        scoringMethod: a.scoringMethod,
        itemCount: a.items.length,
        bandCount: a.bands.length,
        reference: a.reference,
      })),
    };
  });

  // GET /admin/lifecycle — patient lifecycle stages + agent hooks
  app.get('/admin/lifecycle', async () => ({ stages: LIFECYCLE_STAGES }));

  // GET /admin/research/sources — public research + pharma sources
  app.get('/admin/research/sources', async () => ({ count: RESEARCH_SOURCES.length, sources: RESEARCH_SOURCES }));

  // --- Authoring: drafts + publish workflow ---

  app.get('/admin/drafts', async () => ({ drafts: authoring.listDrafts() }));

  app.get<{ Params: { packId: string; id: string } }>('/admin/drafts/:packId/:id', async (req, reply) => {
    const d = authoring.getDraft(req.params.packId, req.params.id);
    if (!d) return reply.code(404).send({ error: 'draft-not-found' });
    return d;
  });

  app.post<{ Body: { packId: string; id: string; yaml: string; status?: 'draft' | 'in-review'; note?: string } }>('/admin/drafts', async (req, reply) => {
    try {
      const body = req.body;
      if (!body?.packId || !body?.id || typeof body.yaml !== 'string') return reply.code(400).send({ error: 'bad-request' });
      const draft = authoring.saveDraft({ ...body, actorRef: 'user:admin-ui' });
      return draft;
    } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });

  app.post<{ Body: { yaml: string } }>('/admin/drafts/validate', async (req, reply) => {
    if (typeof req.body?.yaml !== 'string') return reply.code(400).send({ error: 'bad-request' });
    return authoring.validateYaml(req.body.yaml);
  });

  app.post<{ Params: { packId: string; id: string }; Body: { note?: string } }>('/admin/drafts/:packId/:id/publish', async (req, reply) => {
    try {
      const note = req.body?.note;
      return authoring.publish({ packId: req.params.packId, id: req.params.id, actorRef: 'user:admin-ui', ...(note !== undefined ? { note } : {}) });
    } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });

  app.post<{ Params: { packId: string; id: string }; Body: { note: string } }>('/admin/drafts/:packId/:id/reject', async (req, reply) => {
    try {
      if (!req.body?.note) return reply.code(400).send({ error: 'note-required' });
      authoring.reject({ packId: req.params.packId, id: req.params.id, actorRef: 'user:admin-ui', note: req.body.note });
      return { rejected: true };
    } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });

  app.post<{ Body: Parameters<AgentAuthoringService['scaffoldYaml']>[0] }>('/admin/drafts/scaffold', async (req, reply) => {
    try {
      const yaml = authoring.scaffoldYaml(req.body);
      return { yaml };
    } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });

  app.get('/admin/audit-log', async () => ({ entries: authoring.auditLog() }));

  // --- Realms: worlds the agents inhabit ---

  app.get('/admin/realms', async () => ({
    realms: RealmRegistry.list().map((r) => r.snapshot()),
  }));

  app.get<{ Params: { id: string } }>('/admin/realms/:id', async (req, reply) => {
    const r = RealmRegistry.get(req.params.id);
    if (!r) return reply.code(404).send({ error: 'realm-not-found' });
    return { ...r.snapshot(), presences: r.presences.list(), entitiesByKind: r.graph.snapshot().countsByKind };
  });

  app.post<{ Body: { id: string; mode: RealmMode; seed?: { facilityId: string; kind: 'dialysis' | 'primary-care' | 'urgent-care' | 'hospital'; name: string; units: string[]; patientCount: number } } }>('/admin/realms', async (req, reply) => {
    try {
      const { id, mode, seed } = req.body ?? {} as { id: string; mode: RealmMode; seed?: Parameters<typeof populateFacility>[1] };
      if (!id || !mode) return reply.code(400).send({ error: 'id-and-mode-required' });
      const realm = RealmRegistry.create({ id, mode });
      if (seed) populateFacility(realm, seed);
      realm.start();
      return realm.snapshot();
    } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });

  app.post<{ Params: { id: string }; Body: { deltaMs?: number } }>('/admin/realms/:id/tick', async (req, reply) => {
    const r = RealmRegistry.get(req.params.id);
    if (!r) return reply.code(404).send({ error: 'realm-not-found' });
    const tick = r.clock.advanceBy(req.body?.deltaMs ?? 60_000);
    return { tick, snapshot: r.snapshot() };
  });

  app.post<{ Params: { id: string }; Body: { agentSpecId: string; role: string; clearance: string; facilityId: string; unitId?: string } }>('/admin/realms/:id/presences', async (req, reply) => {
    const r = RealmRegistry.get(req.params.id);
    if (!r) return reply.code(404).send({ error: 'realm-not-found' });
    try {
      const p = r.spawnPresence({
        realmId: r.id, agentSpecId: req.body.agentSpecId, runId: `manual-${Date.now()}`,
        role: req.body.role as 'nurse', clearance: req.body.clearance as 'phi', purposeOfUse: ['treatment'],
        location: { facilityId: req.body.facilityId, ...(req.body.unitId ? { unitId: req.body.unitId } : {}) },
      });
      return p;
    } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });

  app.post<{ Params: { id: string }; Body: { presenceId: string; effect: WorldEffect } }>('/admin/realms/:id/emit', async (req, reply) => {
    const r = RealmRegistry.get(req.params.id);
    if (!r) return reply.code(404).send({ error: 'realm-not-found' });
    try { return r.emit(req.body.presenceId, req.body.effect); }
    catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });

  app.get<{ Params: { id: string } }>('/admin/realms/:id/effects', async (req, reply) => {
    const r = RealmRegistry.get(req.params.id);
    if (!r) return reply.code(404).send({ error: 'realm-not-found' });
    return { effects: r.ledger.listAll() };
  });

  app.get<{ Params: { id: string } }>('/admin/realms/:id/perception', async (req, reply) => {
    const r = RealmRegistry.get(req.params.id);
    if (!r) return reply.code(404).send({ error: 'realm-not-found' });
    return { events: r.perception.recentLog(200) };
  });

  // Live SSE stream: perception events, effects, experiences, attributions.
  // Format: `data: {"type":"perception|effect|experience|attribution","payload":...}\n\n`
  app.get<{ Params: { id: string } }>('/admin/realms/:id/stream', async (req, reply) => {
    const r = RealmRegistry.get(req.params.id);
    if (!r) return reply.code(404).send({ error: 'realm-not-found' });
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const write = (type: string, payload: unknown) => {
      try { reply.raw.write(`data: ${JSON.stringify({ type, at: new Date().toISOString(), payload })}\n\n`); } catch { /* client gone */ }
    };
    write('hello', { realmId: r.id, seq: r.clock.seq, realmAt: r.clock.realmAt.toISOString() });

    // Perception (broadcast to all presences) — we peek through the router log by polling delta.
    let lastPercLen = r.perception.recentLog(1).length;
    const percTimer = setInterval(() => {
      const log = r.perception.recentLog(200);
      if (log.length > lastPercLen) {
        for (const ev of log.slice(lastPercLen)) write('perception', ev);
        lastPercLen = log.length;
      }
    }, 250);

    const offEffect = r.ledger.onAppend((e) => write('effect', e));
    const offExp = r.rules.subscribe((exp) => write('experience', exp));

    // Attribution polling — records grow on downstream effects.
    let lastAttrLen = r.attribution.all().length;
    const attrTimer = setInterval(() => {
      const rec = r.attribution.all();
      if (rec.length > lastAttrLen) {
        for (const a of rec.slice(lastAttrLen)) write('attribution', a);
        lastAttrLen = rec.length;
      }
    }, 500);

    // Heartbeat every 15s so proxies don't kill the connection.
    const hb = setInterval(() => write('heartbeat', { seq: r.clock.seq, realmAt: r.clock.realmAt.toISOString() }), 15_000);

    req.raw.on('close', () => {
      clearInterval(percTimer);
      clearInterval(attrTimer);
      clearInterval(hb);
      offEffect();
      offExp();
    });
  });

  // Episode replay — deterministic replay of a stored episode from its seed.
  // Returns whether the replayed choice matches the stored choice.
  app.get<{ Params: { id: string; episodeId: string } }>('/admin/realms/:id/episodes/:episodeId/replay', async (req, reply) => {
    const r = RealmRegistry.get(req.params.id);
    if (!r) return reply.code(404).send({ error: 'realm-not-found' });
    const ep = r.episodes.get(req.params.episodeId);
    if (!ep) return reply.code(404).send({ error: 'episode-not-found' });
    if (!ep.choice) return { episodeId: ep.episodeId, replay: 'no-choice', ep };
    const { replayEpisodeChoice } = await import('../realm/replay.js');
    const outcome = replayEpisodeChoice(ep, r.selfModel);
    return outcome;
  });

  // Self-Model narrative — template by default, adapter=rich for the richer local writer.
  app.get<{ Params: { id: string; presenceId: string }; Querystring: { adapter?: string } }>('/admin/realms/:id/self/:presenceId/narrative', async (req, reply) => {
    const r = RealmRegistry.get(req.params.id);
    if (!r) return reply.code(404).send({ error: 'realm-not-found' });
    const presence = r.presences.get(req.params.presenceId);
    if (!presence) return reply.code(404).send({ error: 'presence-not-found' });
    if (req.query.adapter === 'rich') {
      const { LocalRichAdapter } = await import('../realm/narrative.js');
      const attrs = r.attribution.forPresence(presence.presenceId).slice(-10).map((a) => ({ ruleId: a.ruleId, outcome: a.consequence.outcome, kind: a.consequence.kind }));
      return r.selfModel.narrative(presence, r.episodes, new LocalRichAdapter(), { recentAttributions: attrs });
    }
    return r.selfModel.narrativeTemplate(presence, r.episodes);
  });

  // GET /admin/summary — count-only rollup for admin dashboard
  app.get('/admin/summary', async () => {
    const agents = loadAllAgents();
    const byPack = new Map<string, number>();
    for (const a of agents) byPack.set(a.packId, (byPack.get(a.packId) ?? 0) + 1);
    return {
      agents: { total: agents.length, byPack: Object.fromEntries(byPack) },
      measures: { total: ALL_CMS_MEASURES.length },
      assessments: { total: 13 },
      lifecycleStages: LIFECYCLE_STAGES.length,
      researchSources: RESEARCH_SOURCES.length,
    };
  });
}
