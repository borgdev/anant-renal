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

// Guideline rule packs — the thresholds as FIRST-CLASS CODE.
//
// WHY. Every protocol pack hardcodes its clinical bounds (a KDIGO phosphate
// band, a CDC fever threshold, an ACIP interval). Those numbers were scattered
// across seven files with the citation living in a comment, which makes the two
// questions a regulator actually asks unanswerable:
//
//   "which guideline does this number come from?"  → a comment, not a structure
//   "if the guideline changes, what do we change?" → grep, and hope
//
// This module makes each bound a named, cited, EXECUTABLE rule: an id, the
// protocol it governs, the comparator, the bound, and — critically — WHERE it is
// enforced (guardrail, coverage gate, authority, escalation, surveillance). The
// assurance dashboard can then answer "which rules back each protocol, and is
// each one actually enforced?" from data rather than from reading source.
//
// The packs' own reference constants remain the runtime values they always were
// (so no behaviour changes here); `RULE_PACK_BINDINGS` records the constant each
// rule mirrors, and a drift test fails if a pack constant and its rule diverge,
// so the guideline copy can never silently drift from the code that enforces it.

/** The protocols this platform ships. */
export type ProtocolId = 'anemia' | 'adequacy' | 'fluid' | 'access' | 'ckd-mbd' | 'nutrition-electrolytes' | 'infection';

export type RuleSource = 'KDIGO' | 'KDOQI' | 'CDC' | 'NHSN' | 'ACIP' | 'CMS' | 'AnantHQ';

/** Where a rule is actually enforced in the platform (never just documented). */
export type RuleEnforcement =
  | 'guardrail'        // blocks or downgrades a recommendation
  | 'coverage-gate'    // refuses to answer at all
  | 'authority'        // the platform has no authority to act
  | 'escalation'       // routes to a human / another team
  | 'surveillance';    // drives monitoring rather than action

export type RuleComparator =
  | 'gt' | 'gte' | 'lt' | 'lte' | 'between' | 'outside' | 'present' | 'never';

export interface RuleReference {
  source: RuleSource;
  /** the guideline edition, so a re-issue is a new rule version, not an edit */
  edition: string;
  /** the specific statement the bound implements */
  statement: string;
  url?: string;
}

export interface RuleDefinition {
  id: string;
  protocol: ProtocolId;
  name: string;
  /** the clinical quantity the rule constrains */
  metric: string;
  unit: string;
  comparator: RuleComparator;
  bounds: { min?: number; max?: number; value?: number };
  /** how the platform enforces it (a rule with no enforcement is a gap) */
  enforcement: RuleEnforcement;
  /** the pack module that implements it (for traceability) */
  implementedIn: string;
  reference: RuleReference;
}

/* ======================================================================
 * KDIGO / KDOQI / CMS — the renal protocols
 * ====================================================================== */

const KDIGO_CKD_MBD_2017: RuleReference = {
  source: 'KDIGO', edition: '2017',
  statement: 'CKD-MBD guideline: maintain serum phosphate, calcium and PTH toward the normal range using serial joint interpretation.',
  url: 'https://kdigo.org/guidelines/ckd-mbd/',
};
const KDOQI_NUTRITION_2020: RuleReference = {
  source: 'KDOQI', edition: '2020',
  statement: 'KDOQI clinical practice guideline for nutrition in CKD: protein-energy wasting assessment and electrolyte safety.',
  url: 'https://www.kidney.org/professionals/kdoqi',
};
const KDIGO_ANEMIA_2012: RuleReference = {
  source: 'KDIGO', edition: '2012',
  statement: 'KDIGO anemia guideline: Hb target band, iron repletion before ESA escalation, ESA hyporesponse review.',
  url: 'https://kdigo.org/guidelines/anemia-in-ckd/',
};
const KDIGO_HEMODIALYSIS_2015: RuleReference = {
  source: 'KDIGO', edition: '2015',
  statement: 'KDIGO hemodialysis adequacy: spKt/V target and the URR floor for thrice-weekly treatment.',
  url: 'https://kdigo.org/guidelines/hemodialysis-adequacy/',
};
const KDOQI_VASCULAR_ACCESS_2019: RuleReference = {
  source: 'KDOQI', edition: '2019',
  statement: 'KDOQI vascular access guideline: surveillance of flow, recirculation and venous pressure against the patient\'s own baseline.',
  url: 'https://www.kidney.org/professionals/kdoqi/guidelines',
};
const CMS_QIP: RuleReference = {
  source: 'CMS', edition: '2026',
  statement: 'ESRD QIP measure specifications (Kt/V, hypercalcemia, NHSN BSI) — the reporting definitions the platform mirrors.',
  url: 'https://www.cms.gov/medicare/quality/esrd-qip',
};

/* ======================================================================
 * CDC / NHSN / ACIP — infection & prevention
 * ====================================================================== */

const CDC_BSI_2017: RuleReference = {
  source: 'CDC', edition: '2017',
  statement: 'CDC dialysis bloodstream-infection prevention: temperature at every session, access care, catheter necessity review.',
  url: 'https://www.cdc.gov/dialysis/prevention-tools/',
};
const NHSN_SURVEILLANCE: RuleReference = {
  source: 'NHSN', edition: '2026',
  statement: 'NHSN dialysis event surveillance definitions for bloodstream infection (fever threshold and blood-culture confirmation).',
  url: 'https://www.cdc.gov/nhsn/dialysis/',
};
const ACIP_SCHEDULE: RuleReference = {
  source: 'ACIP', edition: '2026',
  statement: 'ACIP adult immunisation schedule as applied to dialysis patients (hepatitis B series, annual influenza, pneumococcal, SARS-CoV-2).',
  url: 'https://www.cdc.gov/vaccines/hcp/imz-schedules/',
};

/* ======================================================================
 * The rule set
 * ====================================================================== */

