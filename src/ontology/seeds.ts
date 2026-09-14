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

// Seed a batteries-included subset of the ontology. This is not the full
// SNOMED/LOINC/RxNorm distribution — those load through licensed loaders. This
// seed covers the categories every care setting references so agents, measures,
// and adapters have real codes to bind to on day one.

import { OntologyGraph } from './graph.js';

export function seedOntology(g: OntologyGraph): OntologyGraph {
  // ---- SNOMED CT: chronic conditions + acute presentations ----
  const snomed = [
    ['404684003', 'Clinical finding (finding)'],
    ['64572001',  'Disease (disorder)'],
    ['73211009',  'Diabetes mellitus (disorder)'],
    ['44054006',  'Diabetes mellitus type 2 (disorder)'],
    ['46635009',  'Diabetes mellitus type 1 (disorder)'],
    ['38341003',  'Essential hypertension (disorder)'],
    ['84114007',  'Heart failure (disorder)'],
    ['53741008',  'Coronary arteriosclerosis (disorder)'],
    ['22298006',  'Myocardial infarction (disorder)'],
    ['13645005',  'Chronic obstructive lung disease (disorder)'],
    ['195967001', 'Asthma (disorder)'],
    ['709044004', 'Chronic kidney disease (disorder)'],
    ['46177005',  'End-stage renal disease (disorder)'],
    ['302870006', 'Hypertensive nephropathy (disorder)'],
    ['197321007', 'Steatosis of liver (disorder)'],
    ['191736004', 'Obsessive-compulsive disorder (disorder)'],
    ['370143000', 'Major depressive disorder (disorder)'],
    ['370247008', 'Anxiety disorder (disorder)'],
    ['66214007',  'Substance-induced disorder (disorder)'],
    ['15188001',  'Hearing loss (disorder)'],
    ['65363002',  'Otitis media (disorder)'],
    ['54150009',  'Upper respiratory infection (disorder)'],
    ['233604007', 'Pneumonia (disorder)'],
    ['91302008',  'Sepsis (disorder)'],
    ['76571007',  'Septic shock (disorder)'],
    ['235595009', 'Gastroesophageal reflux disease (disorder)'],
    ['235856003', 'Disorder of liver (disorder)'],
    ['128053003', 'Deep vein thrombosis (disorder)'],
    ['59282003',  'Pulmonary embolism (disorder)'],
    ['230690007', 'Cerebrovascular accident (disorder)'],
    ['128613002', 'Seizure disorder (disorder)'],
    ['26929004',  'Alzheimer disease (disorder)'],
    ['49049000',  "Parkinson's disease (disorder)"],
    ['363346000', 'Malignant neoplastic disease (disorder)'],
    ['254637007', 'Non-small cell lung cancer (disorder)'],
    ['254843006', 'Malignant tumor of breast (disorder)'],
    ['363510005', 'Malignant tumor of prostate (disorder)'],
    ['77386006',  'Pregnant (finding)'],
    ['3950001',   'Birth (finding)'],
    ['225336008', 'Hospice care (regime/therapy)'],
    ['86569001',  'Cardiac arrest (disorder)'],
    ['409586006', 'Complication of procedure (disorder)'],
  ];
  for (const [code, display] of snomed) g.addConcept({ system: 'snomed-ct', code: code as string, display: display as string });
  // is-a hierarchy (representative)
  const isA = (child: string, parent: string): void => g.addRelationship({ source: { system: 'snomed-ct', code: child }, target: { system: 'snomed-ct', code: parent }, predicate: 'is-a' });
  isA('73211009', '64572001'); isA('44054006', '73211009'); isA('46635009', '73211009');
  isA('84114007', '64572001'); isA('53741008', '64572001'); isA('22298006', '53741008');
  isA('13645005', '64572001'); isA('195967001', '64572001');
  isA('709044004', '64572001'); isA('46177005', '709044004'); isA('302870006', '709044004');
  isA('370143000', '64572001'); isA('370247008', '64572001');
  isA('91302008', '64572001'); isA('76571007', '91302008');
  isA('230690007', '64572001'); isA('26929004', '64572001'); isA('49049000', '64572001');
  isA('363346000', '64572001'); isA('254637007', '363346000'); isA('254843006', '363346000'); isA('363510005', '363346000');

  // ---- LOINC: high-value lab + vitals + assessments ----
  const loinc: [string, string, string?][] = [
    ['8302-2', 'Body height', 'vital'],
    ['29463-7', 'Body weight', 'vital'],
    ['39156-5', 'Body mass index (BMI)', 'vital'],
    ['8480-6', 'Systolic blood pressure', 'vital'],
    ['8462-4', 'Diastolic blood pressure', 'vital'],
    ['8867-4', 'Heart rate', 'vital'],
    ['9279-1', 'Respiratory rate', 'vital'],
    ['8310-5', 'Body temperature', 'vital'],
    ['59408-5', 'Oxygen saturation in arterial blood by Pulse oximetry', 'vital'],
    ['4548-4', 'Hemoglobin A1c/Hemoglobin.total in Blood', 'chem'],
    ['2160-0', 'Creatinine [Mass/volume] in Serum or Plasma', 'chem'],
    ['48642-3', 'Glomerular filtration rate [Volume Rate/Area] in Serum, Plasma or Blood by Creatinine-based formula (MDRD)/1.73 sq M among non black population', 'chem'],
    ['17861-6', 'Calcium [Mass/volume] in Serum or Plasma', 'chem'],
    ['2777-1', 'Phosphate [Mass/volume] in Serum or Plasma', 'chem'],
    ['2823-3', 'Potassium [Moles/volume] in Serum or Plasma', 'chem'],
    ['2951-2', 'Sodium [Moles/volume] in Serum or Plasma', 'chem'],
    ['2075-0', 'Chloride [Moles/volume] in Serum or Plasma', 'chem'],
    ['1975-2', 'Bilirubin.total [Mass/volume] in Serum or Plasma', 'chem'],
    ['1742-6', 'Alanine aminotransferase [Enzymatic activity/volume] in Serum or Plasma', 'chem'],
    ['1920-8', 'Aspartate aminotransferase [Enzymatic activity/volume] in Serum or Plasma', 'chem'],
    ['718-7', 'Hemoglobin [Mass/volume] in Blood', 'hem'],
    ['6690-2', 'Leukocytes [#/volume] in Blood by Automated count', 'hem'],
    ['777-3', 'Platelets [#/volume] in Blood by Automated count', 'hem'],
    ['2093-3', 'Cholesterol [Mass/volume] in Serum or Plasma', 'lipids'],
    ['2085-9', 'Cholesterol in HDL [Mass/volume] in Serum or Plasma', 'lipids'],
    ['13457-7', 'Cholesterol in LDL [Mass/volume] in Serum or Plasma by calculation', 'lipids'],
    ['2571-8', 'Triglyceride [Mass/volume] in Serum or Plasma', 'lipids'],
    // Verified 2026-09-14 against tx.fhir.org $lookup. These were previously
    // mislabelled: 33914-3 and 70969-1 were presented as Kt/V but are both GFR
    // (MDRD). The real Kt/V codes are 70961-8 / 70965-9 (HD) and 70960-0 (PD).
    ['33914-3', 'Glomerular filtration rate [Volume Rate/Area] in Serum or Plasma by Creatinine-based formula (MDRD)/1.73 sq M', 'nephrology'],
    ['70969-1', 'Glomerular filtration rate [Volume Rate/Area] in Serum, Plasma or Blood by Creatinine-based formula (MDRD)/1.73 sq M among male population', 'nephrology'],
    ['70961-8', 'Kt/V.Hemodialysis', 'nephrology'],
    ['70965-9', 'Kt/V.Hemodialysis [Daugirdas II]', 'nephrology'],
    ['70960-0', 'Kt/V.Peritoneal Dialysis', 'nephrology'],
    // Assessments. Codes whose stated concept did not match the code (AUDIT-C
    // and MoCA were swapped; 38208-5 is "Pain severity - Reported", not Braden)
    // are corrected, and the four instruments with no verifiable LOINC concept
    // (ADL, IADL, KDQOL-36, CAGE) are dropped rather than left as a guess.
    ['44261-6', 'Patient Health Questionnaire 9 item (PHQ-9) total score [Reported]', 'assessment'],
    ['70274-6', 'Generalized anxiety disorder 7 item (GAD-7) total score [Reported.PHQ]', 'assessment'],
    ['72172-0', 'Total score [MoCA]', 'assessment'],
    ['72109-2', 'Alcohol Use Disorder Identification Test - Consumption [AUDIT-C]', 'assessment'],
    ['38227-5', 'Braden scale total score', 'assessment'],
    ['59460-6', 'Fall risk total [Morse Fall Scale]', 'assessment'],
    ['107107-5', 'Mini nutritional assessment - short form 3 months Reported.MNA-SF', 'assessment'],
  ];
  for (const [code, display, category] of loinc) {
    g.addConcept({ system: 'loinc', code, display, ...(category ? { attributes: { category } } : {}) });
  }

  // ---- RxNorm: top ambulatory + inpatient meds (SCD/SBD product codes) ----
  // Every row here was previously mislabelled — the code meant a DIFFERENT drug
  // or a different strength (e.g. "Furosemide 40 MG" was acetaminophen/codeine,
  // "Empagliflozin 10 MG" was fentanyl injection). All 19 below are verified
  // against NLM RxNav. A duplicate amoxicillin row and a semaglutide row were
  // removed: the latter has no product-level RxCUI (only the SCDC component
  // 2553600), and writing a component as a product is its own defect.
  const rxnorm: [string, string][] = [
    ['313782',  'acetaminophen 325 MG Oral Tablet'],
    ['308191',  'amoxicillin 500 MG Oral Capsule'],
    ['308460',  'azithromycin 250 MG Oral Tablet'],
    ['861007',  'metformin hydrochloride 500 MG Oral Tablet'],
    ['314076',  'lisinopril 10 MG Oral Tablet'],
    ['197361',  'amlodipine 5 MG Oral Tablet'],
    ['617310',  'atorvastatin 20 MG Oral Tablet'],
    ['855332',  'warfarin sodium 5 MG Oral Tablet'],
    ['1364445', 'apixaban 5 MG Oral Tablet'],
    ['866427',  '24 HR metoprolol succinate 25 MG Extended Release Oral Tablet'],
    ['313988',  'furosemide 40 MG Oral Tablet'],
    ['311034',  'insulin, regular, human 100 UNT/ML Injectable Solution'],
    ['311041',  'insulin glargine 100 UNT/ML Injectable Solution'],
    ['749206',  'sevelamer carbonate 800 MG Oral Tablet'],
    ['239999',  '1 ML epoetin alfa 4000 UNT/ML Injection'],
    ['312941',  'sertraline 50 MG Oral Tablet'],
    ['308048',  'alprazolam 0.5 MG Oral Tablet'],
    ['857002',  'acetaminophen 325 MG / hydrocodone bitartrate 5 MG Oral Tablet'],
    ['1545658', 'empagliflozin 10 MG Oral Tablet'],
  ];
  for (const [code, display] of rxnorm) g.addConcept({ system: 'rxnorm', code, display });

  // ---- ICD-10-CM: high-frequency dx ----
  const icd10: [string, string][] = [
    ['E11.9', 'Type 2 diabetes mellitus without complications'],
    ['E10.9', 'Type 1 diabetes mellitus without complications'],
    ['I10',   'Essential (primary) hypertension'],
    ['I50.9', 'Heart failure, unspecified'],
    ['I25.10','Atherosclerotic heart disease of native coronary artery without angina pectoris'],
    ['I21.9', 'Acute myocardial infarction, unspecified'],
    ['J44.9', 'Chronic obstructive pulmonary disease, unspecified'],
    ['J45.909','Unspecified asthma, uncomplicated'],
    ['N18.6', 'End stage renal disease'],
    ['N18.4', 'Chronic kidney disease, stage 4 (severe)'],
    ['F32.9', 'Major depressive disorder, single episode, unspecified'],
    ['F41.9', 'Anxiety disorder, unspecified'],
    ['A41.9', 'Sepsis, unspecified organism'],
    ['J18.9', 'Pneumonia, unspecified organism'],
    ['I63.9', 'Cerebral infarction, unspecified'],
    ['G30.9', "Alzheimer's disease, unspecified"],
    ['G20',   "Parkinson's disease"],
    ['C34.90','Malignant neoplasm of unspecified part of unspecified bronchus or lung'],
    ['C50.919','Malignant neoplasm of unsp site of unspecified female breast'],
    ['Z51.5', 'Encounter for palliative care'],
    ['Z94.0', 'Kidney transplant status'],
    ['Z94.1', 'Heart transplant status'],
    ['Z94.4', 'Liver transplant status'],
    ['Z00.00','Encounter for general adult medical examination without abnormal findings'],
    ['Z11.3', 'Encounter for screening for infections with a predominantly sexual mode of transmission'],
  ];
  for (const [code, display] of icd10) g.addConcept({ system: 'icd-10-cm', code, display });

  // ---- CPT/HCPCS: high-frequency codes ----
  const cpt: [string, string][] = [
    ['99213', 'Office/outpatient E/M established patient, low complexity, 20-29 min'],
    ['99214', 'Office/outpatient E/M established patient, moderate complexity, 30-39 min'],
    ['99215', 'Office/outpatient E/M established patient, high complexity, 40-54 min'],
    ['99202', 'Office/outpatient E/M new patient, low complexity, 15-29 min'],
    ['99203', 'Office/outpatient E/M new patient, low complexity, 30-44 min'],
    ['99204', 'Office/outpatient E/M new patient, moderate complexity, 45-59 min'],
    ['99283', 'Emergency department visit, moderate complexity'],
    ['99284', 'Emergency department visit, moderate-high complexity'],
    ['99285', 'Emergency department visit, high complexity'],
    ['90837', 'Psychotherapy, 60 minutes'],
    ['93000', 'ECG, routine, with interpretation and report'],
    ['80053', 'Comprehensive metabolic panel'],
    ['80048', 'Basic metabolic panel'],
    ['85025', 'CBC with automated differential'],
    ['83036', 'Hemoglobin A1c'],
    ['90999', 'Unlisted dialysis procedure, inpatient or outpatient'],
    ['90935', 'Hemodialysis procedure, single evaluation'],
    ['90945', 'Dialysis procedure other than hemodialysis, single evaluation'],
    ['90999', 'Unlisted dialysis procedure'],
    ['77067', 'Screening mammography, bilateral, with CAD'],
    ['45378', 'Colonoscopy, flexible, diagnostic'],
  ];
  for (const [code, display] of cpt) g.addConcept({ system: 'cpt', code, display });
  const hcpcs: [string, string][] = [
    ['J0885', 'Epoetin alfa, non-esrd, 1000 units'],
    ['Q4081', 'Injection, epoetin alfa, 100 units (for ESRD on dialysis)'],
    ['J0887', 'Epoetin beta, esrd on dialysis, 1 microgram'],
    ['A4657', 'Syringe with or without needle, each'],
    ['E1637', 'Hemostats, each'],
    ['E1590', 'Hemodialysis machine'],
  ];
  for (const [code, display] of hcpcs) g.addConcept({ system: 'hcpcs', code, display });

  // ---- UCUM units used across labs/vitals ----
  for (const [code, display] of [['mg/dL','milligram per deciliter'],['mmol/L','millimole per liter'],['mm[Hg]','millimeter of mercury'],['/min','per minute'],['g/dL','gram per deciliter'],['10*3/uL','thousand per microliter'],['ng/mL','nanogram per milliliter'],['mL/min/{1.73_m2}','ml per minute per 1.73 sq meter']] as const) {
    g.addConcept({ system: 'ucum', code, display });
  }

  // ---- Value sets — the canonical ones measures + agents bind to ----
  g.registerValueSet({ id: 'vs:diabetes-any', title: 'Diabetes (any type)', description: 'All descendants of SNOMED Diabetes mellitus', includes: [{ kind: 'descendants-of', system: 'snomed-ct', root: '73211009' }, { kind: 'codes', system: 'snomed-ct', codes: ['73211009'] }, { kind: 'codes', system: 'icd-10-cm', codes: ['E10.9','E11.9'] }], bindingStrength: 'required', steward: 'harness' });
  g.registerValueSet({ id: 'vs:hypertension', title: 'Hypertension', description: 'Essential hypertension', includes: [{ kind: 'codes', system: 'snomed-ct', codes: ['38341003'] }, { kind: 'codes', system: 'icd-10-cm', codes: ['I10'] }], bindingStrength: 'required', steward: 'harness' });
  g.registerValueSet({ id: 'vs:chronic-kidney-disease', title: 'CKD', description: 'All CKD stages including ESRD', includes: [{ kind: 'descendants-of', system: 'snomed-ct', root: '709044004' }, { kind: 'codes', system: 'snomed-ct', codes: ['709044004'] }, { kind: 'codes', system: 'icd-10-cm', codes: ['N18.4','N18.6'] }], bindingStrength: 'required', steward: 'harness' });
  g.registerValueSet({ id: 'vs:end-stage-renal-disease', title: 'ESRD', description: 'End-stage renal disease', includes: [{ kind: 'codes', system: 'snomed-ct', codes: ['46177005'] }, { kind: 'codes', system: 'icd-10-cm', codes: ['N18.6'] }, { kind: 'codes', system: 'icd-10-cm', codes: ['Z94.0'] }], bindingStrength: 'required', steward: 'harness' });
  g.registerValueSet({ id: 'vs:heart-failure', title: 'Heart failure', description: 'HF diagnosis', includes: [{ kind: 'codes', system: 'snomed-ct', codes: ['84114007'] }, { kind: 'codes', system: 'icd-10-cm', codes: ['I50.9'] }], bindingStrength: 'required', steward: 'harness' });
  g.registerValueSet({ id: 'vs:sepsis-or-septic-shock', title: 'Sepsis or septic shock', description: 'Sepsis + septic shock', includes: [{ kind: 'codes', system: 'snomed-ct', codes: ['91302008','76571007'] }, { kind: 'codes', system: 'icd-10-cm', codes: ['A41.9'] }], bindingStrength: 'required', steward: 'harness' });
  g.registerValueSet({ id: 'vs:vital-signs', title: 'Vital signs LOINCs', description: 'Standard vitals panel', includes: [{ kind: 'filter', system: 'loinc', attribute: 'category', op: 'equals', value: 'vital' }], bindingStrength: 'required', steward: 'harness' });
  g.registerValueSet({ id: 'vs:validated-assessments', title: 'Validated assessment instruments', description: 'PHQ-9, GAD-7, MoCA, AUDIT-C, Braden, Morse, MNA-SF (instruments without a verifiable LOINC concept are not listed)', includes: [{ kind: 'filter', system: 'loinc', attribute: 'category', op: 'equals', value: 'assessment' }], bindingStrength: 'required', steward: 'harness' });
  g.registerValueSet({ id: 'vs:renal-labs', title: 'Renal labs', description: 'Creatinine, eGFR, Ca, P, K, Na, Cl, Kt/V', includes: [{ kind: 'codes', system: 'loinc', codes: ['2160-0','48642-3','17861-6','2777-1','2823-3','2951-2','2075-0','33914-3','70969-1','70961-8','70965-9','70960-0'] }], bindingStrength: 'required', steward: 'harness' });
  g.registerValueSet({ id: 'vs:lipid-panel', title: 'Lipid panel', description: 'Total, HDL, LDL, triglycerides', includes: [{ kind: 'filter', system: 'loinc', attribute: 'category', op: 'equals', value: 'lipids' }], bindingStrength: 'required', steward: 'harness' });
  g.registerValueSet({ id: 'vs:kt-v-adequate', title: 'Kt/V adequate result', description: 'Delivered Kt/V LOINCs — HD 70961-8, HD Daugirdas II 70965-9, PD 70960-0 (value threshold checked at runtime)', includes: [{ kind: 'codes', system: 'loinc', codes: ['70961-8','70965-9','70960-0'] }], bindingStrength: 'required', steward: 'harness' });
  g.registerValueSet({ id: 'vs:transplant-status-any-organ', title: 'Transplant status (any organ)', description: 'Kidney, heart, liver, lung, pancreas transplant status', includes: [{ kind: 'codes', system: 'icd-10-cm', codes: ['Z94.0','Z94.1','Z94.4'] }], bindingStrength: 'required', steward: 'harness' });
  g.registerValueSet({ id: 'vs:hospice-or-palliative', title: 'Hospice / palliative care', description: 'Palliative or hospice encounter', includes: [{ kind: 'codes', system: 'snomed-ct', codes: ['225336008'] }, { kind: 'codes', system: 'icd-10-cm', codes: ['Z51.5'] }], bindingStrength: 'required', steward: 'harness' });

  return g;
}
