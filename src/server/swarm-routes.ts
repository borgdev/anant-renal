/******************************************************************************
 * Swarm admin routes — the executive surface over the bounded-cell layer.
 *
 *   GET  /admin/swarm/cells          — 12 cell manifests
 *   GET  /admin/swarm/insights       — swarm insights (consensus/conflict/abstention)
 *   GET  /admin/swarm/nba            — ranked next-best actions (advisory)
 *   GET  /admin/swarm/episodes       — outcome episodes
 *   POST /admin/swarm/episodes       — open an outcome episode
 *   POST /admin/swarm/episodes/:id/decide   — approve / reject
 *   POST /admin/swarm/episodes/:id/ack      — acknowledgement
 *   POST /admin/swarm/whatif         — server-side policy replay (isolated sandbox)
 *   POST /admin/swarm/demo           — (re)seed the executable reference boundary
 *   GET  /admin/swarm/release-gate   — release-gate state (green/red inputs + verdict)
 *   POST /admin/swarm/release-gate/evaluate — re-evaluate with containment overrides
 *   GET  /admin/swarm/bridge         — kafka-bridge status (worker, leases, receipts)
 *   POST /admin/swarm/bridge/poll    — drain one bridge batch (lease→validate→publish)
 *   POST /admin/swarm/bridge/seed    — enqueue demo canonical events into the outbox
 ******************************************************************************/

import type { FastifyInstance } from 'fastify';
import type { CanonicalEvent, CanonicalEventType } from '../healthcare-core/events.js';
import { SWARM_CELLS, cellAllows } from '../swarm/cells.js';
import { buildSwarmDemo, policyWhatIf, type SwarmDemoState } from '../swarm/demo.js';
import { PersistentOutcomeCoordinator } from '../swarm/durable-coordinator.js';
import { computeRollups, deriveLiveSwarm, hasLiveData, integrationHealth, type LiveRealmSource } from '../swarm/live.js';
import { applyRedOverrides, demoReleaseInput, evaluateRelease } from '../swarm/release.js';
import { sqlWorkspacePersistence, SwarmWorkspaceStore, projectRealmEvents, type NbaDecision, type SubmissionPackage, type WorkspaceDoc, type WorkspaceKind } from '../swarm/workspace.js';
import type { ApprovalClass, WorldEffectKind } from '../swarm/types.js';
import type { EventBroker } from './event-broker.js';
import { InProcessEventBroker } from './inprocess-event-broker.js';
import { KafkaBridge, seedBridgeOutbox, tenantValidation, type BridgeStore } from './kafka-bridge.js';
import { getSqlStore } from './sql/index.js';

export interface SwarmRouteOptions {
  /** kafka-bridge durability store (SqlStore in prod); absent → bridge endpoints report unavailable. */
  store?: BridgeStore;
  /** Broker the bridge publishes through; defaults to an in-process broker. */
  broker?: EventBroker;
  /** Real realm snapshots — when any realm has patients, the swarm state is derived from live data. */
  realms?: () => LiveRealmSource[];
  /** Real realm ledger events (projected into the exec event feed). */
  events?: () => Array<{ realmId: string; eventId: string; kind: string; status: string; emittedAt: string; realmAt?: string; presenceId?: string; payload: Record<string, unknown> }>;
}

/** A few canonical events to seed the embedded kafka-bridge demo. */
function demoBridgeEvents(): CanonicalEvent[] {
  const at = '2026-08-22T09:00:00.000Z';
  const ev = (id: string, type: CanonicalEventType, scopeId: string, payload: Record<string, unknown> = {}): CanonicalEvent => ({
    id, type, occurredAt: at, scopeId, subjectId: `pt:${scopeId}`, facilityId: `fac:${scopeId}`,
    payload, provenance: { sourceId: `bridge-demo:${scopeId}`, observedAt: at, ingestedAt: at }, classification: 'confidential',
  });
  return [
    ev('evt:bridge-0001', 'treatment.completed', 'realm:dialysis-1', { sessions: 3 }),
    ev('evt:bridge-0002', 'lab.result-arrived', 'realm:dialysis-1', { panel: 'cmp' }),
    ev('evt:bridge-0003', 'claim.submitted', 'realm:dialysis-1', { amount: 12800 }),
    ev('evt:bridge-0004', 'coverage.active', 'realm:dialysis-1', { policy: 'P-8821' }),
  ];
}

// Singleton runtime state (in-memory for the demo; persisted later).
let demoState: SwarmDemoState | null = null;
let bridge: KafkaBridge | null = null;
let coordinator: PersistentOutcomeCoordinator | null = null;
let workspace: SwarmWorkspaceStore | null = null;
let whatIfRunner: ((threshold: number) => Promise<Record<string, unknown>>) | null = null;

/** The durable swarm workspace (built by registerSwarmRoutes) — shared with
 *  demo-cleanup and other modules. Null until swarm routes register. */
export function getSwarmWorkspace(): SwarmWorkspaceStore | null {
  return workspace;
}

/** The persistent outcome coordinator singleton (episodes survive via the
 *  workspace store). Shared with the platform work API so My Work sees the
 *  same in-memory authoritative episode map the swarm routes mutate. */
export function getSwarmCoordinator(): PersistentOutcomeCoordinator | null {
  return coordinator;
}

/** Isolated policy what-if against the live swarm boundary — shared with the
 *  platform canvas simulate (Journey O). Wired by registerSwarmRoutes. */
export function swarmWhatIf(threshold: number): Promise<Record<string, unknown>> {
  if (!whatIfRunner) throw new Error('swarm-runtime-not-ready');
  return whatIfRunner(threshold);
}

/** Reset the in-memory swarm runtime (outcome-coordinator cache + reference demo
 *  boundary) — used by demo cleanup so durable deletions take effect immediately
 *  instead of lingering in the read cache. */
export function resetSwarmRuntime(): void {
  coordinator?.reset();
  demoState = null;
}