export const RULE_PACKS: readonly RuleDefinition[] = [
  /* ---------- anemia / ESA ---------- */
  {
    id: 'kdigo.hb.band', protocol: 'anemia', name: 'Haemoglobin target band',
    metric: 'Haemoglobin', unit: 'g/dL', comparator: 'between', bounds: { min: 10, max: 12 },
    enforcement: 'guardrail', implementedIn: 'src/swarm/anemia.ts',
    reference: { ...KDIGO_ANEMIA_2012, statement: 'Do not intentionally maintain Hb > 11.5 g/dL and avoid falling below 10 g/dL; individualise within the 10–12 band.' },
  },
  {
    id: 'kdigo.hb.low-not-on-esa', protocol: 'anemia', name: 'Assess before starting ESA',
    metric: 'Haemoglobin', unit: 'g/dL', comparator: 'lt', bounds: { value: 9 },
    enforcement: 'guardrail', implementedIn: 'src/swarm/anemia.ts',
    reference: { ...KDIGO_ANEMIA_2012, statement: 'Below 9 g/dL in a patient not yet on ESA, assess iron status and other causes before starting ESA.' },
  },
  {
    id: 'kdigo.esa.above-band', protocol: 'anemia', name: 'Reduce or hold above band',
    metric: 'Haemoglobin', unit: 'g/dL', comparator: 'gt', bounds: { value: 11 },
    enforcement: 'guardrail', implementedIn: 'src/swarm/anemia.ts',
    reference: KDIGO_ANEMIA_2012,
  },
  {
    id: 'kdigo.esa.escalation-without-response', protocol: 'anemia', name: 'Escalation without response review',
    metric: 'ESA escalations', unit: 'count/90d', comparator: 'gte', bounds: { value: 3 },
    enforcement: 'escalation', implementedIn: 'src/swarm/anemia.ts',
    reference: { ...KDIGO_ANEMIA_2012, statement: 'Repeated dose escalation without an Hb response requires a hyporesponse work-up rather than further escalation.' },
  },
  {
    id: 'kdigo.iron.quarterly-check', protocol: 'anemia', name: 'Iron status checked each quarter',
    metric: 'Days since iron panel', unit: 'd', comparator: 'gt', bounds: { value: 90 },
    enforcement: 'coverage-gate', implementedIn: 'src/swarm/anemia.ts',
    reference: { ...KDIGO_ANEMIA_2012, statement: 'Iron status (ferritin and transferrin saturation) must be current before ESA decisions.' },
  },
  {
    id: 'kdigo.iron.microcytic-first', protocol: 'anemia', name: 'Iron depletion before ESA titration',
    metric: 'MCV', unit: 'fL', comparator: 'lt', bounds: { value: 80 },
    enforcement: 'guardrail', implementedIn: 'src/swarm/anemia.ts',
    reference: { ...KDIGO_ANEMIA_2012, statement: 'A microcytic picture requires iron/B12 repletion before ESA titration.' },
  },
  {
    id: 'kdigo.esa.max-step', protocol: 'anemia', name: 'Smallest titratable ESA step',
    metric: 'ESA dose step', unit: 'units/wk', comparator: 'lte', bounds: { value: 500 },
    enforcement: 'guardrail', implementedIn: 'src/swarm/anemia.ts',
    reference: { ...KDIGO_ANEMIA_2012, statement: 'Change ESA dose in the smallest titratable increment to limit Hb variability.' },
  },

  /* ---------- adequacy ---------- */
  {
    id: 'kdigo.ktv.target', protocol: 'adequacy', name: 'spKt/V target (thrice weekly)',
    metric: 'spKt/V', unit: '', comparator: 'gte', bounds: { value: 1.2 },
    enforcement: 'guardrail', implementedIn: 'src/protocols/priors.ts',
    reference: KDIGO_HEMODIALYSIS_2015,
  },
  {
    id: 'kdigo.ktv.frequent-target', protocol: 'adequacy', name: 'spKt/V target (frequent dialysis)',
    metric: 'spKt/V', unit: '', comparator: 'gte', bounds: { value: 1.4 },
    enforcement: 'surveillance', implementedIn: 'src/protocols/priors.ts',
    reference: { ...KDIGO_HEMODIALYSIS_2015, statement: 'For patients on more frequent sessions the weekly standard is expressed as a higher per-session target.' },
  },
  {
    id: 'kdigo.urr.floor', protocol: 'adequacy', name: 'URR floor',
    metric: 'URR', unit: '%', comparator: 'gte', bounds: { value: 60 },
    enforcement: 'guardrail', implementedIn: 'src/protocols/priors.ts',
    reference: { ...KDIGO_HEMODIALYSIS_2015, statement: 'URR provides a check when a measured spKt/V is unavailable.' },
  },
  {
    id: 'cms.ktv.qip-threshold', protocol: 'adequacy', name: 'ESRD QIP Kt/V reporting threshold',
    metric: 'spKt/V', unit: '', comparator: 'gte', bounds: { value: 1.2 },
    enforcement: 'surveillance', implementedIn: 'src/cms/qip.ts',
    reference: { ...CMS_QIP, statement: 'The Kt/V measure threshold the QIP scores facilities against.' },
  },
  {
    id: 'anant.treatment.duration-step', protocol: 'adequacy', name: 'Smallest prescribed-time step',
    metric: 'Treatment time step', unit: 'min', comparator: 'lte', bounds: { value: 15 },
    enforcement: 'guardrail', implementedIn: 'src/swarm/adequacy.ts',
    reference: { source: 'AnantHQ', edition: '2026', statement: 'Prescription changes step by the smallest actionable increment to keep the counterfactual interpretable.' },
  },
  {
    id: 'cms.ktv.delivered-sessions', protocol: 'adequacy', name: 'Delivered sessions before an adequacy claim',
    metric: 'Delivered sessions', unit: 'count', comparator: 'gte', bounds: { value: 3 },
    enforcement: 'coverage-gate', implementedIn: 'src/swarm/adequacy-governance.ts',
    reference: { ...KDIGO_HEMODIALYSIS_2015, statement: 'Adequacy is a property of a treatment pattern, not one session — the gate refuses to answer below three delivered sessions.' },
  },
  {
    id: 'cms.ktv.clearance-samples', protocol: 'adequacy', name: 'Measured clearance samples before an adequacy claim',
    metric: 'Clearance samples', unit: 'count', comparator: 'gte', bounds: { value: 3 },
    enforcement: 'coverage-gate', implementedIn: 'src/swarm/adequacy-governance.ts',
    reference: { ...KDIGO_HEMODIALYSIS_2015, statement: 'At least three measured URR / pre-post urea values are required in the window.' },
  },
  {
    id: 'anant.recirculation.interpretability', protocol: 'adequacy', name: 'Recirculation ceiling for a clearable signal',
    metric: 'Recirculation', unit: '%', comparator: 'lte', bounds: { value: 30 },
    enforcement: 'coverage-gate', implementedIn: 'src/swarm/adequacy-governance.ts',
    reference: { source: 'AnantHQ', edition: '2026', statement: 'Above this recirculation the delivered clearance signal is not interpretable and the gate refuses rather than correcting.' },
  },
  {
    id: 'kdigo.idwg.flag', protocol: 'adequacy', name: 'Inter-dialytic weight gain flag',
    metric: 'IDWG', unit: 'kg', comparator: 'gt', bounds: { value: 2.5 },
    enforcement: 'surveillance', implementedIn: 'src/protocols/priors.ts',
    reference: { ...KDIGO_HEMODIALYSIS_2015, statement: 'Inter-dialytic weight gain indicates volume overload and drives dry-weight review.' },
  },

  /* ---------- fluid / IDH ---------- */
  {
    id: 'anant.uf-rate.safe', protocol: 'fluid', name: 'Safe ultrafiltration rate ceiling',
    metric: 'UF rate', unit: 'mL/kg/h', comparator: 'lte', bounds: { value: 10 },
    enforcement: 'guardrail', implementedIn: 'src/swarm/fluid.ts',
    reference: { source: 'AnantHQ', edition: '2026', statement: 'UF rates above 10 mL/kg/h are associated with intradialytic hypotension and organ stunning; the platform never proposes above the safe ceiling.' },
  },
  {
    id: 'anant.uf-rate.high', protocol: 'fluid', name: 'High-risk ultrafiltration rate',
    metric: 'UF rate', unit: 'mL/kg/h', comparator: 'gt', bounds: { value: 13 },
    enforcement: 'escalation', implementedIn: 'src/swarm/fluid.ts',
    reference: { source: 'AnantHQ', edition: '2026', statement: 'Above 13 mL/kg/h the platform escalates rather than titrates.' },
  },
  {
    id: 'kdigo.nadir-sbp.floor', protocol: 'fluid', name: 'Nadir systolic pressure floor',
    metric: 'Nadir SBP', unit: 'mmHg', comparator: 'lt', bounds: { value: 90 },
    enforcement: 'guardrail', implementedIn: 'src/protocols/priors.ts',
    reference: { ...KDIGO_HEMODIALYSIS_2015, statement: 'Intradialytic hypotension is defined by a nadir below 90 mmHg with symptoms.' },
  },
  {
    id: 'anant.uf.achievement-floor', protocol: 'fluid', name: 'UF achievement floor',
    metric: 'UF achievement', unit: '%', comparator: 'gte', bounds: { value: 80 },
    enforcement: 'surveillance', implementedIn: 'src/swarm/fluid.ts',
    reference: { source: 'AnantHQ', edition: '2026', statement: 'Repeatedly achieving under 80% of the target suggests the target itself is wrong.' },
  },
  {
    id: 'anant.uf-rate.step', protocol: 'fluid', name: 'Smallest UF-rate step',
    metric: 'UF rate step', unit: 'mL/h', comparator: 'lte', bounds: { value: 50 },
    enforcement: 'guardrail', implementedIn: 'src/swarm/fluid.ts',
    reference: { source: 'AnantHQ', edition: '2026', statement: 'Counterfactual UF steps are the smallest titratable change.' },
  },
  {
    id: 'kdigo.fluid.telemetry-sessions', protocol: 'fluid', name: 'Sessions with intra-session telemetry',
    metric: 'Telemetry sessions', unit: 'count', comparator: 'gte', bounds: { value: 2 },
    enforcement: 'coverage-gate', implementedIn: 'src/swarm/fluid-governance.ts',
    reference: { source: 'AnantHQ', edition: '2026', statement: 'Ultrafiltration rate is a within-session phenomenon — fewer than two instrumented sessions cannot support a refill-rate claim.' },
  },
  {
    id: 'kdigo.fluid.telemetry-points', protocol: 'fluid', name: 'Telemetry samples per session',
    metric: 'Telemetry samples', unit: 'count', comparator: 'gte', bounds: { value: 4 },
    enforcement: 'coverage-gate', implementedIn: 'src/swarm/fluid-governance.ts',
    reference: { source: 'AnantHQ', edition: '2026', statement: 'Five-to-fifteen minute sampling needs at least four points per session to estimate a refill slope.' },
  },
  {
    id: 'anant.dry-weight.freshness', protocol: 'fluid', name: 'Dry-weight reassessment freshness',
    metric: 'Dry-weight age', unit: 'days', comparator: 'lt', bounds: { value: 30 },
    enforcement: 'coverage-gate', implementedIn: 'src/swarm/fluid-governance.ts',
    reference: { source: 'AnantHQ', edition: '2026', statement: 'A target weight older than 30 days is out of date and the gate refuses to reason from it.' },
  },

  /* ---------- vascular access ---------- */
  {
    id: 'kdoqi.access.venous-pressure-rise', protocol: 'access', name: 'Venous pressure rise from baseline',
    metric: 'Venous pressure rise', unit: '%', comparator: 'gt', bounds: { value: 25 },
    enforcement: 'escalation', implementedIn: 'src/swarm/access.ts',
    reference: KDOQI_VASCULAR_ACCESS_2019,
  },
  {
    id: 'kdoqi.access.recirculation', protocol: 'access', name: 'Recirculation flag',
    metric: 'Recirculation', unit: '%', comparator: 'gt', bounds: { value: 10 },
    enforcement: 'escalation', implementedIn: 'src/swarm/access.ts',
    reference: KDOQI_VASCULAR_ACCESS_2019,
  },
  {
    id: 'kdoqi.access.flow-floor', protocol: 'access', name: 'Access flow floor',
    metric: 'Access flow', unit: 'mL/min', comparator: 'gte', bounds: { value: 600 },
    enforcement: 'escalation', implementedIn: 'src/swarm/access.ts',
    reference: KDOQI_VASCULAR_ACCESS_2019,
  },
  {
    id: 'kdoqi.access.flow-decline', protocol: 'access', name: 'Access flow decline from baseline',
    metric: 'Access flow decline', unit: '%', comparator: 'gt', bounds: { value: 25 },
    enforcement: 'escalation', implementedIn: 'src/swarm/access.ts',
    reference: KDOQI_VASCULAR_ACCESS_2019,
  },
  {
    id: 'kdoqi.access.min-observations', protocol: 'access', name: 'Observations before a referral',
    metric: 'Measured observations', unit: 'count', comparator: 'gte', bounds: { value: 3 },
    enforcement: 'coverage-gate', implementedIn: 'src/swarm/access.ts',
    reference: { ...KDOQI_VASCULAR_ACCESS_2019, statement: 'A single measurement is not a trend; the referral needs serial evidence against the patient\'s own baseline.' },
  },
  {
    id: 'kdoqi.access.quiet-window', protocol: 'access', name: 'Post-intervention quiet window',
    metric: 'Days since intervention', unit: 'days', comparator: 'gte', bounds: { value: 14 },
    enforcement: 'guardrail', implementedIn: 'src/swarm/access.ts',
    reference: { ...KDOQI_VASCULAR_ACCESS_2019, statement: 'No routine re-referral inside the 14-day post-intervention window — an early re-referral is a surveillance artefact, not a finding.' },
  },
  {
    id: 'anant.access.guard-flag-gate', protocol: 'access', name: 'A surfaced access finding must carry its guard flag',
    metric: 'Guard flag', unit: '', comparator: 'present', bounds: {},
    enforcement: 'guardrail', implementedIn: 'src/swarm/access-governance.ts',
    reference: { source: 'AnantHQ', edition: '2026', statement: 'Every access recommendation must carry the guard flag that shaped it (catheter in situ, technique-first, quiet window) so the reviewer can see what was suppressed and why.' },
  },
  {
    id: 'kdoqi.access.acoustic-provenance', protocol: 'access', name: 'Acoustic path requires provenance',
    metric: 'Capture provenance', unit: '', comparator: 'present', bounds: {},
    enforcement: 'authority', implementedIn: 'src/swarm/access-governance.ts',
    reference: { source: 'AnantHQ', edition: '2026', statement: 'The acoustic observer is feature-flagged and refuses captures without provenance; no raw patient audio is ever stored.' },
  },
  {
    id: 'anant.access.stenosis-referral', protocol: 'access', name: 'Stenosis referral threshold',
    metric: 'Stenosis probability', unit: '', comparator: 'gte', bounds: { value: 0.5 },
    enforcement: 'escalation', implementedIn: 'src/swarm/access.ts',
    reference: { source: 'AnantHQ', edition: '2026', statement: 'Referral is proposed at or above this probability, with the Δ-from-baseline evidence attached.' },
  },

  /* ---------- CKD-MBD ---------- */
  {
    id: 'kdigo.phosphate.band', protocol: 'ckd-mbd', name: 'Serum phosphate target',
    metric: 'Phosphate', unit: 'mg/dL', comparator: 'between', bounds: { min: 2.5, max: 5.5 },
    enforcement: 'guardrail', implementedIn: 'src/swarm/mbd.ts', reference: KDIGO_CKD_MBD_2017,
  },
  {
    id: 'kdigo.calcium.band', protocol: 'ckd-mbd', name: 'Corrected calcium target',
    metric: 'Corrected calcium', unit: 'mg/dL', comparator: 'between', bounds: { min: 8.4, max: 10.2 },
    enforcement: 'guardrail', implementedIn: 'src/swarm/mbd.ts', reference: KDIGO_CKD_MBD_2017,
  },
  {
    id: 'kdigo.pth.band', protocol: 'ckd-mbd', name: 'PTH target (toward normal)',
    metric: 'PTH', unit: 'pg/mL', comparator: 'between', bounds: { min: 130, max: 585 },
    enforcement: 'guardrail', implementedIn: 'src/swarm/mbd.ts',
    reference: { ...KDIGO_CKD_MBD_2017, statement: 'PTH is interpreted jointly with phosphate and calcium, never in isolation.' },
  },
  {
    id: 'kdigo.vitd.sufficiency', protocol: 'ckd-mbd', name: 'Vitamin D sufficiency',
    metric: '25-OH vitamin D', unit: 'ng/mL', comparator: 'gte', bounds: { value: 30 },
    enforcement: 'surveillance', implementedIn: 'src/swarm/mbd.ts', reference: KDIGO_CKD_MBD_2017,
  },
  {
    id: 'anant.calcium.safety-ceiling', protocol: 'ckd-mbd', name: 'Calcium safety ceiling (hard envelope)',
    metric: 'Corrected calcium', unit: 'mg/dL', comparator: 'lte', bounds: { value: 10.5 },
    enforcement: 'guardrail', implementedIn: 'src/swarm/mbd.ts',
    reference: { source: 'AnantHQ', edition: '2026', statement: 'A hard envelope enforced BEFORE scoring: no candidate therapy may project calcium above the ceiling, whatever the score says.' },
  },
  {
    id: 'anant.calcium.safety-floor', protocol: 'ckd-mbd', name: 'Calcium safety floor (hard envelope)',
    metric: 'Corrected calcium', unit: 'mg/dL', comparator: 'gte', bounds: { value: 8 },
    enforcement: 'guardrail', implementedIn: 'src/swarm/mbd.ts',
    reference: { source: 'AnantHQ', edition: '2026', statement: 'Hypocalcaemia is as dangerous as hypercalcaemia; the floor is part of the same hard envelope.' },
  },
  {
    id: 'anant.phosphate.safety-floor', protocol: 'ckd-mbd', name: 'Phosphate safety floor (hard envelope)',
    metric: 'Phosphate', unit: 'mg/dL', comparator: 'gte', bounds: { value: 2 },
    enforcement: 'guardrail', implementedIn: 'src/swarm/mbd.ts',
    reference: { source: 'AnantHQ', edition: '2026', statement: 'Binder escalation must not project phosphate below the floor.' },
  },
  {
    id: 'cms.hypercalcemia.threshold', protocol: 'ckd-mbd', name: 'ESRD QIP hypercalcaemia threshold',
    metric: 'Corrected calcium', unit: 'mg/dL', comparator: 'gt', bounds: { value: 10.2 },
    enforcement: 'surveillance', implementedIn: 'src/cms/qip.ts', reference: CMS_QIP,
  },
  {
    id: 'kdigo.mbd.serial-triplets', protocol: 'ckd-mbd', name: 'Serial triplets before interpretation',
    metric: 'Calcium/phosphate/PTH triplets', unit: 'count', comparator: 'gte', bounds: { value: 2 },
    enforcement: 'coverage-gate', implementedIn: 'src/swarm/mbd.ts',
    reference: { ...KDIGO_CKD_MBD_2017, statement: 'All three analytes are interpreted jointly and serially; a single triplet cannot carry a therapy decision.' },
  },

  /* ---------- nutrition / electrolytes ---------- */
  {
    id: 'kdoqi.albumin.floor', protocol: 'nutrition-electrolytes', name: 'Serum albumin floor',
    metric: 'Albumin', unit: 'g/dL', comparator: 'lt', bounds: { value: 3.5 },
    enforcement: 'surveillance', implementedIn: 'src/swarm/nutrition.ts', reference: KDOQI_NUTRITION_2020,
  },
  {
    id: 'kdoqi.albumin.severe', protocol: 'nutrition-electrolytes', name: 'Severe hypoalbuminaemia',
    metric: 'Albumin', unit: 'g/dL', comparator: 'lt', bounds: { value: 3 },
    enforcement: 'escalation', implementedIn: 'src/swarm/nutrition.ts', reference: KDOQI_NUTRITION_2020,
  },
  {
    id: 'kdoqi.crp.inflammation', protocol: 'nutrition-electrolytes', name: 'Inflammation cut-off',
    metric: 'hs-CRP', unit: 'mg/L', comparator: 'gt', bounds: { value: 10 },
    enforcement: 'surveillance', implementedIn: 'src/swarm/nutrition.ts',
    reference: { ...KDOQI_NUTRITION_2020, statement: 'A high CRP with falling albumin is inflammation, not poor intake — feeding will not fix it.' },
  },
  {
    id: 'kdoqi.handgrip.low', protocol: 'nutrition-electrolytes', name: 'Low handgrip strength',
    metric: 'Handgrip', unit: 'kg', comparator: 'lt', bounds: { value: 24 },
    enforcement: 'surveillance', implementedIn: 'src/swarm/nutrition.ts', reference: KDOQI_NUTRITION_2020,
  },
  {
    id: 'kdoqi.nonhdl.low', protocol: 'nutrition-electrolytes', name: 'Low non-HDL cholesterol',
    metric: 'Non-HDL cholesterol', unit: 'mg/dL', comparator: 'lt', bounds: { value: 100 },
    enforcement: 'surveillance', implementedIn: 'src/swarm/nutrition.ts',
    reference: { ...KDOQI_NUTRITION_2020, statement: 'A LOW non-HDL is the adverse nutrition signal in dialysis, not a favourable one.' },
  },
  {
    id: 'kdigo.potassium.high', protocol: 'nutrition-electrolytes', name: 'Hyperkalaemia threshold',
    metric: 'Potassium', unit: 'mmol/L', comparator: 'gt', bounds: { value: 6 },
    enforcement: 'guardrail', implementedIn: 'src/swarm/nutrition.ts', reference: KDOQI_NUTRITION_2020,
  },
  {
    id: 'kdoqi.potassium.lab-max-age', protocol: 'nutrition-electrolytes', name: 'Potassium lab freshness',
    metric: 'Potassium age', unit: 'h', comparator: 'lte', bounds: { value: 12 },
    enforcement: 'guardrail', implementedIn: 'src/swarm/nutrition.ts',
    reference: { ...KDOQI_NUTRITION_2020, statement: 'Every potassium-lowering action requires a confirmatory lab no older than this; a device ECG pattern is an adjunct and can never stand alone.' },
  },
  {
    id: 'kdigo.bicarbonate.low', protocol: 'nutrition-electrolytes', name: 'Metabolic acidosis floor',
    metric: 'Bicarbonate', unit: 'mmol/L', comparator: 'lt', bounds: { value: 22 },
    enforcement: 'surveillance', implementedIn: 'src/swarm/nutrition.ts', reference: KDOQI_NUTRITION_2020,
  },
  {
    id: 'kdoqi.pew.markers', protocol: 'nutrition-electrolytes', name: 'PEW marker count',
    metric: 'PEW markers', unit: 'count', comparator: 'gte', bounds: { value: 3 },
    enforcement: 'surveillance', implementedIn: 'src/swarm/nutrition.ts',
    reference: { ...KDOQI_NUTRITION_2020, statement: 'PEW is a multi-marker diagnosis, and its five pathways are never averaged into one cause.' },
  },
  {
    id: 'kdoqi.pew.min-markers', protocol: 'nutrition-electrolytes', name: 'Nutrition markers before a PEW claim',
    metric: 'Nutrition markers', unit: 'count', comparator: 'gte', bounds: { value: 2 },
    enforcement: 'coverage-gate', implementedIn: 'src/swarm/nutrition-governance.ts',
    reference: { ...KDOQI_NUTRITION_2020, statement: 'A protein-energy wasting assessment needs at least two measured markers; below that the pack refuses the claim rather than imputing.' },
  },
  {
    id: 'kdoqi.nutrition.serial-measurements', protocol: 'nutrition-electrolytes', name: 'Serial measurements before interpretation',
    metric: 'Serial measurements', unit: 'count', comparator: 'gte', bounds: { value: 2 },
    enforcement: 'coverage-gate', implementedIn: 'src/swarm/nutrition-governance.ts',
    reference: { ...KDOQI_NUTRITION_2020, statement: 'Nutrition trends are read across sessions; a single draw cannot support a dietary change.' },
  },

  /* ---------- infection / vaccination ---------- */
  {
    id: 'nhsn.fever.threshold', protocol: 'infection', name: 'Fever threshold for evaluation',
    metric: 'Temperature', unit: '°C', comparator: 'gte', bounds: { value: 38 },
    enforcement: 'escalation', implementedIn: 'src/swarm/infection.ts',
    reference: { ...NHSN_SURVEILLANCE, statement: 'A dialysis patient with a temperature at or above 38.0 °C requires evaluation; the platform proposes cultures and a review.' },
  },
  {
    id: 'cdc.temperature.low-grade', protocol: 'infection', name: 'Low-grade surveillance trigger',
    metric: 'Temperature', unit: '°C', comparator: 'gte', bounds: { value: 37.8 },
    enforcement: 'surveillance', implementedIn: 'src/swarm/infection.ts',
    reference: { ...CDC_BSI_2017, statement: 'Temperature is recorded at every session; the lower trigger drives surveillance rather than action.' },
  },
  {
    id: 'cdc.temperature.min-readings', protocol: 'infection', name: 'Serial readings before a triage claim',
    metric: 'Temperature readings', unit: 'count', comparator: 'gte', bounds: { value: 3 },
    enforcement: 'coverage-gate', implementedIn: 'src/swarm/infection.ts',
    reference: { ...CDC_BSI_2017, statement: 'A single reading is never a trend; the triage refuses to answer without a serial series.' },
  },
  {
    id: 'cdc.catheter.escalation-days', protocol: 'infection', name: 'Catheter-day escalation',
    metric: 'Catheter days', unit: 'd', comparator: 'gt', bounds: { value: 90 },
    enforcement: 'escalation', implementedIn: 'src/swarm/infection-prevention.ts',
    reference: { ...CDC_BSI_2017, statement: 'A catheter in situ beyond 90 days with a mature alternative documented is escalated for removal review.' },
  },
  {
    id: 'cdc.culture.before-antibiotic', protocol: 'infection', name: 'Blood cultures before antimicrobial discussion',
    metric: 'Culture on file', unit: '', comparator: 'present', bounds: {},
    enforcement: 'guardrail', implementedIn: 'src/swarm/infection.ts',
    reference: { ...CDC_BSI_2017, statement: 'Culture-before-antibiotic is a rule, not a preference: no culture on file refuses the discussion outright.' },
  },
  {
    id: 'anant.antimicrobial.authority', protocol: 'infection', name: 'No antimicrobial authority',
    metric: 'Prescribing authority', unit: '', comparator: 'never', bounds: {},
    enforcement: 'authority', implementedIn: 'src/swarm/infection-types.ts',
    reference: { source: 'AnantHQ', edition: '2026', statement: 'The platform never names an antimicrobial, a dose or a duration — agent selection is a prescriber decision.' },
  },
  {
    id: 'anant.prevention.model-free', protocol: 'infection', name: 'Prevention path is model-free',
    metric: 'Model inputs to prevention', unit: '', comparator: 'never', bounds: {},
    enforcement: 'authority', implementedIn: 'src/swarm/infection-prevention.ts',
    reference: { source: 'AnantHQ', edition: '2026', statement: 'Vaccination due dates, serology follow-up, audit cadence and catheter-day escalation are deterministic rules over records; no model output reaches them.' },
  },
  {
    id: 'nhsn.procalcitonin.watch', protocol: 'infection', name: 'Procalcitonin watch threshold',
    metric: 'Procalcitonin', unit: 'ng/mL', comparator: 'gt', bounds: { value: 0.5 },
    enforcement: 'surveillance', implementedIn: 'src/swarm/infection.ts', reference: NHSN_SURVEILLANCE,
  },
  {
    id: 'nhsn.procalcitonin.high', protocol: 'infection', name: 'Procalcitonin high threshold',
    metric: 'Procalcitonin', unit: 'ng/mL', comparator: 'gt', bounds: { value: 2 },
    enforcement: 'escalation', implementedIn: 'src/swarm/infection.ts', reference: NHSN_SURVEILLANCE,
  },
  {
    id: 'nhsn.nlr.sepsis-signal', protocol: 'infection', name: 'NLR sepsis-triage signal',
    metric: 'Neutrophil–lymphocyte ratio', unit: '', comparator: 'gte', bounds: { value: 6 },
    enforcement: 'escalation', implementedIn: 'src/swarm/infection.ts', reference: NHSN_SURVEILLANCE,
  },
  {
    id: 'acip.hepatitis-b.series', protocol: 'infection', name: 'Hepatitis B series for dialysis patients',
    metric: 'Hepatitis B doses', unit: 'count', comparator: 'gte', bounds: { value: 3 },
    enforcement: 'escalation', implementedIn: 'src/swarm/infection-prevention.ts', reference: ACIP_SCHEDULE,
  },
  {
    id: 'acip.influenza.annual', protocol: 'infection', name: 'Annual influenza vaccination',
    metric: 'Influenza interval', unit: 'd', comparator: 'lte', bounds: { value: 365 },
    enforcement: 'escalation', implementedIn: 'src/swarm/infection-prevention.ts', reference: ACIP_SCHEDULE,
  },
  {
    id: 'acip.hbsab.protective', protocol: 'infection', name: 'Protective anti-HBs titre',
    metric: 'Anti-HBs', unit: 'mIU/mL', comparator: 'gte', bounds: { value: 10 },
    enforcement: 'escalation', implementedIn: 'src/swarm/infection-prevention.ts',
    reference: { ...ACIP_SCHEDULE, statement: 'A titre below the protective threshold triggers a recheck and revaccination if still non-protective.' },
  },
  {
    id: 'cdc.audit.cadence', protocol: 'infection', name: 'Prevention audit cadence',
    metric: 'Days since audit', unit: 'd', comparator: 'gt', bounds: { value: 30 },
    enforcement: 'surveillance', implementedIn: 'src/swarm/infection-prevention.ts',
    reference: { ...CDC_BSI_2017, statement: 'Hand-hygiene and access-care audits follow a cadence; a missing audit is overdue, never assumed done.' },
  },

  /* ---------- the authority boundary, declared once per pack ----------
   * Every pack states `autonomy: 'never-autonomous'` in its regulatory posture,
   * and its advisor gate fails if the platform is ever handed machine, ordering
   * or prescribing authority. These rules make that boundary auditable from the
   * same table a reviewer reads the thresholds from — the drift test asserts the
   * posture constant still says `never-autonomous`.
   */
  {
    id: 'anant.anemia.authority', protocol: 'anemia', name: 'No autonomous ESA dose authority',
    metric: 'Dose autonomy', unit: '', comparator: 'never', bounds: {},
    enforcement: 'authority', implementedIn: 'src/swarm/anemia-governance.ts',
    reference: { source: 'AnantHQ', edition: '2026', statement: 'The platform never changes an ESA dose on its own: every recommendation is a Class C proposal a nephrologist approves.' },
  },
  {
    id: 'anant.adequacy.authority', protocol: 'adequacy', name: 'No machine-control authority',
    metric: 'Machine control', unit: '', comparator: 'never', bounds: {},
    enforcement: 'authority', implementedIn: 'src/swarm/adequacy-governance.ts',
    reference: { source: 'AnantHQ', edition: '2026', statement: 'No machine parameter is written by the platform — the advisor gate fails outright if machine-control authority is ever granted.' },
  },
  {
    id: 'anant.fluid.authority', protocol: 'fluid', name: 'No ultrafiltration authority',
    metric: 'UF control', unit: '', comparator: 'never', bounds: {},
    enforcement: 'authority', implementedIn: 'src/swarm/fluid-governance.ts',
    reference: { source: 'AnantHQ', edition: '2026', statement: 'The platform sets no ultrafiltration rate and no machine parameter; it proposes and a clinician decides.' },
  },
  {
    id: 'anant.mbd.authority', protocol: 'ckd-mbd', name: 'No prescribing authority',
    metric: 'Prescribing', unit: '', comparator: 'never', bounds: {},
    enforcement: 'authority', implementedIn: 'src/swarm/mbd-governance.ts',
    reference: { source: 'AnantHQ', edition: '2026', statement: 'The platform never writes a therapy or orders a drug — binder and calcimimetic changes stay prescriber decisions.' },
  },
  {
    id: 'anant.nutrition.authority', protocol: 'nutrition-electrolytes', name: 'No ordering authority',
    metric: 'Ordering', unit: '', comparator: 'never', bounds: {},
    enforcement: 'authority', implementedIn: 'src/swarm/nutrition-governance.ts',
    reference: { source: 'AnantHQ', edition: '2026', statement: 'The platform orders no drug, supplement or transport, and a device ECG pattern can never stand alone as a potassium result.' },
  },
  {
    id: 'anant.anemia.twin-drift', protocol: 'anemia', name: 'Forecast drift monitored against target',
    metric: 'Twin MAPE vs target', unit: '%', comparator: 'lte', bounds: { value: 10 },
    enforcement: 'surveillance', implementedIn: 'src/swarm/anemia-twin.ts',
    reference: { source: 'AnantHQ', edition: '2026', statement: 'The patient twin is scored against its own forecast every week; drifting past the target is recorded for review, not actioned automatically.' },
  },
];

