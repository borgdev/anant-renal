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

// Small in-process demo dataset shared by every page. In a production build,
// this file is replaced by API-backed loaders — the shape of the data stays
// identical.

import { AccessEvaluator, AuditLedger, PackRegistry } from '../../src/control-plane/index.js';
import { DataQualityEngine, MeasureCatalog, replay } from '../../src/healthcare-core/index.js';
import { OrganizationDirectory, __resetIdCounterForTests } from '../../src/kernel/index.js';
import { healthcareCorePack, dialysisProviderPack, ckdNavigationPack, payerPack, cmsUniversePack } from '../../packs/index.js';
import { dialysisReplayReducer } from '../../packs/dialysis-provider/replay-reducer.js';
import { dialysisMeasures } from '../../packs/dialysis-provider/measures/esrd-qip.js';
import { assessLab, prioritizeQueue } from '../../packs/dialysis-provider/labs/index.js';

export interface DemoData {
  eventCount: number;
  emittedCount: number;
  caseCount: number;
  worstSeverity: string | null;
  auditValid: boolean;
  packs: Array<{ id: string; version: string }>;
  measures: Array<{ id: string; score?: number; numerator?: number; denominator?: number }>;
  cases: Array<{ id: string; patientId: string; facilityId: string; status: string; reason?: string }>;
  labs: ReturnType<typeof prioritizeQueue>;
  audit: Array<{ sequence: number; action: string; actorId: string; hash: string }>;
}

let CACHE: DemoData | null = null;

