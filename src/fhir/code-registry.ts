/******************************************************************************
 *
 * Copyright (c) 2026 AnantHQ Inc.
 * All Rights Reserved.
 *
 * This software is licensed, not sold.
 *
 * The contents of this file constitute confidential and proprietary
 * information belonging exclusively to AnantHQ Inc.
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

// Terminology registry (F4) — the ONE place an internal domain slug becomes a
// real coded concept.
//
// The clinical engine speaks in lowercase slugs (`epoetin-alfa`, `KTV-DEL`,
// `missed-treatment`). Before F4 those slugs were written straight into
// RxNorm / LOINC / CVX / SNOMED fields, so a clinician received a "code" no
// system recognises. Every code that leaves the building now resolves through
// this registry, and an unmapped slug REFUSES the write rather than shipping a
// plausible-looking wrong code.
//
// Two fidelities, and the distinction is the point:
//
//   `verified` — the code value was checked against the authority's own service
//                (tx.fhir.org for LOINC/SNOMED, NLM RxNav for RxNorm) and the
//                display below is what the authority returned. `source` records
//                which service and when.
//   `local`    — no authoritative concept was found, so we declare our OWN code
//                system instead of writing a wrong code into a licensed one.
//                These require clinical/terminology sign-off before a
//                production integration; `terminologyReport()` lists them.
//
// A `local` entry is honest. Guessing a SNOMED concept id is not, because it
// looks authoritative and fails silently in the EMR. Verify with:
//   node scripts/verify-fhir-codes.mjs      (network; not part of CI)

import { code, concept, type Coding, type CodeableConcept } from './types.js';

export type CodeDomain =
  | 'lab'
  | 'vital'
  | 'drug'
  | 'vaccine'
  | 'safety-flag'
  | 'assessment'
  | 'access-type'
  | 'access-event'
  | 'dialysis-modality'
  | 'claim-type'
  | 'route'
  | 'followup'
  | 'practitioner-role'
  | 'task-code'
  | 'encounter-class'
  | 'discharge-disposition'
  | 'observation-category'
  | 'security-label'
  // F7 — the renal wire model
  | 'procedure'
  | 'procedure-category'
  | 'body-weight'
  | 'session-metric'
  | 'access-metric'
  | 'session-telemetry';

export type CodeFidelity = 'verified' | 'local';

export interface CodeEntry {
  readonly domain: CodeDomain;
  readonly slug: string;
  readonly system: string;
  readonly code: string;
  readonly display: string;
  readonly version: string;
  readonly fidelity: CodeFidelity;
  /** Where the mapping came from. For `verified`, the service queried + date. */
  readonly source: string;
}

/** Our own code system for concepts we could not verify. Never a licensed one. */
export function localCodeSystem(domain: CodeDomain): string {
  return `urn:ananthealth:codesystem:${domain}`;
}

/** Releases the verified entries were checked against. */
const V = {
  loinc: '2.82',
  rxnorm: '2026-02-03',
  cvx: '2025-07-15',
  snomed: '2025-02-01',
  fhir: '4.0.1',
  hl7v3: '2023',
} as const;

const LOINC = 'http://loinc.org';
const RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm';
const CVX = 'http://hl7.org/fhir/sid/cvx';
const SNOMED = 'http://snomed.info/sct';
const FHIR_TX = 'http://terminology.hl7.org/CodeSystem';
const V3 = 'http://terminology.hl7.org/CodeSystem/v3-ActCode';
const V3_ROUTE = 'http://terminology.hl7.org/CodeSystem/v3-RouteOfAdministration';

const VERIFIED = 'verified 2026-09-13 via tx.fhir.org $lookup';
const VERIFIED_RXNAV = 'verified 2026-09-13 via NLM RxNav + tx.fhir.org $lookup';
const SPEC = 'published code from the FHIR R4 / HL7 v3 specification';

