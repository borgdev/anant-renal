/******************************************************************************
 * Adoption metrics (Phase 3.6) — tests.
 *
 * Two properties matter more than the arithmetic:
 *   1. A metric that cannot be computed from stored data is reported as
 *      unavailable WITH its reason. A fabricated latency is worse than a gap,
 *      because it looks like the most authoritative number on the panel.
 *   2. A "cluster" needs evidence: a reason repeated by one person is one
 *      opinion, and promoting it to a finding would turn a single click into a
 *      fleet-wide tuning recommendation.
 ******************************************************************************/

import { describe, it, expect } from 'vitest';
import {
  ADOPTION_SAMPLE_FLOOR,
  analyseRankedAdoption,
  clusterDismissalReasons,
  reasonSignature,
} from '../src/swarm/adoption.js';
import type { NbaDecision } from '../src/swarm/workspace.js';

const dec = (over: Partial<NbaDecision>): NbaDecision => ({
  id: `nba-dec-${Math.round(Math.random() * 1e9).toString(16)}`,
  createdAt: '2026-09-12T09:00:00.000Z',
  updatedAt: '2026-09-12T09:00:00.000Z',
  nbaId: 'nba:1',
  title: 't',
  subject: 'patient:p-1',
  scopeType: 'patient',
  decision: 'approved',
  approver: 'md',
  evidenceCount: 1,
  expectedOutcome: 1,
  ...over,
});

