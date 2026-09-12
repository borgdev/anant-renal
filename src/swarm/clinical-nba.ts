/******************************************************************************
 * Clinical protocol → next-best action bridge.
 *
 * WHY THIS MODULE EXISTS
 * Every protocol pack could compute a governed, patient-specific recommendation
 * (`adequacyRecommend`, `esaRecommend`, …) and then had NOTHING that turned it
 * into an NBA. The packs' NBAs were literal arrays keyed to fabricated patient
 * ids (`patient:esa-1`, `patient:p-ktv-1`) that no realm contained and no
 * console rendered — a dead fixture. So the clinical half reasoned over real
 * patients while the action half was a hardcoded demo, and the two never met.
 *
 * This module is the missing conversion, and it is the ONLY place that maps a
 * protocol's own action vocabulary ('extend-time', 'refer-duplex-ultrasound',
 * 'suspend') onto the governed `WorldEffectKind` the platform may actually
 * perform. Two invariants are enforced here:
 *
 *   1. An NBA names ONE governed action (`NbaCandidate.action`) and only a cell
 *      whose manifest already lists that kind may propose it (`allowedActions`).
 *      `rankNextBestActionsDetailed` drops and reports any violation.
 *   2. The value claim carries a UNIT. `valueUnit` + `expectedOutcome` are the
 *      only legal way to state worth, so a count of events can never be
 *      formatted as dollars again (the console used to multiply by 1000).
 *
 * A protocol action token that is NOT in the map is reported in `unmapped`
 * rather than silently dropped, so a gap in coverage is observable.
 ******************************************************************************/

import { makeProposal, aggregateSwarmInsights, type CellProposal, type SwarmInsight } from './insight.js';
import {
  attachInsightBelief,
  rankNextBestActionsDetailed,
  type NbaCandidate,
  type NbaRankingDiagnostics,
  type NbaTrajectory,
  type NbaTrajectoryPoint,
  type NextBestAction,
} from './nba.js';
import { cellAllowlist, type CellManifest } from './cells.js';
import type { ActionValueUnit } from './actions.js';
import type { ApprovalClass, EvidenceRef, ScopeType, WorldEffectKind } from './types.js';

/* Type-only imports: erased at runtime, so packs may import this module without
 * creating a cycle. */
import type { AdequacyRecommendation } from './adequacy.js';
import type { FluidRecommendation } from './fluid.js';
import type { AccessRecommendation } from './access.js';
import type { EsaRecommendation } from './anemia.js';
import { HGB_TARGET } from './anemia.js';
import type { EsaWhatIfResult } from './anemia-forecast.js';
import type { MbdRecommendation } from './mbd.js';
import type { NutritionRecommendation } from './nutrition.js';
import type { InfectionRecommendation } from './infection.js';

export type ClinicalProtocolId = 'adequacy' | 'fluid' | 'access' | 'anemia' | 'mbd' | 'nutrition' | 'infection';

/** Wire shape every protocol's `/state` publishes for its live action board, so
 *  the console renders one contract and never re-derives what a value means. */
export interface ClinicalActionsPayload {
  nbas: NextBestAction[];
  insights: Array<{
    subject: string;
    kind: string;
    consensus: number;
    retained: boolean;
    belief?: number | undefined;
    plausibility?: number | undefined;
    conflictMass?: number | undefined;
  }>;
  considered: number;
  actionable: number;
  suppressed: number;
  kinds: string[];
  unmapped: string[];
  rejected: Array<{ title: string; actionKind: string; cells: string[] }>;
}

/** Project a bridge result onto the wire. `unmapped` and `rejected` travel with
 *  the data so a governance gap is visible to the operator, not just the log. */
export function clinicalActionsPayload(state: ClinicalNbaState): ClinicalActionsPayload {
  return {
    nbas: state.nbas,
    insights: state.insights.map((i) => ({
      subject: i.subject,
      kind: i.kind,
      consensus: i.consensus,
      retained: i.retained,
      ...(typeof i.belief === 'number' ? { belief: i.belief } : {}),
      ...(typeof i.plausibility === 'number' ? { plausibility: i.plausibility } : {}),
      ...(typeof i.conflictMass === 'number' ? { conflictMass: i.conflictMass } : {}),
    })),
    considered: state.considered,
    actionable: state.actionable,
    suppressed: state.suppressed,
    kinds: state.kinds,
    unmapped: state.unmapped,
    rejected: state.diagnostics.rejected,
  };
}

/**
 * What the pack would write in the chart if a human approved it.
 *
 * The order draft is authored by the PACK because the pack owns the clinical
 * reasoning (and the dose). Two rules keep it honest:
 *  - `payload` must NOT name a patient. The bridge injects `patientId` from the
 *    finding, so an order can never point at a different patient than the episode
 *    it was approved under.
 *  - `effect` must be one the owning cell's `allowedActions` permits — a draft may
 *    not smuggle in an action the cell is not allowed to perform.
 */
export interface ClinicalOrderDraft {
  effect: WorldEffectKind;
  payload: Record<string, unknown>;
}

/** What a protocol action is: the governed kind it invokes, its value unit, and
 *  the review posture the action carries. */
export interface ClinicalActionSpec {
  /** The governed WorldEffectKind this clinical action performs. */
  kind: WorldEffectKind;
  /** Human imperative shown to the operator. */
  label: string;
  /** Denomination of the value claim — never invented downstream. */
  valueUnit: ActionValueUnit;
  /** Magnitude of one action over the protocol horizon, in `valueUnit`. This is
   *  the protocol's stated horizon (e.g. one month of thrice-weekly therapy),
   *  NOT a measurement of the patient. */
  horizon: number;
  approvalClass: ApprovalClass;
  urgency: number;
  policyCost: number;
  risk: number;
  /** The cell that owns this action; must already allow `kind`. */
  cellId: string;
  /** Reversible by the protocol's own rollback, or requires re-review. */
  rollback: boolean;
  /** The order this action places, when it places one. */
  order?: ClinicalOrderDraft;
}

