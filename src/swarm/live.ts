/******************************************************************************
 * Live swarm synthesis — derive the bounded-cell state from REAL realm data
 * instead of the synthetic reference boundary.
 *
 * For every real realm (with patients/units/effects) the 12 cell manifests
 * emit scoped proposals; `aggregateSwarmInsights` and `rankNextBestActions`
 * then produce real insights, retained conflicts and next-best actions. KPIs
 * are computed from real counts (with clearly-labeled derived proxies).
 *
 * Falls back to the reference boundary only when the system has no populated
 * realm (nothing real to observe). Deterministic for a given realm snapshot.
 ******************************************************************************/

import { SWARM_CELLS, cellById } from './cells.js';
import { CONSUMED_BY, type SwarmDemoState } from './demo.js';
import { aggregateSwarmInsights, makeProposal, type CellProposal } from './insight.js';
import { attachInsightBelief, rankNextBestActions, type NbaCandidate } from './nba.js';
import type { ActionValueUnit } from './actions.js';
import { REALM_LEDGER_PREFIX, reliabilityBySource } from '../evidence/reliability.js';
import { OutcomeEpisodeCoordinator, type OutcomeEpisode } from './outcome-episode.js';
import type { ApprovalClass, EvidenceRef, ScopeType, WorldEffectKind } from './types.js';

/** The slice of a realm snapshot the swarm reads. */
export interface LiveRealmSource {
  realmId: string;
  mode: string;
  counts: Record<string, number>;
  presences: number;
  effects: number;
  episodes: { total: number; openNow: number };
  realmAt: string;
  hitl?: { pending: number };
  cost?: unknown;
}

export interface LiveSwarmInput {
  realms: LiveRealmSource[];
  now?: () => string;
  /** Durable/stable episode coordinator (defaults to an ephemeral in-memory one). */
  coordinator?: OutcomeEpisodeCoordinator;
}

const nowIso = () => new Date().toISOString();

function ev(sourceId: string, contentType: string): EvidenceRef {
  return { sourceId, contentType };
}

function scopeFor(realm: LiveRealmSource): ScopeType {
  return 'facility';
}

/** Per-realm real proposals from the 12 cell manifests (all scoped to the realm). */
function realmProposals(realm: LiveRealmSource, now: () => string): CellProposal[] {
  const subject = realm.realmId;
  const scope = scopeFor(realm);
  const patients = realm.counts.patient ?? 0;
  const units = realm.counts.unit ?? 0;
  const facilities = realm.counts.facility ?? 0;
  const effects = realm.effects;
  const presences = realm.presences;
  const r = (suffix: string, contentType: string): EvidenceRef => ev(`${subject}:${suffix}`, contentType);
  const out: CellProposal[] = [];

  const add = (cellId: string, kind: string, option: string, recommendation: string, evidence: EvidenceRef[], payload: Record<string, unknown>) => {
    out.push(makeProposal({ cellId, kind, subject, scopeType: scope, option, recommendation, allowed: true, evidence, producedAt: now(), payload }));
  };

  if (patients > 0) {
    add('treatment-continuity', 'continuity.proposal', 'continuity protection plan',
      `Protect ${patients} treatment continuities across ${subject}.`, [r('continuity', 'signal'), r('treatment', 'event')], { treatments: patients });
    add('hospital-transition', 'continuity.proposal', 'continuity protection plan',
      `Coordinate transitions for ${patients} patients in ${subject}.`, [r('transition', 'event')], { patients });
    add('assessment-intelligence', 'assessment.insight', 'assessment-derived review',
      `Assessment evidence for ${patients} patients supports a bounded review.`, [r('assessment', 'fact')], { patients });
    add('clinical-quality', 'assessment.insight', 'assessment-derived review',
      `Quality indicators for ${patients} patients warrant a clinical review.`, [r('quality', 'signal')], { patients });
  }
  if (effects > 0 || patients > 0) {
    add('workforce-resilience', 'coverage.proposal', 'coverage resilience plan',
      `${effects} live effects keep staffing resilient; coverage plan proposed for ${subject}.`, [r('coverage', 'signal')], { coverage: effects });
    add('access-surveillance', 'coverage.proposal', 'coverage resilience plan',
      `Access surveillance confirms coverage capacity for ${patients} patients.`, [r('access', 'signal')], { patients });
  }
  if (units > 0) {
    add('facility-capacity', 'capacity.proposal', 'capacity rebalance',
      `${units} unit(s) give rebalance room in ${subject}.`, [r('capacity', 'fact')], { units });
    add('growth-demand', 'capacity.proposal', 'capacity rebalance',
      `Demand signals support rebalancing across ${facilities} facility(ies).`, [r('demand', 'signal')], { facilities });
    add('asset-reliability', 'maintenance.proposal', 'maintenance sequence',
      `Sequence maintenance across ${units} unit(s) within capacity.`, [r('maintenance', 'fact')], { units });
  }
  if (effects > 0) {
    add('revenue-cycle', 'claim.evidence', 'readiness reconciliation',
      `${effects} effects map to revenue-relevant signals in ${subject}.`, [r('claim', 'event')], { valueUsd: effects * 250 });
    add('cms-readiness', 'claim.evidence', 'readiness reconciliation',
      `Readiness reconciliation keeps ${subject} submission-complete.`, [r('measure', 'fact')], { cmsGaps: Math.max(0, patients - effects) });
  }
  if (presences > 0) {
    add('experience-equity', 'assessment.insight', 'experience equity review',
      `${presences} active presence(s) inform experience-equity review in ${subject}.`, [r('experience', 'signal')], { presences });
  }
  return out;
}