/** Shorthand for a verified entry. */
const v = (
  domain: CodeDomain,
  slug: string,
  system: string,
  code_: string,
  display: string,
  version: string,
  source = VERIFIED,
): CodeEntry => ({ domain, slug, system, code: code_, display, version, fidelity: 'verified', source });

/** Shorthand for a locally-declared entry awaiting terminology sign-off. */
const l = (domain: CodeDomain, slug: string, display: string, why: string): CodeEntry => ({
  domain,
  slug,
  system: localCodeSystem(domain),
  code: slug,
  display,
  version: '1.0.0',
  fidelity: 'local',
  source: `local concept — ${why}`,
});

/**
 * Every code the harness can emit. Seeded from src/ontology/seeds.ts and
 * src/healthcare-core/terminology.ts where those values were CORRECT, and
 * corrected where verification proved them wrong (see DEV-NOTES below).
 */
export const CODE_SEEDS: readonly CodeEntry[] = Object.freeze([
  // ---- Labs (LOINC) -------------------------------------------------------
  // NOTE: seeds.ts declares `33914-3` as "Estimated urea Kt/V ratio" and
  // `70969-1` as "Urea clearance normalized to volume of distribution (Kt/V)".
  // tx.fhir.org returns GFR (MDRD) for BOTH. The real Kt/V codes are 70961-8 /
  // 70965-9 (HD) and 70960-0 (PD); 18262-6 and 18263-4 are LDL/HDL cholesterol.
  v('lab', 'K', LOINC, '2823-3', 'Potassium [Moles/volume] in Serum or Plasma', V.loinc),
  v('lab', 'POTASSIUM', LOINC, '2823-3', 'Potassium [Moles/volume] in Serum or Plasma', V.loinc),
  v('lab', 'HGB', LOINC, '718-7', 'Hemoglobin [Mass/volume] in Blood', V.loinc),
  v('lab', 'PHOS', LOINC, '2777-1', 'Phosphate [Mass/volume] in Serum or Plasma', V.loinc),
  v('lab', 'ALBUMIN', LOINC, '2885-2', 'Protein [Mass/volume] in Serum or Plasma', V.loinc),
  v('lab', 'CREATININE', LOINC, '2160-0', 'Creatinine [Mass/volume] in Serum or Plasma', V.loinc),
  v('lab', 'BICARB', LOINC, '1963-8', 'Bicarbonate [Moles/volume] in Serum or Plasma', V.loinc),
  v('lab', 'CRP', LOINC, '1988-5', 'C reactive protein [Mass/volume] in Serum or Plasma', V.loinc),
  v('lab', 'CRP-HS', LOINC, '30522-7', 'C reactive protein [Mass/volume] in Serum or Plasma by High sensitivity method', V.loinc),
  v('lab', 'WBC', LOINC, '6690-2', 'Leukocytes [#/volume] in Blood by Automated count', V.loinc),
  v('lab', 'PROCALCITONIN', LOINC, '33959-8', 'Procalcitonin [Mass/volume] in Serum or Plasma', V.loinc),
  v('lab', 'NEUTPCT', LOINC, '770-8', 'Neutrophils/Leukocytes in Blood by Automated count', V.loinc),
  v('lab', 'LYMPHPCT', LOINC, '736-9', 'Lymphocytes/Leukocytes in Blood by Automated count', V.loinc),
  v('lab', 'NONHDL', LOINC, '43396-1', 'Cholesterol non HDL [Mass/volume] in Serum or Plasma', V.loinc),
  v('lab', 'VITD', LOINC, '62292-8', '25-Hydroxyvitamin D3+25-Hydroxyvitamin D2 [Mass/volume] in Serum or Plasma', V.loinc),
  v('lab', 'PTH', LOINC, '2731-8', 'Parathyrin.intact [Mass/volume] in Serum or Plasma', V.loinc),
  v('lab', 'FERRITIN', LOINC, '2276-4', 'Ferritin [Mass/volume] in Serum or Plasma', V.loinc),
  v('lab', 'TSAT', LOINC, '2502-3', 'Iron saturation [Mass Fraction] in Serum or Plasma', V.loinc),
  v('lab', 'CALCIUM', LOINC, '17861-6', 'Calcium [Mass/volume] in Serum or Plasma', V.loinc),
  v('lab', 'MCV', LOINC, '787-2', 'MCV [Entitic mean volume] in Red Blood Cells by Automated count', V.loinc),
  v('lab', 'HBSAB', LOINC, '22322-2', 'Hepatitis B virus surface Ab [Presence] in Serum', V.loinc),
  v('lab', 'BCULT', LOINC, '600-7', 'Bacteria identified in Blood by Culture', V.loinc),
  v('lab', 'URR', LOINC, '54456-9', 'Urea reduction ratio in Serum or Plasma', V.loinc),
  // Dialysis adequacy — the KTV-DEL placeholder is gone.
  v('lab', 'KTV', LOINC, '70961-8', 'Kt/V.Hemodialysis', V.loinc),
  v('lab', 'KTV-DEL', LOINC, '70961-8', 'Kt/V.Hemodialysis', V.loinc),
  v('lab', 'SPKTV', LOINC, '70965-9', 'Kt/V.Hemodialysis [Daugirdas II]', V.loinc),
  v('lab', 'KTV-PD', LOINC, '70960-0', 'Kt/V.Peritoneal Dialysis', V.loinc),

  // ---- Vitals (LOINC) ----------------------------------------------------
  v('vital', 'hr', LOINC, '8867-4', 'Heart rate', V.loinc),
  v('vital', 'spo2', LOINC, '2708-6', 'Oxygen saturation in Arterial blood', V.loinc),
  v('vital', 'temp', LOINC, '8310-5', 'Body temperature', V.loinc),
  v('vital', 'rr', LOINC, '9279-1', 'Respiratory rate', V.loinc),
  v('vital', 'bp', LOINC, '55284-4', 'Blood pressure systolic and diastolic', V.loinc),
  v('vital', 'bp-systolic', LOINC, '8480-6', 'Systolic blood pressure', V.loinc),
  v('vital', 'bp-diastolic', LOINC, '8462-4', 'Diastolic blood pressure', V.loinc),

  // ---- Drugs (RxNorm ingredient RxCUI) -----------------------------------
  // NOTE: five values in seeds.ts / terminology.ts were MISLABELLED and are
  // corrected here — 104375 is lisinopril (not epoetin alfa), 349849 is
  // isoleucine (not darbepoetin), 1364430 is apixaban (not sevelamer).
  v('drug', 'epoetin-alfa', RXNORM, '105694', 'epoetin alfa', V.rxnorm, VERIFIED_RXNAV),
  v('drug', 'darbepoetin-alfa', RXNORM, '283838', 'darbepoetin alfa', V.rxnorm, VERIFIED_RXNAV),
  v('drug', 'sevelamer', RXNORM, '214824', 'sevelamer', V.rxnorm, VERIFIED_RXNAV),
  v('drug', 'calcium-acetate', RXNORM, '214342', 'calcium acetate', V.rxnorm, VERIFIED_RXNAV),
  v('drug', 'cinacalcet', RXNORM, '384379', 'cinacalcet hydrochloride', V.rxnorm, VERIFIED_RXNAV),
  v('drug', 'calcitriol', RXNORM, '1894', 'calcitriol', V.rxnorm, VERIFIED_RXNAV),
  v('drug', 'lanthanum-carbonate', RXNORM, '234416', 'lanthanum carbonate', V.rxnorm, VERIFIED_RXNAV),
  v('drug', 'sucroferric-oxyhydroxide', RXNORM, '1484283', 'sucroferric oxyhydroxide', V.rxnorm, VERIFIED_RXNAV),
  v('drug', 'ferric-citrate', RXNORM, '1594675', 'ferric citrate', V.rxnorm, VERIFIED_RXNAV),
  v('drug', 'ferric-sucrose', RXNORM, '24909', 'iron sucrose', V.rxnorm, VERIFIED_RXNAV),
  // Emitted by the MBD/nutrition packs but with no ingredient RxCUI verified yet.
  l('drug', 'sevelamer-carbonate', 'sevelamer carbonate', 'RxNorm ingredient is sevelamer (214824)'),
  l('drug', 'phosphate-binder', 'phosphate binder (unspecified)', 'no single ingredient concept'),

  // ---- Vaccines (CVX, HL7 v2 table 0292) ---------------------------------
  v('vaccine', 'hepatitis-b', CVX, '43', 'Hep B, adult', V.cvx),
  v('vaccine', 'influenza', CVX, '150', 'Influenza, split virus, quadrivalent, PF', V.cvx),
  v('vaccine', 'pneumococcal', CVX, '133', 'Pneumococcal conjugate PCV 13', V.cvx),
  v('vaccine', 'sars-cov-2', CVX, '213', 'SARS-COV-2 (COVID-19) vaccine, UNSPECIFIED', V.cvx),

  // ---- Safety flags (SNOMED where verified, local otherwise) -------------
  v('safety-flag', 'hypoxia', SNOMED, '389086002', 'Hypoxia', V.snomed),
  v('safety-flag', 'missed-treatment', SNOMED, '7058009', 'Noncompliance with treatment', V.snomed),
  v('safety-flag', 'bacteremia', SNOMED, '5758002', 'Bacteremia', V.snomed),
  v('safety-flag', 'line-associated-bacteremia', SNOMED, '428885001', 'Bacteremia associated with intravascular line', V.snomed),
  // No authoritative concept verified — declared locally rather than guessed.
  l('safety-flag', 'access-risk', 'Vascular access at risk', 'no verified SNOMED concept'),
  l('safety-flag', 'lab-critical', 'Critical laboratory result', 'no verified SNOMED concept'),
  l('safety-flag', 'repeated-abnormal-labs', 'Repeated abnormal laboratory results', 'no verified SNOMED concept'),
  l('safety-flag', 'ecg-peaked-t-pattern', 'Peaked T waves on ECG', 'no verified SNOMED concept'),
  l('safety-flag', 'sepsis.detected', 'Sepsis suspected', 'bacteremia (5758002) is the verified proxy'),

  // ---- Assessments (LOINC instruments; operational audits are local) -----
  // NOTE: these were transcribed from seeds.ts and THREE were wrong there —
  // 72172-0 was labelled AUDIT-C but is MoCA, 72109-2 was labelled MoCA but is
  // AUDIT-C (they are SWAPPED), and 38208-5 was labelled Braden but is "Pain
  // severity - Reported". scripts/verify-fhir-codes.mjs is what caught it.
  // We emit a SCORE, so the total-score variants are the right ones.
  v('assessment', 'phq9', LOINC, '44261-6', 'Patient Health Questionnaire 9 item (PHQ-9) total score [Reported]', V.loinc),
  v('assessment', 'gad7', LOINC, '70274-6', 'Generalized anxiety disorder 7 item (GAD-7) total score [Reported.PHQ]', V.loinc),
  v('assessment', 'auditc', LOINC, '75626-2', 'Total score [AUDIT-C]', V.loinc),
  v('assessment', 'moca', LOINC, '72172-0', 'Total score [MoCA]', V.loinc),
  v('assessment', 'braden', LOINC, '38227-5', 'Braden scale total score', V.loinc),
  v('assessment', 'morse-fall', LOINC, '59460-6', 'Fall risk total [Morse Fall Scale]', V.loinc),
  v('assessment', 'mna', LOINC, '107107-5', 'Mini nutritional assessment - short form 3 months Reported.MNA-SF', V.loinc),
  l('assessment', 'kdqol', 'KDQOL-36 physical composite summary', 'no LOINC concept found on the terminology server'),
  l('assessment', 'cage', 'CAGE questionnaire', 'no LOINC concept found on the terminology server'),
  l('assessment', 'phq2', 'PHQ-2 depression screen', 'LOINC 55758-7 not yet verified'),
  l('assessment', 'handgrip', 'Handgrip strength', 'LOINC grip-strength code not yet verified'),
  l('assessment', 'access-care-audit', 'Access-care audit', 'operational audit, no terminology concept'),
  l('assessment', 'hand-hygiene-audit', 'Hand-hygiene audit', 'operational audit, no terminology concept'),
  l('assessment', 'safety-event-close', 'Safety-event closure review', 'operational review, no terminology concept'),

  // ---- Vascular access (SNOMED where verified) ---------------------------
  v('access-type', 'avg', SNOMED, '312317000', 'Arteriovenous graft', V.snomed),
  v('access-event', 'thrombosis', SNOMED, '234205007', 'Arteriovenous fistula thrombosis', V.snomed),
  v('access-event', 'stenosis', SNOMED, '234203000', 'Arteriovenous fistula stenosis', V.snomed),
  v('access-event', 'infection', SNOMED, '234206008', 'Arteriovenous fistula infection', V.snomed),
  l('access-type', 'avf', 'Arteriovenous fistula (native)', 'natural-AVF presence concept not verified'),
  l('access-type', 'cvc', 'Central venous catheter', 'CVC presence concept not verified'),
  l('access-event', 'surveillance', 'Access surveillance', 'no verified SNOMED concept'),
  l('access-event', 'cannulation-difficulty', 'Cannulation difficulty', 'no verified SNOMED concept'),
  l('access-event', 'angioplasty', 'Fistulogram and angioplasty', 'procedure code not verified'),
  l('access-event', 'declot', 'Access declotting', 'procedure code not verified'),
  l('access-event', 'catheter-placed', 'Catheter placed', 'procedure code not verified'),
  l('access-event', 'avf-created', 'Arteriovenous fistula created', 'procedure code not verified'),

  // ---- Dialysis modality (absent before F4; needed by F7 and claims) -----
  l('dialysis-modality', 'hemodialysis', 'In-centre haemodialysis', 'no verified modality concept'),
  l('dialysis-modality', 'hemodiafiltration', 'Haemodiafiltration', 'no verified modality concept'),
  l('dialysis-modality', 'peritoneal', 'Peritoneal dialysis', 'no verified modality concept'),

  // ---- F7 · the dialysis treatment itself and the session's delivered metrics --
  // The SESSION is a `Procedure`, so the treatment needs a real procedure code.
  v('procedure', 'hemodialysis', SNOMED, '302497006', 'Haemodialysis', V.snomed),
  v('procedure-category', 'dialysis', SNOMED, '265764009', 'Renal dialysis', V.snomed),
  l('procedure', 'hemodiafiltration', 'Haemodiafiltration', 'only CVVHDF (233590002) verified — a different modality'),
  l('procedure', 'peritoneal-dialysis', 'Peritoneal dialysis', 'no exact concept verified'),
  // Body weight / dry weight. 8341-0 is the DRY weight, which is the one that matters.
  v('body-weight', 'body-weight', LOINC, '29463-7', 'Body weight', V.loinc),
  v('body-weight', 'dry-weight', LOINC, '8341-0', 'Dry body weight Measured', V.loinc),
  v('body-weight', 'pre-weight', LOINC, '3141-9', 'Body weight Measured', V.loinc),
  v('body-weight', 'post-weight', LOINC, '3141-9', 'Body weight Measured', V.loinc),
  l('body-weight', 'idwg', 'Interdialytic weight gain', 'no LOINC concept found'),
  // Delivered-session metrics, emitted as Observations referencing the Procedure.
  v('session-metric', 'ktv-delivered', LOINC, '70961-8', 'Kt/V.Hemodialysis', V.loinc),
  v('session-metric', 'urr', LOINC, '54456-9', 'Urea reduction ratio in Serum or Plasma', V.loinc),
  v('session-metric', 'uf-volume', LOINC, '99741-1', 'Ultrafiltrate volume removed', V.loinc),
  l('session-metric', 'recirculation', 'Access recirculation', 'no LOINC concept found'),
  l('session-metric', 'qb-avg', 'Average blood flow rate', 'no LOINC concept found'),
  // Access measurements taken during a session.
  v('access-metric', 'venous-pressure', SNOMED, '252076005', 'Venous pressure', V.snomed),
  l('access-metric', 'arterial-pressure', 'Arterial pressure', 'no concept verified'),
  l('access-metric', 'access-flow', 'Access flow', 'no concept verified'),
  l('access-metric', 'recirculation', 'Access recirculation', 'no LOINC concept found'),
  l('access-metric', 'blood-flow', 'Blood flow rate (Qb)', 'no concept verified'),
  // F8 — the MACHINE channels sampled during a session. These are hemodynamic,
  // not vital signs: conflating them makes an EMR file a dialysate flow rate as
  // a patient observation.
  v('session-telemetry', 'qd', LOINC, '99712-2', 'Dialysate flow rate Renal replacement therapy circuit', V.loinc),
  v('session-telemetry', 'venous-pressure', SNOMED, '252076005', 'Venous pressure', V.snomed),
  v('session-telemetry', 'uf-volume', LOINC, '99741-1', 'Ultrafiltrate volume removed', V.loinc),
  l('session-telemetry', 'qb', 'Blood flow rate (Qb)', 'no LOINC/SNOMED concept verified'),
  l('session-telemetry', 'arterial-pressure', 'Arterial pressure', 'only a MONITORING concept verified, not a pressure value'),
  l('session-telemetry', 'uf-rate', 'Ultrafiltration rate', 'no concept verified'),

  // ---- Financial / administrative ----------------------------------------
  v('claim-type', 'institutional', FHIR_TX + '/claim-type', 'institutional', 'Institutional', V.fhir, SPEC),
  v('claim-type', 'professional', FHIR_TX + '/claim-type', 'professional', 'Professional', V.fhir, SPEC),
  v('route', 'PO', V3_ROUTE, 'PO', 'Oral', V.hl7v3, SPEC),
  v('route', 'IV', V3_ROUTE, 'IV', 'Intravenous', V.hl7v3, SPEC),
  v('route', 'SC', V3_ROUTE, 'SC', 'Subcutaneous', V.hl7v3, SPEC),
  v('encounter-class', 'AMB', V3, 'AMB', 'ambulatory', V.hl7v3, SPEC),
  v('security-label', 'restricted', 'http://terminology.hl7.org/CodeSystem/v3-Confidentiality', 'R', 'Restricted', V.hl7v3, SPEC),
  v('discharge-disposition', 'home', FHIR_TX + '/discharge-disposition', '01', 'Discharge to home', V.fhir, SPEC),
  v('discharge-disposition', 'transfer', FHIR_TX + '/discharge-disposition', '02', 'Discharge to another healthcare facility', V.fhir, SPEC),
  v('discharge-disposition', 'snf', FHIR_TX + '/discharge-disposition', '03', 'Discharge to skilled nursing facility', V.fhir, SPEC),
  v('discharge-disposition', 'home-health', FHIR_TX + '/discharge-disposition', '06', 'Discharge to home with home health', V.fhir, SPEC),
  v('discharge-disposition', 'ama', FHIR_TX + '/discharge-disposition', '07', 'Left against medical advice', V.fhir, SPEC),
  v('discharge-disposition', 'expired', FHIR_TX + '/discharge-disposition', '20', 'Expired', V.fhir, SPEC),
  v('discharge-disposition', 'hospice', FHIR_TX + '/discharge-disposition', '50', 'Discharge to hospice', V.fhir, SPEC),
  v('discharge-disposition', 'unknown', FHIR_TX + '/discharge-disposition', '09', 'Discharge disposition unknown', V.fhir, SPEC),
  v('observation-category', 'laboratory', FHIR_TX + '/observation-category', 'laboratory', 'Laboratory', V.fhir, SPEC),
  v('observation-category', 'vital-signs', FHIR_TX + '/observation-category', 'vital-signs', 'Vital Signs', V.fhir, SPEC),
  v('observation-category', 'survey', FHIR_TX + '/observation-category', 'survey', 'Survey', V.fhir, SPEC),
  v('observation-category', 'hemodynamic', 'http://terminology.hl7.org/CodeSystem/observation-category', 'hemodynamic', 'Hemodynamic', V.fhir, SPEC),

  // ---- Follow-up / referral / task ---------------------------------------
  l('followup', 'routine', 'Routine follow-up', 'scheduling category, no terminology concept'),
  l('followup', 'nephro-clinic', 'Nephrology clinic follow-up', 'scheduling category, no terminology concept'),
  l('followup', 'adequacy-consult', 'Dialysis adequacy consultation', 'scheduling category, no terminology concept'),
  l('followup', 'payer-followup', 'Payer follow-up', 'scheduling category, no terminology concept'),
  l('practitioner-role', 'nephrologist', 'Nephrologist', 'practitioner role, no terminology concept'),
  l('practitioner-role', 'nephrology', 'Nephrology service', 'emitted as a "resource" but is a SERVICE, not a role — emitter should be corrected'),
  l('practitioner-role', 'dietitian', 'Renal dietitian', 'practitioner role, no terminology concept'),
  l('practitioner-role', 'nurse', 'Dialysis nurse', 'practitioner role, no terminology concept'),
  l('task-code', 'facilities', 'Facilities task', 'workflow-local task kind'),
  l('task-code', 'clinical-review', 'Clinical review task', 'workflow-local task kind'),
  l('task-code', 'documentation', 'Documentation task', 'workflow-local task kind'),
]);

