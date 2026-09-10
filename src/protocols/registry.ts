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

// F2/F3 — Protocol registry.
//
// One declarative source of truth for the seven renal protocols: what each one
// reads, how it is modelled (per the verified-literature choices recorded in
// docs/renal-protocols-implementation-strategy.md §0), its safety class, the
// cells/workspace kinds it owns, and how its status is derived from REAL
// patient state. The cockpit (F3) renders whatever is registered here — a new
// protocol appears by configuration, not by new page scaffolding.

import type { RenalCohortSummary, RenalPatientFacts } from '../swarm/renal-cohort.js';
import type { ProtocolId } from './shared-state.js';
import {
  adequacyPrior, fluidPrior, infectionPrior, nutritionPrior, phosphatePrior,
  KTV_TARGET, PHOS_TARGET_MAX_MG_DL, IDWG_FLAG_KG, URR_FLOOR_PCT, ALBUMIN_FLOOR_G_DL,
  K_HYPERKALEMIA, CRP_INFLAMMATION_MG_L, NADIR_SBP_FLOOR,
} from './priors.js';

export type ProtocolStatus = 'green' | 'amber' | 'red' | 'unknown';

export interface ProtocolModelPlan {
  /** Model family chosen for this protocol, per the verified literature. */
  family: string;
  /** Why that family (paper-verified rationale). */
  rationale: string;
  /** Mechanistic prior the head corrects. */
  prior: string;
  /** Forecast/evaluation targets. */
  targets: readonly string[];
  /** Published baseline the head must beat. */
  baseline: string;
  /** What would make this protocol production-ready. */
  validationGate: string;
}

export interface ProtocolDescriptor {
  id: ProtocolId;
  substate: string;
  label: string;
  domain: string;
  /** Inputs this protocol reads from the shared state / ledger. */
  inputs: readonly string[];
  model: ProtocolModelPlan;
  safetyClass: 'A' | 'B' | 'C';
  cells: readonly string[];
  workspaceKinds: readonly string[];
  routes: readonly string[];
  ui: { panel: string; route: string };
  /** Implemented today, or registered as a plan slot for a later slice. */
  status: 'implemented' | 'planned';
  /** Which F1 signals the protocol depends on. */
  requiredSignals: readonly string[];
}

