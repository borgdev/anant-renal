/******************************************************************************
 * Agent Studio — the unified agent mental model (port plan Phase D).
 *
 * The docs require ONE surface for authoring, triggers, topics, outputs, test,
 * kill switch, rollback and operations. This route consolidates what already
 * exists (published pack agents, drafts, the durable topic plan, run stats)
 * into a single `/admin/platform/agents` registry with isolated test / kill /
 * rollback / output-topic operations. No new runtime — it composes the existing
 * authoring, run store and topic-plan services.
 *
 *   GET  /admin/platform/agents                — unified registry
 *   GET  /admin/platform/agents/:id            — detail (spec + runs + bindings)
 *   POST /admin/platform/agents/:id/test       — isolated contract test
 *   POST /admin/platform/agents/:id/kill       — durable kill switch (by agent)
 *   POST /admin/platform/agents/:id/un-kill    — clear kill switch
 *   POST /admin/platform/agents/:id/rollback   — durable rollback request
 *   PUT  /admin/platform/agents/:id/output-topic — bind output/DLQ topic
 ******************************************************************************/

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { loadAllAgents } from './admin-routes.js';
import { AgentAuthoringService, type DraftRecord } from './agent-authoring.js';
import { AgentRunStore } from './agent-run-store.js';
import { getSwarmWorkspace } from './swarm-routes.js';
import type { SwarmWorkspaceStore, AgentKillSwitch, AgentRollback, PlatformTopicPlan } from '../swarm/workspace.js';
import type { AgentSpec } from '../agents/index.js';

const DEFAULT_OUTPUT = 'anant.agent.output.v1';
const DEFAULT_DLQ = 'anant.agent.output.dlq.v1';

interface ResolvedAgent {
  id: string;
  packId: string;
  source: 'published' | 'draft';
  spec?: AgentSpec;
  draft?: DraftRecord;
}

/** Resolve an agent by id — `packId:id` targets a draft; a bare id targets a
 *  published agent spec (first pack match). */
function resolveAgent(id: string, published: Array<{ packId: string; spec: AgentSpec }>, drafts: DraftRecord[]): ResolvedAgent | undefined {
  const hasPack = id.includes(':');
  if (hasPack) {
    const [packId, agentId] = id.split(':');
    if (!packId || !agentId) return undefined;
    const d = drafts.find((x) => x.packId === packId && x.id === agentId);
    return d ? { id: agentId, packId, source: 'draft', draft: d } : undefined;
  }
  const p = published.find((a) => a.spec.id === id);
  return p ? { id: p.spec.id, packId: p.packId, source: 'published', spec: p.spec } : undefined;
}

function topicBindings(plan: PlatformTopicPlan | undefined): Map<string, { topic: string; dlqTopic?: string }> {
  const map = new Map<string, { topic: string; dlqTopic?: string }>();
  for (const e of plan?.entries ?? []) {
    if (e.owningAgent) {
      map.set(e.owningAgent, { topic: e.topic, ...(e.dlqTopic ? { dlqTopic: e.dlqTopic } : {}) });
    }
  }
  return map;
}

function toRegistryRow(input: {
  id: string; packId: string; source: 'published' | 'draft'; displayName: string; description: string;
  triggerKind: string; scope: string; clearance: string; purposeOfUse: string[]; hitlGates: number;
  outputTopic: string; dlqTopic: string; killSwitch: boolean; killReason: string | null; rollbackStatus: string | null;
  runs: number; lastRunAt: string | null; validation?: { ok: boolean; errors: string[] };
}) {
  return input;
}