/**
 * Does this value already look like a code in `system`? Callers legitimately
 * supply a real code instead of a slug (`17861-6` for calcium), and real
 * integrations carry both forms — so the registry resolves either. It still
 * requires the value to be registered, so a typo cannot slip through.
 */
export function looksLikeCode(system: string, value: string): boolean {
  if (system === LOCAL_SYSTEM_PREFIX || system.startsWith(LOCAL_SYSTEM_PREFIX)) return false;
  if (system === 'http://loinc.org') return /^\d+-\d$/.test(value);
  if (system === 'http://hl7.org/fhir/sid/cvx') return /^\d{1,3}$/.test(value);
  return /^\d{1,10}$/.test(value); // RxNorm / SNOMED concept ids
}

const LOCAL_SYSTEM_PREFIX = 'urn:ananthealth:codesystem:';

/** A slug that has no terminology mapping. Refuses the write (never a silent slug). */
export class UnmappedCodeError extends Error {
  readonly domain: CodeDomain;
  readonly slug: string;
  constructor(domain: CodeDomain, slug: string) {
    super(
      `Unmapped terminology code: ${domain}:'${slug}'. Add it to CODE_SEEDS in src/fhir/code-registry.ts ` +
        `(verified against the authority, or declared locally) before it can be written.`,
    );
    this.name = 'UnmappedCodeError';
    this.domain = domain;
    this.slug = slug;
  }
}

