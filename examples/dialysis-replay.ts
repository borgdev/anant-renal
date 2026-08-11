// End-to-end dialysis replay: ingest CSV rows -> canonical events -> DQ gate
// -> replay -> quality measures -> QAPI case -> audit ledger. Runs with
// `npm run demo:replay`.

import { OrganizationDirectory, TemporalHypergraphStore, __resetIdCounterForTests } from '../src/kernel/index.js';
import { AccessEvaluator, AuditLedger, PackRegistry } from '../src/control-plane/index.js';
import { DataQualityEngine, MeasureCatalog, replay } from '../src/healthcare-core/index.js';
import { parseCsv, mapCsvRow } from '../src/adapters/csv.js';
import { healthcareCorePack, dialysisProviderPack, ckdNavigationPack, payerPack, cmsUniversePack } from '../packs/index.js';
import { dialysisReplayReducer } from '../packs/dialysis-provider/replay-reducer.js';
import { dialysisMeasures } from '../packs/dialysis-provider/measures/esrd-qip.js';

__resetIdCounterForTests();

const now = () => new Date().toISOString();

// 1. Directory + registry
const dir = new OrganizationDirectory();
dir.registerOrganization({ id: 'org:acme-dialysis', kind: 'provider', name: 'Acme Dialysis', attributes: {} });
dir.registerPerson({ id: 'person:coordinator-1', organizationId: 'org:acme-dialysis', displayName: 'Coordinator 1', roles: ['coordinator'], attributes: {} });
dir.registerScope({ id: 'scope:facility-1', kind: 'facility', organizationId: 'org:acme-dialysis', memberIds: ['person:coordinator-1'], attributes: {} });

const registry = new PackRegistry();
registry.register(healthcareCorePack);
registry.register(dialysisProviderPack);
registry.register(ckdNavigationPack);
registry.register(payerPack);
registry.register(cmsUniversePack);

// 2. Audit + access
const audit = new AuditLedger();
const access = new AccessEvaluator(
  dir,
  [
    { role: 'coordinator', actions: ['read', 'execute'], resourceTypes: ['dialysis.case', 'dialysis.treatment'] },
  ],
  [],
);

// 3. Ingest CSV
const csv = `treatment_id,patient_id,facility_id,scheduled_at,status
t-1,p-1,fac-1,2026-08-01T13:00:00Z,missed
t-2,p-2,fac-1,2026-08-01T13:00:00Z,completed
t-3,p-1,fac-1,2026-08-03T13:00:00Z,missed
t-4,p-3,fac-1,2026-08-03T13:00:00Z,completed`;

const rows = parseCsv(csv);
const events = rows.map((r, i) => mapCsvRow(r, {
  eventType: r.status === 'missed' ? 'treatment.missed' : 'treatment.completed',
  subjectIdColumn: 'patient_id',
  occurredAtColumn: 'scheduled_at',
  facilityId: 'fac-1',
  scopeId: 'scope:facility-1',
  sourceId: 'demo-csv',
  ingestedAt: now(),
  payloadColumns: ['treatment_id', 'facility_id', 'status'],
  classification: 'internal',
}, i)).filter((e): e is NonNullable<typeof e> => e !== null)
  .map((e) => ({
    ...e,
    payload: {
      id: e.payload['treatment_id'],
      patientId: e.subjectId,
      facilityId: e.facilityId,
      scheduledAt: e.occurredAt,
      status: e.payload['status'],
    },
  }));

// 4. Replay
const dq = new DataQualityEngine();
const report = replay({ id: 'batch:demo', events, window: { from: '2026-08-01', to: '2026-08-08' } }, dialysisReplayReducer, dq);

// 5. Measures
const catalog = new MeasureCatalog();
for (const m of dialysisMeasures) catalog.register(m);
const measureResults = catalog.evaluateAll({
  treatments: Object.values(report.finalState.treatments),
  labs: [],
  facilityId: 'fac-1',
  windowFrom: '2026-08-01',
  windowTo: '2026-08-08',
});

// 6. Audit + summary
audit.append({ id: 'audit:demo:replay', occurredAt: now(), actorId: 'person:coordinator-1', scopeId: 'scope:facility-1', action: 'replay.run', traceId: 'trace:demo', payload: { batchId: report.batchId, eventCount: report.eventCount, emittedCount: report.emittedCount } });

const store = new TemporalHypergraphStore();
console.log('replay report', {
  events: report.eventCount,
  emitted: report.emittedCount,
  cases: Object.keys(report.finalState.cases).length,
});
console.log('measures', measureResults.map((r) => ({ id: r.id, score: r.result.score })));
console.log('audit verified:', audit.verify() === null);
console.log('hypergraph seed:', store.snapshot().id);
console.log('access probe:', access.evaluate({
  subject: { id: 'person:coordinator-1', organizationId: 'org:acme-dialysis', roles: ['coordinator'], attributes: {} },
  resource: { id: 'case:t-1', type: 'dialysis.case', scopeId: 'scope:facility-1', scopeKind: 'facility', ownerOrganizationId: 'org:acme-dialysis', classification: 'internal', attributes: {} },
  action: 'read',
  environment: { purposeOfUse: 'operations', managedDevice: true, sessionAgeMinutes: 5, mfaAgeMinutes: 5, now: now() },
}).decision);
