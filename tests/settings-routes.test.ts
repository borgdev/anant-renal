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

// Settings admin — master-data CRUD (facilities, units, patients) over HTTP.
// NODE_ENV=test routes getSqlStore() to in-memory SQLite, so this exercises the
// same SqlStore → SqlDb seam production uses.

import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import type { PostgresEventStore } from '../src/server/postgres-event-store.js';
import type { CanonicalEvent } from '../src/healthcare-core/events.js';
import type { LedgerEntry } from '../src/hypergraph/ledger.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import type { ActorContext } from '../src/server/scoped-persistence.js';

function inMemoryStore(): PostgresEventStore {
  const events: CanonicalEvent[] = [];
  const ledger: LedgerEntry[] = [];
  const audit: unknown[] = [];
  return {
    async applyMigrations() { /* noop */ },
    async appendEvent(_scope: { scopeId: string; actorRef: string }, ev: CanonicalEvent) { events.push(ev); },
    async queryEvents() { return events; },
    async appendLedger(_scopeId: string, entry: LedgerEntry) { ledger.push(entry); },
    async queryLedger() { return ledger; },
    async appendAudit(row: unknown) { audit.push(row); },
    async withTransaction<T>(fn: (client: unknown) => Promise<T>) { return fn({}); },
  } as unknown as PostgresEventStore;
}

const actor: ActorContext = { actorRef: 'user:ops-1', scopeIds: ['scope:facility-1'], purposeOfUse: 'operations', clearance: 'internal' };

async function makeApp() {
  return buildApp({
    store: inMemoryStore(),
    telemetry: new Telemetry('test', new InMemorySink()),
    packs: [healthcareCorePack],
    authenticate: async () => actor,
    checkHealth: async () => ({ db: true, redis: true }),
  });
}

