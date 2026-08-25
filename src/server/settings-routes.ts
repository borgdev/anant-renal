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

// Settings admin — CRUD for master data (facilities, units, patients, assessment catalog,
// lifecycle stages, nudge templates) + durable realms.
//
//   GET/POST       /admin/settings/facilities        (list / create)
//   PUT/DELETE     /admin/settings/facilities/:id    (update / delete)
//   GET/POST       /admin/settings/units
//   PUT/DELETE     /admin/settings/units/:id
//   GET/POST       /admin/settings/patients?facilityId=&unitId=
//   PUT/DELETE     /admin/settings/patients/:id
//   GET/POST       /admin/settings/assessments?domain=
//   PUT/DELETE     /admin/settings/assessments/:id
//   GET/POST       /admin/settings/lifecycle
//   PUT/DELETE     /admin/settings/lifecycle/:id
//   GET/POST       /admin/settings/nudges?kind=
//   PUT/DELETE     /admin/settings/nudges/:id
//   GET            /admin/settings/realms            (durable realm snapshots)
//   DELETE         /admin/settings/realms/:id        (remove the durable snapshot)
//
// All reads/writes go through SqlStore → SqlDb, so the data is durable and the
// SQLite ↔ Postgres swap story is unchanged.

import type { FastifyInstance } from 'fastify';
import { getSqlStore } from './sql/index.js';