const key = (domain: CodeDomain, slug: string): string => `${domain}\u0001${slug}`;

export class CodeRegistry {
  private readonly byKey = new Map<string, CodeEntry>();
  /** Entries indexed by their real code, so a caller may pass either form. */
  private readonly byCode = new Map<string, CodeEntry>();
  private usage = new Map<string, number>();

  constructor(seeds: readonly CodeEntry[] = CODE_SEEDS) {
    for (const entry of seeds) this.register(entry);
  }

  register(entry: CodeEntry): void {
    this.byKey.set(key(entry.domain, entry.slug), entry);
    const codeKey = key(entry.domain, entry.code);
    if (!this.byKey.has(codeKey) && !this.byCode.has(codeKey)) this.byCode.set(codeKey, entry);
  }

  /** Non-throwing lookup by slug OR by real code — for reports and audits. */
  lookup(domain: CodeDomain, value: string): CodeEntry | undefined {
    return this.byKey.get(key(domain, value)) ?? this.byCode.get(key(domain, value));
  }

  /** Resolve or refuse. Records usage so a test can enumerate every code emitted. */
  resolve(domain: CodeDomain, slug: string): CodeEntry {
    this.usage.set(key(domain, slug), (this.usage.get(key(domain, slug)) ?? 0) + 1);
    const entry = this.lookup(domain, slug);
    if (!entry) throw new UnmappedCodeError(domain, slug);
    return entry;
  }