/* ======================================================================
 * Bindings — the constant each rule mirrors in the packs
 * ====================================================================== */

export interface RuleBinding {
  ruleId: string;
  /** module + exported constant the runtime value lives in */
  constant: string;
  /** dotted path inside that constant (for nested bands) */
  path?: string;
  /**
   * For a boundary that is stated rather than measured (an authority posture, a
   * boolean capability flag), the exact value the constant must still hold. The
   * drift test asserts it verbatim, so `never-autonomous` cannot quietly become
   * something else.
   */
  expectValue?: string | number | boolean;
}

export const RULE_PACK_BINDINGS: readonly RuleBinding[] = [
  { ruleId: 'kdigo.hb.band', constant: 'HGB_TARGET', path: 'min' },
  { ruleId: 'kdigo.ktv.target', constant: 'KTV_TARGET' },
  { ruleId: 'kdigo.ktv.frequent-target', constant: 'KTV_TARGET_FREQUENT' },
  { ruleId: 'kdigo.urr.floor', constant: 'URR_FLOOR_PCT' },
  { ruleId: 'kdigo.idwg.flag', constant: 'IDWG_FLAG_KG' },
  { ruleId: 'kdigo.nadir-sbp.floor', constant: 'NADIR_SBP_FLOOR' },
  { ruleId: 'kdigo.phosphate.band', constant: 'MBD_REFERENCE', path: 'phosphateTargetMgDl.upper' },
  { ruleId: 'kdigo.calcium.band', constant: 'MBD_REFERENCE', path: 'correctedCalciumTargetMgDl.upper' },
  { ruleId: 'kdigo.pth.band', constant: 'MBD_REFERENCE', path: 'pthTargetPgMl.upper' },
  { ruleId: 'kdigo.vitd.sufficiency', constant: 'MBD_REFERENCE', path: 'vitaminDSufficiencyNgMl' },
  { ruleId: 'anant.calcium.safety-ceiling', constant: 'MBD_REFERENCE', path: 'calciumSafetyCeilingMgDl' },
  { ruleId: 'anant.calcium.safety-floor', constant: 'MBD_REFERENCE', path: 'calciumSafetyFloorMgDl' },
  { ruleId: 'anant.phosphate.safety-floor', constant: 'MBD_REFERENCE', path: 'phosphateSafetyFloorMgDl' },
  { ruleId: 'kdigo.mbd.serial-triplets', constant: 'MBD_REFERENCE', path: 'minTriplets' },
  { ruleId: 'kdoqi.albumin.floor', constant: 'NUTRITION_REFERENCE', path: 'albuminFloorGDl' },
  { ruleId: 'kdoqi.albumin.severe', constant: 'NUTRITION_REFERENCE', path: 'albuminSevereGDl' },
  { ruleId: 'kdoqi.crp.inflammation', constant: 'NUTRITION_REFERENCE', path: 'crpInflammationMgL' },
  { ruleId: 'kdoqi.handgrip.low', constant: 'NUTRITION_REFERENCE', path: 'handgripLowKg' },
  { ruleId: 'kdoqi.nonhdl.low', constant: 'NUTRITION_REFERENCE', path: 'nonHdlLowMgDl' },
  { ruleId: 'kdigo.potassium.high', constant: 'NUTRITION_REFERENCE', path: 'potassiumHighMmolL' },
  { ruleId: 'kdoqi.potassium.lab-max-age', constant: 'NUTRITION_REFERENCE', path: 'potassiumLabMaxAgeHours' },
  { ruleId: 'kdigo.bicarbonate.low', constant: 'NUTRITION_REFERENCE', path: 'bicarbonateLowMmolL' },
  { ruleId: 'kdoqi.pew.markers', constant: 'NUTRITION_REFERENCE', path: 'fewMarkersRequired' },
  { ruleId: 'kdoqi.pew.min-markers', constant: 'NUTRITION_COVERAGE_DEFAULTS', path: 'minNutritionMarkers' },
  { ruleId: 'kdoqi.nutrition.serial-measurements', constant: 'NUTRITION_REFERENCE', path: 'minSerialMeasurements' },
  { ruleId: 'nhsn.fever.threshold', constant: 'INFECTION_REFERENCE', path: 'feverC' },
  { ruleId: 'cdc.temperature.low-grade', constant: 'INFECTION_REFERENCE', path: 'lowGradeFeverC' },
  { ruleId: 'cdc.temperature.min-readings', constant: 'INFECTION_REFERENCE', path: 'minTemperatureReadings' },
  { ruleId: 'cdc.catheter.escalation-days', constant: 'INFECTION_REFERENCE', path: 'catheterEscalationDays' },
  { ruleId: 'nhsn.procalcitonin.watch', constant: 'INFECTION_REFERENCE', path: 'procalcitoninWatchNgMl' },
  { ruleId: 'nhsn.procalcitonin.high', constant: 'INFECTION_REFERENCE', path: 'procalcitoninHighNgMl' },
  { ruleId: 'nhsn.nlr.sepsis-signal', constant: 'INFECTION_REFERENCE', path: 'nlrHigh' },
  { ruleId: 'kdoqi.access.venous-pressure-rise', constant: 'ACCESS_REFERENCE', path: 'venousPressureRisePct' },
  { ruleId: 'kdoqi.access.recirculation', constant: 'ACCESS_REFERENCE', path: 'recirculationFlagPct' },
  { ruleId: 'kdoqi.access.flow-floor', constant: 'ACCESS_REFERENCE', path: 'accessFlowFloorMlMin' },
  { ruleId: 'kdoqi.access.flow-decline', constant: 'ACCESS_REFERENCE', path: 'accessFlowDeclinePct' },
  { ruleId: 'kdoqi.access.min-observations', constant: 'ACCESS_REFERENCE', path: 'minObservationsForReferral' },
  { ruleId: 'kdoqi.access.quiet-window', constant: 'ACCESS_REFERENCE', path: 'postInterventionQuietDays' },
  { ruleId: 'anant.access.stenosis-referral', constant: 'ACCESS_REFERENCE', path: 'stenosisReferralThreshold' },
  { ruleId: 'anant.recirculation.interpretability', constant: 'ADEQUACY_COVERAGE_DEFAULTS', path: 'maxRecirculationPct' },
  { ruleId: 'anant.uf-rate.safe', constant: 'UF_RATE_PER_KG_SAFE' },
  { ruleId: 'anant.uf-rate.high', constant: 'UF_RATE_PER_KG_HIGH' },
  { ruleId: 'anant.uf-rate.step', constant: 'UF_RATE_STEP' },
  { ruleId: 'anant.anemia.authority', constant: 'ESA_REGULATORY_POSTURE', path: 'autonomy', expectValue: 'never-autonomous' },
  { ruleId: 'anant.adequacy.authority', constant: 'ADEQUACY_REGULATORY_POSTURE', path: 'autonomy', expectValue: 'never-autonomous' },
  { ruleId: 'anant.fluid.authority', constant: 'FLUID_REGULATORY_POSTURE', path: 'autonomy', expectValue: 'never-autonomous' },
  { ruleId: 'anant.mbd.authority', constant: 'MBD_REGULATORY_POSTURE', path: 'autonomy', expectValue: 'never-autonomous' },
  { ruleId: 'anant.nutrition.authority', constant: 'NUTRITION_REGULATORY_POSTURE', path: 'autonomy', expectValue: 'never-autonomous' },
  { ruleId: 'anant.anemia.twin-drift', constant: 'ESA_TWIN_DRIFT_TARGET_MAPE_PCT' },
];
/* ======================================================================
 * Queries + evaluation
 * ====================================================================== */