describe('reason clustering folds wording, never meaning', () => {
  it('word order and punctuation do not create two clusters', () => {
    expect(reasonSignature('Iron panel missing')).toBe(reasonSignature('missing iron panel!'));
    expect(reasonSignature('The iron, panel is missing.')).toBe('iron missing panel');
  });

  it('different meanings stay apart', () => {
    expect(reasonSignature('iron panel missing')).not.toBe(reasonSignature('patient already transfused'));
  });

  it('a reason with no content words has no signature', () => {
    expect(reasonSignature('   —  ')).toBe('');
    expect(reasonSignature('and the to')).toBe('');
  });

  it('keeps every wording that fed a cluster, so nothing is hidden by the fold', () => {
    const clusters = clusterDismissalReasons([
      dec({ decision: 'dismissed', reason: 'iron panel missing' }),
      dec({ decision: 'dismissed', reason: 'Missing iron panel' }),
      dec({ decision: 'dismissed', reason: 'iron panel missing' }),
      dec({ decision: 'approved' }),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.count).toBe(3);
    expect(clusters[0]!.variants).toHaveLength(2);
    // The displayed wording is the one clinicians actually used most.
    expect(clusters[0]!.reason).toBe('iron panel missing');
  });

  it('a dismissal with no usable reason is not counted as a reason', () => {
    expect(clusterDismissalReasons([dec({ decision: 'dismissed' }), dec({ decision: 'dismissed', reason: '  ' })])).toEqual([]);
  });
});

describe('adoption reading — coverage is of TODAY’S ranking, not of history', () => {
  it('separates verdicts recorded from coverage of the published set', () => {
    const decisions = [
      dec({ nbaId: 'nba:stale', decision: 'approved' }),
      dec({ nbaId: 'nba:live-1', decision: 'approved' }),
    ];
    const report = analyseRankedAdoption([{ nbaId: 'nba:live-1' }, { nbaId: 'nba:live-2' }], decisions);
    expect(report.ranked).toBe(2);
    expect(report.decided).toBe(2);
    // Only one of the two PUBLISHED actions has a verdict; the other verdict is
    // history about an action the fleet no longer suggests.
    expect(report.decidedOfRanked).toBe(1);
    expect(report.coveragePct).toBe(50);
  });

  it('reports a ranking nobody answered as a finding about surfacing', () => {
    const report = analyseRankedAdoption([{ nbaId: 'a' }, { nbaId: 'b' }], []);
    expect(report.coveragePct).toBe(0);
    expect(report.reading[0]).toMatch(/not being used/);
  });

  it('an empty ranking yields null coverage rather than 0%', () => {
    const report = analyseRankedAdoption([], []);
    expect(report.coveragePct).toBeNull();
    expect(report.approvalPct).toBeNull();
    expect(report.reading[0]).toMatch(/nothing either way/i);
  });
});

describe('adoption reading — a cluster needs evidence', () => {
  it('will not call one repeated reason a finding without the sample floor', () => {
    // Two dismissals, both the same reason: 100% concentration — but only 2
    // decisions, so it is an observation with its size stated.
    const decisions = [
      dec({ nbaId: 'n1', decision: 'dismissed', reason: 'iron panel missing' }),
      dec({ nbaId: 'n2', decision: 'dismissed', reason: 'iron panel missing' }),
    ];
    const report = analyseRankedAdoption([{ nbaId: 'n1' }, { nbaId: 'n2' }], decisions);
    expect(report.concentrated).toBe(true); // the dismissals agree…
    expect(report.clustered).toBe(false);   // …but there is not enough of a record to act
    expect(report.reading.some((r) => r.includes(`${ADOPTION_SAMPLE_FLOOR}-decision floor`))).toBe(true);
  });

  it('promotes a dominant reason once the sample supports it', () => {
    const decisions = Array.from({ length: ADOPTION_SAMPLE_FLOOR }, (_, i) =>
      dec({ nbaId: `n${i}`, decision: 'dismissed', reason: 'iron panel missing' }),
    );
    const report = analyseRankedAdoption(decisions.map((d) => ({ nbaId: d.nbaId })), decisions);
    expect(report.concentrated).toBe(true);
    expect(report.clustered).toBe(true);
    expect(report.reading.some((r) => r.startsWith('Dismissals concentrate'))).toBe(true);
  });

  it('does not promote a single dismissal to a recommendation', () => {
    const decisions = [dec({ nbaId: 'n1', decision: 'dismissed', reason: 'iron panel missing' })];
    const report = analyseRankedAdoption([{ nbaId: 'n1' }], decisions);
    expect(report.concentrated).toBe(false); // one refusal is one opinion
    expect(report.clustered).toBe(false);
    expect(report.reading.some((r) => r.startsWith('Dismissals concentrate'))).toBe(false);
  });

  it('reports a dominant reason in the criterion’s terms, not the clinician’s', () => {
    const decisions = Array.from({ length: 6 }, (_, i) =>
      dec({ nbaId: `n${i}`, decision: 'dismissed', reason: 'criterion too broad for this unit' }),
    );
    const report = analyseRankedAdoption(decisions.map((d) => ({ nbaId: d.nbaId })), decisions);
    expect(report.clustered).toBe(true);
    expect(report.reading.some((r) => r.includes('signal about the criterion, not about the clinician'))).toBe(true);
  });
});

describe('adoption reading — the unmeasurable is stated, not estimated', () => {
  it('reports time-to-decision as unavailable with the reason', () => {
    const report = analyseRankedAdoption([{ nbaId: 'a' }], [dec({ nbaId: 'a' })]);
    expect(report.timeToDecision.available).toBe(false);
    expect(report.timeToDecision.reason).toMatch(/not computable/);
    // …and there is no numeric field anywhere that a console could mistake for it.
    expect(Object.keys(report)).not.toContain('timeToDecisionMinutes');
    expect(Object.keys(report)).not.toContain('medianTimeToDecision');
  });

  it('counts deferrals and handoffs as work moved, not as refusals', () => {
    const decisions = [
      dec({ nbaId: 'n1', decision: 'deferred' }),
      dec({ nbaId: 'n2', decision: 'handed-off' }),
      dec({ nbaId: 'n3', decision: 'dismissed', reason: 'duplicate of an open order' }),
      dec({ nbaId: 'n4', decision: 'approved' }),
    ];
    const report = analyseRankedAdoption(decisions.map((d) => ({ nbaId: d.nbaId })), decisions);
    expect(report.verdicts).toEqual({ approved: 1, dismissed: 1, deferred: 1, 'handed-off': 1 });
    expect(report.approvalPct).toBe(25);
    expect(report.deferralPct).toBe(25);
    expect(report.handoffPct).toBe(25);
    expect(report.reading.some((r) => r.includes('moving between people'))).toBe(true);
  });

  it('never counts a deferral or a handoff as a dismissal', () => {
    const decisions = [dec({ nbaId: 'n1', decision: 'deferred' }), dec({ nbaId: 'n2', decision: 'handed-off' })];
    const report = analyseRankedAdoption(decisions.map((d) => ({ nbaId: d.nbaId })), decisions);
    expect(report.verdicts.dismissed).toBe(0);
    expect(report.dismissalPct).toBe(0);
    expect(report.dismissalClusters).toEqual([]);
  });
});