  codingFor(domain: CodeDomain, slug: string): Coding {
    const e = this.resolve(domain, slug);
    return code(e.system, e.code, e.display);
  }

  conceptFor(domain: CodeDomain, slug: string): CodeableConcept {
    const e = this.resolve(domain, slug);
    return concept(e.system, e.code, e.display);
  }

  entries(domain?: CodeDomain): readonly CodeEntry[] {
    const all = [...this.byKey.values()];
    return domain ? all.filter((e) => e.domain === domain) : all;
  }

  /** Entries we could not verify against an authority — need clinical sign-off. */
  unverified(): readonly CodeEntry[] {
    return this.entries().filter((e) => e.fidelity === 'local');
  }

  /** Every (domain, slug) resolved since the last reset, with counts. */
  usageReport(): Array<{ domain: CodeDomain; slug: string; count: number; fidelity: CodeFidelity }> {
    return [...this.usage.entries()]
      .map(([k, count]) => {
        const [domain, slug] = k.split('\u0001') as [CodeDomain, string];
        const entry = this.lookup(domain, slug);
        return { domain, slug, count, fidelity: entry?.fidelity ?? ('local' as CodeFidelity) };
      })
      .sort((a, b) => `${a.domain}:${a.slug}`.localeCompare(`${b.domain}:${b.slug}`));
  }

