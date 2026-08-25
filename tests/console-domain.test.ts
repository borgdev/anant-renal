/******************************************************************************
 * AnantHealth — console-domain routes
 *
 * Verifies the backend-sourced console domain catalog (/admin/console/domain)
 * and Learn recipes (/admin/console/learn) that drive the operator console's
 * option lists and default payloads (no hardcoded domain config in the UI).
 ******************************************************************************/

import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import type { PostgresEventStore } from '../src/server/postgres-event-store.js';
import type { CanonicalEvent } from '../src/healthcare-core/events.js';
import type { LedgerEntry } from '../src/hypergraph/ledger.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import type { ActorContext } from '../src/server/scoped-persistence.js';
import { DEFAULT_MEASURE_ID } from '../src/server/console-domain.js';

function inMemoryStore(): PostgresEventStore {
  const events: CanonicalEvent[] = [];
  const ledger: LedgerEntry[] = [];
  const audit: unknown[] = [];
  const store = {
    async applyMigrations() { /* noop */ },
    async appendEvent(_scope: { scopeId: string; actorRef: string }, ev: CanonicalEvent) { events.push(ev); },
    async queryEvents() { return events; },
    async appendLedger(_scopeId: string, entry: LedgerEntry) { ledger.push(entry); },
    async queryLedger() { return ledger; },
    async appendAudit(row: unknown) { audit.push(row); },
    async withTransaction<T>(fn: (client: unknown) => Promise<T>) { return fn({}); },
  } as unknown as PostgresEventStore;
  return store;
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

describe('Console domain API', () => {
  it('GET /admin/console/domain serves the full console catalog', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/admin/console/domain' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { domain: any };
    const d = body.domain;
    expect(d.effectKinds).toContain('record-vitals');
    expect(d.effectKinds).toContain('record-agent-thought');
    expect(d.effectTemplates['result-lab']).toMatchObject({ code: '17861-6', value: 4.2, unit: 'mg/dL', abnormal: 'H' });
    // Staff packs power the world-builder wizard (checkbox id → agent spec).
    expect(d.staffPacks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'wb-md', agentSpecId: 'md', checked: true }),
      expect.objectContaining({ id: 'wb-safety', agentSpecId: 'safety', checked: false }),
    ]));
    // What-If presets carry the JSON effects rendered into the dropdown.
    expect(d.whatIfPresets[0]).toMatchObject({ label: 'Adjust prescription' });
    expect(d.whatIfPresets[0].effects).toEqual([['ktv_adequacy', 0.25], ['phosphate', -0.15]]);
    // Counterfactual + nudge composer defaults.
    expect(d.counterfactualDefault).toMatchObject({ facilityId: 'cf-fac', units: 'ICH-A,ICH-B', patientCount: 12, advanceTicks: 48 });
    expect(d.counterfactualDefault.interventions).toEqual([{ kind: 'event-effect', effect: { diet_phosphate_violation: -0.2 } }]);
    expect(d.nudgeDefault.channels).toEqual(['in-app', 'sms', 'email', 'calendar', 'fhir']);
    expect(d.nudgeDefault.expectedEffect).toEqual({ diet_phosphate_violation: -0.2 });
    // Domain option vocabularies used across Settings / Enterprise.
    expect(d.domainOptions.trajectories).toContain('hyperphosphatemia');
    expect(d.domainOptions.lifecycleKinds).toEqual(expect.arrayContaining([
      { value: 'clinical', label: 'Clinical' },
      { value: 'research', label: 'Research' },
    ]));
    expect(d.domainOptions.facilityKinds).toEqual(expect.arrayContaining([
      { value: 'dialysis', label: 'Dialysis' },
      { value: 'hospital', label: 'Hospital' },
    ]));
    expect(d.domainOptions.retentionEntities).toContain('audit_events');
    expect(d.domainOptions.retentionEntities).toContain('alert_events');
    expect(d.domainOptions.defaultMeasureId).toBe(DEFAULT_MEASURE_ID);
    expect(d.domainOptions.demoLabs).toEqual({ k: 4.2, hgb: 11.5, urr: 68, phos: 5.1 });
  });

  it('GET /admin/console/learn serves the Learn recipes', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/admin/console/learn' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { recipes: any[] };
    expect(body.recipes).toHaveLength(5);
    expect(body.recipes.map((r) => r.id)).toEqual(['sync-vsac', 'sync-kdigo', 'trace-measure', 'ingest-local', 'run-agent']);
    for (const r of body.recipes) {
      expect(r.title).toBeTruthy();
      expect(r.body).toBeTruthy();
      expect(r.action).toMatchObject({ label: expect.any(String), view: expect.any(String) });
    }
  });
});
