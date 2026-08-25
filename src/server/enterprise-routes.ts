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

// Enterprise admin routes (Phase 4) — webhooks, alert rules, retention, audit
// mirror, secret rotation. Registered alongside /admin/* so the operator console
// and the Phase 3 fabric share one surface.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { SecretsProvider } from '../control-plane/secrets.js';
import type { EventBroker } from './event-broker.js';
import type { EventOutbox } from './event-outbox.js';
import type { SqlStore } from './sql/sql-store.js';
import { getSqlStore } from './sql/index.js';
import type { WebhookRegistry, WebhookDeliverer } from './webhooks.js';
import type { AlertService } from './alerts.js';
import type { RetentionService } from './retention.js';
import { auditRowsToFhir } from './audit.js';

export interface EnterpriseRoutesOptions {
  readonly eventBroker?: EventBroker;
  readonly eventOutbox?: EventOutbox;
  readonly webhookRegistry?: WebhookRegistry;
  readonly webhookDeliverer?: WebhookDeliverer;
  readonly alerts?: AlertService;
  readonly retention?: RetentionService;
  readonly secrets?: SecretsProvider;
}

export async function registerEnterpriseRoutes(app: FastifyInstance, opts: EnterpriseRoutesOptions = {}): Promise<void> {
  const store: SqlStore = await getSqlStore();
  const secrets = opts.secrets;

  // ---- Webhooks ----
  app.get<{ Querystring: { activeOnly?: string } }>('/admin/webhooks', async () => ({
    webhooks: (await store.listWebhookEndpoints()).map(({ secret, ...rest }) => ({ ...rest, secretPresent: Boolean(secret) })),
    stats: await store.webhookDeliveryCounts(),
  }));

  app.post<{ Body: { id?: string; realmId?: string; url: string; secret: string; eventTypes: string[]; active?: boolean } }>('/admin/webhooks', async (req, reply) => {
    if (!opts.webhookRegistry) return reply.code(503).send({ error: 'webhooks-not-wired' });
    try {
      const ep = await opts.webhookRegistry.create({
        url: req.body.url,
        secret: req.body.secret,
        eventTypes: req.body.eventTypes,
        ...(req.body?.id ? { id: req.body.id } : {}),
        ...(req.body?.realmId ? { realmId: req.body.realmId } : {}),
        ...(req.body?.active !== undefined ? { active: req.body.active } : {}),
      });
      return { id: ep.id, url: ep.url, eventTypes: JSON.parse(ep.eventTypesJson) };
    } catch (err) { return reply.code(400).send({ error: (err as Error).message }); }
  });

  app.delete<{ Params: { id: string } }>('/admin/webhooks/:id', async (req) => ({ ok: await store.deleteWebhookEndpoint(req.params.id) }));

  app.get<{ Querystring: { limit?: string } }>('/admin/webhooks/deliveries', async (req) => {
    const rows = await store.pendingWebhookDeliveries(Number(req.query.limit ?? 100));
    const delivered = await store.webhookDeliveryCounts();
    return { deliveries: rows, stats: delivered };
  });

  app.post<{ Body: { event: import('../healthcare-core/events.js').CanonicalEvent } }>('/admin/webhooks/test', async (req, reply) => {
    if (!opts.webhookDeliverer) return reply.code(503).send({ error: 'webhooks-not-wired' });
    try {
      const result = await opts.webhookDeliverer.onEvent(req.body.event);
      return result;
    } catch (err) { return reply.code(400).send({ error: (err as Error).message }); }
  });

  // ---- Alert rules + events ----
  app.get('/admin/alerts', async () => ({
    rules: opts.alerts ? await opts.alerts.rules() : [],
    events: opts.alerts ? await opts.alerts.events(50) : [],
  }));

  app.post<{ Body: { id?: string; metric: string; op: 'gt' | 'gte' | 'lt' | 'lte' | 'eq'; threshold: number; severity?: string; enabled?: boolean; label?: string } }>('/admin/alerts', async (req, reply) => {
    if (!opts.alerts) return reply.code(503).send({ error: 'alerts-not-wired' });
    try {
      await opts.alerts.upsert({
        metric: req.body.metric,
        op: req.body.op,
        threshold: req.body.threshold,
        ...(req.body?.id ? { id: req.body.id } : {}),
        ...(req.body?.severity ? { severity: req.body.severity as 'info' | 'warning' | 'critical' } : {}),
        ...(req.body?.enabled !== undefined ? { enabled: req.body.enabled } : {}),
        ...(req.body?.label ? { label: req.body.label } : {}),
      });
      return { ok: true };
    } catch (err) { return reply.code(400).send({ error: (err as Error).message }); }
  });

  app.delete<{ Params: { id: string } }>('/admin/alerts/:id', async (req) => ({ ok: opts.alerts ? await opts.alerts.remove(req.params.id) : false }));

  app.post<{ Body: { metrics: Record<string, number> } }>('/admin/alerts/evaluate', async (req, reply) => {
    if (!opts.alerts) return reply.code(503).send({ error: 'alerts-not-wired' });
    const fired = await opts.alerts.evaluate(req.body?.metrics ?? {});
    return { fired };
  });

  // ---- Retention ----
  app.get('/admin/retention', async () => ({ policies: await store.listRetentionPolicies() }));
  app.post<{ Body: { id?: string; entity: string; scopeId?: string; maxAgeMs: number; enabled?: boolean } }>('/admin/retention', async (req, reply) => {
    if (!opts.retention) return reply.code(503).send({ error: 'retention-not-wired' });
    try {
      await opts.retention.upsert({
        entity: req.body.entity,
        maxAgeMs: req.body.maxAgeMs,
        ...(req.body?.id ? { id: req.body.id } : {}),
        ...(req.body?.scopeId ? { scopeId: req.body.scopeId } : {}),
        ...(req.body?.enabled !== undefined ? { enabled: req.body.enabled } : {}),
      });
      return { ok: true };
    } catch (err) { return reply.code(400).send({ error: (err as Error).message }); }
  });
  app.delete<{ Params: { id: string } }>('/admin/retention/:id', async (req) => ({ ok: opts.retention ? await opts.retention.remove(req.params.id) : false }));
  app.post('/admin/retention/purge', async () => ({ deleted: opts.retention ? await opts.retention.purge() : {} }));

  // ---- Audit mirror (FHIR AuditEvent projection) ----
  app.get<{ Querystring: { scopeId?: string; action?: string; limit?: string } }>('/admin/audit', async (req) => {
    const rows = await store.listAuditEvents({
      ...(req.query.scopeId ? { scopeId: req.query.scopeId } : {}),
      ...(req.query.action ? { action: req.query.action } : {}),
      ...(req.query.limit ? { limit: Number(req.query.limit) } : {}),
    });
    return { audit: rows };
  });
  app.get<{ Querystring: { limit?: string } }>('/admin/audit/fhir', async (req) => {
    const rows = await store.listAuditEvents({ limit: Number(req.query.limit ?? 100) });
    return { resourceType: 'Bundle', type: 'collection', entry: auditRowsToFhir(rows).map((r) => ({ resource: r })) };
  });

  // ---- Secret rotation ----
  app.get('/admin/secrets', async () => ({ keys: secrets ? await secrets.list() : [] }));
  app.post<{ Body: { key: string; value: string } }>('/admin/secrets/rotate', async (req, reply) => {
    if (!secrets) return reply.code(503).send({ error: 'secrets-not-wired' });
    try {
      const result = await secrets.rotate(req.body.key, req.body.value);
      return result;
    } catch (err) { return reply.code(400).send({ error: (err as Error).message }); }
  });

  // ---- Compliance dashboard (Phase 5) ----
  app.get('/admin/compliance', async () => {
    const auditRows = await store.listAuditEvents({ limit: 500 });
    const byAction: Record<string, number> = {};
    const byClassification: Record<string, number> = {};
    for (const a of auditRows) {
      byAction[a.action] = (byAction[a.action] ?? 0) + 1;
      byClassification[a.classification] = (byClassification[a.classification] ?? 0) + 1;
    }
    const fhirRows = await store.listFhirResources({ limit: 500 });
    const fhirByType: Record<string, number> = {};
    for (const f of fhirRows) fhirByType[f.resourceType] = (fhirByType[f.resourceType] ?? 0) + 1;
    const fhirByKind: Record<string, number> = {};
    for (const f of fhirRows) fhirByKind[f.kind] = (fhirByKind[f.kind] ?? 0) + 1;
    return {
      audit: { total: auditRows.length, byAction, byClassification },
      retention: await store.listRetentionPolicies(),
      phiInventory: { fhirResources: fhirRows.length, byType: fhirByType, byKind: fhirByKind },
    };
  });

  // ---- Enterprise summary (for the admin panel) ----
  app.get('/admin/enterprise', async () => ({
    webhooks: await store.webhookDeliveryCounts(),
    alerts: opts.alerts ? await opts.alerts.events(10) : [],
    retention: await store.listRetentionPolicies(),
    auditCount: (await store.listAuditEvents({ limit: 1 })).length === 0 ? 0 : '…',
    broker: opts.eventBroker ? await opts.eventBroker.health() : { ok: false, driver: 'none' },
    outbox: opts.eventOutbox ? await opts.eventOutbox.counts() : { pending: 0, delivered: 0, dead: 0 },
  }));
}