describe('Settings admin — master data', () => {
  it('CRUD facilities', async () => {
    const app = await makeApp();
    let res = await app.inject({ method: 'POST', url: '/admin/settings/facilities', payload: { id: 'fac-1', realmId: 'realm:r', name: 'Northside', kind: 'dialysis' } });
    expect(res.statusCode).toBe(200);

    res = await app.inject({ method: 'GET', url: '/admin/settings/facilities' });
    let list = (res.json() as { facilities: Array<{ id: string; name: string; realmId: string; kind: string }> }).facilities;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'fac-1', name: 'Northside', realmId: 'realm:r', kind: 'dialysis' });

    res = await app.inject({ method: 'PUT', url: '/admin/settings/facilities/fac-1', payload: { name: 'Northside II' } });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: 'GET', url: '/admin/settings/facilities' });
    expect((res.json() as { facilities: Array<{ name: string }> }).facilities[0]!.name).toBe('Northside II');

    res = await app.inject({ method: 'DELETE', url: '/admin/settings/facilities/fac-1' });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: 'GET', url: '/admin/settings/facilities' });
    expect((res.json() as { facilities: unknown[] }).facilities).toHaveLength(0);
    await app.close();
  });

  it('CRUD units + patients and validate required fields', async () => {
    const app = await makeApp();
    await app.inject({ method: 'POST', url: '/admin/settings/facilities', payload: { id: 'fac-1', realmId: 'realm:r', name: 'N' } });
    await app.inject({ method: 'POST', url: '/admin/settings/units', payload: { id: 'fac-1-U1', facilityId: 'fac-1', realmId: 'realm:r', code: 'U1' } });
    let res = await app.inject({ method: 'GET', url: '/admin/settings/units?facilityId=fac-1' });
    expect((res.json() as { units: unknown[] }).units).toHaveLength(1);

    await app.inject({
      method: 'POST', url: '/admin/settings/patients',
      payload: { id: 'p1', facilityId: 'fac-1', unitId: 'fac-1-U1', realmId: 'realm:r', name: 'Jane', age: 45, sex: 'F', trajectory: 'stable' },
    });
    res = await app.inject({ method: 'GET', url: '/admin/settings/patients?facilityId=fac-1' });
    const patients = (res.json() as { patients: Array<{ id: string; trajectory: string; facilityId: string }> }).patients;
    expect(patients).toHaveLength(1);
    expect(patients[0]).toMatchObject({ id: 'p1', trajectory: 'stable', facilityId: 'fac-1' });

    // Missing required field is rejected
    res = await app.inject({ method: 'POST', url: '/admin/settings/patients', payload: { id: 'p2', realmId: 'realm:r' } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'PUT', url: '/admin/settings/patients/p1', payload: { trajectory: 'decompensating' } });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: 'GET', url: '/admin/settings/patients' });
    const after = (res.json() as { patients: Array<{ id: string; trajectory: string }> }).patients.find((p) => p.id === 'p1');
    expect(after?.trajectory).toBe('decompensating');

    res = await app.inject({ method: 'DELETE', url: '/admin/settings/patients/p1' });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: 'GET', url: '/admin/settings/patients' });
    expect((res.json() as { patients: unknown[] }).patients).toHaveLength(0);
    await app.close();
  });

  it('CRUD assessment catalog', async () => {
    const app = await makeApp();
    let res = await app.inject({
      method: 'POST', url: '/admin/settings/assessments',
      payload: { id: 'assess-1', title: 'Dialysis Symptom Index', loinc: '99773-3', domain: 'dialysis', itemCount: 30 },
    });
    expect(res.statusCode).toBe(200);

    res = await app.inject({ method: 'GET', url: '/admin/settings/assessments' });
    let list = (res.json() as { assessments: Array<{ id: string; title: string; loinc: string; domain: string; itemCount: number }> }).assessments;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'assess-1', title: 'Dialysis Symptom Index', loinc: '99773-3', domain: 'dialysis', itemCount: 30 });

    res = await app.inject({ method: 'PUT', url: '/admin/settings/assessments/assess-1', payload: { itemCount: 31 } });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: 'GET', url: '/admin/settings/assessments?domain=dialysis' });
    expect((res.json() as { assessments: Array<{ itemCount: number }> }).assessments[0]!.itemCount).toBe(31);

    // Missing required field rejected
    res = await app.inject({ method: 'POST', url: '/admin/settings/assessments', payload: { id: 'a2', title: 'X' } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'DELETE', url: '/admin/settings/assessments/assess-1' });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: 'GET', url: '/admin/settings/assessments' });
    expect((res.json() as { assessments: unknown[] }).assessments).toHaveLength(0);
    await app.close();
  });

  it('CRUD lifecycle stages + nudge templates', async () => {
    const app = await makeApp();
    let res = await app.inject({ method: 'POST', url: '/admin/settings/lifecycle', payload: { id: 'stage-intake', orderNum: 1, label: 'Intake', kind: 'clinical' } });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: 'GET', url: '/admin/settings/lifecycle' });
    let lifecycle = (res.json() as { lifecycle: Array<{ id: string; orderNum: number; label: string; kind: string }> }).lifecycle;
    expect(lifecycle[0]).toMatchObject({ id: 'stage-intake', orderNum: 1, label: 'Intake', kind: 'clinical' });

    res = await app.inject({ method: 'POST', url: '/admin/settings/nudges', payload: { nudgeKind: 'medication-adherence', channel: 'in-app', description: 'Prompt follow-up', expectedEffectJson: '{"adherence":0.1}' } });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: 'GET', url: '/admin/settings/nudges' });
    let nudges = (res.json() as { nudges: Array<{ id: string; nudgeKind: string; channel: string; expectedEffectJson: string }> }).nudges;
    expect(nudges[0]).toMatchObject({ nudgeKind: 'medication-adherence', channel: 'in-app', expectedEffectJson: '{"adherence":0.1}' });

    // Auto-generated id when omitted
    res = await app.inject({ method: 'POST', url: '/admin/settings/nudges', payload: { nudgeKind: 'phosphate-check', channel: 'sms' } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { id: string }).id).toBe('nudge:phosphate-check');

    // Nudge template id is used to update (the kind may change)
    res = await app.inject({ method: 'PUT', url: '/admin/settings/nudges/nudge:medication-adherence', payload: { channel: 'sms' } });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: 'GET', url: '/admin/settings/nudges?kind=medication-adherence' });
    expect((res.json() as { nudges: Array<{ channel: string }> }).nudges[0]!.channel).toBe('sms');

    res = await app.inject({ method: 'DELETE', url: '/admin/settings/lifecycle/stage-intake' });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: 'DELETE', url: '/admin/settings/nudges/nudge:medication-adherence' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
