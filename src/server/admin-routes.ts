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
import { AcceleratedClock } from '../realm/clock.js';
import { backfillAnchorMs, backfillRealmHistory, type BackfillResult } from '../simulator/backfill.js';
import { listDirectives, listPlanAdvances, directivesByTarget } from '../realm/governance.js';
import { NotificationHub, attachBus } from '../realm/notifications.js';
import { LLMRegistry } from '../realm/llm-registry.js';
import { CounterfactualStore } from '../realm/counterfactual-store.js';
import { captureSnapshot, restoreSnapshot, SnapshotRegistry } from '../realm/realm-snapshot.js';
import { buildHealthcareHypergraphSchema, HEALTHCARE_NODE_SCHEMAS, HEALTHCARE_EDGE_SCHEMAS } from '../../packs/healthcare-core/hypergraph.js';
import { materializeEntityGraph } from '../realm/entity-record.js';
import { RealmHypergraph } from '../realm/hypergraph-bridge.js';
import { countsByType } from '../hypergraph/queries/healthcare.js';
import { getSqlStore } from './sql/index.js';
import {
  createOrgWithFacilities,
  parseFacilitiesCsv,
  ONBOARDING_TEMPLATES,
  findTemplate,
  startWizard,
  saveWizard,
  getWizard,
  listWizards,
  completeWizard,
  type OrganizationTemplate,
  type FacilitySpec,
  type WizardState,
} from '../onboarding/bootstrap.js';
import {
  IdentityRegistry,
  Scim,
  createInvite,
  listInvites,
  revokeInvite,
  claimInvite,
  activateBreakGlass,
  endBreakGlass,
  reviewBreakGlass,
  pendingReviews,
  beginOidcAuth,
  handleOidcCallback,
  beginWorkOSSso,
  handleWorkOSCallback,
  syncWorkOSDirectory,
  orgForToken,
  type IdentityProviderConfig,
  type RoleMapping,
  type ScimUser,
  type ScimGroup,
} from '../identity/index.js';
import { SelfServeAdmin } from '../self-serve/admin.js';
import { compileEntityPack, type CompileOptions, type CompileReport } from '../entity-compiler/index.js';
import { LiquidModelStore, LiquidTrainer, type TrainRequest } from '../liquid/index.js';
import { MeasureEvaluator } from '../measures/evaluator.js';
import { ValueSetRegistry } from '../measures/value-set-registry.js';
import { loadFromDisk } from '../measures/store-loader.js';
import { syncMeasures } from '../measures/source-registry.js';
import { evaluateCatalogMeasure } from '../measures/catalog-evaluator.js';
import type { StoredMeasure } from '../measures/types.js';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';

/** Title-token overlap matcher — suggests a synced eCQM measure for a catalog measure. */
function titleTokens(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
}
function bestMeasureMatch(catTitle: string, synced: readonly StoredMeasure[]): { id: string; score: number } | null {
  const ct = titleTokens(catTitle);
  if (ct.size === 0) return null;
  let best: { id: string; score: number } | null = null;
  for (const m of synced) {
    const st = titleTokens(`${m.title} ${m.name} ${m.cmsId}`);
    let score = 0;
    for (const t of ct) if (st.has(t)) score++;
    if (score > 0 && (!best || score > best.score)) best = { id: m.id, score };
  }
  return best;
}

const _compileReports = new Map<string, CompileReport>();

const authoring = new AgentAuthoringService();

let _measureEvaluator: { evaluator: MeasureEvaluator; repoSlugs: string[]; measureCount: number; libraryCount: number; loadedAt: string; root: string } | null = null;

export function getMeasureEvaluator(): typeof _measureEvaluator {
  if (_measureEvaluator) return _measureEvaluator;
  const root = process.env['HH_MEASURES_ROOT'] ?? pathJoin(process.cwd(), '.harness', 'measures');
  if (!existsSync(root)) return null;
  const store = loadFromDisk({ root });
  if (store.measures.length === 0) return null;
  const cacheDir = pathJoin(tmpdir(), 'hh-vsr-cache');
  mkdirSync(cacheDir, { recursive: true });
  const vsr = new ValueSetRegistry(cacheDir);
  const evaluator = new MeasureEvaluator({ measures: store.measures, libraries: store.libraries, valueSetRegistry: vsr });
  _measureEvaluator = { evaluator, repoSlugs: store.repoSlugs, measureCount: store.measures.length, libraryCount: store.libraries.length, loadedAt: new Date().toISOString(), root };
  return _measureEvaluator;
}

/** Drop the cached evaluator so the next read reloads the synced store. */
export function invalidateMeasureEvaluator(): void { _measureEvaluator = null; }

const PACK_ROOTS: readonly { id: string; dir: string }[] = [
  { id: 'flagship-agents', dir: 'packs/flagship-agents/agents' },
  { id: 'dialysis-deep', dir: 'packs/dialysis-deep/agents' },
  { id: 'primary-care-deep', dir: 'packs/primary-care-deep/agents' },
  { id: 'urgent-care-deep', dir: 'packs/urgent-care-deep/agents' },
  { id: 'research-pharma', dir: 'packs/research-pharma/agents' },
  { id: 'dialysis-provider', dir: 'packs/dialysis-provider/agents' },
];