/** One actionable finding for a real patient, produced by a protocol engine. */
export interface ClinicalFinding {
  patientId: string;
  facilityId?: string | undefined;
  realmId?: string | undefined;
  /** The protocol's own action token (validated against the action map). */
  action: string;
  /** Measured value the action moves (cited in the title). */
  observed?: number | undefined;
  /** Overrides the spec horizon when the protocol can size the work. */
  amount?: number | undefined;
  /** Data-derived urgency override (defaults to the spec's base urgency). */
  urgency?: number | undefined;
  /** Overrides the spec's unit when one finding carries a different claim. */
  valueUnit?: ActionValueUnit | undefined;
  /** Transport implementation detail of the finding. */
  recommendation: string;
  evidence: EvidenceRef[];
  /** The order this finding places (overrides the spec's). Patient id is injected. */
  order?: ClinicalOrderDraft;
  /**
   * The decision curve behind the recommendation. It rides WITH the finding so the
   * approval shows the analysis that produced the number, instead of the browser
   * recomputing a second curve that could disagree with the approved value.
   */
  trajectory?: NbaTrajectory;
  drivers?: Array<{ id: string; label: string; relevance: number }> | undefined;
  model?: { id: string; version: string; kind: string } | undefined;
}

export interface ClinicalRecInput<R> {
  rec: R;
  facilityId?: string | undefined;
  realmId?: string | undefined;
  /**
   * The engine's own what-if analysis for this patient, when the caller already
   * computed it. Passed in rather than recomputed here so the pack and the console
   * cannot end up with two different curves for the same decision.
   */
  whatIf?: EsaWhatIfResult | undefined;
}

export interface ClinicalNbaOptions {
  protocol: ClinicalProtocolId;
  /** Fallback proposal kind. Individual actions take their kind from the owning
   *  cell's manifest `produces`, so a protocol with two cells (e.g. adequacy's
   *  prescription + access-review) emits BOTH kinds correctly. */
  insightKind: string;
  cells: CellManifest[];
  consumedBy: Record<string, string[]>;
  actionMap: Record<string, ClinicalActionSpec | null>;
  findings: ClinicalFinding[];
  limit?: number;
  now?: () => string;
}

export interface ClinicalNbaState {
  proposals: CellProposal[];
  insights: SwarmInsight[];
  nbas: NextBestAction[];
  diagnostics: NbaRankingDiagnostics;
  /** Action tokens the protocol produced but the map does not cover. */
  unmapped: string[];
  /** Proposal kinds actually emitted (one per contributing cell). */
  kinds: string[];
  considered: number;
  actionable: number;
  /** In-band / guardrail-blocked / no-action findings — nothing to do. */
  suppressed: number;
}

const CLINICAL_SCOPE: ScopeType = 'patient';

const round3 = (v: number): number => Math.round(v * 1000) / 1000;
const clamp01 = (v: number): number => Math.min(1, Math.max(0, round3(v)));

export function clinicalSubject(patientId: string): string {
  return `patient:${patientId}`;
}

/** Cite the drivers the engine actually used. A driver is a real computed input
 *  (relevance-weighted), so it is legitimate evidence — and `span` carries the
 *  human-readable citation. */
function evidenceFromDrivers(
  protocol: ClinicalProtocolId,
  patientId: string,
  drivers: Array<{ id: string; label: string; relevance: number }> | undefined,
  observation: string,
): EvidenceRef[] {
  const refs: EvidenceRef[] = [];
  if (observation) refs.push({ sourceId: `${observation}:${patientId}`, contentType: 'fact' });
  for (const d of (drivers ?? []).slice(0, 3)) {
    refs.push({
      sourceId: `${protocol}:${d.id}:${patientId}`,
      contentType: d.relevance >= 0.15 ? 'fact' : 'signal',
      span: `${d.label} (relevance ${d.relevance})`,
    });
  }
  return refs;
}

function titleFor(spec: ClinicalActionSpec, patientId: string, observed: number | undefined): string {
  const suffix = observed === undefined ? '' : ` (observed ${observed})`;
  return `${spec.label} · ${patientId}${suffix}`;
}

/** Due bucket derived from urgency, so the console's SLA never needs a literal. */
function dueFor(urgency: number): string {
  if (urgency >= 0.85) return 'Today';
  if (urgency >= 0.6) return 'Today';
  if (urgency >= 0.4) return 'This week';
  return 'This month';
}

/* ======================================================================
 * The conversion
 * ====================================================================== */

/**
 * What to DO about an ESA window — including when the answer is "refused".
 *
 * A staleness block is a data problem, so it yields an order for the missing
 * measurement instead of a silent no-op. A clinical block (a microcytic picture)
 * stays with `direction: 'blocked'` → the map's `null` → suppressed, because no
 * order this pack can place fixes it: it needs a clinician's iron decision.
 *
 * The recommendation carries the guardrail's own words so the order, the audit
 * trail and the reviewer all cite WHY it was raised.
 */
function anemiaActionFor(rec: EsaRecommendation): { action: string; recommendation: string } {
  if (rec.direction === 'blocked' && rec.guardrails.flags.includes('iron-not-checked-quarterly')) {
    return {
      action: 'order-iron-panel',
      recommendation: `Iron status is stale — order iron studies (ferritin + TSAT) before any ESA change. Guardrail: ${rec.guardrails.blockReason ?? 'iron-not-checked-quarterly'}`,
    };
  }
  return {
    action: rec.direction,
    recommendation: rec.note || `ESA dose ${rec.direction} for ${rec.patientId}.`,
  };
}

/**
 * A name for what the pack asked for, on its way into the patient's record.
 *
 * Where a pack names a concrete ORDER (a lab code, a dose it computed), it drafts
 * that order. Where its output is a PLAN — a therapy decision the prescriber still
 * owns — it drafts a care-plan update, which records the pack's stated intent
 * WITHOUT inventing a number the pack never produced. A fabricated dose is worse
 * than no order: it reaches a patient.
 */
function carePlanDraft(protocol: ClinicalProtocolId, action: string): ClinicalOrderDraft {
  return {
    effect: 'update-care-plan',
    payload: { patch: { [`${protocol}Plan`]: { action, proposedBy: `${protocol}-protocol-pack` } } },
  };
}

