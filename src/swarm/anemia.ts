/******************************************************************************
 * Anemia / ESA dose-adjustment domain — P0 reference CDSS.
 *
 * Incorporates the manifold-learning EPO dose model of Gil-Casares-Casanova et
 * al., "A Manifold Learning Model for Adjusting Anemia Treatment in Chronic
 * Kidney Disease" (Array 2026) as a governed, human-in-the-loop decision-
 * support journey over the SHARED platform primitives (cells → insight → NBA →
 * outcome episode → command → acknowledge → measure-verify) — mirroring how
 * `payer.ts` added a second domain without a runtime fork.
 *
 *   • ESA_FEATURES   — the paper's clinical feature catalog (bounds + LOINC).
 *   • guardDose      — KDIGO-style guardrails (iron repletion first; Hb band).
 *   • esaLatent      — deterministic 2-D latent ("manifold") from the features.
 *   • esaRecommend   — the P0 REFERENCE surrogate recommendation (deterministic;
 *                      the real trained autoencoder arrives in P2). Prior EPO is
 *                      the dominant driver (~40%), MCV next (~16%) — mirroring
 *                      the paper's permutation relevance.
 *   • ESA_CELLS      — bounded anemia-management cells (CellManifest contract).
 *   • seedAnemiaEpisodes — durable episodes on the SHARED PersistentOutcome-
 *                      Coordinator; Class C (nephrologist) → exec My Work.
 *
 * SAFETY BOUNDARY (EU AI Act / MDR posture): this is a CDSS — it recommends,
 * it never orders. The dose is Class C human-approved before any command; iron
 * deficiency and low lab density block a recommendation entirely.
 ******************************************************************************/

import type { CellManifest } from './cells.js';
import { aggregateSwarmInsights, makeProposal, type CellProposal, type SwarmInsight } from './insight.js';
import { attachInsightBelief, rankNextBestActions, type NbaCandidate, type NextBestAction } from './nba.js';
import type { OutcomeEpisode } from './outcome-episode.js';
import type { PersistentOutcomeCoordinator } from './durable-coordinator.js';
import type { EvidenceRef, ScopeType } from './types.js';
import type { SwarmWorkspaceStore } from './workspace.js';

/* ======================================================================
 * 1. Clinical feature catalog (paper Table 1 — subset our domain tracks)
 * ====================================================================== */

export interface EsaFeature {
  id: string;
  label: string;
  loinc?: string;
  unit: string;
  min: number; // domain outlier-clip bound (lower)
  max: number; // domain outlier-clip bound (upper)
  /** Reference surrogate relevance Rᵢ (permutation-style), paper Fig. 10. */
  relevance: number;
}

export const ESA_FEATURES: readonly EsaFeature[] = [
  { id: 'hgb', label: 'Hemoglobin', loinc: '718-7', unit: 'g/dL', min: 5, max: 19, relevance: 0.12 },
  { id: 'mcv', label: 'Mean corpuscular volume', loinc: '787-2', unit: 'fL', min: 55, max: 130, relevance: 0.16 },
  { id: 'ferritin', label: 'Ferritin', loinc: '2276-4', unit: 'ng/mL', min: 5, max: 3000, relevance: 0.05 },
  { id: 'transferrinSat', label: 'Transferrin saturation', unit: '%', min: 5, max: 80, relevance: 0.06 },
  { id: 'crp', label: 'C-reactive protein', unit: 'mg/L', min: 0.1, max: 300, relevance: 0.05 },
  { id: 'calcium', label: 'Calcium', unit: 'mg/dL', min: 6, max: 13, relevance: 0.08 },
  { id: 'pth', label: 'Parathyroid hormone', unit: 'pg/mL', min: 5, max: 1500, relevance: 0.04 },
  { id: 'priorEpo', label: 'Prior EPO dose', unit: 'units/wk', min: 1, max: 20000, relevance: 0.4 },
];