export async function registerSettingsRoutes(app: FastifyInstance): Promise<void> {
  const store = await getSqlStore();

  // ---- Facilities ----
  app.get<{ Querystring: { realmId?: string } }>('/admin/settings/facilities', async (req) => ({
    facilities: await store.listFacilities(req.query.realmId),
  }));
  app.post<{ Body: { id: string; realmId: string; name: string; kind?: string } }>('/admin/settings/facilities', async (req, reply) => {
    const { id, realmId, name, kind } = req.body ?? {};
    if (!id || !realmId || !name) return reply.code(400).send({ error: 'id, realmId, name required' });
    await store.saveFacility({ id, realmId, name, kind: kind ?? null });
    return { ok: true, id };
  });
  app.put<{ Params: { id: string }; Body: { realmId?: string; name?: string; kind?: string } }>('/admin/settings/facilities/:id', async (req, reply) => {
    const existing = await store.getFacility(req.params.id);
    if (!existing) return reply.code(404).send({ error: 'facility-not-found' });
    await store.saveFacility({
      ...existing,
      ...(req.body.realmId !== undefined ? { realmId: req.body.realmId } : {}),
      ...(req.body.name !== undefined ? { name: req.body.name } : {}),
      ...(req.body.kind !== undefined ? { kind: req.body.kind } : {}),
    });
    return { ok: true, id: req.params.id };
  });
  app.delete<{ Params: { id: string } }>('/admin/settings/facilities/:id', async (req, reply) => {
    const ok = await store.deleteFacility(req.params.id);
    if (!ok) return reply.code(404).send({ error: 'facility-not-found' });
    return { ok: true, removed: req.params.id };
  });

  // ---- Units ----
  app.get<{ Querystring: { facilityId?: string } }>('/admin/settings/units', async (req) => ({
    units: await store.listUnits(req.query.facilityId),
  }));
  app.post<{ Body: { id: string; facilityId: string; realmId: string; code: string } }>('/admin/settings/units', async (req, reply) => {
    const { id, facilityId, realmId, code } = req.body ?? {};
    if (!id || !facilityId || !realmId || !code) return reply.code(400).send({ error: 'id, facilityId, realmId, code required' });
    await store.saveUnit({ id, facilityId, realmId, code });
    return { ok: true, id };
  });
  app.put<{ Params: { id: string }; Body: { facilityId?: string; realmId?: string; code?: string } }>('/admin/settings/units/:id', async (req, reply) => {
    const existing = await store.getUnit(req.params.id);
    if (!existing) return reply.code(404).send({ error: 'unit-not-found' });
    await store.saveUnit({
      ...existing,
      ...(req.body.facilityId !== undefined ? { facilityId: req.body.facilityId } : {}),
      ...(req.body.realmId !== undefined ? { realmId: req.body.realmId } : {}),
      ...(req.body.code !== undefined ? { code: req.body.code } : {}),
    });
    return { ok: true, id: req.params.id };
  });
  app.delete<{ Params: { id: string } }>('/admin/settings/units/:id', async (req, reply) => {
    const ok = await store.deleteUnit(req.params.id);
    if (!ok) return reply.code(404).send({ error: 'unit-not-found' });
    return { ok: true, removed: req.params.id };
  });

  // ---- Patients ----
  app.get<{ Querystring: { facilityId?: string; unitId?: string } }>('/admin/settings/patients', async (req) => ({
    patients: await store.listPatients({
      ...(req.query.facilityId ? { facilityId: req.query.facilityId } : {}),
      ...(req.query.unitId ? { unitId: req.query.unitId } : {}),
    }),
  }));
  app.post<{ Body: { id: string; facilityId: string; unitId: string; realmId: string; name?: string; age?: number; sex?: string; trajectory?: string } }>(
    '/admin/settings/patients', async (req, reply) => {
      const { id, facilityId, unitId, realmId, name, age, sex, trajectory } = req.body ?? {};
      if (!id || !facilityId || !unitId || !realmId) return reply.code(400).send({ error: 'id, facilityId, unitId, realmId required' });
      await store.savePatient({ id, facilityId, unitId, realmId, name: name ?? null, age: age ?? null, sex: sex ?? null, trajectory: trajectory ?? null });
      return { ok: true, id };
    },
  );
  app.put<{ Params: { id: string }; Body: { facilityId?: string; unitId?: string; realmId?: string; name?: string; age?: number; sex?: string; trajectory?: string } }>(
    '/admin/settings/patients/:id', async (req, reply) => {
      const existing = await store.getPatient(req.params.id);
      if (!existing) return reply.code(404).send({ error: 'patient-not-found' });
      await store.savePatient({
        ...existing,
        ...(req.body.facilityId !== undefined ? { facilityId: req.body.facilityId } : {}),
        ...(req.body.unitId !== undefined ? { unitId: req.body.unitId } : {}),
        ...(req.body.realmId !== undefined ? { realmId: req.body.realmId } : {}),
        ...(req.body.name !== undefined ? { name: req.body.name } : {}),
        ...(req.body.age !== undefined ? { age: req.body.age } : {}),
        ...(req.body.sex !== undefined ? { sex: req.body.sex } : {}),
        ...(req.body.trajectory !== undefined ? { trajectory: req.body.trajectory } : {}),
      });
      return { ok: true, id: req.params.id };
    },
  );
  app.delete<{ Params: { id: string } }>('/admin/settings/patients/:id', async (req, reply) => {
    const ok = await store.deletePatient(req.params.id);
    if (!ok) return reply.code(404).send({ error: 'patient-not-found' });
    return { ok: true, removed: req.params.id };
  });

  // ---- Assessments (catalog) ----
  app.get<{ Querystring: { domain?: string } }>('/admin/settings/assessments', async (req) => ({
    assessments: await store.listAssessments(req.query.domain),
  }));
  app.post<{ Body: { id: string; title: string; loinc?: string; domain: string; itemCount?: number } }>('/admin/settings/assessments', async (req, reply) => {
    const { id, title, loinc, domain, itemCount } = req.body ?? {};
    if (!id || !title || !domain) return reply.code(400).send({ error: 'id, title, domain required' });
    await store.saveAssessment({ id, title, loinc: loinc ?? null, domain, itemCount: itemCount ?? 0 });
    return { ok: true, id };
  });
  app.put<{ Params: { id: string }; Body: { title?: string; loinc?: string; domain?: string; itemCount?: number } }>('/admin/settings/assessments/:id', async (req, reply) => {
    const existing = await store.getAssessment(req.params.id);
    if (!existing) return reply.code(404).send({ error: 'assessment-not-found' });
    await store.saveAssessment({
      ...existing,
      ...(req.body.title !== undefined ? { title: req.body.title } : {}),
      ...(req.body.loinc !== undefined ? { loinc: req.body.loinc } : {}),
      ...(req.body.domain !== undefined ? { domain: req.body.domain } : {}),
      ...(req.body.itemCount !== undefined ? { itemCount: req.body.itemCount } : {}),
    });
    return { ok: true, id: req.params.id };
  });
  app.delete<{ Params: { id: string } }>('/admin/settings/assessments/:id', async (req, reply) => {
    const ok = await store.deleteAssessment(req.params.id);
    if (!ok) return reply.code(404).send({ error: 'assessment-not-found' });
    return { ok: true, removed: req.params.id };
  });

  // ---- Lifecycle stages (catalog) ----
  app.get('/admin/settings/lifecycle', async () => ({ lifecycle: await store.listLifecycleStages() }));
  app.post<{ Body: { id: string; orderNum?: number; label: string; kind: string } }>('/admin/settings/lifecycle', async (req, reply) => {
    const { id, orderNum, label, kind } = req.body ?? {};
    if (!id || !label || !kind) return reply.code(400).send({ error: 'id, label, kind required' });
    await store.saveLifecycleStage({ id, orderNum: orderNum ?? 0, label, kind });
    return { ok: true, id };
  });
  app.put<{ Params: { id: string }; Body: { orderNum?: number; label?: string; kind?: string } }>('/admin/settings/lifecycle/:id', async (req, reply) => {
    const existing = await store.getLifecycleStage(req.params.id);
    if (!existing) return reply.code(404).send({ error: 'lifecycle-not-found' });
    await store.saveLifecycleStage({
      ...existing,
      ...(req.body.orderNum !== undefined ? { orderNum: req.body.orderNum } : {}),
      ...(req.body.label !== undefined ? { label: req.body.label } : {}),
      ...(req.body.kind !== undefined ? { kind: req.body.kind } : {}),
    });
    return { ok: true, id: req.params.id };
  });
  app.delete<{ Params: { id: string } }>('/admin/settings/lifecycle/:id', async (req, reply) => {
    const ok = await store.deleteLifecycleStage(req.params.id);
    if (!ok) return reply.code(404).send({ error: 'lifecycle-not-found' });
    return { ok: true, removed: req.params.id };
  });

  // ---- Nudge templates (catalog) ----
  app.get<{ Querystring: { kind?: string } }>('/admin/settings/nudges', async (req) => ({
    nudges: await store.listNudgeTemplates(req.query.kind),
  }));
  app.post<{ Body: { id?: string; nudgeKind: string; channel: string; description?: string; expectedEffectJson?: string } }>('/admin/settings/nudges', async (req, reply) => {
    const { nudgeKind, channel, description, expectedEffectJson } = req.body ?? {};
    if (!nudgeKind || !channel) return reply.code(400).send({ error: 'nudgeKind, channel required' });
    const id = req.body?.id ?? `nudge:${nudgeKind.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
    await store.saveNudgeTemplate({ id, nudgeKind, channel, description: description ?? null, expectedEffectJson: expectedEffectJson ?? null });
    return { ok: true, id };
  });
  app.put<{ Params: { id: string }; Body: { nudgeKind?: string; channel?: string; description?: string; expectedEffectJson?: string } }>('/admin/settings/nudges/:id', async (req, reply) => {
    const existing = await store.getNudgeTemplate(req.params.id);
    if (!existing) return reply.code(404).send({ error: 'nudge-template-not-found' });
    await store.saveNudgeTemplate({
      ...existing,
      ...(req.body.nudgeKind !== undefined ? { nudgeKind: req.body.nudgeKind } : {}),
      ...(req.body.channel !== undefined ? { channel: req.body.channel } : {}),
      ...(req.body.description !== undefined ? { description: req.body.description } : {}),
      ...(req.body.expectedEffectJson !== undefined ? { expectedEffectJson: req.body.expectedEffectJson } : {}),
    });
    return { ok: true, id: req.params.id };
  });
  app.delete<{ Params: { id: string } }>('/admin/settings/nudges/:id', async (req, reply) => {
    const ok = await store.deleteNudgeTemplate(req.params.id);
    if (!ok) return reply.code(404).send({ error: 'nudge-template-not-found' });
    return { ok: true, removed: req.params.id };
  });

  // ---- Durable realms (read + delete the snapshot) ----
  app.get('/admin/settings/realms', async () => ({ realms: await store.listRealmSnapshots() }));
  app.delete<{ Params: { id: string } }>('/admin/settings/realms/:id', async (req, reply) => {
    const ok = await store.deleteRealmSnapshot(req.params.id);
    if (!ok) return reply.code(404).send({ error: 'realm-snapshot-not-found' });
    return { ok: true, removed: req.params.id };
  });
}