/**
 * Compact the engine's what-if into the trajectory the approval carries.
 *
 * Only what a clinician reads is kept: the candidate doses, where each one lands
 * Hb, how much of the horizon sits inside the band, and the cost. The full
 * analysis (weights, substrate, exposure PK, per-candidate curves) stays on the
 * CDSS page — an approval payload is a decision record, not a model dump.
 *
 * A blocked analysis keeps its REASON and carries no points. Inventing a flat
 * curve for a patient whose iron status is unknown would put a fabricated Hb
 * projection in front of a prescriber, which is the one thing the guardrail
 * exists to prevent.
 */
export function esaTrajectory(whatIf: EsaWhatIfResult): NbaTrajectory {
  const points: NbaTrajectoryPoint[] = whatIf.candidates.map((c) => ({
    dose: c.dose,
    label: c.label,
    endHgb: Math.round(c.endHgb * 100) / 100,
    peakHgb: Math.round(c.peakHgb * 100) / 100,
    weeksInBand: c.weeksInBand,
    pctInBand: c.pctInBand,
    projectedCostUsd: Math.round(c.projectedCostUsd * 100) / 100,
  }));
  const band = whatIf.controller?.constraints.targetBand ?? { min: HGB_TARGET.min, max: HGB_TARGET.max };
  return {
    horizonWeeks: whatIf.horizonWeeks,
    currentHgb: whatIf.currentHgb,
    currentDose: whatIf.currentDose,
    targetBand: band,
    chosenIndex: points.length > 0 ? whatIf.chosenIndex : null,
    points,
    note: whatIf.note,
    ...(whatIf.blocked || points.length === 0
      ? { unavailableReason: whatIf.blockReason ?? 'The engine produced no candidate curve for this patient.' }
      : {}),
  };
}

/**
 * The ESA order a dose change places.
 *
 * A titration is a NEW order at the new dose (the dose already on record stays as
 * history) — orders are superseded in an EMR, never edited in place. A hold places
 * nothing, so it drafts nothing: an in-band patient must not generate a paper trail
 * of no-op orders. `suspend`/`hold` deliberately have no draft until a hold-med
 * target can be named, rather than inventing an order with no patient effect.
 */
function esaOrderDraft(rec: EsaRecommendation): ClinicalOrderDraft | undefined {
  if (rec.direction !== 'increase' && rec.direction !== 'reduce') return undefined;
  if (rec.recommendedDose === null || rec.recommendedDose <= 0) return undefined;
  return {
    effect: 'order-med',
    payload: {
      code: 'epoetin-alfa',
      dose: String(rec.recommendedDose),
      route: 'IV',
      frequency: 'weekly',
      indication: 'anemia',
    },
  };
}

/**
 * Turn protocol findings into proposals, fused insights and ranked NBAs.
 *
 * Proposals and candidates share a subject and kind, so `attachInsightBelief`
 * binds each NBA to the Dempster–Shafer interval fused from its own evidence —
 * Bel/Pl/K are computed from the finding, never asserted.
 */
export function clinicalNbaState(opts: ClinicalNbaOptions): ClinicalNbaState {
  const now = opts.now ?? (() => new Date().toISOString());
  // The protocol's OWN manifests are the authority for owner + produced kind.
  // (`cellById` only knows the tenant `SWARM_CELLS`, so it must not be used here.)
  const cellMap = new Map(opts.cells.map((c) => [c.id, c]));
  const proposals: CellProposal[] = [];
  const selected: Array<{ finding: ClinicalFinding; spec: ClinicalActionSpec; kind: string }> = [];
  const unmapped: string[] = [];

  for (const finding of opts.findings) {
    const spec = opts.actionMap[finding.action];
    // `undefined` = the map has no entry for this token (a real coverage gap);
    // `null` = the protocol deliberately has no action (in band / blocked).
    if (spec === undefined) {
      unmapped.push(finding.action);
      continue;
    }
    if (spec === null) continue;
    // The owning cell's manifest is the authority on the proposal kind it
    // produces; the option is only a fallback for a cell that declares none.
    const kind = cellMap.get(spec.cellId)?.produces?.[0] ?? opts.insightKind;
    // What the order will be, in the pack's own words, in priority order:
    //   1. the finding's draft (a patient-specific dose, as anemia computes),
    //   2. the spec's draft (a fixed order — a lab code the pack names),
    //   3. a care-plan update, WHEN THE OWNING CELL PERMITS ONE.
    // (3) is the honest floor: a pack whose output is a plan rather than a
    // prescription must still leave a record of what a human approved, and a
    // care-plan patch records the intent without inventing a dose the pack never
    // computed. A fabricated dose reaches a patient, so it is never the fallback.
    const owningCell = cellMap.get(spec.cellId);
    const orderDraft =
      finding.order ??
      spec.order ??
      (owningCell?.allowedActions.includes('update-care-plan') ? carePlanDraft(opts.protocol, spec.kind) : undefined);
    selected.push({ finding, spec, kind });
    const subject = clinicalSubject(finding.patientId);
    proposals.push(
      makeProposal({
        cellId: spec.cellId,
        kind,
        subject,
        scopeType: CLINICAL_SCOPE,
        option: spec.label,
        recommendation: finding.recommendation,
        allowed: true,
        evidence: finding.evidence,
        producedAt: now(),
        approvalClass: spec.approvalClass,
        payload: {
          action: spec.kind,
          observed: finding.observed ?? null,
          amount: finding.amount ?? spec.horizon,
          valueUnit: finding.valueUnit ?? spec.valueUnit,
          ...(finding.facilityId !== undefined ? { facilityId: finding.facilityId } : {}),
          ...(finding.realmId !== undefined ? { realmId: finding.realmId } : {}),
          model: finding.model ?? null,
          // The order travels WITH the proposal, so the episode's command picks it
          // up from here (`orderFromProposal`) instead of the console supplying one.
          ...(orderDraft !== undefined
            ? { order: { effect: orderDraft.effect, payload: { patientId: finding.patientId, ...orderDraft.payload } } }
            : {}),
          // The curve travels with the approval for the same reason the order does:
          // what a human approves must be what the engine computed.
          ...(finding.trajectory !== undefined ? { trajectory: finding.trajectory } : {}),
        },
      }),
    );
  }

  const insights = selected.length
    ? aggregateSwarmInsights({ proposals, consumedBy: opts.consumedBy, mode: 'dst' })
    : [];

  const candidates: NbaCandidate[] = selected.map(({ finding, spec, kind }) => {
    const subject = clinicalSubject(finding.patientId);
    const urgency = clamp01(finding.urgency ?? spec.urgency);
    const owner = cellMap.get(spec.cellId)?.owner ?? 'clinical team';
    const unit = finding.valueUnit ?? spec.valueUnit;
    return {
      title: titleFor(spec, finding.patientId, finding.observed),
      cells: [spec.cellId],
      scopeType: CLINICAL_SCOPE,
      subject,
      owner,
      due: dueFor(urgency),
      evidence: finding.evidence,
      action: { kind: spec.kind, target: subject },
      // The curve rides on the candidate, so the approval shows the analysis the
      // number came from instead of asking the reader to trust the conclusion.
      ...(finding.trajectory !== undefined ? { trajectory: finding.trajectory } : {}),
      valueUnit: unit,
      expectedOutcome: finding.amount ?? spec.horizon,
      // Overwritten by the fused belief interval when the insight matches; the
      // fallback is the protocol's own gate confidence, never a magic number.
      consensus: 0.5,
      approvalClass: spec.approvalClass,
      urgency,
      policyCost: spec.policyCost,
      risk: spec.risk,
      insightKind: kind,
    };
  });

  const { nbas, diagnostics } =
    candidates.length > 0
      ? rankNextBestActionsDetailed(attachInsightBelief(candidates, insights), {
          limit: opts.limit ?? 6,
          beliefAware: true,
          allowlist: cellAllowlist(opts.cells),
        })
      : { nbas: [], diagnostics: { rejected: [], unverified: [] } };

  return {
    proposals,
    insights,
    nbas,
    diagnostics,
    unmapped: [...new Set(unmapped)].sort(),
    kinds: [...new Set(selected.map((s) => s.kind))].sort(),
    considered: opts.findings.length,
    actionable: selected.length,
    suppressed: opts.findings.length - selected.length,
  };
}

