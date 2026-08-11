import { describe, expect, it } from 'vitest';
import { createMissedTreatmentCase, advance, nextOperationalAction } from '../packs/dialysis-provider/missed-treatment/state-machine.js';
import { treatmentRules } from '../packs/dialysis-provider/data-quality.js';
import { DataQualityEngine, replay } from '../src/healthcare-core/index.js';
import type { CanonicalEvent } from '../src/healthcare-core/events.js';
import { dialysisReplayReducer } from '../packs/dialysis-provider/replay-reducer.js';
import { ktvAdequacyMeasure, missedTreatmentRatioMeasure, anemiaManagementMeasure } from '../packs/dialysis-provider/measures/esrd-qip.js';
import { assessLab, prioritizeQueue } from '../packs/dialysis-provider/labs/index.js';
import { detectConflicts, proposeRecoverySlot } from '../packs/dialysis-provider/scheduling/index.js';
import { assessAccess } from '../packs/dialysis-provider/vascular-access/index.js';

describe('missed-treatment state machine', () => {
  it('opens a case for a missed treatment with reason', () => {
    const c = createMissedTreatmentCase({
      treatment: { id: 't1', patientId: 'p1', facilityId: 'f1', scheduledAt: '2026-08-01T13:00:00Z', status: 'missed' },
      hospitalizationConfirmed: false,
      transportIssue: true,
      unresolvedContact: false,
      now: '2026-08-01T14:00:00Z',
    });
    expect(c?.reason).toBe('transport');
    expect(c?.status).toBe('verifying');
    expect(nextOperationalAction(c!)).toBe('verify-source-data');
  });

  it('rejects illegal transitions', () => {
    const c = createMissedTreatmentCase({
      treatment: { id: 't1', patientId: 'p1', facilityId: 'f1', scheduledAt: '2026-08-01T13:00:00Z', status: 'missed' },
      hospitalizationConfirmed: false,
      transportIssue: false,
      unresolvedContact: true,
      now: '2026-08-01T14:00:00Z',
    })!;
    expect(() => advance(c, 'resolved', '2026-08-01T15:00:00Z')).toThrow();
  });
});

describe('DQ rules', () => {
  it('flags missed treatment with completion timestamp', () => {
    const findings = treatmentRules.flatMap((r) => r.evaluate({ id: 't1', patientId: 'p1', facilityId: 'f1', scheduledAt: '2026-08-01T13:00:00Z', completedAt: '2026-08-01T13:00:00Z', status: 'missed' }));
    expect(findings.some((f) => f.ruleId === 'dialysis.missed-treatment-conflict')).toBe(true);
  });
});

describe('replay + measures', () => {
  it('opens a missed-treatment case during replay and computes measures', () => {
    const dq = new DataQualityEngine();
    const events: CanonicalEvent[] = [
      { id: 'e1', type: 'treatment.missed', occurredAt: '2026-08-01T13:00:00Z', scopeId: 's', subjectId: 'p1', facilityId: 'f1', payload: { id: 't1', patientId: 'p1', facilityId: 'f1', scheduledAt: '2026-08-01T13:00:00Z', status: 'missed' }, provenance: { sourceId: 's', observedAt: '2026-08-01T13:00:00Z', ingestedAt: '2026-08-01T13:00:00Z' }, classification: 'internal' },
      { id: 'e2', type: 'treatment.completed', occurredAt: '2026-08-01T13:00:00Z', scopeId: 's', subjectId: 'p2', facilityId: 'f1', payload: { id: 't2', patientId: 'p2', facilityId: 'f1', scheduledAt: '2026-08-01T13:00:00Z', status: 'completed', completedAt: '2026-08-01T16:00:00Z', ktvDelivered: 1.4 }, provenance: { sourceId: 's', observedAt: '2026-08-01T13:00:00Z', ingestedAt: '2026-08-01T13:00:00Z' }, classification: 'internal' },
    ];
    const report = replay({ id: 'b', events, window: { from: '2026-08-01', to: '2026-08-02' } }, dialysisReplayReducer, dq);
    expect(Object.keys(report.finalState.cases)).toHaveLength(1);
    expect(report.emittedCount).toBeGreaterThan(0);

    const dataset = { treatments: Object.values(report.finalState.treatments), labs: [{ id: 'l1', patientId: 'p2', loinc: '718-7', value: 11, unit: 'g/dL', observedAt: '2026-08-01T13:00:00Z' }], facilityId: 'f1', windowFrom: '2026-08-01', windowTo: '2026-08-02' };
    expect(ktvAdequacyMeasure.evaluate(dataset).numerator).toBe(1);
    expect(missedTreatmentRatioMeasure.evaluate(dataset).numerator).toBe(1);
    expect(anemiaManagementMeasure.evaluate(dataset).numerator).toBe(1);
  });
});

describe('labs', () => {
  it('prioritizes critical over routine', () => {
    const items = [
      assessLab({ id: 'l1', patientId: 'p1', loinc: '2823-3', value: 6.8, unit: 'mmol/L', observedAt: '2026-08-01T00:00:00Z' }),
      assessLab({ id: 'l2', patientId: 'p1', loinc: '718-7', value: 11, unit: 'g/dL', observedAt: '2026-08-01T00:00:00Z' }),
    ];
    const q = prioritizeQueue(items);
    expect(q[0]?.significance).toBe('critical');
  });
});

describe('scheduling', () => {
  it('detects double-booked chairs and proposes recovery slot', () => {
    const conflicts = detectConflicts(
      [
        { id: 't1', patientId: 'p1', facilityId: 'f1', scheduledAt: '2026-08-01T13:00:00Z', chairId: 'c1', status: 'scheduled' },
        { id: 't2', patientId: 'p2', facilityId: 'f1', scheduledAt: '2026-08-01T13:00:00Z', chairId: 'c1', status: 'scheduled' },
      ],
      [{ id: 'c1', facilityId: 'f1', status: 'available' }],
      [],
    );
    expect(conflicts.some((c) => c.reason === 'chair-double-booked')).toBe(true);

    const proposal = proposeRecoverySlot({
      patientId: 'p1',
      facilityId: 'f1',
      mustScheduleBefore: '2026-08-02T00:00:00Z',
      shifts: [{ id: 'sh1', facilityId: 'f1', startsAtIso: '2026-08-01T17:00:00Z', endsAtIso: '2026-08-01T21:00:00Z', chairIds: ['c1', 'c2'] }],
      existingSessions: [{ id: 't1', patientId: 'p2', facilityId: 'f1', scheduledAt: '2026-08-01T17:00:00Z', chairId: 'c1', shiftId: 'sh1', status: 'scheduled' }],
      chairs: [{ id: 'c1', facilityId: 'f1', status: 'available' }, { id: 'c2', facilityId: 'f1', status: 'available' }],
    });
    expect(proposal?.chairId).toBe('c2');
  });
});

describe('vascular access', () => {
  it('raises low-flow surveillance', () => {
    const s = assessAccess({ id: 'a1', patientId: 'p1', kind: 'avf', placedAt: '2026-01-01', status: 'monitoring', lastFlowMlPerMin: 500 });
    expect(s?.kind).toBe('low-flow');
  });
});