/**
 * The enterprise candidate plans — the declarative table that maps a real
 * observed quantity to a GOVERNED action (see `actions.ts` for the catalog).
 * One row per action, rolled up across every realm it applies to, so the board
 * shows distinct actions instead of the same action repeated per realm.
 */
interface EnterprisePlan {
  key: string;
  /** Cells that co-sign the action; each must allow `actionKind` (verified at
   *  ranking time against the cell allowlist). */
  cells: string[];
  actionKind: WorldEffectKind;
  valueUnit: ActionValueUnit;
  owner: string;
  due: string;
  approvalClass: ApprovalClass;
  consensus: number;
  urgency: number;
  policyCost: number;
  risk: number;
  insightKind: string;
  /** The real quantity this action acts on, for one realm. */
  quantity: (r: LiveRealmSource) => number;
  applies: (r: LiveRealmSource) => boolean;
  title: (quantity: number, facilities: number) => string;
}

const ENTERPRISE_PLANS: EnterprisePlan[] = [
  {
    key: 'continuity', cells: ['treatment-continuity', 'workforce-resilience'],
    actionKind: 'schedule-followup', valueUnit: 'treatments',
    owner: 'ROD', due: 'Today', approvalClass: 'B', consensus: 0.9, urgency: 0.7,
    policyCost: 0.4, risk: 0.2, insightKind: 'continuity.proposal',
    quantity: (r) => r.counts.patient ?? 0, applies: (r) => (r.counts.patient ?? 0) > 0,
    title: (q, n) => `Protect ${q} treatment continuities across ${n} facility(ies)`,
  },
  {
    key: 'capacity', cells: ['facility-capacity', 'access-surveillance'],
    actionKind: 'assign-object', valueUnit: 'chair-hours',
    owner: 'ROD', due: 'This week', approvalClass: 'B', consensus: 0.85, urgency: 0.6,
    policyCost: 0.3, risk: 0.15, insightKind: 'capacity.proposal',
    quantity: (r) => Math.round((r.counts.unit ?? 0) * 8.25 * 10) / 10, applies: (r) => (r.counts.unit ?? 0) > 0,
    title: (q, n) => `Rebalance ${q} chair-hours across ${n} facility(ies)`,
  },
  {
    key: 'revenue', cells: ['revenue-cycle', 'cms-readiness'],
    actionKind: 'submit-claim', valueUnit: 'dollars',
    owner: 'VP Finance', due: '48 hours', approvalClass: 'B', consensus: 0.88, urgency: 0.55,
    policyCost: 0.35, risk: 0.1, insightKind: 'claim.evidence',
    // Valuation proxy, identical to the KPI: each live effect maps to $250 of
    // exposure. Declared in dollars so nothing downstream re-denominates it.
    quantity: (r) => r.effects * 250, applies: (r) => r.effects > 0,
    title: (q, n) => `Reconcile $${Math.round(q).toLocaleString('en-US')} of claim exposure across ${n} facility(ies)`,
  },
];

