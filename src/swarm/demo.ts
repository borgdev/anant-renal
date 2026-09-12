/******************************************************************************
 * Swarm demo — reproduces the spec's "current executable reference boundary":
 * 12 bounded cells · 5 swarm insights · 4 ranked NBAs · 1 retained conflict ·
 * an approved NBA → idempotent command → acknowledgement → measure result.
 *
 * Fully deterministic (injectable now()); used by the executive cockpit and
 * the swarm-routes demo endpoint. Synthetic-by-default — no real patient data.
 ******************************************************************************/

import { SWARM_CELLS, cellById } from './cells.js';
import { aggregateSwarmInsights, makeProposal, type CellProposal, type SwarmInsight } from './insight.js';
import { attachInsightBelief, rankNextBestActions, type NextBestAction } from './nba.js';
import { OutcomeEpisodeCoordinator, type OutcomeEpisode } from './outcome-episode.js';

export interface SwarmDemoState {
  cells: typeof SWARM_CELLS;
  proposals: CellProposal[];
  insights: SwarmInsight[];
  nbas: NextBestAction[];
  conflictCount: number;
  episodes: OutcomeEpisode[];
  kpis: {
    treatmentsProtected: number;
    capacityHours: number;
    cmsReadiness: number;
    valueAtRisk: number;
    consensus: Record<string, number>;
  };
  /** 'reference' = the synthetic executable reference boundary; 'live' = derived from real realm/event state. */
  source: 'reference' | 'live';
}

/** Consumers per signal kind — which cells observe which canonical signals. */
export const CONSUMED_BY: Record<string, string[]> = {
  'continuity.proposal': ['treatment-continuity', 'workforce-resilience', 'facility-capacity', 'access-surveillance'],
  'capacity.proposal': ['facility-capacity', 'access-surveillance', 'growth-demand'],
  'coverage.proposal': ['workforce-resilience', 'facility-capacity', 'treatment-continuity', 'access-surveillance'],
  'assessment.insight': ['clinical-quality', 'access-surveillance', 'assessment-intelligence'],
  'claim.evidence': ['revenue-cycle', 'cms-readiness'],
  'maintenance.proposal': ['asset-reliability', 'facility-capacity'],
};

const NOW = () => new Date().toISOString();
const ev = (sourceId: string, contentType: string): { sourceId: string; contentType: string } => ({ sourceId, contentType });

