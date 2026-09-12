import { describe, expect, it } from 'vitest';
import {
  CONFIRMED_REVIEW_RELIABILITY, DEFAULT_RELIABILITY, REJECTED_REVIEW_RELIABILITY,
  REALM_LEDGER_RELIABILITY, SYNTHETIC_RELIABILITY, reliabilityBySource,
} from '../src/evidence/reliability.js';
import { aggregateSwarmInsights, makeProposal } from '../src/swarm/insight.js';
import {
  attachInsightBelief, plausibilityOfHarm, rankNextBestActions, scoreCandidateBeliefAware, type NbaCandidate,
} from '../src/swarm/nba.js';
import {
  DST_EPISODE_K_GATE, DST_RESOLVE_BELIEF_GATE, OutcomeEpisodeCoordinator, computeDossierHash, evidenceStatusFor, fuseEpisodeEvidence,
} from '../src/swarm/outcome-episode.js';

const NOW = '2026-08-25T00:00:00.000Z';
const prop = (over: Partial<Parameters<typeof makeProposal>[0]> = {}) => makeProposal({
  cellId: 'workforce-resilience', kind: 'coverage.proposal', subject: 'region:x', scopeType: 'region',
  option: 'plan A', recommendation: 'r', allowed: true, evidence: [], producedAt: NOW, payload: {}, ...over,
});

function driveToVerifying(c: OutcomeEpisodeCoordinator, id: string): void {
  c.addEvidence(id, [{ sourceId: 'realm-ledger:r1', contentType: 'fact' }], true);
  c.propose(id, prop({ cellId: 'treatment-continuity' }), true);
  c.requestApproval(id, 'B');
  c.decide(id, 'approved', 'AR', 'B');
  c.dispatchCommand(id, 'schedule-followup');
  c.acknowledge(id, 'facility');
}

describe('P3 — reliability discounting', () => {
  it('maps review status and source markers to reliability α', () => {
    expect(reliabilityBySource('x', 'rejected')).toBe(REJECTED_REVIEW_RELIABILITY); // 0.2
    expect(reliabilityBySource('x', 'confirmed')).toBe(CONFIRMED_REVIEW_RELIABILITY); // 0.98
    expect(reliabilityBySource('realm-ledger:r1')).toBe(REALM_LEDGER_RELIABILITY); // 0.95
    expect(reliabilityBySource('realm:b3:ev')).toBe(REALM_LEDGER_RELIABILITY);
    expect(reliabilityBySource('sim:renal-a:ev')).toBe(SYNTHETIC_RELIABILITY); // 0.3
    expect(reliabilityBySource('reference:coverage')).toBe(SYNTHETIC_RELIABILITY);
    expect(reliabilityBySource('staffing.coverage.changed.v1')).toBe(DEFAULT_RELIABILITY); // 0.7
  });

  it('discounts cell evidence: low reliability ⇒ lower belief + avgReliability reported', () => {
    const proposals = [
      prop({ evidence: [{ sourceId: 's1', contentType: 'fact' }, { sourceId: 's2', contentType: 'fact' }] }),
      prop({ cellId: 'facility-capacity', evidence: [{ sourceId: 's3', contentType: 'fact' }, { sourceId: 's4', contentType: 'fact' }] }),
    ];
    const weak = aggregateSwarmInsights({ proposals, consumedBy: {}, mode: 'dst', getReliability: () => 0.3 });
    const strong = aggregateSwarmInsights({ proposals, consumedBy: {}, mode: 'dst', getReliability: () => 0.95 });
    const a = weak.find((i) => i.kind === 'coverage.proposal')!;
    const b = strong.find((i) => i.kind === 'coverage.proposal')!;
    expect(a.avgReliability).toBe(0.3);
    expect(b.avgReliability).toBe(0.95);
    expect(a.belief!).toBeLessThan(b.belief!); // discounting reduces commitment
    expect(a.belief!).toBeGreaterThan(0);
    expect(b.belief!).toBeLessThanOrEqual(1);
  });

  it('a rejected evidence review demotes the source toward ignorance', () => {
    const proposals = [prop({ evidence: [{ sourceId: 'e1', contentType: 'fact' }] }), prop({ cellId: 'facility-capacity', evidence: [{ sourceId: 'e2', contentType: 'fact' }] })];
    const rejected = aggregateSwarmInsights({ proposals, consumedBy: {}, mode: 'dst', reviews: { e1: 'rejected' } });
    const clean = aggregateSwarmInsights({ proposals, consumedBy: {}, mode: 'dst' });
    const r = rejected.find((i) => i.kind === 'coverage.proposal')!;
    const c2 = clean.find((i) => i.kind === 'coverage.proposal')!;
    expect(r.avgReliability!).toBeLessThan(c2.avgReliability!);
    expect(r.belief!).toBeLessThan(c2.belief!);
  });
});