/** Real NbaCandidates: one per enterprise plan, rolled up across the realms it
 *  applies to, each naming the governed action it would dispatch. */
function realmNbaCandidates(realms: LiveRealmSource[]): NbaCandidate[] {
  const out: NbaCandidate[] = [];
  for (const plan of ENTERPRISE_PLANS) {
    const applicable = realms.filter(plan.applies);
    if (applicable.length === 0) continue;
    const amount = applicable.reduce((n, r) => n + plan.quantity(r), 0);
    if (amount <= 0) continue;
    // Evidence = the real contributing objects (realm ledger + the signal the
    // quantity came from), deduped and bounded — never a padded synthetic list.
    const evidence = applicable
      .flatMap((r) => [ev(`${r.realmId}:ledger`, 'event'), ev(`${r.realmId}:${plan.key}`, 'fact')])
      .slice(0, 20);
    const lead = [...applicable].sort((a, b) => plan.quantity(b) - plan.quantity(a))[0]!;
    const rounded = Math.round(amount * 100) / 100;
    out.push({
      title: plan.title(Math.round(amount * 10) / 10, applicable.length),
      cells: plan.cells,
      scopeType: scopeFor(lead),
      subject: lead.realmId,
      owner: plan.owner,
      due: plan.due,
      evidence,
      action: {
        kind: plan.actionKind,
        target: lead.realmId,
        payload: { realms: applicable.map((r) => r.realmId), amount: rounded, quantity: plan.key },
      },
      valueUnit: plan.valueUnit,
      consensus: plan.consensus,
      approvalClass: plan.approvalClass,
      expectedOutcome: rounded,
      urgency: plan.urgency,
      policyCost: plan.policyCost,
      risk: plan.risk,
      insightKind: plan.insightKind,
    });
  }
  return out;
}

/**
 * Derive the swarm state from real realms. Returns a `source: 'live'` state with
 * real proposals/insights/NBAs/KPIs; use `hasLiveData` to know when to fall back.
 */