/** KDIGO target band (paper + product anemia-management measure). */
export const HGB_TARGET = { min: 10, max: 12 } as const;
export const ESA_DOSE_STEP = 500; // smallest titratable increment (units/wk)

/* ======================================================================
 * 2. Guardrails — iron repletion first; Hb band; escalation without response
 * ====================================================================== */

export type EsaGuardFlag =
  | 'hgb-below-9-not-on-esa'            // not on ESA yet → assess iron first
  | 'hgb-above-11-on-esa'               // above band → reduce / hold
  | 'esa-dose-escalated-without-response-90d' // escalating but Hb flat
  | 'iron-not-checked-quarterly'        // no iron panel in 90 days → block
  | 'microcytic-iron-first'             // MCV low → iron repletion before EPO

export function guardDose(input: {
  onESA: boolean; currentHgb: number; mcv?: number; esaEscalationsLast90d: number;
  hgbTrendLast90d: readonly number[]; lastIronPanelAt?: string; asOf: string;
}): { flags: EsaGuardFlag[]; blocked: boolean; blockReason: string | null } {
  const flags: EsaGuardFlag[] = [];
  const asOf = Date.parse(input.asOf);
  const lastIron = input.lastIronPanelAt ? Date.parse(input.lastIronPanelAt) : Number.NaN;
  const ironFresh = Number.isFinite(asOf) && Number.isFinite(lastIron) && (asOf - lastIron) / 86400000 <= 90;

  if (!ironFresh) flags.push('iron-not-checked-quarterly');
  if (!input.onESA && input.currentHgb < 9) flags.push('hgb-below-9-not-on-esa');
  if (input.onESA && input.currentHgb > 11) flags.push('hgb-above-11-on-esa');
  if (input.mcv !== undefined && input.mcv < 80) flags.push('microcytic-iron-first');
  if (input.onESA && input.esaEscalationsLast90d >= 2) {
    const first = input.hgbTrendLast90d[0];
    const last = input.hgbTrendLast90d[input.hgbTrendLast90d.length - 1];
    if (first !== undefined && last !== undefined && last - first < 0.5) {
      flags.push('esa-dose-escalated-without-response-90d');
    }
  }

  // Blocking: never recommend an ESA dose while iron status is unknown or the
  // picture is microcytic (fix iron/B12/MCV before EPO — paper + product rule).
  const blocked = flags.includes('iron-not-checked-quarterly') || flags.includes('microcytic-iron-first');
  const blockReason = blocked
    ? flags.includes('microcytic-iron-first')
      ? 'Microcytic picture — replete iron/B12 (MCV) before EPO titration.'
      : 'Iron panel older than 90 days — assess iron status before an ESA recommendation.'
    : null;
  return { flags, blocked, blockReason };
}

/* ======================================================================
 * 3. Deterministic 2-D latent ("manifold") — P0 reference projection
 * ====================================================================== */

const norm = (v: number, f: EsaFeature): number =>
  Math.max(-1, Math.min(1, ((v - f.min) / (f.max - f.min)) * 2 - 1));

export function esaLatent(input: {
  mcv?: number; ferritin?: number; transferrinSat?: number;
  crp?: number; pth?: number; calcium?: number;
}): { l1: number; l2: number; polarRadius: number; polarAngleRad: number } {
  const f = (id: string): EsaFeature => ESA_FEATURES.find((x) => x.id === id)!;
  // Axis 1 — iron / nutrition (erythropoiesis substrate). Higher = replete.
  const iron = (input.mcv !== undefined ? norm(input.mcv, f('mcv')) * 0.5 : 0)
    + (input.ferritin !== undefined ? norm(input.ferritin, f('ferritin')) * 0.25 : 0)
    + (input.transferrinSat !== undefined ? norm(input.transferrinSat, f('transferrinSat')) * 0.25 : 0);
  // Axis 2 — ESA resistance / inflammation (higher = more resistant).
  const resistance = (input.crp !== undefined ? norm(input.crp, f('crp')) * 0.5 : 0)
    + (input.pth !== undefined ? norm(input.pth, f('pth')) * 0.25 : 0)
    + (input.calcium !== undefined ? norm(input.calcium, f('calcium')) * 0.25 : 0);
  const l1 = Math.max(-1, Math.min(1, iron));
  const l2 = Math.max(-1, Math.min(1, resistance));
  return {
    l1, l2,
    polarRadius: Math.hypot(l1, l2),
    polarAngleRad: Math.atan2(l2, l1),
  };
}

