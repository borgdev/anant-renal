/******************************************************************************
 * CMS / EQRS submission lifecycle — Journey K (Epic 8).
 *
 * Draft → validated → approved (dual Class-D) → submitted → reconciled |
 * rejected → correct → resubmit. Transmission is gated on a certified
 * connector + credentials; reference-mode (default) stops before live
 * transmission and says exactly why. Everything derives from durable state.
 *
 * Routes are `/admin/platform/submissions/*` behind the existing admin guard.
 ******************************************************************************/

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getSwarmWorkspace } from './swarm-routes.js';
import type { SwarmWorkspaceStore, SubmissionPackage } from '../swarm/workspace.js';

export async function registerSubmissionRoutes(app: FastifyInstance): Promise<void> {
  const ws = (): SwarmWorkspaceStore => {
    const w = getSwarmWorkspace();
    if (!w) throw new Error('swarm-workspace-not-ready');
    return w;
  };
  const error = (reply: FastifyReply, code: number, message: string): FastifyReply => reply.code(code).send({ error: message });

  app.get('/admin/platform/submissions', async () => ({ packages: await ws().list<SubmissionPackage>('submission-package') }));

  app.get<{ Params: { id: string } }>('/admin/platform/submissions/:id', async (req, reply) => {
    const pkg = await ws().get<SubmissionPackage>('submission-package', req.params.id);
    if (!pkg) return error(reply, 404, 'submission-package-not-found');
    return { package: pkg };
  });

  app.post<{ Body: { measureId: string; measureVersion?: string; realmId?: string; period?: { start: string; end: string }; resultsIncluded?: number; createdBy?: string } }>(
    '/admin/platform/submissions',
    async (req, reply) => {
      try {
        return { package: await ws().createSubmissionPackage(req.body ?? {}) };
      } catch (err) {
        return error(reply, 400, err instanceof Error ? err.message : String(err));
      }
    },
  );

  app.post<{ Params: { id: string } }>('/admin/platform/submissions/:id/validate', async (req, reply) => {
    const pkg = await ws().validateSubmissionPackage(req.params.id);
    if (!pkg) return error(reply, 404, 'submission-package-not-found');
    return { package: pkg };
  });

  app.post<{ Params: { id: string }; Body: { start: string; end: string; by?: string } }>(
    '/admin/platform/submissions/:id/freeze',
    async (req, reply) => {
      const pkg = await ws().freezeSubmissionWindow(req.params.id, { start: req.body?.start ?? '', end: req.body?.end ?? '', ...(req.body?.by ? { by: req.body.by } : {}) });
      if (!pkg) return error(reply, 404, 'submission-package-not-found');
      return { package: pkg };
    },
  );

  app.post<{ Params: { id: string }; Body: { approver: string } }>(
    '/admin/platform/submissions/:id/approve',
    async (req, reply) => {
      try {
        const pkg = await ws().approveSubmission(req.params.id, { approver: req.body?.approver ?? '' });
        if (!pkg) return error(reply, 404, 'submission-package-not-found');
        return { package: pkg, approvals: pkg.approvals?.length ?? 0 };
      } catch (err) {
        return error(reply, 400, err instanceof Error ? err.message : String(err));
      }
    },
  );

  /** Journey K step 9 — transmit only when a certified connector + credentials
   *  exist. Reference-mode stops before live transmission and says why. */
  app.post<{ Params: { id: string }; Body: { by?: string; connectorCertified?: boolean; credentialsPresent?: boolean } }>(
    '/admin/platform/submissions/:id/submit',
    async (req, reply) => {
      const w = ws();
      const kafka = await w.getAdminKafka();
      const connectorCertified = kafka.status === 'contract-verified';
      const credentialsPresent = Boolean(req.body?.credentialsPresent);
      const pkg = await w.submitSubmission(req.params.id, {
        ...(req.body?.by ? { by: req.body.by } : {}),
        connectorCertified,
        credentialsPresent,
      });
      if (!pkg) return error(reply, 404, 'submission-package-not-found');
      if (pkg.transmissionBlocked) {
        return { package: pkg, stopped: true, reason: pkg.transmissionBlocked.reason };
      }
      return { package: pkg, transmitted: pkg.status === 'submitted', transmissionMode: pkg.transmissionMode };
    },
  );

  app.post<{ Params: { id: string }; Body: { status: 'accepted' | 'rejected'; referenceId?: string; message?: string } }>(
    '/admin/platform/submissions/:id/receipt',
    async (req, reply) => {
      const pkg = await ws().receiveSubmissionReceipt(req.params.id, {
        status: req.body?.status,
        ...(req.body?.referenceId ? { referenceId: req.body.referenceId } : {}),
        ...(req.body?.message ? { message: req.body.message } : {}),
      });
      if (!pkg) return error(reply, 404, 'submission-package-not-found');
      return { package: pkg, receipt: pkg.receipt };
    },
  );

  app.post<{ Params: { id: string }; Body: { reason: string; by?: string } }>(
    '/admin/platform/submissions/:id/correct',
    async (req, reply) => {
      const pkg = await ws().correctSubmission(req.params.id, { reason: req.body?.reason ?? '', ...(req.body?.by ? { by: req.body.by } : {}) });
      if (!pkg) return error(reply, 404, 'submission-package-not-found');
      return { package: pkg };
    },
  );

  app.post<{ Params: { id: string }; Body: { by?: string } }>(
    '/admin/platform/submissions/:id/reconcile',
    async (req, reply) => {
      const pkg = await ws().reconcileSubmission(req.params.id, { ...(req.body?.by ? { by: req.body.by } : {}) });
      if (!pkg) return error(reply, 404, 'submission-package-not-found');
      return { package: pkg };
    },
  );

  app.delete<{ Params: { id: string } }>('/admin/platform/submissions/:id', async (req, reply) => {
    const ok = await ws().deleteSubmissionPackage(req.params.id);
    if (!ok) return error(reply, 404, 'submission-package-not-found');
    return { ok: true };
  });
}
