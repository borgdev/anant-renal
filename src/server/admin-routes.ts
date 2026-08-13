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
import { RealmRegistry, populateFacility, Federation, invoicePreview, usageCsv, DEFAULT_BILLING_PLAN, runCounterfactual, type RealmMode, type WorldEffect, type TimelineEntry, type Intervention } from '../realm/index.js';
import { listDirectives, listPlanAdvances, directivesByTarget } from '../realm/governance.js';
import { NotificationHub, attachBus } from '../realm/notifications.js';
import { LLMRegistry } from '../realm/llm-registry.js';
import { CounterfactualStore } from '../realm/counterfactual-store.js';
import { captureSnapshot, restoreSnapshot, SnapshotRegistry } from '../realm/realm-snapshot.js';

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

  // ---- M12 routes ----

  // Approvals queue (HITL)
  app.get<{ Params: { id: string }; Querystring: { status?: string } }>('/admin/realms/:id/approvals', async (req, reply) => {
    const r = RealmRegistry.get(req.params.id);
    if (!r) return reply.code(404).send({ error: 'realm-not-found' });
    const items = req.query.status === 'pending' ? r.hitl.pending() : r.hitl.all();
    return { items, gates: r.hitl.listGates() };
  });

  app.post<{ Params: { id: string; approvalId: string }; Body: { decision: 'approve' | 'reject'; decidedBy: string; note?: string } }>('/admin/realms/:id/approvals/:approvalId/decide', async (req, reply) => {
    const r = RealmRegistry.get(req.params.id);
    if (!r) return reply.code(404).send({ error: 'realm-not-found' });
    try {
      const rec = r.hitl.decide(req.params.approvalId, req.body.decision, req.body.decidedBy, req.body.note);
      return { decided: rec };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  // Cost / outcome rollup
  app.get<{ Params: { id: string } }>('/admin/realms/:id/cost', async (req, reply) => {
    const r = RealmRegistry.get(req.params.id);
    if (!r) return reply.code(404).send({ error: 'realm-not-found' });
    return { rollup: r.cost.rollup(), records: r.cost.list() };
  });

  // Intent submission + plan retrieval
  app.post<{ Params: { id: string }; Body: { intentKind: string; subjectRef?: string; description: string; priority: 'low' | 'normal' | 'high' | 'critical'; by: string } }>('/admin/realms/:id/intents', async (req, reply) => {
    const r = RealmRegistry.get(req.params.id);
    if (!r) return reply.code(404).send({ error: 'realm-not-found' });
    try {
      const result = await r.submitIntent(req.body);
      return result;
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.get<{ Params: { id: string } }>('/admin/realms/:id/intents', async (req, reply) => {
    const r = RealmRegistry.get(req.params.id);
    if (!r) return reply.code(404).send({ error: 'realm-not-found' });
    return { intents: r.listIntents(), plans: r.listPlans() };
  });

  // Org-graph
  app.get<{ Params: { id: string } }>('/admin/realms/:id/org', async (req, reply) => {
    const r = RealmRegistry.get(req.params.id);
    if (!r) return reply.code(404).send({ error: 'realm-not-found' });
    return { nodes: r.graph.listKind('org-node').map((n) => ({ id: n.id, ...n.state })) };
  });

  // Operator seat — parse + apply
  app.post<{ Params: { id: string }; Body: { text: string; adminPresenceId: string; apply?: boolean } }>('/admin/realms/:id/operator', async (req, reply) => {
    const r = RealmRegistry.get(req.params.id);
    if (!r) return reply.code(404).send({ error: 'realm-not-found' });
    const parsed = await r.operatorSeat.parse(req.body.text);
    if (!parsed) return reply.code(400).send({ error: 'unparseable-directive', hint: 'try: spawn a nurse in unit-a; bias nurse-1 toward hold-med by 0.3; get pt-1 discharged safely; explain nurse-1' });
    if (req.body.apply === true) {
      const result = r.operatorSeat.apply(parsed, req.body.adminPresenceId);
      return { parsed, applied: result };
    }
    return { parsed, applied: null };
  });

  // GET /admin/summary — count-only rollup for admin dashboard
  // ---------- M13.A PlanRunner ----------
  app.post<{ Params: { id: string; planId: string } }>('/admin/realms/:id/plans/:planId/step', async (req, reply) => {
    const r = RealmRegistry.get(req.params.id);
    if (!r) { reply.code(404); return { error: 'realm-not-found' }; }
    const outcome = r.stepPlan(req.params.planId);
    return { outcome, plan: r.getPlan(req.params.planId) };
  });
  app.post<{ Params: { id: string; planId: string } }>('/admin/realms/:id/plans/:planId/run', async (req, reply) => {
    const r = RealmRegistry.get(req.params.id);
    if (!r) { reply.code(404); return { error: 'realm-not-found' }; }
    const outcomes = r.runPlan(req.params.planId);
    return { outcomes, plan: r.getPlan(req.params.planId) };
  });

  // ---------- M13.C Multi-facility federation ----------
  app.get('/admin/orgs', async () => ({ orgs: Federation.listOrgs() }));
  app.post<{ Body: { orgId: string; displayName: string; realmIds: string[] } }>('/admin/orgs', async (req, reply) => {
    try {
      const org = Federation.registerOrg({ orgId: req.body.orgId, displayName: req.body.displayName, realmIds: req.body.realmIds });
      return { org };
    } catch (e) { reply.code(400); return { error: (e as Error).message }; }
  });
  app.get<{ Params: { orgId: string } }>('/admin/orgs/:orgId/summary', async (req, reply) => {
    const summary = Federation.orgSummary(req.params.orgId);
    if (!summary) { reply.code(404); return { error: 'org-not-found' }; }
    return summary;
  });
  app.get<{ Params: { orgId: string } }>('/admin/orgs/:orgId/cost', async (req) => ({ rollup: Federation.costRollup(req.params.orgId) }));
  app.get<{ Params: { orgId: string } }>('/admin/orgs/:orgId/hitl', async (req) => ({ load: Federation.hitlLoad(req.params.orgId) }));
  app.get<{ Params: { orgId: string } }>('/admin/orgs/:orgId/plans', async (req) => ({ throughput: Federation.planThroughput(req.params.orgId) }));
  app.get<{ Params: { orgId: string } }>('/admin/orgs/:orgId/safety', async (req) => ({ load: Federation.safetyLoad(req.params.orgId) }));

  // ---------- M13.G Policy trace ----------
  app.get<{ Params: { id: string; presenceId: string }; Querystring: { kinds?: string } }>('/admin/realms/:id/policy/:presenceId', async (req, reply) => {
    const r = RealmRegistry.get(req.params.id);
    if (!r) { reply.code(404); return { error: 'realm-not-found' }; }
    const defaultKinds = ['order-lab', 'order-med', 'hold-med', 'record-vitals', 'flag-safety-event', 'submit-claim', 'discharge-patient', 'schedule-followup'];
    const kinds = req.query.kinds ? req.query.kinds.split(',') : defaultKinds;
    return { trace: r.policy.trace(req.params.presenceId, kinds as WorldEffect['kind'][]) };
  });

  // ---------- M13.F Counterfactual (caller supplies fresh-realm spec) ----------
  app.post<{ Body: {
    realmMode: RealmMode;
    facility: { facilityId: string; kind: 'dialysis' | 'primary-care' | 'urgent-care' | 'hospital'; name: string; units: string[]; patientCount: number };
    interventions: Intervention[];
    timeline?: TimelineEntry[];
    advanceTicks?: number;
  } }>('/admin/counterfactual', async (req, reply) => {
    const { realmMode, facility, interventions, timeline, advanceTicks } = req.body;
    if (!facility) { reply.code(400); return { error: 'facility-required' }; }
    const build = () => {
      const fresh = RealmRegistry.create({ id: `cf#${facility.facilityId}#${Date.now()}#${Math.random().toString(36).slice(2, 6)}`, mode: realmMode });
      populateFacility(fresh, facility);
      return fresh;
    };
    const input = {
      build,
      timeline: timeline ?? [],
      interventions: interventions ?? [],
      ...(advanceTicks !== undefined ? { advanceTicks } : {}),
    };
    try {
      const report = runCounterfactual(input);
      return report;
    } catch (e) { reply.code(500); return { error: (e as Error).message }; }
  });

  // ---------- M13.B Metered billing ----------
  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string; format?: 'json' | 'csv' } }>('/admin/realms/:id/billing', async (req, reply) => {
    const r = RealmRegistry.get(req.params.id);
    if (!r) { reply.code(404); return { error: 'realm-not-found' }; }
    const period = {
      ...(req.query.from ? { from: new Date(req.query.from) } : {}),
      ...(req.query.to ? { to: new Date(req.query.to) } : {}),
    };
    const report = invoicePreview(r, DEFAULT_BILLING_PLAN, period);
    if (req.query.format === 'csv') {
      reply.header('content-type', 'text/csv');
      return usageCsv(report);
    }
    return { plan: DEFAULT_BILLING_PLAN, report };
  });

  // ---- M14 routes ----

  // M14.A — Plan execution timeline
  app.get<{ Params: { id: string; planId: string } }>('/admin/realms/:id/plans/:planId/timeline', async (req, reply) => {
    const r = RealmRegistry.get(req.params.id); if (!r) return reply.code(404).send({ error: 'realm-not-found' });
    const plan = r.getPlan(req.params.planId); if (!plan) return reply.code(404).send({ error: 'plan-not-found' });
    const runLog = (plan as unknown as { runLog?: unknown[] }).runLog ?? [];
    return { planId: plan.planId, steps: plan.steps, runLog };
  });

  // M14.B — Counterfactual studio (persists results for later reference)
  app.post<{ Body: {
    realmId: string;
    facility: { facilityId: string; kind: 'dialysis' | 'primary-care' | 'urgent-care' | 'hospital'; name: string; units: string[]; patientCount: number };
    interventions: Intervention[];
    timeline?: TimelineEntry[];
    advanceTicks?: number;
    label?: string;
  } }>('/admin/counterfactual/run', async (req, reply) => {
    const source = RealmRegistry.get(req.body.realmId); if (!source) return reply.code(404).send({ error: 'realm-not-found' });
    const { facility } = req.body;
    if (!facility) return reply.code(400).send({ error: 'facility-required' });
    const build = () => {
      const fresh = RealmRegistry.create({ id: `cf#${facility.facilityId}#${Date.now()}#${Math.random().toString(36).slice(2, 6)}`, mode: 'sim' });
      populateFacility(fresh, facility);
      return fresh;
    };
    const input = { build, interventions: req.body.interventions, timeline: req.body.timeline ?? [], ...(req.body.advanceTicks !== undefined ? { advanceTicks: req.body.advanceTicks } : {}) };
    try {
      const report = runCounterfactual(input);
      const rec = CounterfactualStore.save(input, report, req.body.label ?? 'ad-hoc', req.body.realmId);
      return rec;
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  app.get('/admin/counterfactual', async () => ({ records: CounterfactualStore.list() }));
  app.get<{ Params: { id: string } }>('/admin/counterfactual/:id', async (req, reply) => {
    const rec = CounterfactualStore.get(req.params.id); if (!rec) return reply.code(404).send({ error: 'cf-not-found' });
    return rec;
  });

  // M14.C — Governance / directive ledger
  app.get<{ Params: { id: string }; Querystring: { verb?: string; presenceId?: string; since?: string; until?: string } }>('/admin/realms/:id/governance/directives', async (req, reply) => {
    const r = RealmRegistry.get(req.params.id); if (!r) return reply.code(404).send({ error: 'realm-not-found' });
    const filter: Parameters<typeof listDirectives>[1] = {};
    if (req.query.verb) filter.verb = req.query.verb;
    if (req.query.presenceId) filter.presenceId = req.query.presenceId;
    if (req.query.since) filter.since = req.query.since;
    if (req.query.until) filter.until = req.query.until;
    return { directives: listDirectives(r, filter) };
  });
  app.get<{ Params: { id: string }; Querystring: { planId?: string } }>('/admin/realms/:id/governance/advances', async (req, reply) => {
    const r = RealmRegistry.get(req.params.id); if (!r) return reply.code(404).send({ error: 'realm-not-found' });
    const filter: Parameters<typeof listPlanAdvances>[1] = {};
    if (req.query.planId) filter.planId = req.query.planId;
    return { advances: listPlanAdvances(r, filter) };
  });
  app.get<{ Params: { id: string } }>('/admin/realms/:id/governance/by-target', async (req, reply) => {
    const r = RealmRegistry.get(req.params.id); if (!r) return reply.code(404).send({ error: 'realm-not-found' });
    return { byTarget: directivesByTarget(r) };
  });

  // M14.D — Notification bus
  app.get('/admin/notifications', async () => ({ notifications: NotificationHub.recent(100) }));
  app.get('/admin/notifications/subscriptions', async () => ({ subscriptions: NotificationHub.listSubscriptions().map((s) => ({ id: s.id, role: s.role, eventKinds: s.eventKinds })) }));
  app.post<{ Body: { role?: string; eventKinds: WorldEffect['kind'][] } }>('/admin/notifications/subscriptions', async (req) => {
    const id = NotificationHub.subscribe({ ...(req.body.role !== undefined ? { role: req.body.role } : {}), eventKinds: req.body.eventKinds, sink: () => { /* in-process only — UI polls */ } });
    return { id };
  });
  app.delete<{ Params: { id: string } }>('/admin/notifications/subscriptions/:id', async (req) => ({ removed: NotificationHub.unsubscribe(req.params.id) }));
  app.post<{ Params: { id: string } }>('/admin/realms/:id/notifications/attach', async (req, reply) => {
    const r = RealmRegistry.get(req.params.id); if (!r) return reply.code(404).send({ error: 'realm-not-found' });
    attachBus(r);
    return { attached: true, realmId: req.params.id };
  });

  // M14.E — Org-scoped billing rollup
  app.get<{ Params: { orgId: string }; Querystring: { from?: string; to?: string } }>('/admin/orgs/:orgId/billing', async (req, reply) => {
    try {
      const period: { from?: Date; to?: Date } = {};
      if (req.query.from) period.from = new Date(req.query.from);
      if (req.query.to) period.to = new Date(req.query.to);
      return Federation.invoicePreviewForOrg(req.params.orgId, DEFAULT_BILLING_PLAN, period);
    } catch (err) {
      return reply.code(404).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // M14.F — LLM adapter registry
  app.get('/admin/llm-adapters', async () => ({ adapters: LLMRegistry.view() }));
  app.post<{ Params: { id: string }; Body: { enabled: boolean } }>('/admin/llm-adapters/:id/enabled', async (req, reply) => {
    try {
      const a = LLMRegistry.setEnabled(req.params.id, req.body.enabled);
      const { handle: _handle, ...rest } = a;
      return rest;
    } catch (err) {
      return reply.code(404).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  app.post<{ Params: { id: string } }>('/admin/llm-adapters/:id/health', async (req, reply) => {
    try {
      const health = await LLMRegistry.healthCheck(req.params.id);
      return health;
    } catch (err) {
      return reply.code(404).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // M14.G — Realm snapshot + restore
  app.post<{ Params: { id: string } }>('/admin/realms/:id/snapshot', async (req, reply) => {
    const r = RealmRegistry.get(req.params.id); if (!r) return reply.code(404).send({ error: 'realm-not-found' });
    const snap = captureSnapshot(r);
    const snapId = SnapshotRegistry.save(snap);
    return { snapshotId: snapId, capturedAt: snap.capturedAt, seq: snap.realm.seq, ledgerLength: snap.effects.length };
  });
  app.get('/admin/snapshots', async () => ({ snapshots: SnapshotRegistry.list() }));
  app.get<{ Params: { id: string } }>('/admin/snapshots/:id', async (req, reply) => {
    const s = SnapshotRegistry.get(req.params.id); if (!s) return reply.code(404).send({ error: 'snapshot-not-found' });
    return s;
  });
  app.post<{ Params: { id: string }; Body: {
    newRealmId?: string;
    facility: { facilityId: string; kind: 'dialysis' | 'primary-care' | 'urgent-care' | 'hospital'; name: string; units: string[]; patientCount: number };
    replayEffects?: boolean;
  } }>('/admin/snapshots/:id/restore', async (req, reply) => {
    const s = SnapshotRegistry.get(req.params.id); if (!s) return reply.code(404).send({ error: 'snapshot-not-found' });
    const facility = req.body.facility;
    if (!facility) return reply.code(400).send({ error: 'facility-required' });
    const newId = req.body.newRealmId ?? `${s.realm.id}-restored-${Date.now().toString(36)}`;
    try {
      const restored = restoreSnapshot(s, () => {
        const fresh = RealmRegistry.create({ id: newId, mode: s.realm.mode as RealmMode });
        populateFacility(fresh, facility);
        return fresh;
      }, { ...(req.body.replayEffects !== undefined ? { replayEffects: req.body.replayEffects } : {}) });
      return { restored: restored.id, seq: restored.clock.seq, ledgerLength: restored.ledger.listAll().length };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

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