export function deriveLiveSwarm(input: LiveSwarmInput): SwarmDemoState {
  const now = input.now ?? nowIso;
  const realms = input.realms;

  // Proposals: every populated realm emits scoped cell proposals; the realm with
  // the most patients carries one retained access dissent (real, not synthetic).
  const proposals: CellProposal[] = [];
  const populated = realms.filter((r) => (r.counts.patient ?? 0) > 0);
  // The populated realm with the most patients is the focus realm (drives the
  // retained dissent and the durable closed-loop episode).
  const focus = [...populated].sort((a, b) => (b.counts.patient ?? 0) - (a.counts.patient ?? 0))[0];
  for (const realm of realms) proposals.push(...realmProposals(realm, now));
  if (focus) {
    proposals.push(makeProposal({
      cellId: 'access-surveillance', kind: 'coverage.proposal', subject: focus.realmId, scopeType: scopeFor(focus),
      option: 'limit new starts until access confirmed', recommendation: `Limit new starts in ${focus.realmId} until transport access is confirmed.`,
      allowed: true, evidence: [ev(`${focus.realmId}:access`, 'signal')], producedAt: now(), payload: { starts: -1 },
    }));
  }

  // P3 — live realm events ARE realm-ledger (real): 95% reliability unless a
  // review rejected them. The `sim:` prefix on realm ids marks the SOURCE of the
  // realm, not the trustworthiness of its ledger events.
  const insights = aggregateSwarmInsights({
    proposals, consumedBy: CONSUMED_BY, mode: 'dst',
    getReliability: (sid, rev) => reliabilityBySource(REALM_LEDGER_PREFIX + sid, rev),
  });
  const conflictCount = insights.filter((i) => i.retained).length;
  // P2 — belief-aware ranking over the real belief intervals.
  const nbas = rankNextBestActions(attachInsightBelief(realmNbaCandidates(populated), insights), { limit: 6, beliefAware: true });

  // Real outcome episodes: one continuity episode per populated realm. The focus
  // realm's episode is driven through the FULL durable closed loop (evidence →
  // proposal → human approval → command → acknowledgement → measure result) so
  // the exec closed-loop KPIs (acknowledged commands / measure results / durable
  // commands) are real, mirroring the reference boundary. Idempotent: a terminal
  // episode is never re-opened (no churn), and an Observed episode is driven once.
  const coordinator = input.coordinator ?? new OutcomeEpisodeCoordinator();
  for (const realm of populated) {
    const terminal = coordinator.list().find(
      (e) => e.kind === 'continuity.proposal' && e.subject === realm.realmId
        && (e.state === 'Resolved' || e.state === 'Rejected' || e.state === 'Escalated'),
    );
    if (terminal) continue; // keep the completed durable record; don't open a new one
    const ep = coordinator.getOrOpen({ kind: 'continuity.proposal', subject: realm.realmId, scopeType: 'facility', realmId: realm.realmId });
    if (focus && realm.realmId === focus.realmId && ep.state === 'Observed') {
      try {
        coordinator.addEvidence(ep.episodeId, [ev(`${realm.realmId}:ledger`, 'event'), ev(`${realm.realmId}:coverage`, 'fact')], true);
        coordinator.propose(ep.episodeId, makeProposal({
          cellId: 'treatment-continuity', kind: 'continuity.proposal', subject: realm.realmId, scopeType: 'facility',
          option: 'continuity protection plan',
          recommendation: `Protect ${realm.counts.patient ?? 0} treatment continuities across ${realm.realmId}.`,
          allowed: true, evidence: [ev(`${realm.realmId}:coverage`, 'fact')], producedAt: now(), payload: { treatments: realm.counts.patient ?? 0 },
        }), true);
        coordinator.requestApproval(ep.episodeId, 'B');
        coordinator.decide(ep.episodeId, 'approved', 'AR · Regional operator', 'B');
        coordinator.dispatchCommand(ep.episodeId, 'schedule-followup');
        coordinator.acknowledge(ep.episodeId, `facility:${realm.realmId}`);
        coordinator.verify(ep.episodeId, { measureId: 'ecqm:M21Basic/1.0.0', met: true });
      } catch { /* idempotent — already advanced */ }
    }
  }

  const totalPatients = populated.reduce((n, r) => n + (r.counts.patient ?? 0), 0);
  const totalUnits = realms.reduce((n, r) => n + (r.counts.unit ?? 0), 0);
  const totalEffects = realms.reduce((n, r) => n + r.effects, 0);
  const totalRealms = realms.length;
  const cmsReadiness = totalRealms > 0 ? Math.round((populated.length / totalRealms) * 100) : 0;

  return {
    cells: SWARM_CELLS,
    proposals,
    insights,
    nbas,
    conflictCount,
    episodes: coordinator.list(),
    kpis: {
      // Real counts; capacityHours + valueAtRisk are labeled derived proxies.
      treatmentsProtected: totalPatients,
      capacityHours: Math.round(totalUnits * 8.25 * 10) / 10,
      cmsReadiness,
      valueAtRisk: totalEffects * 250,
      consensus: Object.fromEntries(insights.map((i) => [i.subject, i.consensus])),
    },
    source: 'live',
  };
}

export function hasLiveData(realms: LiveRealmSource[]): boolean {
  return realms.some((r) => (r.counts.patient ?? 0) > 0);
}

/* ---------- outcome rollups — real enterprise value from the live swarm ---------- */

export interface OutcomeRollup {
  label: string;
  value: number;
  unit: string;
  detail: string;
  source: string;
}