/* ======================================================================
 * Protocol action vocabularies → governed actions
 *
 * Every `cellId` below is the protocol's OWN manifest, and every `kind` is
 * already in that manifest's `allowedActions`. A mismatch is caught by the
 * ranker, not by hope.
 * ====================================================================== */

/** P1 adequacy. Horizon = one month of thrice-weekly therapy. */
export const ADEQUACY_CLINICAL_ACTIONS: Record<string, ClinicalActionSpec | null> = {
  'extend-time': { kind: 'update-care-plan', label: 'Extend treatment time', valueUnit: 'treatments', horizon: 12, approvalClass: 'C', urgency: 0.7, policyCost: 0.4, risk: 0.25, cellId: 'adequacy-prescription', rollback: true },
  'raise-qb': { kind: 'update-care-plan', label: 'Raise blood flow rate', valueUnit: 'treatments', horizon: 12, approvalClass: 'C', urgency: 0.6, policyCost: 0.4, risk: 0.3, cellId: 'adequacy-prescription', rollback: true },
  'reduce-time': { kind: 'update-care-plan', label: 'Reduce treatment time', valueUnit: 'treatments', horizon: 12, approvalClass: 'B', urgency: 0.5, policyCost: 0.35, risk: 0.3, cellId: 'adequacy-prescription', rollback: true },
  'review-access': { kind: 'schedule-followup', label: 'Schedule access review', valueUnit: 'treatments', horizon: 12, approvalClass: 'B', urgency: 0.75, policyCost: 0.5, risk: 0.3, cellId: 'access-clearance-review', rollback: false },
  'adherence-first': { kind: 'notify-staff', label: 'Address adherence before any prescription change', valueUnit: 'treatments', horizon: 12, approvalClass: 'B', urgency: 0.5, policyCost: 0.25, risk: 0.15, cellId: 'adequacy-prescription', rollback: true },
  hold: null,
  blocked: null,
};

/** P2 fluid / IDH. Horizon = one month of thrice-weekly therapy. */
export const FLUID_CLINICAL_ACTIONS: Record<string, ClinicalActionSpec | null> = {
  'reduce-uf-rate': { kind: 'update-care-plan', label: 'Reduce UF rate', valueUnit: 'treatments', horizon: 12, approvalClass: 'C', urgency: 0.75, policyCost: 0.4, risk: 0.3, cellId: 'fluid-uf-optimizer', rollback: true },
  'extend-time-for-uf': { kind: 'update-care-plan', label: 'Extend session to preserve fluid removal', valueUnit: 'treatments', horizon: 12, approvalClass: 'C', urgency: 0.7, policyCost: 0.4, risk: 0.3, cellId: 'fluid-uf-optimizer', rollback: true },
  'review-dry-weight': { kind: 'update-care-plan', label: 'Review dry weight', valueUnit: 'treatments', horizon: 12, approvalClass: 'B', urgency: 0.55, policyCost: 0.35, risk: 0.25, cellId: 'fluid-uf-optimizer', rollback: true },
  'profile-temperature-sodium': { kind: 'update-care-plan', label: 'Profile temperature and sodium', valueUnit: 'treatments', horizon: 12, approvalClass: 'B', urgency: 0.5, policyCost: 0.3, risk: 0.2, cellId: 'fluid-uf-optimizer', rollback: true },
  'adherence-first': { kind: 'notify-staff', label: 'Address between-session adherence first', valueUnit: 'treatments', horizon: 12, approvalClass: 'B', urgency: 0.5, policyCost: 0.25, risk: 0.15, cellId: 'fluid-uf-optimizer', rollback: true },
  hold: null,
  blocked: null,
};