export const RENAL_PROTOCOLS: readonly ProtocolDescriptor[] = [
  {
    id: 'fluid',
    substate: 'SF',
    label: 'Fluid / ultrafiltration',
    domain: 'Volume management',
    inputs: ['avgIdwgKg', 'avgUfAchievementPct', 'minNadirSbp', 'sessions.deliveredMinutes', 'postWeightKg'],
    model: {
      family: 'counterfactual UF simulation + gradient-boosted baseline',
      rationale: 'Published SOTA for intradialytic hypotension is a temporal fusion transformer (AUROC 0.953), but the differentiator here is counterfactual UF/goal simulation with the mechanistic IDWG prior; LightGBM-class baseline first.',
      prior: 'IDWG → UF demand → achievable rate → hypotension risk',
      targets: ['idwgKg@7d', 'idwgKg@28d', 'hypotension episode (next session)'],
      baseline: 'persistence (last IDWG) / logistic on last session vitals',
      validationGate: 'patient-level split, MAE(IDWG) better than persistence at 7d and 28d; hypotension AUROC > 0.80 with calibration slope 0.8–1.2',
    },
    safetyClass: 'B',
    cells: ['fluid-uf-optimizer'],
    workspaceKinds: [],
    routes: ['GET /admin/swarm/protocols/fluid'],
    ui: { panel: 'protocol-cockpit', route: '/admin/swarm/protocols/cockpit' },
    status: 'implemented',
    requiredSignals: ['sessions.avgIdwgKg', 'sessions.avgUfAchievementPct', 'sessions.minNadirSbp'],
  },
  {
    id: 'adequacy',
    substate: 'SG',
    label: 'Dialysis adequacy (clearance)',
    domain: 'Urea kinetics',
    inputs: ['labs.URR', 'sessions.deliveredMinutes', 'prescribedMinutes', 'sessionsPerWeek'],
    model: {
      family: 'XGBoost/random-forest on Daugirdas prior (not a transformer)',
      rationale: 'Verified: tree ensembles lead published adequacy prediction (XGBoost r=0.873, RF AUROC 0.873) and beat CNN/GRU/linear; the Daugirdas spKt/V prior carries the physics, the head corrects residual.',
      prior: 'Daugirdas 1993 single-pool spKt/V + URR ≈ 1 − e^(−Kt/V)',
      targets: ['urrPct@7d', 'urrPct@28d', 'ktv per session'],
      baseline: 'persistence (last URR) + Daugirdas prior alone',
      validationGate: 'patient-level split, MAE(URR) better than persistence at 7d and 28d; ≥90% of sessions meeting Kt/V ≥ 1.2 must be genuinely delivered (time adherence audit)',
    },
    safetyClass: 'B',
    cells: ['adequacy-prescription'],
    workspaceKinds: [],
    routes: ['GET /admin/swarm/protocols/adequacy'],
    ui: { panel: 'protocol-cockpit', route: '/admin/swarm/protocols/cockpit' },
    status: 'implemented',
    requiredSignals: ['labs.URR', 'sessions.avgAdherencePct', 'sessions.avgDeliveredMinutes'],
  },
  {
    id: 'anemia',
    substate: 'SH',
    label: 'Anemia / iron',
    domain: 'ESA + iron management',
    inputs: ['labs.HGB', 'labs.FERRITIN', 'labs.TSAT', 'esaDose', 'labs.crp', 'esa dosing history'],
    model: {
      family: 'CAE manifold + dose regressor with MPC what-if (already shipped)',
      rationale: 'Existing anemia CDS (anemia.esa-dose-v1) is the reference implementation: ESA PK exposure, patient twin drift, phenotype classification, MPC dose selection. No replacement needed — it registers here as one protocol.',
      prior: 'ESA half-life 130 h PK + Hill-type HGB dose response',
      targets: ['hgbGdl@28d', 'hgbGdl@84d', 'dose change'],
      baseline: 'last HGB persistence; phenotype rule-only dosing',
      validationGate: 'twin MAPE ≤ 10% vs observed HGB; drift verdict not "insufficient"; ESA red-team suite passing',
    },
    safetyClass: 'C',
    cells: ['esa-dose-optimization', 'iron-management'],
    workspaceKinds: ['esa-episode', 'esa-mdr-file', 'esa-twin-drift'],
    routes: ['GET /admin/swarm/anemia/*'],
    ui: { panel: 'anemia-cds', route: '/admin/swarm/anemia/state' },
    status: 'implemented',
    requiredSignals: ['labs.HGB', 'labs.TSAT', 'labs.FERRITIN', 'esa dosing events'],
  },
  {
    id: 'ckd-mbd',
    substate: 'SI',
    label: 'CKD-MBD (P / Ca / PTH)',
    domain: 'Mineral & bone',
    inputs: ['labs.PHOS', 'labs.calcium', 'labs.pth', 'binder/calcimimetic/vitamin D exposures', 'ktvPerSession'],
    model: {
      family: 'coupled multi-output temporal head [P, Ca, PTH]',
      rationale: 'Published work in this space is cross-sectional (SVM AUC 0.840); the gap is coupling phosphate, calcium and PTH with binder/calcimimetic exposure over time — so a multi-output temporal head over the shared state, not a single-lab classifier.',
      prior: 'binder binding-capacity + dialytic clearance (weekly Kt/V) phosphate balance',
      targets: ['phosMgDl@28d', 'phosMgDl@84d', 'pth trend'],
      baseline: 'persistence (last phosphate)',
      validationGate: 'patient-level split, MAE(P) better than persistence at 28d and 84d; hypocalcemia false-positive rate < 5%',
    },
    safetyClass: 'B',
    cells: ['mbd-balance'],
    workspaceKinds: [],
    routes: ['GET /admin/swarm/protocols/ckd-mbd'],
    ui: { panel: 'protocol-cockpit', route: '/admin/swarm/protocols/cockpit' },
    status: 'implemented',
    requiredSignals: ['labs.PHOS', 'labs.calcium', 'labs.pth', 'med exposures'],
  },
  {
    id: 'nutrition-electrolytes',
    substate: 'SJ',
    label: 'Nutrition / electrolytes',
    domain: 'PEW + potassium / acid-base',
    inputs: ['labs.albumin', 'labs.K', 'labs.bicarb', 'labs.crp', 'idwg', 'ktvPerSession'],
    model: {
      family: 'gradient boosting + SHAP attribution',
      rationale: 'Verified: PEW modelling with XGBoost + SHAP reaches AUC 0.827 and ECG is adjunct only — so gradient boosting with explicit feature attribution, not a black-box sequence model.',
      prior: 'potassium dialytic decay to a 3.5 mmol/L floor + albumin/CRP wasting pattern',
      targets: ['potassium@7d', 'albumin@28d', 'PEW risk'],
      baseline: 'persistence (last K / last albumin)',
      validationGate: 'patient-level split, MAE(K) better than persistence at 7d; hyperkalemia events detected with recall ≥ 0.8 at ≤ 0.2 false-positive rate',
    },
    safetyClass: 'B',
    cells: ['nutrition-electrolyte'],
    workspaceKinds: [],
    routes: ['GET /admin/swarm/protocols/nutrition-electrolytes'],
    ui: { panel: 'protocol-cockpit', route: '/admin/swarm/protocols/cockpit' },
    status: 'implemented',
    requiredSignals: ['labs.K', 'labs.albumin', 'labs.bicarb', 'labs.crp'],
  },
  {
    id: 'access',
    substate: 'SK',
    label: 'Vascular access',
    domain: 'Access surveillance',
    inputs: ['access.type', 'access.ageDays', 'accessObservations', 'sessions.avgRecirculationPct', 'venous/arterial pressures'],
    model: {
      family: 'Δ-from-baseline detection (change-point, not level)',
      rationale: 'Verified: access stenosis detection from Δ-from-baseline representations is extremely strong (ResNet50 AUROC 0.99 on mel spectrograms) — the transferable lesson is to model deviation from the patient\'s own baseline, which is what the shared state enables.',
      prior: 'recirculation creep + cannulation-pressure drift above the patient baseline',
      targets: ['recirculationPct@28d', 'access dysfunction (30d)'],
      baseline: 'absolute-threshold rule (recirculation > 10%)',
      validationGate: 'patient-level split, dysfunction AUROC > 0.85 vs absolute-threshold rule; alarm rate under 0.2/patient-month',
    },
    safetyClass: 'B',
    cells: ['access-surveillance'],
    workspaceKinds: [],
    routes: ['GET /admin/swarm/protocols/access'],
    ui: { panel: 'protocol-cockpit', route: '/admin/swarm/protocols/cockpit' },
    status: 'implemented',
    requiredSignals: ['access.*', 'sessions.avgRecirculationPct', 'accessObservations'],
  },
  {
    id: 'infection',
    substate: 'SL',
    label: 'Infection / inflammation',
    domain: 'BSI triage + surveillance',
    inputs: ['labs.temp', 'labs.wbc', 'labs.procalcitonin', 'labs.crp', 'access.type', 'accessObservations'],
    model: {
      family: 'split design: XGBoost triage (ML) vs CDC NHSN criteria (deterministic rules)',
      rationale: 'Verified: ML BSI triage reaches AUC 0.914 — but surveillance/compliance criteria must stay deterministic CDC rules. The registry keeps the two paths separate so ML never decides a compliance outcome.',
      prior: 'deterministic NHSN surveillance criteria + ML triage score for review ordering',
      targets: ['triageScore@7d', 'triageScore@28d', 'clinical deterioration'],
      baseline: 'temperature-only rule',
      validationGate: 'triage AUROC > 0.80 with ECE < 0.1; surveillance criteria remain 100% rule-derived (no model input) — asserted by test',
    },
    safetyClass: 'B',
    cells: ['infection-triage'],
    workspaceKinds: [],
    routes: ['GET /admin/swarm/protocols/infection'],
    ui: { panel: 'protocol-cockpit', route: '/admin/swarm/protocols/cockpit' },
    status: 'implemented',
    requiredSignals: ['labs.temp', 'labs.wbc', 'labs.crp', 'access.type'],
  },
] as const;

