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