export function loadAllAgents(): { packId: string; spec: AgentSpec }[] {
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

export interface AdminRoutesOptions {
  /** Phase 3 — live EventBroker (health/DLQ) for the admin panel. */
  readonly eventBroker?: import('./event-broker.js').EventBroker;
  /** Phase 3 — transactional outbox (replay-from-cursor). */
  readonly eventOutbox?: import('./event-outbox.js').EventOutbox;
  /** Phase 3 — realm → broker bridge (attach/detach per realm). */
  readonly realmEventBridge?: import('./realm-event-bridge.js').RealmEventBridge;
}

export async function registerAdminRoutes(app: FastifyInstance, opts: AdminRoutesOptions = {}): Promise<void> {
  // Static admin UI shell — served at /admin/ui/*
  const uiRoot = resolve(process.cwd(), 'admin-ui');
  try {
    await app.register(fastifyStatic, { root: uiRoot, prefix: '/admin/ui/', decorateReply: false });
  } catch { /* UI folder missing — API still usable */ }

  // Renal Swarm executive console — served at /exec/* (Vite build of exec-app/).
  // Wired to the same backend via same-origin /admin/swarm/* endpoints.
  const execRoot = resolve(process.cwd(), 'exec-app', 'dist');
  try {
    await app.register(fastifyStatic, { root: execRoot, prefix: '/exec/', decorateReply: false });
  } catch { /* exec-app not built — console unavailable */ }

  // Canonical documents carry a trailing slash (the static plugins match
  // '/admin/ui/*' and '/exec/*'); the bare paths 404 otherwise. Redirect.
  app.get('/admin/ui', async (_req, reply) => reply.redirect('/admin/ui/'));
  app.get('/exec', async (_req, reply) => reply.redirect('/exec/'));

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

  // GET /admin/measures/store — live-loaded FHIR Measure/Library store (M20 sync output)
  app.get('/admin/measures/store', async () => {
    const me = getMeasureEvaluator();
    if (!me) return { loaded: false, measures: [], libraries: 0 };
    return {
      loaded: true,
      root: me.root,
      loadedAt: me.loadedAt,
      repoSlugs: me.repoSlugs,
      libraries: me.libraryCount,
      measures: me.evaluator.listMeasures().map((m) => ({
        id: m.id, cmsId: m.cmsId, name: m.name, title: m.title,
        version: m.version, status: m.status,
        libraryRefs: m.libraryRefs, upstream: m.upstream,
      })),
    };
  });

  // GET /admin/measures/coverage — which catalog measures are evaluable in the
  // synced eCQM store, plus a title-overlap suggestion per catalog measure.
  app.get('/admin/measures/coverage', async () => {
    const me = getMeasureEvaluator();
    const synced = me ? me.evaluator.listMeasures() : [];
    const byProgram: Record<string, number> = {};
    const catalog = ALL_CMS_MEASURES.map((c) => {
      byProgram[c.programId] = (byProgram[c.programId] ?? 0) + 1;
      const match = bestMeasureMatch(c.title, synced);
      // evaluable via synced CQL or embedded (CQL-free) thresholds
      const source = match ? 'synced' : c.thresholds ? 'embedded' : null;
      return { id: c.id, title: c.title, programId: c.programId, evaluable: !!source, source, syncedId: match?.id ?? null };
    });
    return {
      catalogTotal: ALL_CMS_MEASURES.length,
      syncedTotal: synced.length,
      embeddedTotal: catalog.filter((c) => c.source === 'embedded').length,
      evaluableTotal: catalog.filter((c) => c.evaluable).length,
      byProgram,
      catalog,
      synced: synced.map((m) => ({ id: m.id, cmsId: m.cmsId, title: m.title })),
    };
  });

  // POST /admin/measures/sync — pull real FHIR Measure/Library resources from the
  // authoritative cqframework eCQM GitHub repo (requires network). Graceful offline.
  app.post<{ Body: { token?: string; filter?: string } }>('/admin/measures/sync', async (req, reply) => {
    const root = process.env['HH_MEASURES_ROOT'] ?? pathJoin(process.cwd(), '.harness', 'measures');
    mkdirSync(root, { recursive: true });
    try {
      const results = await syncMeasures({
        layout: { root },
        ...(req.body?.token ? { token: req.body.token } : process.env['GITHUB_TOKEN'] ? { token: process.env['GITHUB_TOKEN'] } : {}),
        ...(req.body?.filter ? { filter: req.body.filter } : {}),
      });
      invalidateMeasureEvaluator();
      return { ok: true, root, results };
    } catch (err) {
      reply.code(502);
      return {
        ok: false,
        error: 'sync-failed',
        message: err instanceof Error ? err.message : String(err),
        hint: 'This needs network access to github.com/cqframework. The local M21Basic fixture keeps the store non-empty offline (run scripts/seed-measure-store.mjs to reseed).',
      };
    }
  });

  // POST /admin/measures/:id/evaluate — run the CQL evaluator on a FHIR bundle.
  // :id accepts both the canonical id ('ecqm:...') and the plain CMS id.
  app.post<{ Params: { id: string }; Body: { bundle: unknown; measurementPeriod?: { start: string; end: string } } }>(
    '/admin/measures/:id/evaluate',
    async (req, reply) => {
      const decodedId = decodeURIComponent(req.params.id);
      if (!req.body || typeof req.body !== 'object' || !('bundle' in req.body)) {
        reply.code(400); return { error: 'body-must-include-bundle' };
      }
      // Embedded catalog measures (CQL-free thresholds) — no synced store required.
      const spec = ALL_CMS_MEASURES.find((m) => m.id === decodedId);
      if (spec?.thresholds) return evaluateCatalogMeasure(spec, req.body.bundle);
      const me = getMeasureEvaluator();
      if (!me) { reply.code(503); return { error: 'measure-store-not-loaded', hint: 'Run cqframework sync first' }; }
      const measure = me.evaluator.getMeasure(decodedId);
      if (!measure) { reply.code(404); return { error: 'measure-not-found', measureId: decodedId }; }
      try {
        const result = await me.evaluator.evaluate({
          measureId: measure.id,
          bundle: req.body.bundle,
          ...(req.body.measurementPeriod ? { measurementPeriod: req.body.measurementPeriod } : {}),
        });
        return result;
      } catch (err) {
        reply.code(500);
        return { error: 'evaluation-failed', message: err instanceof Error ? err.message : String(err) };
      }
    },
  );

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

  app.delete<{ Params: { packId: string; id: string } }>('/admin/drafts/:packId/:id', async (req, reply) => {
    const ok = authoring.removeDraft(req.params.packId, req.params.id);
    if (!ok) return reply.code(404).send({ error: 'draft-not-found' });
    return { ok: true, removed: req.params.id };
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

  // --- Hypergraph (Phase 1 — the realm's entity graph, typed) ---

  app.get('/admin/hypergraph/schema', async () => ({
    nodeTypeCount: HEALTHCARE_NODE_SCHEMAS.length,
    edgeTypeCount: HEALTHCARE_EDGE_SCHEMAS.length,
    nodeTypes: HEALTHCARE_NODE_SCHEMAS.map((n) => n.type),
    edgeTypes: HEALTHCARE_EDGE_SCHEMAS.map((e) => e.type),
  }));

  app.get<{ Params: { id: string } }>('/admin/hypergraph/realm/:id', async (req, reply) => {
    const r = RealmRegistry.get(req.params.id);
    if (!r) return reply.code(404).send({ error: 'realm-not-found' });
    // Prefer the realm's live bridge (auto-populated by every effect); else materialize cold.
    const schema = buildHealthcareHypergraphSchema();
    const snap = r.hypergraph ? r.hypergraph.store.now() : materializeEntityGraph(r.graph, schema, { actorRef: 'user:admin', scopeId: req.params.id }).store.now();
    return {
      realmId: req.params.id,
      live: Boolean(r.hypergraph),
      nodeCount: snap.nodes.size,
      edgeCount: snap.edges.size,
      countsByType: countsByType(snap),
      edgeTypesByType: [...snap.edges.values()].reduce<Record<string, number>>((a, e) => { a[e.type] = (a[e.type] ?? 0) + 1; return a; }, {}),
      patients: [...snap.nodes.values()].filter((n) => n.type === 'patient').map((n) => n.attributes['patientId']),
      effects: [...snap.nodes.values()].filter((n) => n.type === 'effect').length,
    };
  });

  // Full graph (nodes + edges arrays) for the Hypergraph browser SVG.
  app.get<{ Params: { id: string } }>('/admin/hypergraph/realm/:id/graph', async (req, reply) => {
    const r = RealmRegistry.get(req.params.id);
    if (!r) return reply.code(404).send({ error: 'realm-not-found' });
    const schema = buildHealthcareHypergraphSchema();
    const snap = r.hypergraph ? r.hypergraph.store.now() : materializeEntityGraph(r.graph, schema, { actorRef: 'user:admin', scopeId: req.params.id }).store.now();
    const nodes = [...snap.nodes.values()].map((n) => ({ id: n.id, type: n.type, attributes: n.attributes }));
    const edges = [...snap.edges.values()].map((e) => ({
      id: e.id, type: e.type, from: e.roles['from']?.[0] ?? e.roles['effect']?.[0] ?? '', to: e.roles['to']?.[0] ?? e.roles['member']?.[0] ?? '',
      roles: e.roles, attributes: e.attributes,
    }));
    return { realmId: req.params.id, live: Boolean(r.hypergraph), nodes, edges };
  });

  // Patient entities (with their learned liquid state) — backs the What-If forecast panel.
  app.get<{ Params: { id: string } }>('/admin/realms/:id/patients', async (req, reply) => {
    const r = RealmRegistry.get(req.params.id);
    if (!r) return reply.code(404).send({ error: 'realm-not-found' });
    return { patients: r.graph.listKind('patient').map((p) => ({ id: p.id, urn: p.urn, state: p.state })) };
  });

  app.post<{ Body: { id: string; mode: RealmMode; trajectoryEngine?: 'legacy' | 'liquid'; historyDays?: number; seed?: { facilityId: string; kind: 'dialysis' | 'primary-care' | 'urgent-care' | 'hospital'; name: string; units: string[]; patientCount: number } } }>('/admin/realms', async (req, reply) => {
    try {
      const { id, mode, seed, trajectoryEngine, historyDays } = req.body ?? {} as { id: string; mode: RealmMode; trajectoryEngine?: 'legacy' | 'liquid'; historyDays?: number; seed?: Parameters<typeof populateFacility>[1] };
      if (!id || !mode) return reply.code(400).send({ error: 'id-and-mode-required' });
      // R1 — a realm is BORN with a monitoring history. The clock is anchored
      // `historyDays` in the past, the longitudinal record is replayed through
      // the real clock into the ledger, and the clock then lands back on now.
      // Without this a console-created realm had state but an empty ledger, so
      // every protocol's coverage gate blocked its patients forever.
      const backfillDays = Math.max(7, Math.min(365, historyDays ?? 90));
      const anchoredAt = new Date(Date.now() - backfillAnchorMs(backfillDays));
      const realm = RealmRegistry.create({
        id, mode,
        ...(seed ? { clock: new AcceleratedClock({ startAt: anchoredAt, msPerTick: 1000, realmMsPerTick: 3_600_000 }) } : {}),
        ...(trajectoryEngine ? { trajectoryEngine } : {}),
      });
      let backfill: BackfillResult | undefined;
      if (seed) {
        populateFacility(realm, seed, { seed: 1, days: backfillDays });
        backfill = backfillRealmHistory(realm, { days: backfillDays, seed: 1 });
      }
      // Phase 1b — attach the typed hypergraph now and sync the graph once.
      // The projection is a materialised view of state, so this is equivalent to
      // projecting every effect but avoids paying that cost during bulk load.
      realm.attachHypergraph(new RealmHypergraph(buildHealthcareHypergraphSchema(), id));
      realm.start();
      // Phase 3 — stream this realm's effects to the event broker.
      if (opts.realmEventBridge) opts.realmEventBridge.attach(realm);
      // Durable local realm: persist the portable snapshot (full state) + creation spec so it survives restarts.
      try {
        const sql = await getSqlStore();
        await sql.saveRealmSnapshot({ realmId: id, mode, createdAt: new Date().toISOString(), snapshotJson: JSON.stringify(captureSnapshot(realm)) });
        // Creation spec → restored on boot (see realm-restore.ts).
        await sql.saveRealmSpec({
          realmId: id, mode, createdAt: new Date().toISOString(),
          ...(trajectoryEngine ? { trajectoryEngine } : {}),
          specJson: JSON.stringify({
            ...(seed ? { seed } : {}),
            ...(trajectoryEngine ? { trajectoryEngine } : {}),
          }),
        });
        // Seed master data (Settings admin): facility → units → patients from the graph.
        if (seed) {
          for (const f of realm.graph.listKind('facility')) {
            const st = f.state ?? {};
            await sql.saveFacility({ id: f.id, realmId: id, name: typeof st.name === 'string' ? st.name : seed.name, kind: typeof st.kind === 'string' ? st.kind : seed.kind });
          }
          for (const u of realm.graph.listKind('unit')) {
            const st = u.state ?? {};
            await sql.saveUnit({ id: u.id, facilityId: typeof st.facilityId === 'string' ? st.facilityId : seed.facilityId, realmId: id, code: typeof st.code === 'string' ? st.code : u.id });
          }
          for (const p of realm.graph.listKind('patient')) {
            const st = p.state ?? {};
            await sql.savePatient({
              id: p.id, facilityId: typeof st.facilityId === 'string' ? st.facilityId : seed.facilityId,
              unitId: typeof st.unitId === 'string' ? st.unitId : '', realmId: id,
              age: typeof st.age === 'number' ? st.age : null,
              sex: typeof st.sex === 'string' ? st.sex : null,
              trajectory: typeof st.trajectory === 'string' ? st.trajectory : null,
              labsJson: st.labs ? JSON.stringify(st.labs) : null,
              vitalsJson: st.lastVitals ? JSON.stringify(st.lastVitals) : null,
            });
          }
        }
      } catch { /* storage is best-effort; the realm still runs */ }
      return { ...realm.snapshot(), ...(backfill ? { history: backfill } : {}) };
    } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });

  app.post<{ Params: { id: string }; Body: { deltaMs?: number } }>('/admin/realms/:id/tick', async (req, reply) => {
    const r = RealmRegistry.get(req.params.id);
    if (!r) return reply.code(404).send({ error: 'realm-not-found' });
    const tick = r.clock.advanceBy(req.body?.deltaMs ?? 60_000);
    try {
      const sql = await getSqlStore();
      await sql.saveRealmSnapshot({ realmId: r.id, mode: r.mode, createdAt: new Date().toISOString(), snapshotJson: JSON.stringify(captureSnapshot(r)) });
    } catch { /* best-effort */ }
    return { tick, snapshot: r.snapshot() };
  });

  app.delete<{ Params: { id: string } }>('/admin/realms/:id', async (req, reply) => {
    const r = RealmRegistry.get(req.params.id);
    if (!r) return reply.code(404).send({ error: 'realm-not-found' });
    if (opts.realmEventBridge) opts.realmEventBridge.detach(req.params.id);
    RealmRegistry.remove(req.params.id); // stops the clock + drops from the live registry
    try { const sql = await getSqlStore(); await sql.deleteRealmSpec(req.params.id); } catch { /* best-effort */ }
    return { ok: true, removed: req.params.id };
  });

  // Phase 3 — event broker fabric admin: live driver health, outbox state,
  // realm→broker bridge stats, replay-from-cursor.
  app.get('/admin/broker', async () => {
    const [health, deadLetter, outbox, bridge] = await Promise.all([
      opts.eventBroker ? opts.eventBroker.health() : Promise.resolve({ ok: false, driver: 'none' }),
      opts.eventBroker ? opts.eventBroker.deadLetterSize() : Promise.resolve(0),
      opts.eventOutbox ? opts.eventOutbox.counts() : Promise.resolve({ pending: 0, delivered: 0, dead: 0 }),
      opts.realmEventBridge ? opts.realmEventBridge.snapshot() : Promise.resolve({ attached: 0, projected: 0, queued: 0, published: 0, failed: 0 }),
    ]);
    return { health, deadLetter, outbox, bridge, configured: Boolean(opts.eventBroker) };
  });

  app.post<{ Body: { since?: string } }>('/admin/broker/replay', async (req, reply) => {
    if (!opts.eventOutbox || !opts.eventBroker) return reply.code(503).send({ error: 'event-fabric-not-wired' });
    try {
      const republished = await opts.eventOutbox.replay(opts.eventBroker, { ...(req.body?.since ? { since: req.body.since } : {}) });
      return { republished, since: req.body?.since ?? new Date(0).toISOString() };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.get('/admin/broker/drivers', async () => ({
    drivers: ['inprocess', 'kafka', 'redis-streams', 'bullmq', 'rabbitmq', 'nats', 'sqs-sns', 'pubsub', 'event-hubs'],
    current: opts.eventBroker?.driver ?? 'none',
  }));

  app.post<{ Params: { id: string }; Body: { on: boolean } }>('/admin/realms/:id/bridge', async (req, reply) => {
    if (!opts.realmEventBridge) return reply.code(503).send({ error: 'bridge-not-wired' });
    const r = RealmRegistry.get(req.params.id);
    if (!r) return reply.code(404).send({ error: 'realm-not-found' });
    if (req.body?.on === false) opts.realmEventBridge.detach(req.params.id);
    else opts.realmEventBridge.attach(r);
    return { realmId: req.params.id, on: req.body?.on !== false };
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
      try { const sql = await getSqlStore(); await sql.saveRealmSnapshot({ realmId: r.id, mode: r.mode, createdAt: new Date().toISOString(), snapshotJson: JSON.stringify(captureSnapshot(r)) }); } catch { /* best-effort */ }
      return p;
    } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });

  app.post<{ Params: { id: string }; Body: { presenceId: string; effect: WorldEffect } }>('/admin/realms/:id/emit', async (req, reply) => {
    const r = RealmRegistry.get(req.params.id);
    if (!r) return reply.code(404).send({ error: 'realm-not-found' });
    try {
      const emitted = r.emit(req.body.presenceId, req.body.effect);
      try { const sql = await getSqlStore(); await sql.saveRealmSnapshot({ realmId: r.id, mode: r.mode, createdAt: new Date().toISOString(), snapshotJson: JSON.stringify(captureSnapshot(r)) }); } catch { /* best-effort */ }
      return emitted;
    }
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

  // Live inner-lives lists (P0 — power the Episodes / Sentience / Attributions pages).
  app.get<{ Params: { id: string }; Querystring: { status?: string; presenceId?: string } }>('/admin/realms/:id/episodes', async (req, reply) => {
    const r = RealmRegistry.get(req.params.id);
    if (!r) return reply.code(404).send({ error: 'realm-not-found' });
    let eps = r.episodes.all();
    if (req.query.status) eps = eps.filter((e) => e.status === req.query.status);
    if (req.query.presenceId) eps = eps.filter((e) => e.presenceId === req.query.presenceId);
    return { episodes: eps };
  });

  app.get<{ Params: { id: string } }>('/admin/realms/:id/self-models', async (req, reply) => {
    const r = RealmRegistry.get(req.params.id);
    if (!r) return reply.code(404).send({ error: 'realm-not-found' });
    const list = r.selfModel.list();
    return { selfModels: list.map((s) => ({ presenceId: s.presenceId, agentSpecId: s.agentSpecId, role: s.role, competence: s.competence, episodes: s.episodes, choices: s.choices, effects: s.effects, preferences: s.preferences, milestones: s.milestonesReached })) };
  });

  app.get<{ Params: { id: string } }>('/admin/realms/:id/attributions', async (req, reply) => {
    const r = RealmRegistry.get(req.params.id);
    if (!r) return reply.code(404).send({ error: 'realm-not-found' });
    return { attributions: r.attribution.all(), stats: r.attribution.stats() };
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

  // Multi-realm command center (Phase 5) — one SSE wall across every realm:
  // effects + experiences per realm, plus durable webhook delivery activity.
  // `?once=1` writes a snapshot then closes (for previews + tests).
  app.get<{ Querystring: { once?: string } }>('/admin/stream', async (req, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const write = (type: string, payload: unknown) => {
      try { reply.raw.write(`data: ${JSON.stringify({ type, at: new Date().toISOString(), payload })}\n\n`); } catch { /* client gone */ }
    };
    const realms = RealmRegistry.list();
    write('hello', { realms: realms.map((r) => r.id) });

    if (req.query.once === '1') {
      const snapshot = realms.map((r) => ({ realmId: r.id, effects: r.ledger.listAll().slice(-5).map((e) => ({ effectId: e.effectId, kind: e.effect.kind, status: e.status })), seq: r.clock.seq, realmAt: r.clock.realmAt.toISOString() }));
      write('snapshot', { realms: snapshot });
      reply.raw.end();
      return;
    }

    const detachers: Array<() => void> = [];
    for (const r of realms) {
      const offEffect = r.ledger.onAppend((e) => write('effect', { realmId: r.id, ...e }));
      detachers.push(offEffect);
      try {
        const offExp = r.rules.subscribe((exp) => write('experience', { realmId: r.id, ...exp }));
        detachers.push(offExp);
      } catch { /* rules not wired */ }
    }

    // Webhook delivery activity (durable) — poll the SqlStore for new deliveries.
    let lastWebhookLen = 0;
    const whTimer = setInterval(async () => {
      try {
        const sql = await getSqlStore();
        const rows = await sql.pendingWebhookDeliveries(20);
        if (rows.length !== lastWebhookLen) {
          for (const row of rows.slice(0, Math.max(0, rows.length - lastWebhookLen))) write('webhook', { id: row.id, webhookId: row.webhookId, eventId: row.eventId, status: row.status, attempts: row.attempts, at: row.createdAt });
          lastWebhookLen = rows.length;
        }
      } catch { /* transient */ }
    }, 1000);

    const hb = setInterval(() => write('heartbeat', { realms: RealmRegistry.list().length }), 15_000);

    req.raw.on('close', () => {
      clearInterval(whTimer);
      clearInterval(hb);
      for (const detach of detachers) { try { detach(); } catch { /* ignore */ } }
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
    // Durable local billing: persist this meter reading for later rollup.
    try {
      const sql = await getSqlStore();
      const periodStart = period.from?.toISOString().slice(0, 10) ?? new Date().toISOString().slice(0, 10);
      await sql.saveBilling({
        id: `bill-${r.id}-${periodStart}`, realmId: r.id, period: periodStart,
        plan: DEFAULT_BILLING_PLAN.planId, reportJson: JSON.stringify(report),
      });
    } catch { /* best-effort */ }
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
      // Durable local counterfactual: mirror the run into the swappable SQL store so the
      // studio survives restarts (GET /admin/sql/counterfactuals reads from here).
      try {
        const sql = await getSqlStore();
        await sql.saveCounterfactual({
          id: rec.id, realmId: rec.realmId ?? null, label: rec.label,
          inputJson: JSON.stringify(rec.input), reportJson: JSON.stringify(rec.report), createdAt: rec.createdAt,
        });
      } catch { /* best-effort — the in-memory studio record is still returned */ }
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

  // M24 — apply a promotable counterfactual to its source realm "with evidence".
  // Applies the rehearsed interventions to the LIVE realm, emits an
  // operator-directive carrying the evidenceId (link back into the studio),
  // and returns the evidence diff. The directive shows up in Governance →
  // Directives with the evidence link.
  app.post<{ Params: { id: string } }>('/admin/counterfactual/:id/apply', async (req, reply) => {
    const rec = CounterfactualStore.get(req.params.id);
    if (!rec) return reply.code(404).send({ error: 'cf-not-found' });
    if (!rec.report.promotable) {
      return reply.code(400).send({ error: 'not-promotable', gateReasons: rec.report.gateReasons ?? ['promotion-gates-failed'] });
    }
    const source = rec.realmId ? RealmRegistry.get(rec.realmId) : undefined;
    if (!source) return reply.code(400).send({ error: 'source-realm-required', hint: 'run the studio from a live realm' });
    const applied: Array<{ kind: string; detail: string }> = [];

    // 1) Apply the rehearsed interventions to the live realm (mirrors the harness).
    for (const iv of rec.input.interventions) {
      if (iv.kind === 'nudge-preference') {
        const targets = source.presences.list().filter((p) => p.role === iv.presenceRole);
        if (targets.length === 0) { applied.push({ kind: 'nudge-preference', detail: `${iv.presenceRole}: no presence to nudge` }); continue; }
        for (const t of targets) {
          source.selfModel.nudgePreference(t.presenceId, iv.effectKind, iv.delta, 'counterfactual-apply');
        }
        applied.push({ kind: 'nudge-preference', detail: `${iv.presenceRole}×${targets.length} ${iv.effectKind} ${iv.delta > 0 ? '+' : ''}${iv.delta}` });
      } else if (iv.kind === 'event-effect') {
        const proc = source.ambient.list().find((p) => p.id === 'trajectory.liquid') as { biasPatient?: (pid: string, effect: Record<string, number>) => void } | undefined;
        if (!proc?.biasPatient) { applied.push({ kind: 'event-effect', detail: 'no trajectory.liquid process' }); continue; }
        const targets = iv.targetPatient ? [iv.targetPatient] : source.graph.listKind('patient').map((p) => p.id);
        for (const pid of targets) proc.biasPatient(pid, iv.effect);
        applied.push({ kind: 'event-effect', detail: `${targets.length} patient(s) bias ${JSON.stringify(iv.effect)}` });
      }
    }

    // 2) Emit an operator-directive carrying the evidence link.
    const presence = source.presences.list()[0] ?? source.spawnPresence({
      realmId: source.id, agentSpecId: 'counterfactual-apply', runId: `cf-apply-${Date.now()}`,
      role: 'md', clearance: 'phi', purposeOfUse: ['treatment'],
      location: { facilityId: 'f1', unitId: 'U1' },
    });
    const directive = source.emit(presence.presenceId, {
      kind: 'operator-directive',
      verb: 'nudge-preference',
      ...(rec.realmId ? { targetRef: rec.realmId } : {}),
      payload: {
        counterfactualId: rec.id,
        label: rec.label,
        interventions: rec.input.interventions,
        deltas: rec.report.delta,
      },
      originalText: `Applied counterfactual "${rec.label}" (${rec.id}) with evidence: ${rec.report.interpretation}`,
      evidenceId: rec.id,
    });

    return {
      applied: true,
      counterfactualId: rec.id,
      directiveEffectId: directive.effectId,
      evidenceId: rec.id,
      interventions: applied,
      delta: rec.report.delta,
      interpretation: rec.report.interpretation,
      gateReasons: rec.report.gateReasons,
    };
  });

  // ---- Liquid engine (Phase 6): training, promotion, comparison ----
  const liquidStore = new LiquidModelStore();
  const liquidTrainer = new LiquidTrainer(liquidStore);

  app.get('/admin/liquid/models', async () => ({
    active: liquidStore.listModels(),
    history: liquidStore.history(),
  }));

  app.post<{ Body: TrainRequest }>('/admin/liquid/train', async (req, reply) => {
    try {
      const run = await liquidTrainer.train(req.body ?? {});
      return { run, active: liquidStore.activeModel(run.record.domain) };
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post<{ Body: { domain?: string; modelId: string } }>('/admin/liquid/promote', async (req, reply) => {
    const domain = req.body?.domain ?? 'dialysis';
    const rec = liquidStore.promoteExisting(domain, req.body?.modelId);
    if (!rec) return reply.code(404).send({ error: 'model-not-found' });
    return { promoted: rec, active: liquidStore.activeModel(domain) };
  });

  app.get('/admin/liquid/compare', async () => liquidStore.compare('dialysis'));

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

  // ================= M16: Onboarding =================
  app.get('/admin/onboarding/templates', async () => ({
    templates: ONBOARDING_TEMPLATES.map((t) => ({ id: t.id, displayName: t.displayName, description: t.description })),
  }));

  app.post<{ Body: { template?: string; orgId: string; displayName: string; facilities?: FacilitySpec[]; sampleData?: boolean } }>('/admin/onboarding/bootstrap', async (req, reply) => {
    try {
      let tmpl: OrganizationTemplate;
      if (req.body.template) {
        const t = findTemplate(req.body.template);
        if (!t) return reply.code(404).send({ error: `template-not-found:${req.body.template}` });
        tmpl = t.build(req.body.orgId, req.body.displayName);
      } else {
        tmpl = { orgId: req.body.orgId, displayName: req.body.displayName, facilities: req.body.facilities ?? [], sampleData: !!req.body.sampleData };
      }
      return createOrgWithFacilities(tmpl);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post<{ Body: { csv: string; orgId: string; displayName: string; sampleData?: boolean } }>('/admin/onboarding/bootstrap-csv', async (req, reply) => {
    try {
      const facilities = parseFacilitiesCsv(req.body.csv);
      return createOrgWithFacilities({ orgId: req.body.orgId, displayName: req.body.displayName, facilities, sampleData: !!req.body.sampleData });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/admin/onboarding/wizards', async () => ({ wizards: listWizards() }));
  app.post('/admin/onboarding/wizards', async () => ({ wizard: startWizard() }));
  app.get<{ Params: { id: string } }>('/admin/onboarding/wizards/:id', async (req, reply) => {
    const w = getWizard(req.params.id);
    if (!w) return reply.code(404).send({ error: 'wizard-not-found' });
    return { wizard: w };
  });
  app.put<{ Params: { id: string }; Body: Partial<WizardState> }>('/admin/onboarding/wizards/:id', async (req, reply) => {
    const w = getWizard(req.params.id);
    if (!w) return reply.code(404).send({ error: 'wizard-not-found' });
    Object.assign(w, req.body);
    return { wizard: saveWizard(w) };
  });
  app.post<{ Params: { id: string } }>('/admin/onboarding/wizards/:id/complete', async (req, reply) => {
    try {
      return { result: completeWizard(req.params.id) };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ================= M17: Identity =================
  app.get('/admin/identity/providers', async () => ({ providers: IdentityRegistry.listProviders() }));
  app.post<{ Body: IdentityProviderConfig }>('/admin/identity/providers', async (req) => ({ provider: IdentityRegistry.addProvider(req.body) }));
  app.delete<{ Params: { id: string } }>('/admin/identity/providers/:id', async (req) => ({ ok: IdentityRegistry.removeProvider(req.params.id) }));
  app.post<{ Params: { id: string }; Body: { enabled: boolean } }>('/admin/identity/providers/:id/enabled', async (req) => ({ ok: IdentityRegistry.setProviderEnabled(req.params.id, req.body.enabled) }));

  app.get<{ Querystring: { orgId?: string } }>('/admin/identity/principals', async (req) => ({ principals: IdentityRegistry.listPrincipals(req.query.orgId) }));

  app.get<{ Params: { orgId: string } }>('/admin/identity/mappings/:orgId', async (req) => ({ mapping: IdentityRegistry.getMapping(req.params.orgId) }));
  app.put<{ Params: { orgId: string }; Body: Omit<RoleMapping, 'orgId'> }>('/admin/identity/mappings/:orgId', async (req) => ({
    mapping: IdentityRegistry.setMapping({ orgId: req.params.orgId, ...req.body }),
  }));

  app.get('/admin/identity/audit', async () => ({ audit: IdentityRegistry.listAudit() }));

  // Invites
  app.post<{ Body: Parameters<typeof createInvite>[0] }>('/admin/identity/invites', async (req, reply) => {
    try { return { invite: createInvite(req.body) }; }
    catch (err) { return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) }); }
  });
  app.get<{ Querystring: { orgId?: string } }>('/admin/identity/invites', async (req) => ({ invites: listInvites(req.query.orgId) }));
  app.post<{ Params: { id: string } }>('/admin/identity/invites/:id/revoke', async (req) => ({ ok: revokeInvite(req.params.id) }));
  app.post<{ Body: { token: string; displayName?: string } }>('/invites/claim', async (req, reply) => {
    try {
      const principal = claimInvite(req.body.token, req.body.displayName ? { displayName: req.body.displayName } : {});
      return { principal };
    } catch (err) { return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) }); }
  });

  // Break-glass
  app.post<{ Body: { subjectId: string; reason: string; durationMs?: number } }>('/admin/identity/break-glass/activate', async (req, reply) => {
    try { return activateBreakGlass(req.body); }
    catch (err) { return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) }); }
  });
  app.post<{ Body: { subjectId: string } }>('/admin/identity/break-glass/end', async (req) => ({ ok: endBreakGlass(req.body.subjectId) }));
  app.post<{ Params: { id: string }; Body: { reviewedBy: string; note: string; approved: boolean } }>('/admin/identity/break-glass/:id/review', async (req) => ({
    ok: reviewBreakGlass(req.params.id, req.body.reviewedBy, req.body.note, req.body.approved),
  }));
  app.get('/admin/identity/break-glass/pending', async () => ({ pending: pendingReviews() }));

  // OIDC endpoints (auth entry + callback)
  app.get<{ Querystring: { provider: string } }>('/auth/oidc/begin', async (req, reply) => {
    try { return beginOidcAuth(req.query.provider); }
    catch (err) { return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) }); }
  });
  app.get<{ Querystring: { code: string; state: string } }>('/auth/oidc/callback', async (req, reply) => {
    try { return { principal: await handleOidcCallback({ code: req.query.code, state: req.query.state }) }; }
    catch (err) { return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) }); }
  });

  // WorkOS endpoints
  app.get<{ Querystring: { provider: string; redirectUri: string } }>('/auth/workos/begin', async (req, reply) => {
    try { return beginWorkOSSso(req.query.provider, req.query.redirectUri); }
    catch (err) { return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) }); }
  });
  app.get<{ Querystring: { code: string; state: string } }>('/auth/workos/callback', async (req, reply) => {
    try { return { principal: await handleWorkOSCallback(req.query.state, req.query.code) }; }
    catch (err) { return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) }); }
  });
  app.post<{ Params: { providerId: string } }>('/admin/identity/workos/:providerId/sync', async (req, reply) => {
    try { return await syncWorkOSDirectory(req.params.providerId); }
    catch (err) { return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) }); }
  });

  // SCIM 2.0 receiver (bearer-token auth, resolves to orgId)
  const scimAuth = (req: { headers: Record<string, string | string[] | undefined> }) => {
    const h = req.headers['authorization'];
    const auth = Array.isArray(h) ? h[0] : h;
    if (!auth?.startsWith('Bearer ')) return undefined;
    return orgForToken(auth.slice(7));
  };
  app.post<{ Body: ScimUser }>('/scim/v2/Users', async (req, reply) => {
    const orgId = scimAuth(req); if (!orgId) return reply.code(401).send({ error: 'unauthorized' });
    return Scim.createUser(orgId, req.body);
  });
  app.get('/scim/v2/Users', async (req, reply) => {
    const orgId = scimAuth(req); if (!orgId) return reply.code(401).send({ error: 'unauthorized' });
    const filter = (req.query as Record<string, string> | undefined)?.['filter'];
    return Scim.listUsers(orgId, filter);
  });
  app.get<{ Params: { id: string } }>('/scim/v2/Users/:id', async (req, reply) => {
    const orgId = scimAuth(req); if (!orgId) return reply.code(401).send({ error: 'unauthorized' });
    const u = Scim.getUser(req.params.id);
    if (!u) return reply.code(404).send({ error: 'not-found' });
    return u;
  });
  app.put<{ Params: { id: string }; Body: ScimUser }>('/scim/v2/Users/:id', async (req, reply) => {
    const orgId = scimAuth(req); if (!orgId) return reply.code(401).send({ error: 'unauthorized' });
    return Scim.replaceUser(orgId, req.params.id, req.body);
  });
  app.patch<{ Params: { id: string }; Body: { Operations: Array<{ op: 'add'|'remove'|'replace'; path?: string; value?: unknown }> } }>('/scim/v2/Users/:id', async (req, reply) => {
    const orgId = scimAuth(req); if (!orgId) return reply.code(401).send({ error: 'unauthorized' });
    return Scim.patchUser(orgId, req.params.id, req.body.Operations);
  });
  app.delete<{ Params: { id: string } }>('/scim/v2/Users/:id', async (req, reply) => {
    const orgId = scimAuth(req); if (!orgId) return reply.code(401).send({ error: 'unauthorized' });
    return { ok: Scim.deleteUser(req.params.id) };
  });
  app.post<{ Body: ScimGroup }>('/scim/v2/Groups', async (req, reply) => {
    const orgId = scimAuth(req); if (!orgId) return reply.code(401).send({ error: 'unauthorized' });
    return Scim.createGroup(orgId, req.body);
  });
  app.get('/scim/v2/Groups', async (req, reply) => {
    const orgId = scimAuth(req); if (!orgId) return reply.code(401).send({ error: 'unauthorized' });
    return Scim.listGroups();
  });
  app.patch<{ Params: { id: string }; Body: { Operations: Array<{ op: 'add'|'remove'|'replace'; path?: string; value?: unknown }> } }>('/scim/v2/Groups/:id', async (req, reply) => {
    const orgId = scimAuth(req); if (!orgId) return reply.code(401).send({ error: 'unauthorized' });
    return Scim.patchGroup(orgId, req.params.id, req.body.Operations);
  });

  // ================= M18: Self-serve admin =================
  app.get<{ Params: { realmId: string } }>('/admin/self-serve/:realmId/pack-toggles', async (req) => ({ toggles: SelfServeAdmin.getPackToggles(req.params.realmId) }));
  app.put<{ Params: { realmId: string }; Body: { enabledPacks: string[]; disabledAgents: string[]; actorSubjectId?: string } }>('/admin/self-serve/:realmId/pack-toggles', async (req, reply) => {
    try {
      const opts: { realmId: string; enabledPacks: string[]; disabledAgents: string[] } = { realmId: req.params.realmId, enabledPacks: req.body.enabledPacks, disabledAgents: req.body.disabledAgents };
      return { toggles: SelfServeAdmin.setPackToggles(opts, req.body.actorSubjectId) };
    } catch (err) { return reply.code(403).send({ error: err instanceof Error ? err.message : String(err) }); }
  });
  app.get<{ Params: { realmId: string } }>('/admin/self-serve/:realmId/meter-overrides', async (req) => ({ overrides: SelfServeAdmin.listMeterOverrides(req.params.realmId) }));
  app.post<{ Params: { realmId: string }; Body: { unit: string; priceUsdPerUnit: number; budgetCapMonthlyUsd?: number; actorSubjectId?: string } }>('/admin/self-serve/:realmId/meter-overrides', async (req, reply) => {
    try {
      const body: { realmId: string; unit: string; priceUsdPerUnit: number; budgetCapMonthlyUsd?: number } = { realmId: req.params.realmId, unit: req.body.unit, priceUsdPerUnit: req.body.priceUsdPerUnit };
      if (req.body.budgetCapMonthlyUsd !== undefined) body.budgetCapMonthlyUsd = req.body.budgetCapMonthlyUsd;
      return { override: SelfServeAdmin.addMeterOverride(body, req.body.actorSubjectId) };
    } catch (err) { return reply.code(403).send({ error: err instanceof Error ? err.message : String(err) }); }
  });
  app.get<{ Params: { realmId: string } }>('/admin/self-serve/:realmId/custom-effects', async (req) => ({ effects: SelfServeAdmin.listCustomEffects(req.params.realmId) }));
  app.post<{ Params: { realmId: string }; Body: { kind: string; schema: Record<string, unknown>; purpose: string; hitlRequired: boolean; actorSubjectId?: string } }>('/admin/self-serve/:realmId/custom-effects', async (req, reply) => {
    try {
      return { effect: SelfServeAdmin.registerCustomEffect({ realmId: req.params.realmId, kind: req.body.kind, schema: req.body.schema, purpose: req.body.purpose, hitlRequired: req.body.hitlRequired }, req.body.actorSubjectId) };
    } catch (err) { return reply.code(403).send({ error: err instanceof Error ? err.message : String(err) }); }
  });
  app.get<{ Params: { realmId: string } }>('/admin/self-serve/:realmId/hitl-gates', async (req) => ({ gates: SelfServeAdmin.listHitlGates(req.params.realmId) }));
  app.post<{ Params: { realmId: string }; Body: { agentSelector: string; afterStepId: string; role: string; slaMinutes: number; actorSubjectId?: string } }>('/admin/self-serve/:realmId/hitl-gates', async (req, reply) => {
    try {
      return { gate: SelfServeAdmin.addHitlGate({ realmId: req.params.realmId, agentSelector: req.body.agentSelector, afterStepId: req.body.afterStepId, role: req.body.role, slaMinutes: req.body.slaMinutes }, req.body.actorSubjectId) };
    } catch (err) { return reply.code(403).send({ error: err instanceof Error ? err.message : String(err) }); }
  });
  app.get<{ Params: { realmId: string } }>('/admin/self-serve/:realmId/branding', async (req) => ({ branding: SelfServeAdmin.getBranding(req.params.realmId) }));
  app.put<{ Params: { realmId: string }; Body: Omit<Parameters<typeof SelfServeAdmin.setBranding>[0], 'realmId'> & { actorSubjectId?: string } }>('/admin/self-serve/:realmId/branding', async (req, reply) => {
    try {
      const { actorSubjectId, ...rest } = req.body;
      return { branding: SelfServeAdmin.setBranding({ realmId: req.params.realmId, ...rest }, actorSubjectId) };
    } catch (err) { return reply.code(403).send({ error: err instanceof Error ? err.message : String(err) }); }
  });

  // ---------- M19 entity compiler ----------
  app.post<{ Body: CompileOptions }>('/admin/entity-compiler/compile', async (req, reply) => {
    try {
      const result = await compileEntityPack(req.body);
      _compileReports.set(`${req.body.packId}:${result.report.compiledAt}`, result.report);
      return { report: result.report, agentCount: result.agents.length };
    } catch (err) { return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) }); }
  });
  app.get('/admin/entity-compiler/reports', async () => ({
    reports: Array.from(_compileReports.entries()).map(([key, report]) => ({ key, report })),
  }));
}