export function protocolById(id: string): ProtocolDescriptor | undefined {
  return RENAL_PROTOCOLS.find((p) => p.id === id);
}

export interface ProtocolSignal {
  label: string;
  value: string;
  severity: 'info' | 'watch' | 'alert';
}

export interface ProtocolPatientStatus {
  patientId: string;
  realmId: string;
  status: ProtocolStatus;
  severity: number;
  signals: ProtocolSignal[];
  drivers: string[];
}

export interface ProtocolStatusReport {
  protocol: ProtocolId;
  substate: string;
  label: string;
  status: ProtocolStatus;
  /** patients contributing to the status */
  evaluated: number;
  counts: { green: number; amber: number; red: number; unknown: number };
  /** share of evaluated patients at red/amber */
  attentionPct: number;
  topDrivers: string[];
  /** exemplar patients for drill-down (worst first) */
  examples: Array<{ patientId: string; realmId: string; status: ProtocolStatus; drivers: string[] }>;
}

const worstOf = (statuses: ProtocolStatus[]): ProtocolStatus => {
  if (statuses.includes('red')) return 'red';
  if (statuses.includes('amber')) return 'amber';
  if (statuses.includes('green')) return 'green';
  return 'unknown';
};

/** Per-protocol patient evaluation driven only by real patient facts. */
export function evaluateProtocolForPatient(protocol: ProtocolId, facts: RenalPatientFacts): ProtocolPatientStatus {
  const signals: ProtocolSignal[] = [];
  const drivers: string[] = [];
  let severity = 0;

  switch (protocol) {
    case 'fluid': {
      const prior = fluidPrior({
        ...(facts.sessions.avgIdwgKg !== undefined ? { avgIdwgKg: facts.sessions.avgIdwgKg } : {}),
        ...(facts.sessions.avgUfAchievementPct !== undefined ? { avgUfAchievementPct: facts.sessions.avgUfAchievementPct } : {}),
        ...(facts.sessions.minNadirSbp !== undefined ? { minNadirSbp: facts.sessions.minNadirSbp } : {}),
        ...(facts.sessions.avgDeliveredMinutes !== undefined ? { avgDeliveredMinutes: facts.sessions.avgDeliveredMinutes } : {}),
      });
      severity = Math.max(
        (facts.sessions.avgIdwgKg ?? 0) > IDWG_FLAG_KG ? 0.6 : 0,
        (facts.sessions.avgUfAchievementPct ?? 100) < 90 ? 0.5 : 0,
        (facts.sessions.minNadirSbp ?? 999) < NADIR_SBP_FLOOR ? 0.8 : 0,
        facts.signals.shortSessions > 0 ? 0.35 : 0,
      );
      signals.push({ label: 'IDWG', value: facts.sessions.avgIdwgKg !== undefined ? `${facts.sessions.avgIdwgKg} kg` : 'no data', severity: (facts.sessions.avgIdwgKg ?? 0) > IDWG_FLAG_KG ? 'alert' : 'info' });
      signals.push({ label: 'UF achieved', value: facts.sessions.avgUfAchievementPct !== undefined ? `${facts.sessions.avgUfAchievementPct}%` : 'no data', severity: (facts.sessions.avgUfAchievementPct ?? 100) < 90 ? 'watch' : 'info' });
      signals.push({ label: 'Nadir SBP', value: facts.sessions.minNadirSbp !== undefined ? `${facts.sessions.minNadirSbp} mmHg` : 'no data', severity: (facts.sessions.minNadirSbp ?? 999) < NADIR_SBP_FLOOR ? 'alert' : 'info' });
      drivers.push(...prior.drivers);
      break;
    }
    case 'adequacy': {
      const prior = adequacyPrior({
        ...(facts.labs.URR !== undefined ? { urrPct: facts.labs.URR } : {}),
        ...(facts.sessions.avgAdherencePct !== undefined ? { prescribedMinutes: 100, deliveredMinutes: facts.sessions.avgAdherencePct } : {}),
        ...(facts.sessions.count === 0 ? { sessionsPerWeek: 0 } : {}),
      });
      severity = Math.max(
        (facts.labs.URR ?? 70) < URR_FLOOR_PCT ? 0.75 : 0,
        (prior.spKtV ?? KTV_TARGET) < KTV_TARGET ? 0.6 : 0,
        facts.signals.shortSessions > 0 ? 0.4 : 0,
        facts.sessions.count === 0 ? 0.5 : 0,
      );
      signals.push({ label: 'URR', value: facts.labs.URR !== undefined ? `${facts.labs.URR}%` : 'no data', severity: (facts.labs.URR ?? 70) < URR_FLOOR_PCT ? 'alert' : 'info' });
      signals.push({ label: 'spKt/V', value: prior.spKtV !== undefined ? `${prior.spKtV}` : 'no data', severity: (prior.spKtV ?? KTV_TARGET) < KTV_TARGET ? 'watch' : 'info' });
      signals.push({ label: 'Time adherence', value: prior.timeAdherencePct !== undefined ? `${prior.timeAdherencePct}%` : 'no data', severity: (prior.timeAdherencePct ?? 100) < 90 ? 'watch' : 'info' });
      drivers.push(...prior.drivers);
      if (facts.signals.shortSessions > 0) drivers.push(`${facts.signals.shortSessions} shortened session(s) on the ledger`);
      if (facts.sessions.count === 0) drivers.push('no dialysis sessions on the ledger yet — adequacy unmeasured');
      if (facts.sessions.avgRecirculationPct !== undefined && facts.sessions.avgRecirculationPct >= 10) drivers.push(`access recirculation ${facts.sessions.avgRecirculationPct}% reduces effective clearance`);
      break;
    }
    case 'anemia': {
      const hgb = facts.labs.HGB;
      const tsat = facts.labs.TSAT;
      const crp = facts.labs.crp;
      severity = Math.max(
        (hgb ?? 11) < 10 ? 0.7 : 0,
        (hgb ?? 11) < 11 ? 0.35 : 0,
        (tsat ?? 30) < 20 ? 0.6 : 0,
        (crp ?? 0) > CRP_INFLAMMATION_MG_L ? 0.4 : 0,
      );
      signals.push({ label: 'HGB', value: hgb !== undefined ? `${hgb} g/dL` : 'no data', severity: (hgb ?? 11) < 10 ? 'alert' : (hgb ?? 11) < 11 ? 'watch' : 'info' });
      signals.push({ label: 'TSAT', value: tsat !== undefined ? `${tsat}%` : 'no data', severity: (tsat ?? 30) < 20 ? 'alert' : 'info' });
      signals.push({ label: 'ESA dose', value: facts.exposure.esaDoseUnits !== undefined ? `${facts.exposure.esaDoseUnits} u/wk` : 'none', severity: 'info' });
      if (tsat !== undefined && tsat < 20) drivers.push(`TSAT ${tsat}% — functional iron deficiency`);
      if (crp !== undefined && crp > CRP_INFLAMMATION_MG_L) drivers.push(`CRP ${crp} mg/L — ESA hyporesponsiveness`);
      if (hgb !== undefined && hgb < 10) drivers.push(`HGB ${hgb} g/dL below target band`);
      break;
    }
    case 'ckd-mbd': {
      const prior = phosphatePrior({
        ...(facts.labs.PHOS !== undefined ? { phosMgDl: facts.labs.PHOS } : {}),
        ...(facts.labs.calcium !== undefined ? { calciumMgDl: facts.labs.calcium } : {}),
        ...(facts.labs.pth !== undefined ? { pthPgMl: facts.labs.pth } : {}),
        binderCodes: [...facts.exposure.phosphateBinders],
        ...(facts.exposure.calcimimetics.length ? {} : {}),
      });
      severity = Math.max(
        (facts.labs.PHOS ?? 4.5) > PHOS_TARGET_MAX_MG_DL ? 0.65 : 0,
        facts.signals.hyperparathyroidism ? 0.6 : 0,
        facts.signals.hypercalcemia ? 0.5 : 0,
        facts.panel.missing.length ? 0.3 : 0,
      );
      signals.push({ label: 'Phosphate', value: facts.labs.PHOS !== undefined ? `${facts.labs.PHOS} mg/dL` : 'no data', severity: (facts.labs.PHOS ?? 4.5) > PHOS_TARGET_MAX_MG_DL ? 'alert' : 'info' });
      signals.push({ label: 'PTH', value: facts.labs.pth !== undefined ? `${facts.labs.pth} pg/mL` : 'no data', severity: facts.signals.hyperparathyroidism ? 'alert' : 'info' });
      signals.push({ label: 'Binder bound', value: `${prior.boundMgPerDay} mg PO4/d`, severity: prior.boundMgPerDay === 0 ? 'watch' : 'info' });
      drivers.push(...prior.drivers);
      break;
    }
    case 'nutrition-electrolytes': {
      const prior = nutritionPrior({
        ...(facts.labs.albumin !== undefined ? { albuminGdL: facts.labs.albumin } : {}),
        ...(facts.labs.crp !== undefined ? { crpMgL: facts.labs.crp } : {}),
      });
      severity = Math.max(
        (facts.labs.K ?? 4.5) > K_HYPERKALEMIA ? 0.7 : 0,
        (facts.labs.albumin ?? 3.8) < ALBUMIN_FLOOR_G_DL ? 0.55 : 0,
        facts.signals.metabolicAcidosis ? 0.4 : 0,
      );
      signals.push({ label: 'Potassium', value: facts.labs.K !== undefined ? `${facts.labs.K} mmol/L` : 'no data', severity: (facts.labs.K ?? 4.5) > K_HYPERKALEMIA ? 'alert' : 'info' });
      signals.push({ label: 'Albumin', value: facts.labs.albumin !== undefined ? `${facts.labs.albumin} g/dL` : 'no data', severity: (facts.labs.albumin ?? 3.8) < ALBUMIN_FLOOR_G_DL ? 'watch' : 'info' });
      signals.push({ label: 'Bicarbonate', value: facts.labs.bicarb !== undefined ? `${facts.labs.bicarb} mmol/L` : 'no data', severity: facts.signals.metabolicAcidosis ? 'watch' : 'info' });
      drivers.push(...prior.drivers);
      break;
    }
    case 'access': {
      const recirc = facts.sessions.avgRecirculationPct;
      severity = Math.max(
        facts.access.dysfunction ? 0.7 : 0,
        (recirc ?? 0) >= 10 ? 0.6 : 0,
        (facts.access.ageDays ?? 999) < 90 && facts.access.type === 'catheter' ? 0.5 : 0,
        facts.access.observations === 0 ? 0.25 : 0,
      );
      signals.push({ label: 'Access', value: facts.access.type ? `${facts.access.type} (${facts.access.ageDays ?? '?'} d)` : 'unknown', severity: facts.access.type === 'catheter' ? 'watch' : 'info' });
      signals.push({ label: 'Recirculation', value: recirc !== undefined ? `${recirc}%` : 'no data', severity: (recirc ?? 0) >= 10 ? 'alert' : 'info' });
      signals.push({ label: 'Observations', value: `${facts.access.observations}`, severity: facts.access.observations === 0 ? 'watch' : 'info' });
      if (facts.access.lastEvent) drivers.push(`last access event: ${facts.access.lastEvent}`);
      if ((recirc ?? 0) >= 10) drivers.push(`recirculation ${recirc}% ≥ 10%`);
      break;
    }
    case 'infection': {
      const prior = infectionPrior({
        ...(facts.vitals.tempC !== undefined ? { tempC: facts.vitals.tempC } : {}),
        ...(facts.labs.wbc !== undefined ? { wbc: facts.labs.wbc } : {}),
        ...(facts.labs.procalcitonin !== undefined ? { procalcitoninNgMl: facts.labs.procalcitonin } : {}),
        ...(facts.labs.crp !== undefined ? { crpMgL: facts.labs.crp } : {}),
        ...(facts.access.type ? { accessType: facts.access.type } : {}),
        ...(facts.access.lastEvent ? { accessEvent: facts.access.lastEvent } : {}),
      });
      severity = Math.max(prior.meetsSurveillanceCriteria ? 0.9 : 0, prior.triageScore > 0.5 ? 0.6 : prior.triageScore * 0.5, facts.access.type === 'catheter' ? 0.3 : 0);
      signals.push({ label: 'Triage', value: `${prior.triageScore}`, severity: prior.triageScore > 0.5 ? 'watch' : 'info' });
      signals.push({ label: 'NHSN criteria', value: prior.meetsSurveillanceCriteria ? 'met (rule-based)' : 'not met', severity: prior.meetsSurveillanceCriteria ? 'alert' : 'info' });
      signals.push({ label: 'Catheter', value: facts.access.type === 'catheter' ? 'yes' : 'no', severity: facts.access.type === 'catheter' ? 'watch' : 'info' });
      drivers.push(...prior.drivers);
      break;
    }
  }

  const uniqueDrivers = [...new Set(drivers)];
  const status: ProtocolStatus = severity >= 0.6 ? 'red' : severity >= 0.3 ? 'amber' : severity > 0 ? 'green' : (facts.sessions.count === 0 && facts.panel.completenessPct < 50 ? 'unknown' : 'green');
  return { patientId: facts.patientId, realmId: facts.realmId, status, severity: Math.round(severity * 100) / 100, signals, drivers: uniqueDrivers };
}