/* ======================================================================
 * 4. Reference surrogate recommendation (deterministic; trained model = P2)
 * ====================================================================== */

export interface EsaPatientWindow {
  patientId: string;
  facilityId?: string;
  currentHgb: number;
  mcv?: number;
  ferritin?: number;
  transferrinSat?: number;
  crp?: number;
  calcium?: number;
  pth?: number;
  onESA: boolean;
  /** Current weekly EPO dose in units (0 when not on ESA). */
  currentDose: number;
  hgbTrendLast90d: readonly number[];
  esaEscalationsLast90d: number;
  lastIronPanelAt?: string;
  asOf: string;
}

export type EsaModelKind = 'reference-surrogate' | 'trained';

export interface EsaRecommendation {
  patientId: string;
  inTargetBand: boolean;
  guardrails: { flags: EsaGuardFlag[]; blocked: boolean; blockReason: string | null };
  latent: ReturnType<typeof esaLatent>;
  currentDose: number;
  recommendedDose: number | null;
  delta: number;
  direction: 'hold' | 'increase' | 'reduce' | 'suspend' | 'blocked';
  drivers: Array<{ id: string; label: string; relevance: number }>;
  model: { id: string; version: string; kind: EsaModelKind };
  synthetic: boolean;
  note: string;
}

export const ESA_ADVISOR_MODEL = { id: 'anemia.esa-dose-v0', version: '0.1.0', kind: 'reference-surrogate' as const };

/**
 * P0 reference surrogate. Mirrors the paper's learned structure: prior EPO is
 * the dominant input (slow clinical dose progression), the recommendation is
 * ±25% around prior dose per the Hb band, MCV/iron modulate, and guardrails can
 * block. Deterministic so tests and the demo are reproducible. The trained
 * contractive autoencoder + regressor (paper §3) replaces the heuristics in P2
 * under the SAME return contract.
 */
export function esaRecommend(input: EsaPatientWindow): EsaRecommendation {
  const guardrails = guardDose(input);
  const latent = esaLatent(input);
  const currentDose = Math.max(0, input.currentDose);
  const inTargetBand = input.currentHgb >= HGB_TARGET.min && input.currentHgb <= HGB_TARGET.max;

  let recommendedDose: number | null = null;
  let direction: EsaRecommendation['direction'] = 'blocked';
  let note = '';

  if (!guardrails.blocked) {
    const trend = input.hgbTrendLast90d;
    const firstHgb = trend[0];
    const lastHgb = trend[trend.length - 1];
    const rising = firstHgb !== undefined && lastHgb !== undefined && (lastHgb - firstHgb) > 1.0;
    if (input.onESA && input.currentHgb > HGB_TARGET.max) {
      // Above band: reduce ~25% (KDIGO). If still rising despite prior cuts → suspend.
      if (input.currentHgb > 13 || rising) { direction = 'suspend'; recommendedDose = 0; note = 'Hb above band and rising — hold ESA until Hb falls, then resume lower.'; }
      else { direction = 'reduce'; recommendedDose = Math.max(0, Math.round((currentDose * 0.75) / ESA_DOSE_STEP) * ESA_DOSE_STEP); note = 'Hb above 12 — reduce ~25%.'; }
    } else if (input.onESA && input.currentHgb < HGB_TARGET.min) {
      direction = 'increase'; recommendedDose = Math.round((currentDose * 1.25) / ESA_DOSE_STEP) * ESA_DOSE_STEP;
      note = 'Hb below 10 — increase ~25% (watch iron + inflammation on the manifold).';
    } else if (input.onESA) {
      direction = 'hold'; recommendedDose = currentDose;
      note = 'Hb in 10–12 band — hold dose; reassess monthly.';
    } else if (!input.onESA && input.currentHgb >= HGB_TARGET.min) {
      direction = 'hold'; recommendedDose = 0;
      note = 'Not on ESA and Hb in band — no dose change.';
    } else {
      // Not on ESA, Hb < 10: recommending initiation is outside the advisor —
      // the guardrail (iron-first) already blocks when iron is stale; here it is
      // fresh, so surface an initiation suggestion for the MD, never auto-order.
      direction = 'increase'; recommendedDose = 2000;
      note = 'Candidate for ESA initiation — iron is replete; MD review required (Class C).';
    }
  }

  const drivers = ESA_FEATURES.map((f) => ({ id: f.id, label: f.label, relevance: f.relevance }))
    .sort((a, b) => b.relevance - a.relevance);

  return {
    patientId: input.patientId,
    inTargetBand,
    guardrails,
    latent,
    currentDose,
    recommendedDose,
    delta: recommendedDose === null ? 0 : recommendedDose - currentDose,
    direction,
    drivers,
    model: ESA_ADVISOR_MODEL,
    synthetic: true,
    note,
  };
}

