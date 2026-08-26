/******************************************************************************
 * AI Assurance — green/red team + findings lifecycle + release gates (port
 * plan Phase E, spec §20). One surface for the "is this safe and releasable?"
 * question. Everything derives from durable state:
 *
 *   green team      — provider/payer happy paths, golden sets, replay, parity
 *   red team        — active adversarial scenarios vs the CURRENT runtime policy;
 *                     failures create findings (Journey M)
 *   findings        — open → assigned → remediating → retest-failed|retest-passed
 *                     → independently-reviewed → closed (never deleted)
 *   release gates   — schema/green/red/integration/promotion derived live
 *
 * Routes are `/admin/platform/*` and sit behind the existing admin guard.
 ******************************************************************************/

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getSwarmWorkspace } from './swarm-routes.js';
import type { SwarmWorkspaceStore, AssuranceFinding, GreenTeamRun, RedTeamRun, FindingDisposition } from '../swarm/workspace.js';

export async function registerAssuranceRoutes(app: FastifyInstance): Promise<void> {
  const ws = (): SwarmWorkspaceStore => {
    const w = getSwarmWorkspace();
    if (!w) throw new Error('swarm-workspace-not-ready');
    return w;
  };

  const error = (reply: FastifyReply, code: number, message: string): FastifyReply => reply.code(code).send({ error: message });

  /* ---------- dashboard ---------- */

  app.get('/admin/platform/assurance', async () => {
    const w = ws();
    const findings = await w.listFindings();
    const green = await w.list<GreenTeamRun>('green-team-run');
    const red = await w.list<RedTeamRun>('red-team-run');
    const blocking = await w.blockingFindings();
    return {
      findings: {
        total: findings.length,
        open: findings.filter((f) => f.status !== 'closed').length,
        blocking: blocking.length,
        bySeverity: {
          critical: findings.filter((f) => f.severity === 'critical' && f.status !== 'closed').length,
          high: findings.filter((f) => f.severity === 'high' && f.status !== 'closed').length,
          medium: findings.filter((f) => f.severity === 'medium' && f.status !== 'closed').length,
          low: findings.filter((f) => f.severity === 'low' && f.status !== 'closed').length,
        },
      },
      greenTeam: { runs: green.length, latest: green[0] ?? null },
      redTeam: { runs: red.length, latest: red[0] ?? null, activeScenarios: (await w.seedRedTeamScenarios()).filter((s) => s.status === 'active').length },
      releaseGate: { blockingFindings: blocking.length, verdict: blocking.length === 0 ? 'pass' : 'blocked' },
    };
  });

  /* ---------- green team ---------- */

  app.post<{ Body: { ranBy?: string } }>('/admin/platform/green-team/run', async (req) => {
    const w = ws();
    const run = await w.runGreenTeam({ ...(req.body?.ranBy ? { ranBy: req.body.ranBy } : {}) });
    return { run };
  });

  /* ---------- red team suite ---------- */

  app.post<{ Body: { releaseId?: string; ranBy?: string } }>('/admin/platform/red-team/run-suite', async (req) => {
    const w = ws();
    const result = await w.runRedTeamSuite({
      ...(req.body?.releaseId ? { releaseId: req.body.releaseId } : {}),
      ...(req.body?.ranBy ? { ranBy: req.body.ranBy } : {}),
    });
    return result;
  });

  /* ---------- findings ---------- */

  app.get('/admin/platform/findings', async () => {
    const w = ws();
    return { findings: await w.listFindings() };
  });

  app.get<{ Params: { id: string } }>('/admin/platform/findings/:id', async (req, reply) => {
    const finding = await ws().getFinding(req.params.id);
    if (!finding) return error(reply, 404, 'finding-not-found');
    return { finding };
  });

  /** Create a finding — either from a prior red-team run (`runId`) or manually. */
  app.post<{ Body: { runId?: string; severity?: AssuranceFinding['severity']; title?: string; description?: string; threatModel?: string; releaseId?: string } }>(
    '/admin/platform/findings',
    async (req, reply) => {
      const w = ws();
      try {
        if (req.body?.runId) {
          const runs = await w.list<RedTeamRun>('red-team-run');
          const run = runs.find((r) => r.id === req.body.runId);
          if (!run) return error(reply, 404, 'red-team-run-not-found');
          if (run.passed) return error(reply, 400, 'run-passed-no-finding');
          const scenarios = await w.seedRedTeamScenarios();
          const scenario = scenarios.find((s) => s.id === run.scenarioId);
          const failed = run.checks.filter((c) => !c.passed);
          const finding = await w.createFinding({
            severity: req.body?.severity ?? 'high',
            title: req.body?.title?.trim() || `Red-team failure: ${run.scenarioName}`,
            ...(req.body?.description ? { description: req.body.description } : {}),
            threatModel: scenario?.threatModel ?? 'general',
            scenarioId: run.scenarioId,
            runId: run.id,
            expectedControl: scenario?.expected ?? 'Scenario expected control',
            observed: failed.map((c) => `${c.name}: ${c.observed}`).join('; '),
            evidenceHash: run.evidenceHash,
            ...(req.body?.releaseId ? { releaseId: req.body.releaseId } : {}),
          });
          return { finding };
        }
        return error(reply, 400, 'runId-required');
      } catch (err) {
        return error(reply, 400, err instanceof Error ? err.message : String(err));
      }
    },
  );

  const advance = (action: 'assign' | 'remediate' | 'retest' | 'review' | 'close' | 'disposition') => async (
    req: FastifyRequest<{ Params: { id: string }; Body: Record<string, unknown> }>,
    reply: FastifyReply,
  ) => {
    const w = ws();
    try {
      let result: { finding: AssuranceFinding; transition: { from: string; to: string } };
      if (action === 'assign') {
        const owner = typeof req.body?.owner === 'string' ? req.body.owner : '';
        if (!owner) return error(reply, 400, 'owner-required');
        result = await w.advanceFinding(req.params.id, { assignTo: owner });
      } else if (action === 'remediate') {
        const remediation = typeof req.body?.remediation === 'string' ? req.body.remediation : '';
        const by = typeof req.body?.by === 'string' ? req.body.by : undefined;
        if (!remediation) return error(reply, 400, 'remediation-required');
        result = await w.advanceFinding(req.params.id, { remediate: remediation, ...(by ? { remediatedBy: by } : {}) });
      } else if (action === 'retest') {
        const w2 = ws();
        const passed = Boolean(req.body?.passed);
        const runId = typeof req.body?.runId === 'string' && req.body.runId ? req.body.runId : undefined;
        let retestRunId = runId;
        if (!retestRunId) {
          // Re-run the finding's exact scenario against the CURRENT policy.
          const finding = await w2.getFinding(req.params.id);
          if (!finding) return error(reply, 404, 'finding-not-found');
          const policy = await w2.getAdminPolicy();
          const run = await w2.replayRedTeamScenario(finding.scenarioId, {
            ranBy: 'finding-retest',
            policy: { defaultDecision: policy.defaultDecision, externalWritesEnabled: policy.externalWritesEnabled },
          });
          retestRunId = run.id;
          if (typeof req.body?.passed !== 'boolean') {
            result = await w2.advanceFinding(req.params.id, { retest: { runId: run.id, passed: run.passed } });
            return { finding: result.finding, transition: result.transition, run };
          }
        }
        result = await w2.advanceFinding(req.params.id, { retest: { runId: retestRunId, passed } });
      } else if (action === 'review') {
        const reviewer = typeof req.body?.reviewer === 'string' ? req.body.reviewer : '';
        const note = typeof req.body?.note === 'string' ? req.body.note : undefined;
        const acceptClosure = Boolean(req.body?.acceptClosure);
        if (!reviewer) return error(reply, 400, 'reviewer-required');
        result = await w.advanceFinding(req.params.id, { review: { reviewer, ...(note ? { note } : {}), acceptClosure } });
      } else if (action === 'close') {
        const reviewer = typeof req.body?.reviewer === 'string' ? req.body.reviewer : undefined;
        const note = typeof req.body?.note === 'string' ? req.body.note : undefined;
        result = await w.advanceFinding(req.params.id, { close: { ...(reviewer ? { reviewer } : {}), ...(note ? { note } : {}) } });
      } else {
        const kind = typeof req.body?.kind === 'string' ? req.body.kind as FindingDisposition : undefined;
        const by = typeof req.body?.by === 'string' ? req.body.by : '';
        const expiry = typeof req.body?.expiry === 'string' ? req.body.expiry : undefined;
        if (!kind || !by) return error(reply, 400, 'kind-and-by-required');
        result = await w.advanceFinding(req.params.id, { disposition: { kind, by, ...(expiry ? { expiry } : {}) } });
      }
      return { finding: result.finding, transition: result.transition };
    } catch (err) {
      return error(reply, 400, err instanceof Error ? err.message : String(err));
    }
  };

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>('/admin/platform/findings/:id/assign', advance('assign'));
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>('/admin/platform/findings/:id/remediate', advance('remediate'));
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>('/admin/platform/findings/:id/retest', advance('retest'));
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>('/admin/platform/findings/:id/review', advance('review'));
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>('/admin/platform/findings/:id/close', advance('close'));
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>('/admin/platform/findings/:id/disposition', advance('disposition'));
}