describe('P2 — belief-aware NBA ranking', () => {
  const base: NbaCandidate = {
    title: 'Protect treatments', cells: ['treatment-continuity'], scopeType: 'region', subject: 'region:x', owner: 'ROD',
    due: 'Today', evidence: [], action: { kind: 'schedule-followup' }, valueUnit: 'treatments',
    consensus: 0.9, approvalClass: 'B', expectedOutcome: 40, urgency: 0.8,
    policyCost: 0.3, risk: 0.2,
  };

  it('ranks high-belief low-uncertainty actions above wide-interval ones (legacy tie → distinct)', () => {
    const wide = { ...base, title: 'Wide interval', belief: 0.6, plausibility: 0.95 }; // unc 0.35
    const tight = { ...base, title: 'Tight interval', belief: 0.9, plausibility: 0.9 }; // unc 0
    const legacy = rankNextBestActions([wide, tight]);
    // Legacy mode is a tie (same consensus/features) → alphabetical.
    expect(legacy[0]!.title).toBe('Tight interval');
    const aware = rankNextBestActions([wide, tight], { beliefAware: true });
    expect(aware[0]!.title).toBe('Tight interval');
    expect(scoreCandidateBeliefAware(tight, {}, 0.3, 0.5)).toBeGreaterThan(scoreCandidateBeliefAware(wide, {}, 0.3, 0.5));
    expect(plausibilityOfHarm(wide)).toBeCloseTo(0.375, 3); // 0.2 risk + 0.5·0.35
  });

  it('requires approval on worst-case harm even when policy cost is low', () => {
    const risky = { ...base, belief: 0.3, plausibility: 1, risk: 0.5 }; // unc 0.7 → plHarm 0.85
    const aware = rankNextBestActions([risky], { beliefAware: true });
    expect(aware[0]!.status).toBe('awaiting-approval');
    const legacy = rankNextBestActions([risky]);
    expect(legacy[0]!.status).toBe('proposed'); // policyCost 0.3 < 0.75
  });

  it('attachInsightBelief pulls the interval from the matching insight', () => {
    const insights = aggregateSwarmInsights({
      proposals: [
        prop({ evidence: [{ sourceId: 's1', contentType: 'fact' }] }),
        prop({ cellId: 'access-surveillance', option: 'plan B', evidence: [{ sourceId: 's2', contentType: 'fact' }] }),
      ],
      consumedBy: {}, mode: 'dst',
    });
    const attached = attachInsightBelief([{ ...base, insightKind: 'coverage.proposal' }], insights);
    expect(typeof attached[0]!.belief).toBe('number');
    expect(typeof attached[0]!.plausibility).toBe('number');
    expect(typeof attached[0]!.conflictMass).toBe('number');
  });
});