export const RULE_PROTOCOLS: readonly ProtocolId[] = ['anemia', 'adequacy', 'fluid', 'access', 'ckd-mbd', 'nutrition-electrolytes', 'infection'];

export function rulesForProtocol(protocol: ProtocolId): RuleDefinition[] {
  return RULE_PACKS.filter((r) => r.protocol === protocol);
}

export function ruleById(id: string): RuleDefinition | undefined {
  return RULE_PACKS.find((r) => r.id === id);
}

export function bindingFor(ruleId: string): RuleBinding | undefined {
  return RULE_PACK_BINDINGS.find((b) => b.ruleId === ruleId);
}

export interface RuleEvaluation {
  ruleId: string;
  metric: string;
  value?: number | undefined;
  /** true when the value satisfies the rule */
  satisfied: boolean;
  /** human detail for the audit trail */
  detail: string;
  /** the bound the value was compared against */
  against: string;
}

/**
 * Evaluate a value against a rule. Rules with no numeric bound (`present`,
 * `never`) are satisfied when the caller reports the condition holds; they exist
 * to make an AUTHORITY or CONTRACT explicit and reviewable rather than implicit
 * in control flow.
 */
export function evaluateRule(rule: RuleDefinition, value: number | undefined, present = false): RuleEvaluation {
  const { comparator, bounds } = rule;
  if (comparator === 'present') {
    return { ruleId: rule.id, metric: rule.metric, value: undefined, satisfied: present, detail: present ? `${rule.metric} present` : `${rule.metric} missing`, against: 'present' };
  }
  if (comparator === 'never') {
    return { ruleId: rule.id, metric: rule.metric, value: undefined, satisfied: !present, detail: present ? `${rule.metric} was exercised — contract violated` : `${rule.metric} never applied`, against: 'never' };
  }
  if (value === undefined) {
    return { ruleId: rule.id, metric: rule.metric, value: undefined, satisfied: false, detail: `${rule.metric} not measured`, against: describeBounds(rule) };
  }
  let satisfied: boolean;
  switch (comparator) {
    case 'gt': satisfied = value > (bounds.value ?? 0); break;
    case 'gte': satisfied = value >= (bounds.value ?? 0); break;
    case 'lt': satisfied = value < (bounds.value ?? 0); break;
    case 'lte': satisfied = value <= (bounds.value ?? 0); break;
    case 'between': satisfied = value >= (bounds.min ?? Number.NEGATIVE_INFINITY) && value <= (bounds.max ?? Number.POSITIVE_INFINITY); break;
    case 'outside': satisfied = value < (bounds.min ?? Number.NEGATIVE_INFINITY) || value > (bounds.max ?? Number.POSITIVE_INFINITY); break;
    default: satisfied = false;
  }
  return {
    ruleId: rule.id,
    metric: rule.metric,
    value,
    satisfied,
    detail: `${rule.metric} ${value} ${satisfied ? 'satisfies' : 'violates'} ${describeBounds(rule)}`,
    against: describeBounds(rule),
  };
}