/** P3 vascular access. Horizon = one month of surveillance (≈13 sessions). */
export const ACCESS_CLINICAL_ACTIONS: Record<string, ClinicalActionSpec | null> = {
  'refer-duplex-ultrasound': { kind: 'schedule-followup', label: 'Refer for duplex ultrasound / fistulogram', valueUnit: 'treatments', horizon: 13, approvalClass: 'C', urgency: 0.8, policyCost: 0.5, risk: 0.3, cellId: 'access-referral', rollback: false },
  'access-team-review': { kind: 'schedule-followup', label: 'Access-team review', valueUnit: 'treatments', horizon: 13, approvalClass: 'B', urgency: 0.7, policyCost: 0.45, risk: 0.3, cellId: 'access-referral', rollback: false },
  'change-cannulation-technique': { kind: 'update-care-plan', label: 'Change cannulation technique', valueUnit: 'treatments', horizon: 13, approvalClass: 'B', urgency: 0.6, policyCost: 0.35, risk: 0.2, cellId: 'access-surveillance-observer', rollback: true },
  'increase-surveillance': { kind: 'schedule-followup', label: 'Increase surveillance cadence', valueUnit: 'treatments', horizon: 13, approvalClass: 'B', urgency: 0.55, policyCost: 0.3, risk: 0.2, cellId: 'access-surveillance-observer', rollback: true },
  'escalate-now': { kind: 'notify-staff', label: 'Escalate to the access team now', valueUnit: 'treatments', horizon: 13, approvalClass: 'B', urgency: 0.95, policyCost: 0.3, risk: 0.4, cellId: 'access-surveillance-observer', rollback: false },
  'catheter-removal-escalation': { kind: 'schedule-followup', label: 'Catheter-removal escalation', valueUnit: 'treatments', horizon: 13, approvalClass: 'C', urgency: 0.85, policyCost: 0.45, risk: 0.25, cellId: 'access-referral', rollback: false },
  'no-action': null,
  blocked: null,
};

/** P0 anemia / ESA. Horizon = one month of weekly dosing.
 *  NOTE the unit: an ESA dose decision is denominated in DOSES. The pack used to
 *  claim 42,000 "dollars" with no cost model behind it, which the console then
 *  rendered as $42,000. */
export const ANEMIA_CLINICAL_ACTIONS: Record<string, ClinicalActionSpec | null> = {
  increase: { kind: 'titrate-med', label: 'Increase ESA dose', valueUnit: 'doses', horizon: 4, approvalClass: 'C', urgency: 0.6, policyCost: 0.55, risk: 0.25, cellId: 'esa-dose-optimization', rollback: true },
  reduce: { kind: 'titrate-med', label: 'Reduce ESA dose', valueUnit: 'doses', horizon: 4, approvalClass: 'C', urgency: 0.6, policyCost: 0.55, risk: 0.25, cellId: 'esa-dose-optimization', rollback: true },
  suspend: { kind: 'hold-med', label: 'Suspend ESA dose', valueUnit: 'doses', horizon: 4, approvalClass: 'C', urgency: 0.7, policyCost: 0.6, risk: 0.3, cellId: 'esa-dose-optimization', rollback: true },
  hold: null,
  blocked: null,
  //
  // A REFUSAL IS NOT A DEAD END.
  //
  // When the iron-first guardrail blocks a dose, the blocker is a MISSING
  // MEASUREMENT, not a clinical judgement — and a missing measurement is exactly
  // what an order fixes. Without this token the block was silent suppression (the
  // patient got no action at all), which is how a staleness guardrail turns into an
  // unmonitored patient.
  //
  // This is also the second proposal kind this pack emits (`anemia.iron.proposal`
  // from the iron-management cell), so the token sits deliberately OFF the dose path.
  'order-iron-panel': {
    kind: 'order-lab', label: 'Order iron studies (ferritin + TSAT)', valueUnit: 'labs', horizon: 1,
    approvalClass: 'B', urgency: 0.7, policyCost: 0.25, risk: 0.1,
    cellId: 'iron-management', rollback: false,
    order: { effect: 'order-lab', payload: { code: 'FERRITIN', priority: 'routine' } },
  },
};

/** P4 CKD-MBD. Horizon = one month of thrice-daily binder dosing. */
export const MBD_CLINICAL_ACTIONS: Record<string, ClinicalActionSpec | null> = {
  'increase-binder': { kind: 'update-care-plan', label: 'Increase phosphate binder', valueUnit: 'doses', horizon: 90, approvalClass: 'C', urgency: 0.6, policyCost: 0.45, risk: 0.25, cellId: 'mbd-therapy-advisor', rollback: true },
  'reduce-binder': { kind: 'update-care-plan', label: 'Reduce phosphate binder', valueUnit: 'doses', horizon: 90, approvalClass: 'C', urgency: 0.55, policyCost: 0.45, risk: 0.25, cellId: 'mbd-therapy-advisor', rollback: true },
  'switch-binder': { kind: 'update-care-plan', label: 'Switch binder class', valueUnit: 'doses', horizon: 90, approvalClass: 'C', urgency: 0.55, policyCost: 0.5, risk: 0.3, cellId: 'mbd-therapy-advisor', rollback: true },
  'start-calcimimetic': { kind: 'update-care-plan', label: 'Start calcimimetic', valueUnit: 'doses', horizon: 90, approvalClass: 'C', urgency: 0.7, policyCost: 0.55, risk: 0.35, cellId: 'mbd-therapy-advisor', rollback: true },
  'increase-calcimimetic': { kind: 'update-care-plan', label: 'Increase calcimimetic', valueUnit: 'doses', horizon: 90, approvalClass: 'C', urgency: 0.65, policyCost: 0.55, risk: 0.35, cellId: 'mbd-therapy-advisor', rollback: true },
  'reduce-calcimimetic': { kind: 'update-care-plan', label: 'Reduce calcimimetic', valueUnit: 'doses', horizon: 90, approvalClass: 'C', urgency: 0.6, policyCost: 0.5, risk: 0.3, cellId: 'mbd-therapy-advisor', rollback: true },
  'start-vitamin-d': { kind: 'update-care-plan', label: 'Start active vitamin D', valueUnit: 'doses', horizon: 90, approvalClass: 'C', urgency: 0.6, policyCost: 0.5, risk: 0.3, cellId: 'mbd-therapy-advisor', rollback: true },
  'reduce-vitamin-d': { kind: 'update-care-plan', label: 'Reduce active vitamin D', valueUnit: 'doses', horizon: 90, approvalClass: 'C', urgency: 0.65, policyCost: 0.5, risk: 0.3, cellId: 'mbd-therapy-advisor', rollback: true },
  'dialysis-dose-review': { kind: 'update-care-plan', label: 'Review dialysis dose (phosphate removal)', valueUnit: 'doses', horizon: 90, approvalClass: 'C', urgency: 0.6, policyCost: 0.45, risk: 0.25, cellId: 'mbd-therapy-advisor', rollback: true },
  // A calcium-ceiling / hypocalcaemia safety review is a real escalation to the
  // safety watch, not a no-op — it is the KDIGO hard-envelope contract firing.
  'safety-review': { kind: 'notify-staff', label: 'CKD-MBD safety review', valueUnit: 'doses', horizon: 90, approvalClass: 'B', urgency: 0.85, policyCost: 0.35, risk: 0.3, cellId: 'mbd-safety-watch', rollback: false },
  'adherence-coaching': { kind: 'notify-staff', label: 'Binder adherence coaching', valueUnit: 'doses', horizon: 90, approvalClass: 'B', urgency: 0.5, policyCost: 0.25, risk: 0.15, cellId: 'mbd-therapy-advisor', rollback: true },
  continue: null,
  hold: null,
  blocked: null,
};