describe('P2/P4 — episode evidence fusion + gates', () => {
  it('fuses episode evidence into a belief interval with provenance', () => {
    const fusion = fuseEpisodeEvidence([
      { sourceId: 'realm-ledger:r1', contentType: 'fact' },
      { sourceId: 'realm-ledger:r2', contentType: 'event' },
    ]);
    expect(fusion.sources).toHaveLength(2);
    expect(fusion.sources[0]!.alpha).toBe(REALM_LEDGER_RELIABILITY);
    expect(fusion.belief).toBeGreaterThan(0);
    expect(fusion.plausibility).toBeGreaterThanOrEqual(fusion.belief);
    expect(fusion.uncertainty).toBeCloseTo(fusion.plausibility - fusion.belief, 5);
    expect(Object.keys(fusion.massVector).length).toBeGreaterThan(0);
  });

  it('dstGates escalate an unmet measure instead of resolving it', () => {
    const c = new OutcomeEpisodeCoordinator({ dstGates: true });
    const e = c.open({ kind: 'coverage.proposal', subject: 'region:x', scopeType: 'region' });
    driveToVerifying(c, e.episodeId);
    c.verify(e.episodeId, { measureId: 'm', met: false });
    expect(c.get(e.episodeId)!.state).toBe('Escalated');
  });

  it('flags weak fused evidence on a met measure (still resolves, honestly)', () => {
    const c = new OutcomeEpisodeCoordinator({ dstGates: true });
    const e = c.open({ kind: 'coverage.proposal', subject: 'region:x', scopeType: 'region' });
    // A single synthetic signal → belief far below the resolve gate.
    c.addEvidence(e.episodeId, [{ sourceId: 'sim:test:ev', contentType: 'signal' }], true);
    expect(c.get(e.episodeId)!.evidenceFusion!.belief).toBeLessThan(DST_RESOLVE_BELIEF_GATE);
    c.propose(e.episodeId, prop({ cellId: 'treatment-continuity' }), true);
    c.requestApproval(e.episodeId, 'B');
    c.decide(e.episodeId, 'approved', 'AR', 'B');
    c.dispatchCommand(e.episodeId, 'schedule-followup');
    c.acknowledge(e.episodeId, 'facility');
    c.verify(e.episodeId, { measureId: 'm', met: true });
    const done = c.get(e.episodeId)!;
    expect(done.state).toBe('Resolved');
    expect(done.transitions.at(-1)?.note).toContain('weak evidence');
    expect(done.evidenceStatus).toBe('weak');
  });

  it('dossierHash includes the fusion vector (P4 provenance)', () => {
    const withFact = { sources: [{ sourceId: 'realm-ledger:r', contentType: 'fact', weight: 0.7, alpha: 0.95 }], belief: 0.5, plausibility: 1, uncertainty: 0.5, conflictMass: 0, massVector: { verified: 0.5, '*': 0.5 } };
    const withEvent = { sources: [{ sourceId: 'realm-ledger:r', contentType: 'event', weight: 0.5, alpha: 0.95 }], belief: 0.4, plausibility: 1, uncertainty: 0.6, conflictMass: 0, massVector: { verified: 0.4, '*': 0.6 } };
    const a = computeDossierHash({ episodeId: 'e', kind: 'k', subject: 'p', scopeType: 'patient', state: 'Resolved', openedAt: NOW, transitions: [], evidence: [{ sourceId: 'realm-ledger:r', contentType: 'fact' }], evidenceFusion: withFact, dossierHash: '' } as never);
    const b = computeDossierHash({ episodeId: 'e', kind: 'k', subject: 'p', scopeType: 'patient', state: 'Resolved', openedAt: NOW, transitions: [], evidence: [{ sourceId: 'realm-ledger:r', contentType: 'event' }], evidenceFusion: withEvent, dossierHash: '' } as never);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('evidenceStatusFor maps fused evidence to corroborated / weak / contested', () => {
    const base = { plausibility: 0.9, uncertainty: 0.4, massVector: {}, sources: [{ sourceId: 'x', contentType: 'event', weight: 0.5, alpha: 0.5 }] };
    expect(evidenceStatusFor({ ...base, belief: DST_RESOLVE_BELIEF_GATE, conflictMass: 0 })).toBe('corroborated');
    expect(evidenceStatusFor({ ...base, belief: 0.3, conflictMass: 0 })).toBe('weak');
    expect(evidenceStatusFor({ ...base, belief: 0.1, conflictMass: DST_EPISODE_K_GATE + 0.1 })).toBe('contested');
    expect(evidenceStatusFor(undefined)).toBeUndefined();
  });
});

describe('P4 — insight provenance decomposition', () => {
  it('every insight carries a decomposable evidenceFusion (sources + mass vector)', () => {
    const proposals = [
      prop({ evidence: [{ sourceId: 'realm-ledger:s1', contentType: 'fact' }, { sourceId: 'realm-ledger:s2', contentType: 'event' }] }),
      prop({ cellId: 'facility-capacity', evidence: [{ sourceId: 'realm-ledger:s3', contentType: 'fact' }] }),
      prop({ cellId: 'access-surveillance', option: 'plan B', evidence: [{ sourceId: 'realm-ledger:s4', contentType: 'fact' }] }),
    ];
    const insights = aggregateSwarmInsights({ proposals, consumedBy: {}, mode: 'dst' });
    const cov = insights.find((i) => i.kind === 'coverage.proposal')!;
    expect(cov.evidenceFusion).toBeDefined();
    expect(cov.evidenceFusion!.sources).toHaveLength(3);
    expect(cov.evidenceFusion!.sources[0]).toMatchObject({ cellId: 'workforce-resilience', option: 'plan A' });
    expect(Object.keys(cov.evidenceFusion!.massVector).length).toBeGreaterThan(0);
    // Top-level readout equals the provenance record.
    expect(cov.evidenceFusion!.belief).toBe(cov.belief);
    expect(cov.evidenceFusion!.plausibility).toBe(cov.plausibility);
    expect(cov.evidenceFusion!.conflictMass).toBe(cov.conflictMass);
  });
});