function describeBounds(rule: RuleDefinition): string {
  const { comparator, bounds, unit } = rule;
  const u = unit ? ` ${unit}` : '';
  switch (comparator) {
    case 'between': return `${bounds.min}–${bounds.max}${u}`;
    case 'outside': return `outside ${bounds.min}–${bounds.max}${u}`;
    case 'gt': return `> ${bounds.value}${u}`;
    case 'gte': return `>= ${bounds.value}${u}`;
    case 'lt': return `< ${bounds.value}${u}`;
    case 'lte': return `<= ${bounds.value}${u}`;
    case 'present': return 'must be present';
    case 'never': return 'must never be exercised';
    default: return '—';
  }
}

/** Every rule a protocol relies on, with where it is enforced. */
export interface RulePackSummary {
  total: number;
  byProtocol: Record<string, { rules: number; enforcement: Record<string, number>; sources: string[] }>;
  bySource: Record<string, number>;
  byEnforcement: Record<string, number>;
  /** rules with no `implementedIn` — a rule nobody enforces is a gap */
  unenforced: string[];
}

export function rulePackSummary(): RulePackSummary {
  const byProtocol: RulePackSummary['byProtocol'] = {};
  const bySource: Record<string, number> = {};
  const byEnforcement: Record<string, number> = {};
  const unenforced: string[] = [];
  for (const rule of RULE_PACKS) {
    const entry = byProtocol[rule.protocol] ?? { rules: 0, enforcement: {}, sources: [] };
    entry.rules += 1;
    entry.enforcement[rule.enforcement] = (entry.enforcement[rule.enforcement] ?? 0) + 1;
    if (!entry.sources.includes(rule.reference.source)) entry.sources.push(rule.reference.source);
    byProtocol[rule.protocol] = entry;
    bySource[rule.reference.source] = (bySource[rule.reference.source] ?? 0) + 1;
    byEnforcement[rule.enforcement] = (byEnforcement[rule.enforcement] ?? 0) + 1;
    if (!rule.implementedIn) unenforced.push(rule.id);
  }
  return { total: RULE_PACKS.length, byProtocol, bySource, byEnforcement, unenforced };
}

/**
 * The rules a protocol does NOT cover, out of the enforcement classes a clinical
 * decision-support system is expected to declare. Used by the assurance
 * dashboard to show a gap rather than claim completeness.
 */
export function enforcementGaps(protocol: ProtocolId): RuleEnforcement[] {
  const present = new Set(rulesForProtocol(protocol).map((r) => r.enforcement));
  return (['guardrail', 'coverage-gate', 'authority', 'escalation', 'surveillance'] as RuleEnforcement[]).filter((e) => !present.has(e));
}

/** The guideline editions currently bound, for the MDR/regulatory surface. */
export function rulePackEditions(): Array<{ source: RuleSource; edition: string; rules: number }> {
  const map = new Map<string, { source: RuleSource; edition: string; rules: number }>();
  for (const rule of RULE_PACKS) {
    const key = `${rule.reference.source}@${rule.reference.edition}`;
    const entry = map.get(key) ?? { source: rule.reference.source, edition: rule.reference.edition, rules: 0 };
    entry.rules += 1;
    map.set(key, entry);
  }
  return [...map.values()].sort((a, b) => b.rules - a.rules);
}