/** P5 nutrition / electrolytes. Horizon = one dietetic care plan. */
export const NUTRITION_CLINICAL_ACTIONS: Record<string, ClinicalActionSpec | null> = {
  'dietitian-referral': { kind: 'schedule-followup', label: 'Refer to renal dietetics', valueUnit: 'care-plans', horizon: 1, approvalClass: 'C', urgency: 0.6, policyCost: 0.4, risk: 0.2, cellId: 'nutrition-pew-advisor', rollback: true },
  'oral-nutrition-supplement': { kind: 'update-care-plan', label: 'Start oral nutrition supplement', valueUnit: 'care-plans', horizon: 1, approvalClass: 'C', urgency: 0.55, policyCost: 0.4, risk: 0.2, cellId: 'nutrition-pew-advisor', rollback: true },
  'dialysis-dose-review': { kind: 'update-care-plan', label: 'Review dialysis dose (intake)', valueUnit: 'care-plans', horizon: 1, approvalClass: 'C', urgency: 0.55, policyCost: 0.45, risk: 0.25, cellId: 'nutrition-pew-advisor', rollback: true },
  'inflammation-review': { kind: 'order-lab', label: 'Order inflammatory panel', valueUnit: 'labs', horizon: 1, approvalClass: 'B', urgency: 0.6, policyCost: 0.3, risk: 0.15, cellId: 'nutrition-pew-advisor', rollback: true },
  'target-weight-reassessment': { kind: 'update-care-plan', label: 'Reassess target weight', valueUnit: 'care-plans', horizon: 1, approvalClass: 'B', urgency: 0.5, policyCost: 0.3, risk: 0.2, cellId: 'nutrition-pew-advisor', rollback: true },
  'k-binder-plan': { kind: 'update-care-plan', label: 'Start potassium binder plan', valueUnit: 'care-plans', horizon: 1, approvalClass: 'C', urgency: 0.7, policyCost: 0.5, risk: 0.3, cellId: 'nutrition-pew-advisor', rollback: true },
  'diet-potassium-education': { kind: 'update-care-plan', label: 'Dietary potassium education', valueUnit: 'care-plans', horizon: 1, approvalClass: 'B', urgency: 0.55, policyCost: 0.3, risk: 0.2, cellId: 'nutrition-pew-advisor', rollback: true },
  'raasi-review': { kind: 'update-care-plan', label: 'Review RAASi therapy', valueUnit: 'care-plans', horizon: 1, approvalClass: 'C', urgency: 0.6, policyCost: 0.5, risk: 0.3, cellId: 'nutrition-pew-advisor', rollback: true },
  'alkali-review': { kind: 'update-care-plan', label: 'Review alkali therapy', valueUnit: 'care-plans', horizon: 1, approvalClass: 'C', urgency: 0.55, policyCost: 0.45, risk: 0.25, cellId: 'nutrition-pew-advisor', rollback: true },
  'urgent-lab-confirmation': { kind: 'order-lab', label: 'Urgent confirmatory potassium', valueUnit: 'labs', horizon: 1, approvalClass: 'C', urgency: 0.9, policyCost: 0.35, risk: 0.3, cellId: 'electrolyte-safety-watch', rollback: false, order: { effect: 'order-lab', payload: { code: 'K', priority: 'stat' } } },
  'ed-triage': { kind: 'flag-safety-event', label: 'Emergency department triage', valueUnit: 'safety-events', horizon: 1, approvalClass: 'C', urgency: 0.95, policyCost: 0.4, risk: 0.4, cellId: 'electrolyte-safety-watch', rollback: false },
  'potassium-restriction': { kind: 'update-care-plan', label: 'Potassium restriction plan', valueUnit: 'care-plans', horizon: 1, approvalClass: 'B', urgency: 0.6, policyCost: 0.3, risk: 0.2, cellId: 'nutrition-pew-advisor', rollback: true },
  continue: null,
  blocked: null,
};