export function buildSwarmDemo(now: () => string = NOW): SwarmDemoState {
  // ---- Proposals (deterministic) ----
  const proposals: CellProposal[] = [
    // 1 · Weekend coverage — 3 cells agree, access dissents (retained conflict).
    makeProposal({ cellId: 'workforce-resilience', kind: 'coverage.proposal', subject: 'region:middle-tennessee', scopeType: 'region', option: 'three-facility coverage plan', recommendation: 'Staffing, capacity and continuity cells agree on a three-facility coverage plan; credential and overtime limits remain inside policy.', allowed: true, evidence: [ev('staffing.coverage.changed.v1', 'signal'), ev('schedule.changed', 'signal')], producedAt: now(), payload: { treatments: 43 } }),
    makeProposal({ cellId: 'facility-capacity', kind: 'coverage.proposal', subject: 'region:middle-tennessee', scopeType: 'region', option: 'three-facility coverage plan', recommendation: '24.5 chair-hours available inside staffing and machine constraints.', allowed: true, evidence: [ev('facility.capacity.changed.v2', 'fact'), ev('physical-object', 'fact')], producedAt: now(), payload: { chairHours: 24.5 } }),
    makeProposal({ cellId: 'treatment-continuity', kind: 'coverage.proposal', subject: 'region:middle-tennessee', scopeType: 'region', option: 'three-facility coverage plan', recommendation: 'Weekend coverage can protect 43 treatments.', allowed: true, evidence: [ev('adt.discharge', 'event'), ev('treatment.missed', 'event')], producedAt: now(), payload: { treatments: 43 } }),
    makeProposal({ cellId: 'access-surveillance', kind: 'coverage.proposal', subject: 'region:middle-tennessee', scopeType: 'region', option: 'reduce weekend starts', recommendation: 'Reduce new weekend starts until transport access is confirmed.', allowed: true, evidence: [ev('transport.issue', 'event'), ev('treatment.missed', 'event')], producedAt: now(), payload: { starts: -9 } }),
    // 2 · Catheter review — quality + access + assessment converge.
    makeProposal({ cellId: 'clinical-quality', kind: 'assessment.insight', subject: 'market:nashville-south', scopeType: 'market', option: 'nurse-led catheter review', recommendation: 'Catheter risk and patient-reported tenderness converge; a nurse-led review at two facilities is supported; no diagnosis is inferred.', allowed: true, evidence: [ev('vital.observed', 'event'), ev('condition.recorded', 'event')], producedAt: now(), payload: { patients: 31 } }),
    makeProposal({ cellId: 'access-surveillance', kind: 'assessment.insight', subject: 'market:nashville-south', scopeType: 'market', option: 'nurse-led catheter review', recommendation: 'Exit-site observations support review at two facilities.', allowed: true, evidence: [ev('assessment.response', 'fact')], producedAt: now(), payload: { facilities: 2 } }),
    makeProposal({ cellId: 'assessment-intelligence', kind: 'assessment.insight', subject: 'market:nashville-south', scopeType: 'market', option: 'nurse-led catheter review', recommendation: 'Patient-reported tenderness answers retained with exact text; supports clinical review.', allowed: true, evidence: [ev('assessment.response.v1', 'fact')], producedAt: now(), payload: {} }),
    // 3 · Mapping defect — revenue + CMS trace one version.
    makeProposal({ cellId: 'revenue-cycle', kind: 'claim.evidence', subject: 'division:southeast', scopeType: 'division', option: 'resolve eligibility-to-treatment mapping variance', recommendation: 'One mapping defect explains revenue and CMS gaps; traced to the synthetic eligibility-to-treatment mapping version.', allowed: true, evidence: [ev('claim.remittance', 'event'), ev('claim.denied', 'event')], producedAt: now(), payload: { valueUsd: 184000 } }),
    makeProposal({ cellId: 'cms-readiness', kind: 'claim.evidence', subject: 'division:southeast', scopeType: 'division', option: 'resolve eligibility-to-treatment mapping variance', recommendation: 'CMS variance shares the same mapping version root cause.', allowed: true, evidence: [ev('coverage.active', 'event'), ev('measure.gap', 'fact')], producedAt: now(), payload: { cmsGaps: 11 } }),
    // 4 · Chair rebalance.
    makeProposal({ cellId: 'access-surveillance', kind: 'capacity.proposal', subject: 'facility:riverbend-franklin', scopeType: 'facility', option: 'rebalance 24.5 chair-hours', recommendation: 'Rebalance 24.5 chair-hours to recover +9 starts.', allowed: true, evidence: [ev('schedule.changed', 'signal')], producedAt: now(), payload: { chairHours: 24.5 } }),
    makeProposal({ cellId: 'growth-demand', kind: 'capacity.proposal', subject: 'facility:riverbend-franklin', scopeType: 'facility', option: 'rebalance 24.5 chair-hours', recommendation: 'Demand signals support +9 starts this period.', allowed: true, evidence: [ev('coverage.inquiry', 'signal'), ev('contact.attempted', 'signal')], producedAt: now(), payload: { starts: 9 } }),
    // 5 · Maintenance windows.
    makeProposal({ cellId: 'asset-reliability', kind: 'maintenance.proposal', subject: 'facility:riverbend-franklin', scopeType: 'facility', option: 'sequence three maintenance windows', recommendation: 'Sequence three maintenance windows within 18 chair-hours.', allowed: true, evidence: [ev('device.observation', 'event'), ev('maintenance.due', 'fact')], producedAt: now(), payload: { windows: 3, hours: 18 } }),
    makeProposal({ cellId: 'facility-capacity', kind: 'maintenance.proposal', subject: 'facility:riverbend-franklin', scopeType: 'facility', option: 'sequence three maintenance windows', recommendation: 'Capacity permits sequenced windows without lost starts.', allowed: true, evidence: [ev('facility.capacity.changed.v2', 'fact')], producedAt: now(), payload: {} }),
  ];

  // ---- Aggregate insights ----
  const insights = aggregateSwarmInsights({ proposals, consumedBy: CONSUMED_BY, mode: 'dst' });
  const conflictCount = insights.filter((i) => i.retained).length;

  // ---- Rank NBAs (4) — P2: belief-aware (Bel + λ·(Pl−Bel) − γ·Pl(harm)) ----
  const nbas = rankNextBestActions(attachInsightBelief([
    { title: 'Protect 43 weekend treatments', cells: ['treatment-continuity', 'workforce-resilience'], scopeType: 'region', subject: 'region:middle-tennessee', owner: 'ROD', due: '2 hours', evidence: Array.from({ length: 18 }, (_, i) => ev(`ev:${i}`, 'object')), action: { kind: 'schedule-followup', target: 'region:middle-tennessee' }, valueUnit: 'treatments', consensus: 0.96, approvalClass: 'B', expectedOutcome: 43, urgency: 0.95, policyCost: 0.4, risk: 0.2, insightKind: 'coverage.proposal' },
    { title: 'Rebalance 24.5 chair-hours', cells: ['facility-capacity', 'growth-demand'], scopeType: 'facility', subject: 'facility:riverbend-franklin', owner: 'ROD', due: 'Today', evidence: Array.from({ length: 14 }, (_, i) => ev(`ev:${i}`, 'object')), action: { kind: 'assign-object', target: 'facility:riverbend-franklin' }, valueUnit: 'chair-hours', consensus: 0.93, approvalClass: 'B', expectedOutcome: 24.5, urgency: 0.8, policyCost: 0.3, risk: 0.15, insightKind: 'capacity.proposal' },
    { title: 'Open catheter reduction review', cells: ['clinical-quality'], scopeType: 'market', subject: 'market:nashville-south', owner: 'Quality Director', due: 'This week', evidence: Array.from({ length: 22 }, (_, i) => ev(`ev:${i}`, 'object')), action: { kind: 'update-care-plan', target: 'market:nashville-south' }, valueUnit: 'patients', consensus: 0.94, approvalClass: 'C', expectedOutcome: 31, urgency: 0.6, policyCost: 0.5, risk: 0.3, insightKind: 'assessment.insight' },
    { title: 'Resolve clean-claim mapping variance', cells: ['revenue-cycle', 'cms-readiness'], scopeType: 'division', subject: 'division:southeast', owner: 'VP Finance', due: '48 hours', evidence: Array.from({ length: 28 }, (_, i) => ev(`ev:${i}`, 'object')), action: { kind: 'submit-claim', target: 'division:southeast' }, valueUnit: 'dollars', consensus: 0.99, approvalClass: 'B', expectedOutcome: 184000, urgency: 0.7, policyCost: 0.35, risk: 0.1, insightKind: 'claim.evidence' },
  ], insights), { limit: 4, beliefAware: true });

  // ---- Outcome episode: approved NBA → command → ack → measure ----
  // P2 — dstGates: an unmet measure escalates; weak fused evidence is flagged.
  const coordinator = new OutcomeEpisodeCoordinator({ dstGates: true });
  const episode = coordinator.open({ kind: 'coverage.proposal', subject: 'region:middle-tennessee', scopeType: 'region' });
  const lead = cellById('treatment-continuity');
  coordinator.addEvidence(episode.episodeId, [ev('staffing.coverage.changed.v1', 'signal'), ev('treatment.missed', 'event'), ev('facility.capacity.changed.v2', 'fact')], true);
  coordinator.propose(episode.episodeId, makeProposal({
    cellId: 'treatment-continuity', kind: 'continuity.proposal', subject: 'region:middle-tennessee', scopeType: 'region', option: 'three-facility coverage plan', recommendation: 'Protect 43 weekend treatments via a three-facility coverage plan.', allowed: true, evidence: [ev('adt.discharge', 'event')], producedAt: now(), payload: { treatments: 43 },
  }), true);
  coordinator.requestApproval(episode.episodeId, lead?.approvalClass ?? 'B');
  coordinator.decide(episode.episodeId, 'approved', 'AR · Regional operator', lead?.approvalClass ?? 'B');
  coordinator.dispatchCommand(episode.episodeId, 'schedule-followup');
  coordinator.acknowledge(episode.episodeId, 'facility:riverbend-franklin');
  coordinator.verify(episode.episodeId, { measureId: 'ecqm:M21Basic/1.0.0', met: true });

  return {
    cells: SWARM_CELLS,
    proposals,
    insights,
    nbas,
    conflictCount,
    episodes: coordinator.list(),
    kpis: {
      treatmentsProtected: 43,
      capacityHours: 24.5,
      cmsReadiness: 93.8,
      valueAtRisk: 720000,
      consensus: Object.fromEntries(insights.map((i) => [i.subject, i.consensus])),
    },
    source: 'reference',
  };
}

/**
 * Server-side policy replay · isolated sandbox (spec plane 4 / cockpit 8).
 * Returns what WOULD change if the escalation (consensus) threshold moved —
 * without mutating runtime state.
 */
export function policyWhatIf(threshold: number, state: SwarmDemoState): {
  threshold: number; episodesSurfaced: number; treatmentsProtected: number; reviewsRequired: number; estimatedValue: number; simulation: boolean;
} {
  const surfaced = state.insights.filter((i) => i.consensus >= threshold);
  const treatments = Math.round(surfaced.reduce((n, i) => n + Number(i.payload?.treatments ?? 0), 0));
  const reviews = surfaced.filter((i) => i.review !== 'none').length;
  const value = Math.round(surfaced.reduce((n, i) => n + Number(i.payload?.valueUsd ?? 0), 0) + state.kpis.treatmentsProtected * 1000);
  return { threshold, episodesSurfaced: surfaced.length, treatmentsProtected: treatments, reviewsRequired: reviews, estimatedValue: value, simulation: true };
}