export function runDemoReplay(): DemoData {
  if (CACHE) return CACHE;
  __resetIdCounterForTests();

  const dir = new OrganizationDirectory();
  dir.registerOrganization({ id: 'org:acme', kind: 'provider', name: 'Acme Dialysis', attributes: {} });
  dir.registerPerson({ id: 'person:c1', organizationId: 'org:acme', displayName: 'Coordinator', roles: ['coordinator'], attributes: {} });
  dir.registerScope({ id: 'scope:root', kind: 'organization', organizationId: 'org:acme', memberIds: ['person:c1'], attributes: {} });

  const registry = new PackRegistry();
  registry.register(healthcareCorePack);
  registry.register(dialysisProviderPack);
  registry.register(ckdNavigationPack);
  registry.register(payerPack);
  registry.register(cmsUniversePack);

  const audit = new AuditLedger();
  const evaluator = new AccessEvaluator(dir, [{ role: 'coordinator', actions: ['read'], resourceTypes: ['dialysis.case'] }], []);
  evaluator; // referenced to keep imports tidy

  const dq = new DataQualityEngine();

  const events = [
    { id: 'e1', type: 'treatment.missed' as const, occurredAt: '2026-08-01T13:00:00Z', scopeId: 'scope:root', subjectId: 'p1', facilityId: 'fac-1', payload: { id: 't1', patientId: 'p1', facilityId: 'fac-1', scheduledAt: '2026-08-01T13:00:00Z', status: 'missed' }, provenance: { sourceId: 'demo', observedAt: '2026-08-01T13:00:00Z', ingestedAt: '2026-08-01T13:00:00Z' }, classification: 'internal' as const },
    { id: 'e2', type: 'treatment.completed' as const, occurredAt: '2026-08-01T13:00:00Z', scopeId: 'scope:root', subjectId: 'p2', facilityId: 'fac-1', payload: { id: 't2', patientId: 'p2', facilityId: 'fac-1', scheduledAt: '2026-08-01T13:00:00Z', status: 'completed', completedAt: '2026-08-01T16:00:00Z', ktvDelivered: 1.4 }, provenance: { sourceId: 'demo', observedAt: '2026-08-01T13:00:00Z', ingestedAt: '2026-08-01T13:00:00Z' }, classification: 'internal' as const },
    { id: 'e3', type: 'transport.issue' as const, occurredAt: '2026-08-03T12:00:00Z', scopeId: 'scope:root', subjectId: 'p3', facilityId: 'fac-1', payload: {}, provenance: { sourceId: 'demo', observedAt: '2026-08-03T12:00:00Z', ingestedAt: '2026-08-03T12:00:00Z' }, classification: 'internal' as const },
    { id: 'e4', type: 'treatment.missed' as const, occurredAt: '2026-08-03T13:00:00Z', scopeId: 'scope:root', subjectId: 'p3', facilityId: 'fac-1', payload: { id: 't3', patientId: 'p3', facilityId: 'fac-1', scheduledAt: '2026-08-03T13:00:00Z', status: 'missed' }, provenance: { sourceId: 'demo', observedAt: '2026-08-03T13:00:00Z', ingestedAt: '2026-08-03T13:00:00Z' }, classification: 'internal' as const },
  ];

  const report = replay({ id: 'batch:demo', events, window: { from: '2026-08-01', to: '2026-08-08' } }, dialysisReplayReducer, dq);

  const catalog = new MeasureCatalog();
  for (const m of dialysisMeasures) catalog.register(m);
  const measures = catalog.evaluateAll({
    treatments: Object.values(report.finalState.treatments),
    labs: [
      { id: 'l1', patientId: 'p2', loinc: '718-7', value: 11, unit: 'g/dL', observedAt: '2026-08-01T00:00:00Z' },
      { id: 'l2', patientId: 'p1', loinc: '2823-3', value: 6.8, unit: 'mmol/L', observedAt: '2026-08-01T00:00:00Z' },
    ],
    facilityId: 'fac-1',
    windowFrom: '2026-08-01',
    windowTo: '2026-08-08',
  });

  audit.append({ id: 'audit:demo:1', occurredAt: '2026-08-01T13:00:00Z', actorId: 'person:c1', scopeId: 'scope:root', action: 'replay.run', traceId: 'trace:demo', payload: { batchId: report.batchId } });
  audit.append({ id: 'audit:demo:2', occurredAt: '2026-08-01T13:00:00Z', actorId: 'person:c1', scopeId: 'scope:root', action: 'case.opened', traceId: 'trace:demo', payload: { count: Object.keys(report.finalState.cases).length } });

  const labs = prioritizeQueue([
    assessLab({ id: 'l1', patientId: 'p2', loinc: '718-7', value: 11, unit: 'g/dL', observedAt: '2026-08-01T00:00:00Z' }),
    assessLab({ id: 'l2', patientId: 'p1', loinc: '2823-3', value: 6.8, unit: 'mmol/L', observedAt: '2026-08-01T00:00:00Z' }),
    assessLab({ id: 'l3', patientId: 'p3', loinc: '2777-1', value: 8.5, unit: 'mg/dL', observedAt: '2026-08-01T00:00:00Z' }),
  ]);

  // P2 — ESA anemia supplement on the shared DemoData shape: an "Hb in target
  // band" measure row + a Class-C ESA dose case from the synthetic ESA cohort.
  // (API-backed loaders will replace these rows in production; the shape stays
  // identical, so the measures/cases pages render them with no changes.)
  const ESA_MEASURE_ID = 'esrd-qip.anemia-management';
  const baseMeasures = measures.map((m) => ({ id: m.id, score: m.result.score, numerator: m.result.numerator, denominator: m.result.denominator }));
  const measureRows = baseMeasures.some((m) => m.id === ESA_MEASURE_ID)
    ? baseMeasures
    : [...baseMeasures, { id: ESA_MEASURE_ID, score: 88, numerator: 7, denominator: 8 }];
  const baseCases = Object.values(report.finalState.cases).map((c) => ({ id: c.id, patientId: c.patientId, facilityId: c.facilityId, status: c.status, reason: c.reason }));
  const esaCase = { id: 'case:esa-1', patientId: 'p-esa-1', facilityId: 'fac-1', status: 'verifying', reason: 'Hb 9.4 below the 10–12 g/dL target — Class C ESA dose review (synthetic ESA cohort)' };
  const caseRows = baseCases.some((c) => c.id === esaCase.id) ? baseCases : [...baseCases, esaCase];

  CACHE = {
    eventCount: report.eventCount,
    emittedCount: report.emittedCount,
    caseCount: Object.keys(report.finalState.cases).length,
    worstSeverity: report.worstSeverity,
    auditValid: audit.verify() === null,
    packs: registry.all().map((p) => ({ id: p.id, version: p.version })),
    measures: measureRows,
    cases: caseRows,
    labs,
    audit: audit.all().map((a) => ({ sequence: a.sequence, action: a.action, actorId: a.actorId, hash: a.hash })),
  };
  return CACHE;
}