/** P6 infection. Horizon = one clinical action; prevention half is rule-driven. */
export const INFECTION_CLINICAL_ACTIONS: Record<string, ClinicalActionSpec | null> = {
  'blood-culture-order': { kind: 'order-lab', label: 'Order blood cultures before antibiotics', valueUnit: 'labs', horizon: 1, approvalClass: 'C', urgency: 0.85, policyCost: 0.35, risk: 0.25, cellId: 'bsi-triage', rollback: true, order: { effect: 'order-lab', payload: { code: 'BCULT', priority: 'stat' } } },
  'culture-then-antibiotic-discussion': { kind: 'flag-safety-event', label: 'Culture-then-antibiotic discussion', valueUnit: 'escalations', horizon: 1, approvalClass: 'C', urgency: 0.9, policyCost: 0.4, risk: 0.3, cellId: 'bsi-triage', rollback: false },
  'empiric-antibiotic-discussion': { kind: 'flag-safety-event', label: 'Escalate for clinician antibiotic decision', valueUnit: 'escalations', horizon: 1, approvalClass: 'C', urgency: 0.95, policyCost: 0.45, risk: 0.35, cellId: 'bsi-triage', rollback: false },
  'temperature-surveillance': { kind: 'notify-staff', label: 'Intensify temperature surveillance', valueUnit: 'observations', horizon: 1, approvalClass: 'B', urgency: 0.5, policyCost: 0.2, risk: 0.15, cellId: 'bsi-triage', rollback: true },
  'isolation-review': { kind: 'notify-staff', label: 'Isolation precaution review', valueUnit: 'notifications', horizon: 1, approvalClass: 'C', urgency: 0.6, policyCost: 0.35, risk: 0.2, cellId: 'bsi-triage', rollback: true },
  'catheter-removal-escalation': { kind: 'notify-staff', label: 'Catheter-removal escalation', valueUnit: 'notifications', horizon: 1, approvalClass: 'C', urgency: 0.8, policyCost: 0.4, risk: 0.25, cellId: 'bsi-triage', rollback: false },
  'urgent-clinical-review': { kind: 'flag-safety-event', label: 'Urgent clinical review', valueUnit: 'escalations', horizon: 1, approvalClass: 'C', urgency: 0.95, policyCost: 0.45, risk: 0.35, cellId: 'bsi-triage', rollback: false },
  'vaccination-outreach': { kind: 'schedule-followup', label: 'Vaccination outreach (rule-driven)', valueUnit: 'notifications', horizon: 1, approvalClass: 'B', urgency: 0.55, policyCost: 0.25, risk: 0.1, cellId: 'infection-prevention', rollback: true },
  'serology-followup': { kind: 'order-lab', label: 'Order anti-HBs serology follow-up', valueUnit: 'labs', horizon: 1, approvalClass: 'B', urgency: 0.6, policyCost: 0.25, risk: 0.1, cellId: 'infection-prevention', rollback: true },
  'access-care-review': { kind: 'record-assessment', label: 'Access-care audit task', valueUnit: 'assessments', horizon: 1, approvalClass: 'B', urgency: 0.5, policyCost: 0.2, risk: 0.1, cellId: 'infection-prevention', rollback: true },
  'audit-task': { kind: 'record-assessment', label: 'Infection-prevention audit task', valueUnit: 'assessments', horizon: 1, approvalClass: 'B', urgency: 0.45, policyCost: 0.2, risk: 0.1, cellId: 'infection-prevention', rollback: true },
  continue: null,
  blocked: null,
};

export const CLINICAL_ACTION_MAPS: Record<ClinicalProtocolId, Record<string, ClinicalActionSpec | null>> = {
  adequacy: ADEQUACY_CLINICAL_ACTIONS,
  fluid: FLUID_CLINICAL_ACTIONS,
  access: ACCESS_CLINICAL_ACTIONS,
  anemia: ANEMIA_CLINICAL_ACTIONS,
  mbd: MBD_CLINICAL_ACTIONS,
  nutrition: NUTRITION_CLINICAL_ACTIONS,
  infection: INFECTION_CLINICAL_ACTIONS,
};

/* ======================================================================
 * Finding adapters — one per protocol, from the engine's own recommendation
 * ====================================================================== */

/** Adequacy: urgency scales with the prescription change the engine asks for,
 *  and — when no change is asked for — with the delivered-time shortfall that
 *  actually fired the adherence flag. `adherencePct` lives on the WINDOW, not on
 *  the recommendation (the rec only carries what it prescribed), so the caller
 *  passes it in; clearance alone cannot differentiate these patients because
 *  they are all IN band. */
export function adequacyFindings(
  inputs: Array<ClinicalRecInput<AdequacyRecommendation> & { adherencePct?: number | undefined }>,
): ClinicalFinding[] {
  return inputs.map(({ rec, facilityId, realmId, adherencePct }) => {
    const delta = Math.abs(rec.recommended?.deltaMinutes ?? 0);
    const shortfall = adherencePct !== undefined ? Math.max(0, (100 - adherencePct) / 100) : 0;
    const urgency = clamp01(0.45 + Math.max(Math.min(0.5, delta / 90), Math.min(0.5, shortfall * 1.5)));
    // Report the measurement that justifies THIS action, so the title is never
    // misleading (an in-band clearance is not the problem being fixed here).
    const observed = rec.action === 'adherence-first' && adherencePct !== undefined ? adherencePct : rec.current.spKtV;
    const evidence = evidenceFromDrivers('adequacy', rec.patientId, rec.drivers, 'session.ended.v1');
    if (adherencePct !== undefined) {
      evidence.unshift({
        sourceId: `session.ended.v1:delivered-pct:${rec.patientId}`,
        contentType: 'fact',
        span: `Delivered ${adherencePct}% of prescribed treatment time`,
      });
    }
    return {
      patientId: rec.patientId,
      ...(facilityId !== undefined ? { facilityId } : {}),
      ...(realmId !== undefined ? { realmId } : {}),
      action: rec.action,
      ...(observed !== undefined ? { observed } : {}),
      urgency,
      recommendation: rec.note || `Adequacy action ${rec.action} for ${rec.patientId}.`,
      evidence,
      drivers: rec.drivers,
      model: rec.model,
    };
  });
}