/** Lazily-resolved outcome coordinator (durable when a workspace store is wired). */
function coord(): PersistentOutcomeCoordinator {
  if (!coordinator) coordinator = new PersistentOutcomeCoordinator();
  return coordinator;
}

function liveRealms(opts: SwarmRouteOptions): LiveRealmSource[] {
  return opts.realms?.() ?? [];
}

function shortHash(input: string): string {
  let h = 0xdeadbeef;
  for (let i = 0; i < input.length; i += 1) h = Math.imul(h ^ input.charCodeAt(i), 2654435761);
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Prefer live-derived swarm state when real realms are populated; else reference. */
async function state(opts: SwarmRouteOptions): Promise<SwarmDemoState> {
  const realms = liveRealms(opts);
  if (hasLiveData(realms)) {
    return deriveLiveSwarm({ realms, coordinator: coord() });
  }
  if (!demoState) demoState = buildSwarmDemo();
  return demoState;
}

/* ---------- dynamic topology projection — the exec graph is derived from real
 * data (ontology hierarchy + master-data facilities/patients + cell/measure/
 * source catalogs), NOT the hardcoded reference seed. The seed is only a
 * last-resort fallback when the system has nothing real to render. ---------- */

export type ProjectedNode = { id: string; label: string; type: string; x: number; y: number; z: number; attributes: Record<string, unknown> };
export type ProjectedEdge = { id: string; source: string; target: string; relation: string; confidence: number; attributes: Record<string, unknown> };

const GRAPH_LEVELS = ['enterprise', 'division', 'region', 'facility'] as const;

export async function projectTopology(wsStore: SwarmWorkspaceStore): Promise<{ nodes: ProjectedNode[]; edges: ProjectedEdge[] }> {
  const cat = await wsStore.catalogs();
  const ontology = (cat['operating-model'] as Record<string, unknown> | null) ?? null;
  const scopePath = (ontology?.scopePath as Array<{ id?: string; level?: string; label?: string; facilities?: number; patients?: number }> | undefined) ?? [];
  const cells = (cat['agent-manifest'] as Array<{ id?: string; displayName?: string; name?: string; domain?: string }>) ?? [];
  const measurePacks = (cat['measure-pack'] as Array<Record<string, unknown>>) ?? [];
  const sources = (cat['public-source'] as Array<Record<string, unknown>>) ?? [];

  let facilities: Array<{ id: string; name: string; realmId: string }> = [];
  let patients: Array<{ id: string; facilityId: string; name?: string | null }> = [];
  try {
    const store = await getSqlStore();
    facilities = await store.listFacilities();
    patients = await store.listPatients();
  } catch {
    // master data unavailable — topology still renders from ontology + catalogs
  }

  const hasReal = scopePath.length > 0 || facilities.length > 0 || cells.length > 0;
  if (!hasReal) return wsStore.listTopology();

  const nodes: ProjectedNode[] = [];
  const edges: ProjectedEdge[] = [];
  const addNode = (id: string, label: string, type: string, x: number, y: number, z = 0, attributes: Record<string, unknown> = {}) => nodes.push({ id, label, type, x, y, z, attributes });
  const addEdge = (source: string, target: string, relation: string, attributes: Record<string, unknown> = {}) => edges.push({ id: `${source}->${target}`, source, target, relation, confidence: 1, attributes });

  // 1. Hierarchy spine from the operating-model ontology (graph-supported levels).
  const hierarchyIds: Record<string, string> = {};
  let prevId: string | null = null;
  let y = 4.5;
  for (const scope of scopePath) {
    const level = scope.level ?? '';
    if (!(GRAPH_LEVELS as readonly string[]).includes(level)) continue;
    const id = scope.id ?? level;
    hierarchyIds[level] = id;
    addNode(id, scope.label ?? level, level, 0, y, 0, { facilities: scope.facilities ?? 0, patients: scope.patients ?? 0 });
    if (prevId) addEdge(prevId, id, 'contains');
    prevId = id;
    y -= 1.0;
  }
  const facilityScopeId = hierarchyIds['facility'] ?? hierarchyIds['region'] ?? hierarchyIds['division'] ?? hierarchyIds['enterprise'];
  const enterpriseId = hierarchyIds['enterprise'] ?? nodes[0]?.id;

  // 2. Real master-data facilities → patient nodes.
  const patientByFacility = new Map<string, Array<{ id: string; name?: string | null }>>();
  for (const p of patients) {
    const list = patientByFacility.get(p.facilityId) ?? [];
    list.push(p);
    patientByFacility.set(p.facilityId, list);
  }
  for (const [i, facility] of facilities.slice(0, 8).entries()) {
    const fid = `fac:${facility.id}`;
    const fx = -3.6 + i * 1.2;
    addNode(fid, facility.name || facility.id, 'facility', fx, 1.4, 0, { realmId: facility.realmId, patients: patientByFacility.get(facility.id)?.length ?? 0 });
    if (facilityScopeId) addEdge(facilityScopeId, fid, 'contains', { realmId: facility.realmId });
    (patientByFacility.get(facility.id) ?? []).slice(0, 2).forEach((p, j) => {
      addNode(`pt:${p.id}`, p.name ?? p.id, 'patient', fx + (j === 0 ? 0 : 0.8), 0.5, 0.2, { realmId: facility.realmId });
      addEdge(fid, `pt:${p.id}`, 'serves');
    });
  }

  // 3. Cells (agent manifests) fanned below the hierarchy.
  const cellIds = cells.slice(0, 12).map((c, i) => {
    const cid = `cell:${c.id ?? i}`;
    addNode(cid, c.displayName ?? c.name ?? c.id ?? `cell-${i}`, 'cell', -4.2 + i * 0.8, -1.0, 0.2, { domain: c.domain ?? null });
    if (enterpriseId) addEdge(enterpriseId, cid, 'serves', { domain: c.domain ?? null });
    return cid;
  });

  // 4. Measure + authority source.
  const measureId = 'measure';
  addNode(measureId, measurePacks.length ? String(measurePacks[0]?.id ?? 'Continuity measure') : 'Continuity measure', 'measure', 0, -2.4, 0.4, { packs: measurePacks.length });
  for (const cid of cellIds.slice(0, 4)) addEdge(cid, measureId, 'updates');
  const authorityId = 'cms-authority';
  addNode(authorityId, sources.length ? 'CMS authority sources' : 'CMS authority', 'source', 3.6, -2.4, -0.2, { sources: sources.length });
  addEdge(authorityId, measureId, 'governs');

  return { nodes, edges };
}

export async function registerSwarmRoutes(app: FastifyInstance, opts: SwarmRouteOptions = {}): Promise<void> {
  // The durable workspace + outcome coordinator are built FIRST so every route
  // (episodes, NBA, catalogs, substrate) shares one persistent store.
  if (!workspace) {
    workspace = new SwarmWorkspaceStore(
      opts.store && typeof (opts.store as { saveWorkspace?: unknown }).saveWorkspace === 'function'
        ? sqlWorkspacePersistence(opts.store as unknown as Parameters<typeof sqlWorkspacePersistence>[0])
        : undefined,
    );
    await workspace.hydrate();
  }
  coordinator = new PersistentOutcomeCoordinator(workspace);
  await coordinator.ensureLoaded();

  const ws = (): SwarmWorkspaceStore => workspace as SwarmWorkspaceStore;
  const realmCounts = (realmId?: string): { units: number; patients: number; presences: number; effects: number } => {
    const realms = liveRealms(opts);
    const target = realmId ? realms.find((r) => r.realmId === realmId) : realms[0];
    if (!target) return { units: 0, patients: 0, presences: 0, effects: 0 };
    return { units: target.counts.unit ?? 0, patients: target.counts.patient ?? 0, presences: target.presences ?? 0, effects: target.effects ?? 0 };
  };

  app.get('/admin/swarm/cells', async () => ({ cells: SWARM_CELLS }));

  app.get('/admin/swarm/integration', async () => {
    const realms = liveRealms(opts);
    return integrationHealth(realms, await state(opts));
  });

  app.get('/admin/swarm/insights', async () => {
    const s = await state(opts);
    return { insights: s.insights, conflictCount: s.conflictCount };
  });

  // Read-only live swarm snapshot — the exec console polls THIS instead of the
  // reseeding POST /admin/swarm/demo, so reads never mutate server state. NBA
  // status is overlaid with the durable decision ledger (executed/dismissed).
  app.get('/admin/swarm/state', async () => {
    const s = await state(opts);
    const decisions = await ws().listNbaDecisions();
    const byId = new Map<string, NbaDecision>();
    for (const d of decisions) byId.set(d.nbaId, d);
    const nbas = s.nbas.map((n) => ({
      ...n,
      status: byId.has(n.nbaId) ? (byId.get(n.nbaId)!.decision === 'approved' ? 'executed' : 'dismissed') : n.status,
    }));
    return { ...s, nbas, decisions: [...byId.values()], source: s.source };
  });

  app.get('/admin/swarm/nba', async () => {
    const s = await state(opts);
    const decisions = await ws().listNbaDecisions();
    const byId = new Map<string, NbaDecision>();
    for (const d of decisions) byId.set(d.nbaId, d);
    const nbas = s.nbas.map((n) => ({
      ...n,
      status: byId.has(n.nbaId) ? (byId.get(n.nbaId)!.decision === 'approved' ? 'executed' : 'dismissed') : n.status,
    }));
    return { nbas, decisions: [...byId.values()], advisory: true };
  });

  app.get('/admin/swarm/nba/decisions', async () => ({ decisions: await ws().listNbaDecisions() }));

  // Durable NBA decision — approvals open/advance the outcome episode, dismissals
  // record the human override; both write an audit row and survive restarts.
  app.post<{ Params: { id: string }; Body: { decision?: 'approved' | 'dismissed'; approver?: string } }>(
    '/admin/swarm/nba/:id/decide',
    async (req, reply) => {
      const s = await state(opts);
      const nba = s.nbas.find((n) => n.nbaId === req.params.id);
      if (!nba) return reply.code(404).send({ error: 'nba-not-found' });
      const decision = req.body?.decision === 'dismissed' ? 'dismissed' : 'approved';
      const approver = req.body?.approver ?? 'operator';
      let episodeId: string | undefined;
      if (decision === 'approved') {
        const ep = coord().getOrOpen({ kind: 'continuity.proposal', subject: nba.subject, scopeType: nba.scopeType });
        try {
          coord().addEvidence(ep.episodeId, nba.evidence.map((e) => ({ sourceId: e.sourceId, contentType: e.contentType })), true);
          coord().propose(ep.episodeId, {
            proposalId: `prop-${ep.episodeId}`, cellId: nba.cells[0] ?? 'treatment-continuity', kind: 'continuity.proposal',
            subject: nba.subject, scopeType: nba.scopeType, option: 'human-authorized plan', recommendation: nba.title,
            allowed: true, evidence: nba.evidence.map((e) => ({ sourceId: e.sourceId, contentType: e.contentType })),
            producedAt: new Date().toISOString(), payload: { expectedOutcome: nba.expectedOutcome },
          }, true);
          coord().requestApproval(ep.episodeId, nba.approvalClass);
        } catch {
          // already advanced — idempotent
        }
        episodeId = ep.episodeId;
      }
      const record = await ws().recordNbaDecision({
        nbaId: nba.nbaId, title: nba.title, subject: nba.subject, scopeType: nba.scopeType,
        decision, approver, evidenceCount: nba.evidenceCount, expectedOutcome: nba.expectedOutcome,
        ...(episodeId ? { episodeId } : {}),
      });
      await ws().addSwarmAudit({ actor: approver, action: `nba.${decision}`, entityType: 'next-best-action', entityId: nba.nbaId, decision, detail: nba.title });
      return { decision: record };
    },
  );

  app.get('/admin/swarm/episodes', async () => {
    const s = await state(opts);
    const seen = new Set<string>();
    const episodes = [...coord().list(), ...s.episodes].filter((e) => (seen.has(e.episodeId) ? false : (seen.add(e.episodeId), true)));
    return { episodes };
  });

  app.get('/admin/swarm/rollups', async () => computeRollups(await state(opts)));

  app.post<{ Body: { kind: string; subject: string; scopeType: string } }>('/admin/swarm/episodes', async (req) => {
    const { kind, subject, scopeType } = req.body ?? {};
    if (!kind || !subject || !scopeType) return { error: 'kind, subject and scopeType are required' };
    const e = coord().open({ kind, subject, scopeType: scopeType as 'region' | 'facility' | 'patient' });
    return { episode: e };
  });
  app.post<{ Params: { id: string } }>('/admin/swarm/episodes/:id/propose', async (req, reply) => {
    try {
      const e = coord().get(req.params.id);
      if (!e) return reply.code(404).send({ error: 'outcome-episode-not-found' });
      // Coordination fast-path: evidence → proposal → awaiting approval.
      coord().addEvidence(e.episodeId, [{ sourceId: `signal:${e.kind}`, contentType: 'signal' }], true);
      coord().propose(e.episodeId, {
        proposalId: `prop-${e.episodeId}`, cellId: 'treatment-continuity', kind: e.kind, subject: e.subject,
        scopeType: e.scopeType, option: 'human-authorized plan', recommendation: `Coordinate ${e.kind} for ${e.subject}.`,
        allowed: true, evidence: [{ sourceId: `signal:${e.kind}`, contentType: 'signal' }], producedAt: new Date().toISOString(), payload: {},
      }, true);
      coord().requestApproval(e.episodeId, 'B');
      return { episode: coord().get(e.episodeId) };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  app.post<{ Params: { id: string }; Body: { decision: 'approved' | 'rejected'; approver: string; approvalClass: ApprovalClass; action?: WorldEffectKind } }>(
    '/admin/swarm/episodes/:id/decide',
    async (req, reply) => {
      try {
        const e = coord().get(req.params.id);
        if (!e) return reply.code(404).send({ error: 'outcome-episode-not-found' });
        const { decision, approver, approvalClass, action } = req.body ?? {};
        coord().decide(e.episodeId, decision ?? 'approved', approver ?? 'operator', approvalClass ?? 'B');
        if (decision !== 'rejected' && action) {
          if (e.proposal?.cellId && !cellAllows(e.proposal.cellId, action)) {
            return reply.code(400).send({ error: `action-not-allowed: cell ${e.proposal.cellId} may not emit ${action}` });
          }
          coord().dispatchCommand(e.episodeId, action);
        }
        return { episode: coord().get(e.episodeId) };
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { by?: string; measureId?: string; met?: boolean } }>(
    '/admin/swarm/episodes/:id/ack',
    async (req, reply) => {
      try {
        const e = coord().get(req.params.id);
        if (!e) return reply.code(404).send({ error: 'outcome-episode-not-found' });
        const { by, measureId, met } = req.body ?? {};
        coord().acknowledge(e.episodeId, by ?? 'facility');
        coord().verify(e.episodeId, { measureId: measureId ?? 'ecqm:M21Basic/1.0.0', met: met ?? true });
        return { episode: coord().get(e.episodeId) };
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.post<{ Body: { threshold?: number } }>('/admin/swarm/whatif', async (req) => {
    const threshold = req.body?.threshold;
    if (threshold === undefined || typeof threshold !== 'number' || threshold < 0 || threshold > 1) {
      return { error: 'threshold must be a number in [0,1]' };
    }
    return policyWhatIf(threshold, await state(opts));
  });

  // Wire the shared what-if runner used by platform canvas simulate (Journey O).
  whatIfRunner = async (threshold: number) => policyWhatIf(threshold, await state(opts));

  app.post('/admin/swarm/demo', async () => {
    demoState = buildSwarmDemo();
    return { ok: true, ...(await state(opts)) };
  });

  // M-S3 — release gate (green/red-team gating; pure + deterministic).
  app.get('/admin/swarm/release-gate', async () => {
    const input = demoReleaseInput();
    return { input, verdict: evaluateRelease(input) };
  });
  app.post<{ Body: { red?: Array<{ id: string; contained: boolean }>; approvals?: { required?: number; granted?: string[] } } }>(
    '/admin/swarm/release-gate/evaluate',
    async (req) => {
      const base = demoReleaseInput();
      const input = demoReleaseInput({
        ...(req.body?.red ? { red: applyRedOverrides(base.red, req.body.red) } : {}),
        ...(req.body?.approvals ? { approvals: { required: req.body.approvals.required ?? 2, granted: req.body.approvals.granted ?? [] } } : {}),
      });
      return { input, verdict: evaluateRelease(input) };
    },
  );

  // M-S3 — kafka-bridge: durable connector over the transactional outbox.
  // Registered only when a store is wired (prod SqlStore); absent → endpoints
  // report kafka-bridge-unavailable.
  if (opts.store) {
    bridge = new KafkaBridge(opts.store, {
      broker: opts.broker ?? new InProcessEventBroker(),
      workerId: `bridge:${process.env.HH_NODE_ID ?? 'local'}`,
      validate: tenantValidation,
    });
    bridge.start();
  }
  app.get('/admin/swarm/bridge', async () => {
    if (!bridge) return { error: 'kafka-bridge-unavailable' };
    return { status: await bridge.status() };
  });
  app.post('/admin/swarm/bridge/poll', async () => {
    if (!bridge) return { error: 'kafka-bridge-unavailable' };
    const result = await bridge.pollOnce();
    return { ...result, status: await bridge.status() };
  });
  app.post('/admin/swarm/bridge/seed', async () => {
    if (!bridge || !opts.store) return { error: 'kafka-bridge-unavailable' };
    const seeded = await seedBridgeOutbox(opts.store, demoBridgeEvents());
    return { seeded, status: await bridge.status() };
  });

  // M-S6 — swarm workspace: durable CRUD for every executive asset (red-team,
  // submissions, config releases, evidence reviews, facility simulations,
  // knowledge notes, platform-admin profile/bridge/policy). Persists to the
  // SqlStore `swarm_workspace` table when a store is wired; else in-memory.
  // (workspace/ws()/realmCounts are built at the top of this handler.)

  app.get('/admin/swarm/workspace', async () => ({ summary: await ws().summary() }));

  // --- red-team scenarios + replay runs ---
  app.get('/admin/swarm/red-team/scenarios', async () => ({ scenarios: await ws().seedRedTeamScenarios() }));
  app.post<{ Body: { name: string; description?: string; threatModel?: string; checks?: Array<{ name: string; description: string }>; createdBy?: string } }>(
    '/admin/swarm/red-team/scenarios',
    async (req, reply) => {
      try {
        const scenario = await ws().createRedTeamScenario(req.body ?? {});
        return { scenario };
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );
  app.put<{ Params: { id: string }; Body: { name?: string; description?: string; threatModel?: string; checks?: Array<{ name: string; description: string }>; status?: 'active' | 'archived' } }>(
    '/admin/swarm/red-team/scenarios/:id',
    async (req, reply) => {
      const updated = await ws().updateRedTeamScenario(req.params.id, req.body ?? {});
      if (!updated) return reply.code(404).send({ error: 'red-team-scenario-not-found' });
      return { scenario: updated };
    },
  );
  app.delete<{ Params: { id: string } }>('/admin/swarm/red-team/scenarios/:id', async (req, reply) => {
    const ok = await ws().deleteRedTeamScenario(req.params.id);
    if (!ok) return reply.code(404).send({ error: 'red-team-scenario-not-found' });
    return { ok: true };
  });
  app.post<{ Body: { scenarioId?: string; ranBy?: string } }>('/admin/swarm/red-team/replay', async (req, reply) => {
    try {
      const policy = await ws().getAdminPolicy();
      const run = await ws().replayRedTeamScenario(req.body?.scenarioId ?? '', {
        ...(req.body?.ranBy ? { ranBy: req.body.ranBy } : {}),
        policy: { defaultDecision: policy.defaultDecision, externalWritesEnabled: policy.externalWritesEnabled },
      });
      return { run };
    } catch (err) {
      return reply.code(404).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  app.get('/admin/swarm/red-team/runs', async () => ({ runs: await ws().listRedTeamRuns() }));

  // --- CMS / EQRS submission packages ---
  app.get('/admin/swarm/submissions', async () => ({ packages: await ws().list<SubmissionPackage>('submission-package') }));
  app.post<{ Body: { measureId: string; measureVersion?: string; realmId?: string; period?: { start: string; end: string }; createdBy?: string } }>(
    '/admin/swarm/submissions',
    async (req, reply) => {
      try {
        const pkg = await ws().createSubmissionPackage({ ...(req.body ?? {}), realms: { total: realmCounts(req.body?.realmId).patients } });
        return { package: pkg };
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );
  app.post<{ Params: { id: string } }>('/admin/swarm/submissions/:id/validate', async (req, reply) => {
    const pkg = await ws().validateSubmissionPackage(req.params.id);
    if (!pkg) return reply.code(404).send({ error: 'submission-package-not-found' });
    return { package: pkg };
  });
  app.delete<{ Params: { id: string } }>('/admin/swarm/submissions/:id', async (req, reply) => {
    const ok = await ws().deleteSubmissionPackage(req.params.id);
    if (!ok) return reply.code(404).send({ error: 'submission-package-not-found' });
    return { ok: true };
  });

  // --- configuration studio release dossier ---
  app.get('/admin/swarm/config/releases', async () => ({ releases: await ws().listReleases(), active: await ws().activeRelease() }));
  app.post<{ Body: { version?: string; changeSummary?: string; objectCount?: number; createdBy?: string } }>(
    '/admin/swarm/config/releases',
    async (req, reply) => {
      try {
        const release = await ws().createReleaseDraft(req.body ?? {});
        return { release };
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );
  app.post<{ Params: { id: string } }>('/admin/swarm/config/releases/:id/validate', async (req, reply) => {
    const release = await ws().validateRelease(req.params.id);
    if (!release) return reply.code(404).send({ error: 'config-release-not-found' });
    return { release };
  });
  app.post<{ Params: { id: string } }>('/admin/swarm/config/releases/:id/request-approval', async (req, reply) => {
    const release = await ws().approveRelease(req.params.id);
    if (!release) return reply.code(404).send({ error: 'config-release-not-found' });
    return { release };
  });
  app.post<{ Params: { id: string } }>('/admin/swarm/config/releases/:id/activate', async (req, reply) => {
    const release = await ws().activateRelease(req.params.id);
    if (!release) return reply.code(404).send({ error: 'config-release-not-found' });
    return { release };
  });
  app.delete<{ Params: { id: string } }>('/admin/swarm/config/releases/:id', async (req, reply) => {
    const ok = await ws().deleteRelease(req.params.id);
    if (!ok) return reply.code(404).send({ error: 'config-release-not-found' });
    return { ok: true };
  });

  // --- platform admin: tenant / kafka / policy ---
  app.get('/admin/swarm/admin/tenant', async () => ({ tenant: await ws().getAdminTenant() }));
  app.put<{ Body: Record<string, unknown> }>('/admin/swarm/admin/tenant', async (req) => ({ tenant: await ws().saveAdminTenant(req.body ?? {}) }));
  app.get('/admin/swarm/admin/kafka', async () => ({ kafka: await ws().getAdminKafka() }));
  app.put<{ Body: Record<string, unknown> }>('/admin/swarm/admin/kafka', async (req) => ({ kafka: await ws().saveAdminKafka(req.body ?? {}) }));
  app.post('/admin/swarm/admin/kafka/test', async () => ({ kafka: await ws().testAdminKafka() }));
  app.get('/admin/swarm/admin/policy', async () => ({ policy: await ws().getAdminPolicy() }));
  app.put<{ Body: Record<string, unknown> }>('/admin/swarm/admin/policy', async (req) => ({ policy: await ws().saveAdminPolicy(req.body ?? {}) }));

  // --- evidence reviews (command cockpit) ---
  app.get('/admin/swarm/reviews', async () => ({ reviews: await ws().listReviews() }));
  app.post<{ Body: { entityId: string; entityType?: string; reason?: string; requestedBy?: string } }>(
    '/admin/swarm/reviews',
    async (req, reply) => {
      try {
        const review = await ws().requestReview(req.body ?? {});
        return { review };
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );
  app.post<{ Params: { id: string }; Body: { decision?: 'confirmed' | 'rejected'; reviewer?: string; note?: string } }>(
    '/admin/swarm/reviews/:id/review',
    async (req, reply) => {
      try {
        const review = await ws().reviewEvidence(req.params.id, { decision: req.body?.decision ?? 'confirmed', ...(req.body?.reviewer ? { reviewer: req.body.reviewer } : {}), ...(req.body?.note ? { note: req.body.note } : {}) });
        if (!review) return reply.code(404).send({ error: 'evidence-review-not-found' });
        return { review };
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  // --- facility twin simulations ---
  app.get('/admin/swarm/facility/simulations', async () => ({ simulations: await ws().listSimulations() }));
  app.post<{ Body: { realmId?: string; unitId?: string; patientId?: string; requestedSlot?: string; simulatedBy?: string } }>(
    '/admin/swarm/facility/simulate',
    async (req, reply) => {
      try {
        const simulation = await ws().simulateFacility({ ...(req.body ?? {}), realm: realmCounts(req.body?.realmId) });
        return { simulation };
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  // --- knowledge notes (intelligence workspace) ---
  app.get<{ Querystring: { nodeId?: string } }>('/admin/swarm/notes', async (req) => ({ notes: await ws().listNotes(req.query.nodeId) }));
  app.post<{ Body: { nodeId: string; title: string; content?: string; createdBy?: string } }>(
    '/admin/swarm/notes',
    async (req, reply) => {
      try {
        const note = await ws().createNote({ ...(req.body ?? {}), content: req.body?.content ?? '' });
        return { note };
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );
  app.post<{ Params: { id: string }; Body: { body: string; by?: string } }>('/admin/swarm/notes/:id/comments', async (req, reply) => {
    const existing = await ws().get<import('../swarm/workspace.js').KnowledgeNote>('knowledge-note', req.params.id);
    if (!existing) return reply.code(404).send({ error: 'knowledge-note-not-found' });
    try {
      const note = await ws().addComment(existing.nodeId, req.params.id, req.body ?? {});
      return { note };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  app.delete<{ Params: { id: string } }>('/admin/swarm/notes/:id', async (req, reply) => {
    const ok = await ws().deleteNote(req.params.id);
    if (!ok) return reply.code(404).send({ error: 'knowledge-note-not-found' });
    return { ok: true };
  });

  // --- executive substrate — the enrichment the exec console renders, now real.
  // Events are composed from REAL realm ledger entries (projected) + durable records.
  // `?limit=N` caps the projected (real) ledger feed to the N most recent events so
  // the exec console stops pulling tens of thousands of rows (20MB+ JSON) per load.
  app.get<{ Querystring: { limit?: string } }>('/admin/swarm/events', async (req) => {
    const all = projectRealmEvents(opts.events?.() ?? []);
    const durable = await ws().listEvents();
    const rawLimit = req.query.limit;
    const limit = rawLimit !== undefined ? Math.max(1, Math.min(parseInt(String(rawLimit), 10) || 1000, 5000)) : undefined;
    let real = all;
    if (limit !== undefined) {
      // Distribute the cap across realms so every realm (and thus every patient's
      // ledger) stays represented. A global "last N" window can be dominated by a
      // single realm during its burst and starve the others entirely.
      const byRealm = new Map<string, typeof all>();
      for (const e of all) {
        const rows = byRealm.get(e.realmId) ?? [];
        rows.push(e);
        byRealm.set(e.realmId, rows);
      }
      const realms = byRealm.size || 1;
      const perRealm = Math.max(1, Math.ceil(limit / realms));
      real = [...byRealm.values()].flatMap((rows) => rows.slice(-perRealm));
      if (real.length > limit) real = real.slice(-limit);
    }
    // temporalStates stays the TRUE total (all ledger + durable) even when the
    // feed is capped, so aggregate counters/replays are unaffected by `?limit`.
    const temporalStates = all.length + durable.length;
    return { events: [...real, ...durable], realCount: real.length, durableCount: durable.length, temporalStates };
  });
  app.post<{ Body: { eventId: string; eventType: string; subjectType?: string; subjectId?: string; sourceSystem?: string; status?: string; payload?: Record<string, unknown> } }>(
    '/admin/swarm/events',
    async (req, reply) => {
      try {
        const event = await ws().recordEvent(req.body ?? {} as { eventId: string; eventType: string });
        return { event };
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );
  app.delete<{ Params: { id: string } }>('/admin/swarm/events/:id', async (req, reply) => {
    const ok = await ws().remove('swarm-event', req.params.id);
    if (!ok) return reply.code(404).send({ error: 'swarm-event-not-found' });
    return { ok: true };
  });

  // Evidence
  app.get('/admin/swarm/evidence', async () => ({ evidence: await ws().listEvidence() }));
  app.post<{ Body: { evidenceId?: string; evidenceType?: string; subjectId?: string; exactText: string; confidenceBasisPoints?: number; questionId?: string; humanConfirmed?: boolean } }>(
    '/admin/swarm/evidence',
    async (req, reply) => {
      try {
        const item = await ws().addEvidence(req.body ?? { exactText: '' });
        return { evidence: item };
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );
  app.delete<{ Params: { id: string } }>('/admin/swarm/evidence/:id', async (req, reply) => {
    const ok = await ws().remove('evidence', req.params.id);
    if (!ok) return reply.code(404).send({ error: 'evidence-not-found' });
    return { ok: true };
  });

  // Traces
  app.get('/admin/swarm/traces', async () => ({ traces: await ws().listTraces() }));
  app.post<{ Body: { spanId?: string; name: string; system?: string; status?: string; durationMs?: number; detail?: string } }>(
    '/admin/swarm/traces',
    async (req, reply) => {
      try {
        const trace = await ws().addTrace(req.body ?? { name: '' });
        return { trace };
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );
  app.delete<{ Params: { id: string } }>('/admin/swarm/traces/:id', async (req, reply) => {
    const ok = await ws().remove('trace', req.params.id);
    if (!ok) return reply.code(404).send({ error: 'trace-not-found' });
    return { ok: true };
  });

  // Models + drift
  app.get('/admin/swarm/models', async () => ({ models: await ws().listModels() }));
  app.post<{ Body: { modelId: string; modelVersion?: string; evaluationScoreBasisPoints?: number; costMicrounitsPerCall?: number; killSwitch?: boolean } }>(
    '/admin/swarm/models',
    async (req, reply) => {
      try {
        const model = await ws().addModel(req.body ?? { modelId: '' });
        return { model };
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );
  app.delete<{ Params: { id: string } }>('/admin/swarm/models/:id', async (req, reply) => {
    const ok = await ws().remove('model', req.params.id);
    if (!ok) return reply.code(404).send({ error: 'model-not-found' });
    return { ok: true };
  });
  app.get('/admin/swarm/drift', async () => ({ drift: await ws().listDrift() }));
  app.post<{ Body: { targetId: string; metric: string; valueBasisPoints?: number; thresholdBasisPoints?: number; status?: string } }>(
    '/admin/swarm/drift',
    async (req, reply) => {
      try {
        const item = await ws().addDrift(req.body ?? { targetId: '', metric: '' });
        return { drift: item };
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );
  app.delete<{ Params: { id: string } }>('/admin/swarm/drift/:id', async (req, reply) => {
    const ok = await ws().remove('model-drift', req.params.id);
    if (!ok) return reply.code(404).send({ error: 'drift-not-found' });
    return { ok: true };
  });

  // Authority sources
  app.get('/admin/swarm/authority', async () => ({ sources: await ws().listAuthoritySources() }));
  app.post<{ Body: { sourceId: string; authority?: string; effectiveFrom?: string; sourceUrl?: string; status?: string } }>(
    '/admin/swarm/authority',
    async (req, reply) => {
      try {
        const source = await ws().addAuthoritySource(req.body ?? { sourceId: '' });
        return { source };
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );
  app.delete<{ Params: { id: string } }>('/admin/swarm/authority/:id', async (req, reply) => {
    const ok = await ws().remove('authority-source', req.params.id);
    if (!ok) return reply.code(404).send({ error: 'authority-source-not-found' });
    return { ok: true };
  });

  // Governance audits
  app.get('/admin/swarm/audits', async () => ({ audits: await ws().listSwarmAudits() }));
  app.post<{ Body: { eventId?: string; category?: string; actor: string; action: string; entityType?: string; entityId?: string; decision?: string; detail?: string } }>(
    '/admin/swarm/audits',
    async (req, reply) => {
      try {
        const audit = await ws().addSwarmAudit(req.body ?? { actor: '', action: '' });
        return { audit };
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );
  app.delete<{ Params: { id: string } }>('/admin/swarm/audits/:id', async (req, reply) => {
    const ok = await ws().remove('swarm-audit', req.params.id);
    if (!ok) return reply.code(404).send({ error: 'swarm-audit-not-found' });
    return { ok: true };
  });

  // Topology (intelligence workspace graph)
  app.get('/admin/swarm/topology', async () => ({ ...(await projectTopology(ws())) }));
  app.post<{ Body: { label: string; type?: string; x?: number; y?: number; z?: number } }>(
    '/admin/swarm/topology/nodes',
    async (req, reply) => {
      try {
        const node = await ws().addTopologyNode(req.body ?? { label: '' });
        return { node };
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );
  app.delete<{ Params: { id: string } }>('/admin/swarm/topology/nodes/:id', async (req, reply) => {
    const ok = await ws().remove('topology-node', req.params.id);
    if (!ok) return reply.code(404).send({ error: 'topology-node-not-found' });
    return { ok: true };
  });
  app.post<{ Body: { source: string; target: string; relation: string } }>(
    '/admin/swarm/topology/edges',
    async (req, reply) => {
      try {
        const edge = await ws().addTopologyEdge(req.body ?? { source: '', target: '', relation: '' });
        return { edge };
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );
  app.delete<{ Params: { id: string } }>('/admin/swarm/topology/edges/:id', async (req, reply) => {
    const ok = await ws().remove('topology-edge', req.params.id);
    if (!ok) return reply.code(404).send({ error: 'topology-edge-not-found' });
    return { ok: true };
  });

  // --- catalogs — every static dataset the exec console used to import from src/data.
  const CATALOG_KINDS: string[] = [
    'agent-manifest', 'measure-pack', 'public-source', 'domain-pack', 'operating-model', 'ecosystem',
    'runtime-policy', 'public-benchmark', 'federal-fact', 'green-team-check', 'source-mapping',
    'facility-station', 'assessment-response', 'outcome-episode-story', 'patient-timeline',
  ];
  const CATALOG_SINGLE: string[] = ['operating-model', 'ecosystem', 'runtime-policy', 'public-benchmark', 'domain-pack'];
  app.get('/admin/swarm/catalog', async () => ({ catalogs: await ws().catalogs() }));
  app.get<{ Params: { kind: string } }>('/admin/swarm/catalog/:kind', async (req, reply) => {
    const kind = req.params.kind;
    if (!CATALOG_KINDS.includes(kind)) return reply.code(404).send({ error: 'catalog-kind-not-found' });
    if (CATALOG_SINGLE.includes(kind)) {
      const rows = await ws().list<WorkspaceDoc & { data?: unknown }>(kind as WorkspaceKind);
      return { data: rows[0]?.data ?? null, id: rows[0]?.id ?? null };
    }
    return { rows: await ws().listCatalog(kind as WorkspaceKind) };
  });
  app.post<{ Params: { kind: string }; Body: Record<string, unknown> }>('/admin/swarm/catalog/:kind', async (req, reply) => {
    const kind = req.params.kind;
    if (!CATALOG_KINDS.includes(kind)) return reply.code(404).send({ error: 'catalog-kind-not-found' });
    if (CATALOG_SINGLE.includes(kind)) {
      // Upsert the single document.
      const existing = (await ws().list<WorkspaceDoc>(kind as WorkspaceKind))[0];
      const doc = req.body?.data ?? req.body;
      if (existing) await ws().update<WorkspaceDoc & { data?: unknown }>(kind as WorkspaceKind, String(existing.id), { data: doc });
      else await ws().create<WorkspaceDoc & { data?: unknown }>(kind as WorkspaceKind, `${kind}-default`, { data: doc });
      return { ok: true, kind };
    }
    const id = String((req.body?.id as string) ?? shortHash(JSON.stringify(req.body ?? {})));
    const row = await ws().create(kind as WorkspaceKind, id, (req.body ?? {}) as Record<string, unknown>);
    return { ok: true, row };
  });
  app.delete<{ Params: { kind: string; id: string } }>('/admin/swarm/catalog/:kind/:id', async (req, reply) => {
    const kind = req.params.kind;
    if (!CATALOG_KINDS.includes(kind)) return reply.code(404).send({ error: 'catalog-kind-not-found' });
    const ok = await ws().remove(kind as WorkspaceKind, req.params.id);
    if (!ok) return reply.code(404).send({ error: 'catalog-row-not-found' });
    return { ok: true };
  });

  // Full CRUD — fetch or update a single catalog row / the single-doc payload.
  app.get<{ Params: { kind: string; id: string } }>('/admin/swarm/catalog/:kind/:id', async (req, reply) => {
    const kind = req.params.kind;
    if (!CATALOG_KINDS.includes(kind)) return reply.code(404).send({ error: 'catalog-kind-not-found' });
    const row = await ws().get<WorkspaceDoc>(kind as WorkspaceKind, req.params.id);
    if (!row) return reply.code(404).send({ error: 'catalog-row-not-found' });
    if (CATALOG_SINGLE.includes(kind)) return { data: (row as WorkspaceDoc & { data?: unknown }).data ?? null };
    return { row };
  });
  app.put<{ Params: { kind: string; id: string }; Body: Record<string, unknown> }>('/admin/swarm/catalog/:kind/:id', async (req, reply) => {
    const kind = req.params.kind;
    if (!CATALOG_KINDS.includes(kind)) return reply.code(404).send({ error: 'catalog-kind-not-found' });
    if (CATALOG_SINGLE.includes(kind)) {
      const existing = await ws().get<WorkspaceDoc>(kind as WorkspaceKind, req.params.id);
      if (!existing) return reply.code(404).send({ error: 'catalog-row-not-found' });
      const doc = (req.body?.data as unknown) ?? req.body;
      await ws().update<WorkspaceDoc & { data?: unknown }>(kind as WorkspaceKind, req.params.id, { data: doc });
      return { ok: true, kind };
    }
    const updated = await ws().update(kind as WorkspaceKind, req.params.id, (req.body ?? {}) as Record<string, unknown>);
    if (!updated) return reply.code(404).send({ error: 'catalog-row-not-found' });
    return { ok: true, row: updated };
  });

  // ---- Ontology — the org hierarchy operating model. Persisted to Postgres via the
  // durable swarm_workspace store (kind 'operating-model'); the exec console renders
  // exclusively from this document. `realized` projects live facility/patient counts
  // from the master-data tables so the admin can reconcile config with real data.
  app.get('/admin/ontology', async () => {
    const rows = await ws().list<WorkspaceDoc & { data?: unknown }>('operating-model');
    const ontology = rows[0]?.data ?? null;
    let realized = { totalFacilities: 0, totalPatients: 0, perFacility: [] as Array<{ id: string; name: string; realmId: string; patients: number }> };
    try {
      const store = await getSqlStore();
      const facilities = await store.listFacilities();
      const patients = await store.listPatients();
      const byFacility = new Map<string, number>();
      for (const p of patients) byFacility.set(p.facilityId, (byFacility.get(p.facilityId) ?? 0) + 1);
      realized = {
        totalFacilities: facilities.length,
        totalPatients: patients.length,
        perFacility: facilities.map((f) => ({ id: f.id, name: f.name, realmId: f.realmId, patients: byFacility.get(f.id) ?? 0 })),
      };
    } catch {
      // storage unavailable — realized stays zeroed
    }
    return { ontology, realized };
  });
  app.put<{ Body: Record<string, unknown> }>('/admin/ontology', async (req, reply) => {
    const doc = (req.body ?? {}) as Record<string, unknown>;
    const rows = await ws().list<WorkspaceDoc>('operating-model');
    if (rows[0]) await ws().update<WorkspaceDoc & { data?: unknown }>('operating-model', String(rows[0].id), { data: doc });
    else await ws().create<WorkspaceDoc & { data?: unknown }>('operating-model', 'operating-model-default', { data: doc });
    return { ok: true };
  });
};