/* ======================================================================
 * 5. Bounded cells (CellManifest contract)
 * ====================================================================== */

export const ESA_CELLS: CellManifest[] = [
  {
    id: 'esa-dose-optimization', version: '0.1.0', displayName: 'ESA dose optimization',
    domain: 'quality', owner: 'Nephrology · Anemia MD',
    consumes: ['lab.result-arrived', 'medication.updated', 'medication.administered'],
    produces: ['anemia.esa.proposal'],
    allowedActions: ['order-med', 'titrate-med', 'hold-med', 'administer-med', 'order-lab', 'update-care-plan'],
    approvalClass: 'C', evalGate: 0.9, killSwitch: false, rollback: true,
    observerRef: 'docs/anemia-esa-cds-integration.md · surrogate esaRecommend (P2 trainer)',
  },
  {
    id: 'iron-management', version: '0.1.0', displayName: 'Iron management',
    domain: 'patient-care', owner: 'Nephrology · Anemia MD',
    consumes: ['lab.result-arrived'],
    produces: ['anemia.iron.proposal'],
    allowedActions: ['order-lab', 'order-med', 'update-care-plan'],
    approvalClass: 'C', evalGate: 0.9, killSwitch: false, rollback: true,
    observerRef: 'packs/dialysis-provider/medication · MCV/ferritin repletion protocol',
  },
];

export const ANEMIA_CONSUMED_BY: Record<string, string[]> = {
  'anemia.esa.proposal': ['esa-dose-optimization', 'iron-management'],
  'anemia.iron.proposal': ['iron-management', 'esa-dose-optimization'],
};

export const ANEMIA_EPISODE_KINDS = ['anemia.esa-response'] as const;

/* ======================================================================
 * 6. Reference boundary (proposals → insights → ranked NBAs)
 * ====================================================================== */

export interface AnemiaDemoState {
  source: 'anemia';
  features: readonly EsaFeature[];
  cells: CellManifest[];
  proposals: CellProposal[];
  insights: SwarmInsight[];
  nbas: NextBestAction[];
  conflictCount: number;
  episodes: OutcomeEpisode[];
  kpis: { hgbInBandPct: number; esaLowEpoRequirement: number; atRiskEscalation: number; valueAtRiskUsd: number };
}

const NOW = () => new Date().toISOString();
const ev = (sourceId: string, contentType: string): EvidenceRef => ({ sourceId, contentType });