  resetUsage(): void {
    this.usage = new Map();
  }
}

/** Process-wide registry. */
export const codeRegistry = new CodeRegistry();

export function codeFor(domain: CodeDomain, slug: string): CodeEntry {
  return codeRegistry.resolve(domain, slug);
}

export function conceptFor(domain: CodeDomain, slug: string): CodeableConcept {
  return codeRegistry.conceptFor(domain, slug);
}

export interface TerminologyReport {
  readonly total: number;
  readonly verified: number;
  readonly local: number;
  readonly byDomain: Record<string, { verified: number; local: number }>;
  /** The entries a terminology reviewer must sign off before production. */
  readonly needsSignOff: Array<{ domain: CodeDomain; slug: string; display: string; why: string }>;
}

export function terminologyReport(): TerminologyReport {
  const byDomain: Record<string, { verified: number; local: number }> = {};
  let verified = 0;
  let local = 0;
  for (const e of codeRegistry.entries()) {
    const d = (byDomain[e.domain] ??= { verified: 0, local: 0 });
    if (e.fidelity === 'verified') { verified++; d.verified++; } else { local++; d.local++; }
  }
  return {
    total: verified + local,
    verified,
    local,
    byDomain,
    needsSignOff: codeRegistry.unverified().map((e) => ({
      domain: e.domain,
      slug: e.slug,
      display: e.display,
      why: e.source,
    })),
  };
}