/** Fluid: urgency from the engine's own IDH probability at 60 minutes. */
export function fluidFindings(inputs: Array<ClinicalRecInput<FluidRecommendation>>): ClinicalFinding[] {
  return inputs.map(({ rec, facilityId, realmId }) => {
    const idh60 = rec.current.idhRiskByMinute?.[60] ?? 0;
    return {
      patientId: rec.patientId,
      ...(facilityId !== undefined ? { facilityId } : {}),
      ...(realmId !== undefined ? { realmId } : {}),
      action: rec.action,
      ...(rec.current.ufRatePerKg !== undefined ? { observed: rec.current.ufRatePerKg } : {}),
      urgency: clamp01(0.45 + 0.5 * idh60),
      // The engine's risk is the candidate's harm plausibility, not a guess.
      recommendation: rec.note || `Fluid action ${rec.action} for ${rec.patientId}.`,
      evidence: evidenceFromDrivers('fluid', rec.patientId, rec.drivers, 'session.telemetry.v1'),
      drivers: rec.drivers,
      model: rec.model,
    };
  });
}

/** Access: urgency from the engine's own stenosis probability. */
export function accessFindings(inputs: Array<ClinicalRecInput<AccessRecommendation>>): ClinicalFinding[] {
  return inputs.map(({ rec, facilityId, realmId }) => ({
    patientId: rec.patientId,
    ...(facilityId !== undefined ? { facilityId } : {}),
    ...(realmId !== undefined ? { realmId } : {}),
    action: rec.action,
    observed: rec.stenosisProbability,
    urgency: clamp01(0.45 + 0.5 * rec.stenosisProbability),
    recommendation: rec.note || `Access action ${rec.action} for ${rec.patientId}.`,
    evidence: evidenceFromDrivers('access', rec.patientId, rec.drivers, 'access.observed.v1'),
    drivers: rec.drivers,
    model: rec.model,
  }));
}

/** Anemia: the direction IS the action; urgency scales with the dose step. */
export function anemiaFindings(inputs: Array<ClinicalRecInput<EsaRecommendation>>): ClinicalFinding[] {
  return inputs.map(({ rec, facilityId, realmId, whatIf }) => {
    const stepPct = rec.currentDose > 0 && rec.delta !== 0 ? Math.abs(rec.delta) / rec.currentDose : 0;
    return {
      patientId: rec.patientId,
      ...(facilityId !== undefined ? { facilityId } : {}),
      ...(realmId !== undefined ? { realmId } : {}),
      ...anemiaActionFor(rec),
      ...(rec.currentDose > 0 ? { observed: rec.currentDose } : {}),
      urgency: clamp01(0.5 + Math.min(0.45, stepPct)),
      ...(esaOrderDraft(rec) !== undefined ? { order: esaOrderDraft(rec)! } : {}),
      // The curve the recommendation came from. When a caller supplies the engine's
      // own what-if, the approval shows it; the bridge never invents one.
      ...(whatIf !== undefined ? { trajectory: esaTrajectory(whatIf) } : {}),
      evidence: evidenceFromDrivers(
        'anemia',
        rec.patientId,
        rec.drivers,
        rec.guardrails.blocked ? 'esa.guardrail' : 'lab.result-arrived',
      ),      drivers: rec.drivers,
      model: rec.model,
    };
  });
}

/** CKD-MBD: urgency from how far outside the coupled target the patient sits. */
export function mbdFindings(inputs: Array<ClinicalRecInput<MbdRecommendation>>): ClinicalFinding[] {
  return inputs.map(({ rec, facilityId, realmId }) => ({
    patientId: rec.patientId,
    ...(facilityId !== undefined ? { facilityId } : {}),
    ...(realmId !== undefined ? { realmId } : {}),
    action: rec.action,
    ...(rec.current.phosphate !== undefined ? { observed: rec.current.phosphate } : {}),
    urgency: clamp01(rec.inTarget ? 0.45 : 0.72),
    recommendation: rec.note || `CKD-MBD action ${rec.action} for ${rec.patientId}.`,
    evidence: evidenceFromDrivers('mbd', rec.patientId, rec.drivers, 'lab.result-arrived'),
    drivers: rec.drivers,
    model: rec.model,
  }));
}

/** Nutrition: urgency from the safety contract (emergency > plan > routine). */
export function nutritionFindings(inputs: Array<ClinicalRecInput<NutritionRecommendation>>): ClinicalFinding[] {
  return inputs.map(({ rec, facilityId, realmId }) => ({
    patientId: rec.patientId,
    ...(facilityId !== undefined ? { facilityId } : {}),
    ...(realmId !== undefined ? { realmId } : {}),
    action: rec.action,
    ...(rec.current.potassium !== undefined ? { observed: rec.current.potassium } : {}),
    // A plan is rarely one lever: the value scales with the number of levers.
    amount: Math.max(1, rec.plan.length),
    urgency: clamp01(rec.safety.emergency ? 0.95 : rec.action === 'continue' ? 0.3 : 0.6),
    recommendation: rec.note || `Nutrition action ${rec.action} for ${rec.patientId}.`,
    evidence: evidenceFromDrivers('nutrition', rec.patientId, rec.drivers, 'lab.result-arrived'),
    drivers: rec.drivers,
    model: rec.model,
  }));
}

/** Infection: triage half is statistical; prevention half is rule-driven.
 *  Urgency comes from the triage band (a policy verdict), not the raw number —
 *  the band is what the protocol acts on. */
export function infectionFindings(inputs: Array<ClinicalRecInput<InfectionRecommendation>>): ClinicalFinding[] {
  return inputs.map(({ rec, facilityId, realmId }) => {
    const bandUrgency = rec.assessment.band === 'high' ? 0.9 : rec.assessment.band === 'watch' ? 0.6 : 0.45;
    return {
      patientId: rec.patientId,
      ...(facilityId !== undefined ? { facilityId } : {}),
      ...(realmId !== undefined ? { realmId } : {}),
      action: rec.action,
      observed: rec.assessment.probability,
      urgency: clamp01(bandUrgency),
      recommendation: rec.note || `Infection action ${rec.action} for ${rec.patientId}.`,
      evidence: evidenceFromDrivers('infection', rec.patientId, rec.drivers, 'lab.result-arrived'),
      drivers: rec.drivers,
      model: rec.model,
    };
  });
}