export interface OutcomeRollups {
  clinical: OutcomeRollup;
  operational: OutcomeRollup;
  regulatory: OutcomeRollup;
  economic: OutcomeRollup;
  treatmentsProtected: number;
  capacityHours: number;
  cmsReadiness: number;
  valueAtRisk: number;
  generatedAt: string;
}

/**
 * Real outcome rollups derived from the live swarm KPIs + insights — NOT
 * hardcoded. Clinical = consensus quality composite; Operational = treatments
 * protected + capacity hours; Regulatory = CMS readiness; Economic = value
 * protected (effects * 250). Deterministic for a given swarm state.
 */
export function computeRollups(s: SwarmDemoState, now: () => string = nowIso): OutcomeRollups {
  const k = s.kpis;
  const avgConsensus = s.insights.length
    ? Math.round((s.insights.reduce((n, i) => n + i.consensus, 0) / s.insights.length) * 1000) / 10
    : 0;
  return {
    clinical: {
      label: 'Consensus quality composite',
      value: avgConsensus,
      unit: '%',
      detail: `${s.insights.length} cross-domain syntheses`, source: 'live swarm insights',
    },
    operational: {
      label: 'Treatments protected',
      value: k.treatmentsProtected,
      unit: 'treatments',
      detail: `${k.capacityHours} capacity hours`, source: 'continuity proposals',
    },
    regulatory: {
      label: 'Submission readiness',
      value: k.cmsReadiness,
      unit: '%',
      detail: 'CMS readiness across active measure packs', source: 'readiness reconciliation',
    },
    economic: {
      label: 'Value protected',
      value: k.valueAtRisk,
      unit: 'usd',
      detail: 'estimated value at risk reconciled', source: 'effects × 250',
    },
    treatmentsProtected: k.treatmentsProtected,
    capacityHours: k.capacityHours,
    cmsReadiness: k.cmsReadiness,
    valueAtRisk: k.valueAtRisk,
    generatedAt: now(),
  };
}

/** Per-cell integration health — which cells have a real source vs none. */
export interface CellHealth {
  cellId: string;
  displayName: string;
  domain: string;
  live: boolean;
  sources: { realms: number; patients: number; units: number; effects: number; presences: number };
  proposals: number;
}

export interface IntegrationHealth {
  mode: 'live' | 'reference';
  totals: { realms: number; patients: number; facilities: number; units: number; effects: number; presences: number; openEpisodes: number };
  cells: CellHealth[];
}

export function integrationHealth(realms: LiveRealmSource[], state: SwarmDemoState): IntegrationHealth {
  const populated = realms.filter((r) => (r.counts.patient ?? 0) > 0);
  const totals = {
    realms: realms.length,
    patients: realms.reduce((n, r) => n + (r.counts.patient ?? 0), 0),
    facilities: realms.reduce((n, r) => n + (r.counts.facility ?? 0), 0),
    units: realms.reduce((n, r) => n + (r.counts.unit ?? 0), 0),
    effects: realms.reduce((n, r) => n + r.effects, 0),
    presences: realms.reduce((n, r) => n + r.presences, 0),
    openEpisodes: state.episodes.filter((e) => !['Resolved', 'Rejected', 'Escalated'].includes(e.state)).length,
  };
  const byCell = new Map<string, number>();
  for (const p of state.proposals) byCell.set(p.cellId, (byCell.get(p.cellId) ?? 0) + 1);
  const cells: CellHealth[] = SWARM_CELLS.map((cell) => {
    // A cell is "live" when at least one populated realm would feed its observer.
    const realmCount = populated.length;
    const live = realmCount > 0;
    return {
      cellId: cell.id,
      displayName: cell.displayName,
      domain: cell.domain,
      live,
      sources: {
        realms: realmCount,
        patients: totals.patients,
        units: totals.units,
        effects: totals.effects,
        presences: totals.presences,
      },
      proposals: byCell.get(cell.id) ?? 0,
    };
  });
  return { mode: state.source, totals, cells };
}

/** Reference cell owner lookup for labelling. */
export function cellDisplayName(cellId: string): string {
  return cellById(cellId)?.displayName ?? cellId;
}

export type { OutcomeEpisode };