export async function registerAgentStudioRoutes(app: FastifyInstance): Promise<void> {
  const ws = (): SwarmWorkspaceStore => {
    const w = getSwarmWorkspace();
    if (!w) throw new Error('swarm-workspace-not-ready');
    return w;
  };
  const authoring = new AgentAuthoringService();

  async function registry() {
    const published = loadAllAgents();
    const drafts = authoring.listDrafts();
    const [plan, kills, rollbacks] = await Promise.all([
      ws().getPlatformTopicPlan(),
      ws().list<AgentKillSwitch>('agent-kill-switch'),
      ws().list<AgentRollback>('agent-rollback'),
    ]);
    const bindings = topicBindings(plan);
    const runs = AgentRunStore.list({ limit: 200 });

    const draftRows = drafts.map((d) => {
      const kill = kills.find((k) => k.agentId === d.id && k.packId === d.packId && k.active);
      const binding = bindings.get(d.id);
      const runFor = runs.filter((r) => r.agent?.agentId === d.id && r.agent?.source === 'draft');
      return toRegistryRow({
        id: d.id, packId: d.packId, source: 'draft', displayName: d.id, description: 'Draft agent (not yet published)',
        triggerKind: 'draft', scope: 'org', clearance: 'internal', purposeOfUse: [], hitlGates: 0,
        outputTopic: binding?.topic ?? DEFAULT_OUTPUT, dlqTopic: binding?.dlqTopic ?? DEFAULT_DLQ,
        killSwitch: kill?.active ?? false, killReason: kill?.reason ?? null, rollbackStatus: null,
        runs: runFor.length, lastRunAt: runFor[0]?.at ?? null,
        validation: d.validation,
      });
    });

    const publishedRows = published.map((a) => {
      const kill = kills.find((k) => k.agentId === a.spec.id && k.active);
      const binding = bindings.get(a.spec.id);
      const runFor = runs.filter((r) => r.agent?.agentId === a.spec.id && r.agent?.source === 'published');
      const rollback = rollbacks.find((r) => r.agentId === a.spec.id);
      return toRegistryRow({
        id: a.spec.id, packId: a.packId, source: 'published', displayName: a.spec.displayName, description: a.spec.description,
        triggerKind: a.spec.trigger.kind, scope: a.spec.scope, clearance: a.spec.governance.clearanceRequired,
        purposeOfUse: a.spec.governance.purposeOfUse, hitlGates: a.spec.governance.hitlGates.length,
        outputTopic: binding?.topic ?? DEFAULT_OUTPUT, dlqTopic: binding?.dlqTopic ?? DEFAULT_DLQ,
        killSwitch: kill?.active ?? false, killReason: kill?.reason ?? null, rollbackStatus: rollback?.status ?? null,
        runs: runFor.length, lastRunAt: runFor[0]?.at ?? null,
      });
    });

    const agents = [...draftRows, ...publishedRows].sort((a, b) => String(b.lastRunAt ?? '').localeCompare(String(a.lastRunAt ?? '')));
    return { count: agents.length, total: published.length + drafts.length, agents, topics: plan ?? null };
  }

  app.get('/admin/platform/agents', async () => registry());

  app.get<{ Params: { id: string } }>('/admin/platform/agents/:id', async (req, reply) => {
    const r = await registry();
    const match = resolveAgent(req.params.id, loadAllAgents(), authoring.listDrafts());
    if (!match) return reply.code(404).send({ error: 'agent-not-found' });
    const row = r.agents.find((a) => a.id === match.id && a.packId === match.packId && a.source === match.source);
    const runs = AgentRunStore.list({ agentId: match.id, limit: 20 });
    return {
      agent: row,
      spec: match.spec ?? (match.draft ? authoring.validateYaml(match.draft.yaml).spec : undefined) ?? null,
      draft: match.draft ? { status: match.draft.status, updatedAt: match.draft.updatedAt, author: match.draft.authorRef, validation: match.draft.validation } : null,
      runs,
    };
  });

  app.post<{ Params: { id: string } }>('/admin/platform/agents/:id/test', async (req, reply) => {
    const match = resolveAgent(req.params.id, loadAllAgents(), authoring.listDrafts());
    if (!match) return reply.code(404).send({ error: 'agent-not-found' });
    const plan = await ws().getPlatformTopicPlan();
    const binding = topicBindings(plan).get(match.id);
    const spec = match.spec ?? (match.draft ? authoring.validateYaml(match.draft.yaml) : null);
    if (match.source === 'draft' && spec && 'ok' in spec && !(spec as { ok: boolean }).ok) {
      return reply.code(400).send({ error: 'agent-validation-failed', errors: (spec as { errors: string[] }).errors });
    }
    const agentSpec = match.source === 'published' ? match.spec : (spec as { ok: true; spec?: AgentSpec }).spec;
    return {
      test: {
        agentId: match.id,
        source: match.source,
        mode: 'contract-only',
        ok: true,
        contract: agentSpec ? {
          trigger: agentSpec.trigger.kind,
          scope: agentSpec.scope,
          clearanceRequired: agentSpec.governance.clearanceRequired,
          purposeOfUse: agentSpec.governance.purposeOfUse,
          hitlGates: agentSpec.governance.hitlGates.length,
          inputs: Object.keys(agentSpec.inputs),
          outputs: Object.keys(agentSpec.outputs),
        } : null,
        outputTopic: binding?.topic ?? DEFAULT_OUTPUT,
        dlqTopic: binding?.dlqTopic ?? DEFAULT_DLQ,
        note: 'Contract-only test completed — trigger, outputs, governance and topic routing resolved. No broker interaction performed.',
      },
    };
  });

  app.post<{ Params: { id: string }; Body: { reason?: string; by?: string } }>(
    '/admin/platform/agents/:id/kill',
    async (req, reply) => {
      const match = resolveAgent(req.params.id, loadAllAgents(), authoring.listDrafts());
      if (!match) return reply.code(404).send({ error: 'agent-not-found' });
      const w = ws();
      const existing = (await w.list<AgentKillSwitch>('agent-kill-switch')).find((k) => k.agentId === match.id && k.packId === match.packId);
      const doc = existing
        ? (await w.update<AgentKillSwitch>('agent-kill-switch', existing.id, { active: true, reason: req.body?.reason?.trim() || 'killed from Agent Studio', by: req.body?.by?.trim() || 'operator' }))
        : await w.create<AgentKillSwitch>('agent-kill-switch', `kill-${match.packId}-${match.id}`, {
            agentId: match.id, packId: match.packId, source: match.source, reason: req.body?.reason?.trim() || 'killed from Agent Studio', by: req.body?.by?.trim() || 'operator', active: true,
          });
      return { agentId: match.id, killSwitch: doc?.active ?? true, reason: doc?.reason ?? null };
    },
  );

  app.post<{ Params: { id: string } }>('/admin/platform/agents/:id/un-kill', async (req, reply) => {
    const match = resolveAgent(req.params.id, loadAllAgents(), authoring.listDrafts());
    if (!match) return reply.code(404).send({ error: 'agent-not-found' });
    const w = ws();
    const existing = (await w.list<AgentKillSwitch>('agent-kill-switch')).find((k) => k.agentId === match.id && k.packId === match.packId);
    if (existing) await w.update<AgentKillSwitch>('agent-kill-switch', existing.id, { active: false });
    return { agentId: match.id, killSwitch: false };
  });

  app.post<{ Params: { id: string }; Body: { toVersion?: string; reason?: string; by?: string } }>(
    '/admin/platform/agents/:id/rollback',
    async (req, reply) => {
      const match = resolveAgent(req.params.id, loadAllAgents(), authoring.listDrafts());
      if (!match) return reply.code(404).send({ error: 'agent-not-found' });
      const w = ws();
      const rollback = await w.create<AgentRollback>('agent-rollback', `rb-${match.packId}-${match.id}-${Date.now()}`, {
        agentId: match.id, packId: match.packId, toVersion: req.body?.toVersion?.trim() || 'previous', reason: req.body?.reason?.trim() || 'rolled back from Agent Studio', by: req.body?.by?.trim() || 'operator', status: 'requested',
      });
      return { agentId: match.id, rollback: { status: rollback.status, toVersion: rollback.toVersion } };
    },
  );

  app.put<{ Params: { id: string }; Body: { topic?: string; dlqTopic?: string } }>(
    '/admin/platform/agents/:id/output-topic',
    async (req, reply) => {
      const match = resolveAgent(req.params.id, loadAllAgents(), authoring.listDrafts());
      if (!match) return reply.code(404).send({ error: 'agent-not-found' });
      const topic = req.body?.topic?.trim() || DEFAULT_OUTPUT;
      const dlqTopic = req.body?.dlqTopic?.trim() || DEFAULT_DLQ;
      const w = ws();
      const plan = (await w.getPlatformTopicPlan()) ?? { defaultOutputTopic: DEFAULT_OUTPUT, agentDlqTopic: DEFAULT_DLQ, actionCommandTopic: 'anant.action.command.v1', actionAckTopic: 'anant.action.ack.v1', outcomeStateTopic: 'anant.outcome.state.v1', assuranceEventTopic: 'anant.assurance.event.v1', entries: [] };
      const entries = (plan.entries ?? []).filter((e) => e.owningAgent !== match.id);
      entries.push({ id: `binding-${match.id}`, topic, direction: 'outbound', contract: 'agent-output-envelope.v1', owningAgent: match.id, dlqTopic, classification: 'confidential' });
      const saved = await w.savePlatformTopicPlan({ ...plan, entries });
      return { agentId: match.id, outputTopic: topic, dlqTopic, entries: saved.entries.length };
    },
  );
}