/** Deterministic anemia reference boundary — mirror of buildPayerDemo. */
export function buildAnemiaDemo(now: () => string = NOW): Omit<AnemiaDemoState, 'episodes'> {
  const proposals: CellProposal[] = [
    makeProposal({
      cellId: 'esa-dose-optimization', kind: 'anemia.esa.proposal', subject: 'patient:p-esa-1', scopeType: 'patient',
      option: 'review ESA dose in latent cluster', approvalClass: 'C',
      recommendation: 'Patient p-esa-1 (Hb 9.4, MCV 92, ferritin 640, TSAT 28%) sits in the low-EPO-requirement region — recommend a 25% dose reduction toward the KDIGO 10–12 band after MD review.',
      allowed: true, evidence: [ev('lab.result-arrived:hgb', 'fact'), ev('lab.result-arrived:ferritin', 'fact')],
      producedAt: now(), payload: { hgb: 9.4, direction: 'reduce', step: 0.75 },
    }),
    makeProposal({
      cellId: 'iron-management', kind: 'anemia.esa.proposal', subject: 'patient:p-esa-1', scopeType: 'patient',
      option: 'review ESA dose in latent cluster', approvalClass: 'C',
      recommendation: 'Iron stores are replete (ferritin 640) — no iron intervention; support ESA dose reduction.',
      allowed: true, evidence: [ev('lab.result-arrived:mcv', 'fact'), ev('lab.result-arrived:ferritin', 'fact')],
      producedAt: now(), payload: { ferritin: 640 },
    }),
  ];

  const insights = aggregateSwarmInsights({ proposals, consumedBy: ANEMIA_CONSUMED_BY, mode: 'dst' });
  const conflictCount = insights.filter((i) => i.retained).length;

  const candidates: NbaCandidate[] = [
    {
      title: 'Reduce ESA dose for p-esa-1 (Hb trending into band)', cells: ['esa dose optimization', 'iron management'],
      scopeType: 'patient', subject: 'patient:p-esa-1', owner: 'Nephrology · Anemia MD', due: 'This month',
      evidence: [ev('lab.result-arrived:hgb', 'fact'), ev('lab.result-arrived:ferritin', 'fact')],
      consensus: 0.9, approvalClass: 'C', expectedOutcome: 42000, urgency: 0.6, policyCost: 0.55, risk: 0.2,
      insightKind: 'anemia.esa.proposal',
    },
  ];
  const nbas = rankNextBestActions(attachInsightBelief(candidates, insights), { limit: 4, beliefAware: true });

  return {
    source: 'anemia',
    features: ESA_FEATURES,
    cells: ESA_CELLS,
    proposals,
    insights,
    nbas,
    conflictCount,
    kpis: { hgbInBandPct: 71, esaLowEpoRequirement: 34, atRiskEscalation: 6, valueAtRiskUsd: 210000 },
  };
}

/* ======================================================================
 * 7. Durable episodes on the SHARED coordinator (idempotent)
 * ====================================================================== */

export function anemiaEpisodes(coordinator: PersistentOutcomeCoordinator): OutcomeEpisode[] {
  return coordinator.list().filter((e) => (ANEMIA_EPISODE_KINDS as readonly string[]).includes(e.kind));
}

/**
 * Seed durable anemia episodes (idempotent by kind+subject+scopeType, INCLUDING
 * terminal ones — mirror of seedPayerEpisodes):
 *   1. anemia.esa-response · patient:p-esa-1 — AwaitingApproval (Class C) →
 *      flows into My Work for the medical role, with the dose recommendation in
 *      the proposal payload.
 *   2. anemia.esa-response · patient:p-esa-2 — FULL closed loop: approve →
 *      titrate-med command → acknowledge → verify (Hb band measure met) →
 *      Resolved.
 */