/** Roll a cohort up per protocol into the cockpit's status rows. */
export function assessProtocols(facts: RenalPatientFacts[]): ProtocolStatusReport[] {
  return RENAL_PROTOCOLS.map((descriptor) => {
    const evaluated = facts.map((f) => evaluateProtocolForPatient(descriptor.id, f));
    const counts = { green: 0, amber: 0, red: 0, unknown: 0 };
    for (const row of evaluated) counts[row.status] += 1;
    const driverTally = new Map<string, number>();
    for (const row of evaluated) for (const d of row.drivers) driverTally.set(d, (driverTally.get(d) ?? 0) + 1);
    const evaluatedCount = evaluated.length;
    return {
      protocol: descriptor.id,
      substate: descriptor.substate,
      label: descriptor.label,
      status: worstOf(evaluated.map((r) => r.status)),
      evaluated: evaluatedCount,
      counts,
      attentionPct: evaluatedCount ? Math.round(((counts.red + counts.amber) / evaluatedCount) * 100) : 0,
      topDrivers: [...driverTally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([d, n]) => `${d} (${n})`),
      examples: [...evaluated]
        .sort((a, b) => b.severity - a.severity)
        .slice(0, 5)
        .map((r) => ({ patientId: r.patientId, realmId: r.realmId, status: r.status, drivers: r.drivers })),
    };
  });
}

/** Fleet-level index used by the cockpit header. */
export function cockpitIndex(reports: ProtocolStatusReport[], summary: RenalCohortSummary): { status: ProtocolStatus; redProtocols: number; amberProtocols: number; patients: number; sessions: number } {
  const status = worstOf(reports.map((r) => r.status));
  return {
    status,
    redProtocols: reports.filter((r) => r.status === 'red').length,
    amberProtocols: reports.filter((r) => r.status === 'amber').length,
    patients: summary.patients,
    sessions: summary.sessions,
  };
}