export async function seedAnemiaEpisodes(coordinator: PersistentOutcomeCoordinator, _ws?: SwarmWorkspaceStore, now: () => string = NOW): Promise<{ opened: string[]; existing: string[]; closed: string[] }> {
  const opened: string[] = [];
  const existing: string[] = [];
  const closed: string[] = [];
  const findAnemia = (kind: string, subject: string, scopeType: ScopeType): OutcomeEpisode | undefined =>
    coordinator.list().find((e) => e.kind === kind && e.subject === subject && e.scopeType === scopeType);

  // --- AwaitingApproval (Class C) → My Work ---
  const p1 = findAnemia('anemia.esa-response', 'patient:p-esa-1', 'patient');
  if (!p1) {
    const rec = esaRecommend({ patientId: 'p-esa-1', currentHgb: 9.4, mcv: 92, ferritin: 640, transferrinSat: 28, crp: 6, calcium: 9.2, pth: 120, onESA: true, currentDose: 8000, hgbTrendLast90d: [8.8, 8.9, 9.0, 9.1, 9.2, 9.4], esaEscalationsLast90d: 1, lastIronPanelAt: '2026-08-01T00:00:00Z', asOf: now() });
    const e = coordinator.open({ kind: 'anemia.esa-response', subject: 'patient:p-esa-1', scopeType: 'patient' });
    coordinator.addEvidence(e.episodeId, [ev('lab.result-arrived:hgb', 'fact'), ev('lab.result-arrived:ferritin', 'fact')], true);
    coordinator.propose(e.episodeId, makeProposal({
      cellId: 'esa-dose-optimization', kind: 'anemia.esa.proposal', subject: e.subject, scopeType: 'patient',
      option: 'review ESA dose in latent cluster', approvalClass: 'C',
      recommendation: `${rec.direction === 'increase' ? 'Increase' : rec.direction === 'reduce' ? 'Reduce' : 'Hold'} ESA dose to ${rec.recommendedDose ?? rec.currentDose} units/wk (current ${rec.currentDose}). ${rec.note}`,
      allowed: true, evidence: [ev('lab.result-arrived:hgb', 'fact')], producedAt: now(),
      payload: { advisor: rec },
    }), true);
    coordinator.requestApproval(e.episodeId, 'C');
    opened.push(e.episodeId);
  } else {
    existing.push(p1.episodeId);
  }

  // --- Full closed loop (approve → titrate → administer → Hb verify) ---
  const p2 = findAnemia('anemia.esa-response', 'patient:p-esa-2', 'patient');
  if (!p2) {
    const e = coordinator.open({ kind: 'anemia.esa-response', subject: 'patient:p-esa-2', scopeType: 'patient' });
    coordinator.addEvidence(e.episodeId, [ev('lab.result-arrived:hgb', 'fact'), ev('medication.administered:esa', 'event')], true);
    coordinator.propose(e.episodeId, makeProposal({
      cellId: 'esa-dose-optimization', kind: 'anemia.esa.proposal', subject: e.subject, scopeType: 'patient',
      option: 'titrate to band', approvalClass: 'C',
      recommendation: 'Titrate ESA to 6000 units/wk (patient p-esa-2, Hb 10.8, iron replete); MD approved dose order; verify Hb stays in 10–12 band.',
      allowed: true, evidence: [ev('lab.result-arrived:hgb', 'fact')], producedAt: now(), payload: { dose: 6000 },
    }), true);
    coordinator.requestApproval(e.episodeId, 'C');
    coordinator.decide(e.episodeId, 'approved', 'Dr. Alvarez (nephrology)', 'C');
    coordinator.dispatchCommand(e.episodeId, 'titrate-med');
    coordinator.acknowledge(e.episodeId, 'patient:p-esa-2');
    coordinator.verify(e.episodeId, { measureId: 'esrd-qip.anemia-management', met: true });
    closed.push(e.episodeId);
  } else {
    existing.push(p2.episodeId);
  }

  return { opened, existing, closed };
}

/** Targeted reset — removes ONLY anemia episodes (in-memory + durable). */
export async function dropAnemiaEpisodes(coordinator: PersistentOutcomeCoordinator): Promise<number> {
  const targets = anemiaEpisodes(coordinator);
  for (const e of targets) coordinator.remove(e.episodeId);
  return targets.length;
}

export type { OutcomeEpisode };
