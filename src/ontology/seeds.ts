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
    ['48642-3', 'Glomerular filtration rate/1.73 sq M.predicted [Volume Rate/Area] in Serum, Plasma or Blood by Creatinine-based formula (CKD-EPI)', 'chem'],
    ['17861-6', 'Calcium [Mass/volume] in Serum or Plasma', 'chem'],
    ['2777-1', 'Phosphate [Mass/volume] in Serum or Plasma', 'chem'],
    ['2823-3', 'Potassium [Moles/volume] in Serum or Plasma', 'chem'],
    ['2951-2', 'Sodium [Moles/volume] in Serum or Plasma', 'chem'],
    ['2823-3', 'Potassium [Moles/volume] in Serum or Plasma', 'chem'],
    ['2075-0', 'Chloride [Moles/volume] in Serum or Plasma', 'chem'],
    ['1975-2', 'Bilirubin.total [Mass/volume] in Serum or Plasma', 'chem'],
    ['1742-6', 'Alanine aminotransferase [Enzymatic activity/volume] in Serum or Plasma', 'chem'],
    ['1920-8', 'Aspartate aminotransferase [Enzymatic activity/volume] in Serum or Plasma', 'chem'],
    ['718-7', 'Hemoglobin [Mass/volume] in Blood', 'hem'],
    ['6690-2', 'Leukocytes [#/volume] in Blood by Automated count', 'hem'],
    ['777-3', 'Platelets [#/volume] in Blood by Automated count', 'hem'],
    ['2093-3', 'Cholesterol [Mass/volume] in Serum or Plasma', 'lipids'],
    ['2085-9', 'Cholesterol in HDL [Mass/volume] in Serum or Plasma', 'lipids'],
    ['13457-7', 'Cholesterol in LDL [Mass/volume] in Serum or Plasma by direct assay', 'lipids'],
    ['2571-8', 'Triglyceride [Mass/volume] in Serum or Plasma', 'lipids'],
    ['33914-3', 'Estimated urea Kt/V ratio', 'nephrology'],
    ['70969-1', 'Urea clearance normalized to volume of distribution (Kt/V)', 'nephrology'],
    ['33747-0', 'General appearance of Patient', 'exam'],
    ['44249-1', 'PHQ-9 quick depression assessment panel', 'assessment'],
    ['69737-5', 'Generalized anxiety disorder 7 item (GAD-7)', 'assessment'],
    ['72172-0', 'Alcohol Use Disorders Identification Test [AUDIT-C]', 'assessment'],
    ['72109-2', 'Montreal Cognitive Assessment (MoCA) total score', 'assessment'],
    ['38208-5', 'Braden Scale total score', 'assessment'],
    ['54556-4', 'Morse Fall Scale total score', 'assessment'],
    ['77584-8', 'ADL score', 'assessment'],
    ['57249-9', 'IADL score', 'assessment'],
    ['96566-2', 'KDQOL-36 physical composite summary', 'assessment'],
    ['80392-9', 'Mini Nutritional Assessment (MNA) short form total score', 'assessment'],
    ['54580-4', 'CAGE questionnaire', 'assessment'],
  ];
  for (const [code, display, category] of loinc) {
    g.addConcept({ system: 'loinc', code, display, ...(category ? { attributes: { category } } : {}) });
  }

  // ---- RxNorm: top ambulatory + inpatient meds (SCD/SBD IDs) ----
  const rxnorm: [string, string][] = [
    ['1049502', 'Acetaminophen 325 MG Oral Tablet'],
    ['198211',  'Amoxicillin 500 MG Oral Capsule'],
    ['617314',  'Azithromycin 250 MG Oral Tablet'],
    ['866426',  'Metformin hydrochloride 500 MG Oral Tablet'],
    ['200258',  'Lisinopril 10 MG Oral Tablet'],
    ['308136',  'Amlodipine 5 MG Oral Tablet'],
    ['617993',  'Atorvastatin 20 MG Oral Tablet'],
    ['198211',  'Amoxicillin 500 MG Oral Capsule'],
    ['856987',  'Warfarin sodium 5 MG Oral Tablet'],
    ['855332',  'Apixaban 5 MG Oral Tablet'],
    ['866516',  'Metoprolol succinate 25 MG Extended Release Oral Tablet'],
    ['993781',  'Furosemide 40 MG Oral Tablet'],
    ['197361',  'Insulin regular human 100 UNT/ML Injectable Solution'],
    ['261551',  'Insulin glargine 100 UNT/ML Injectable Solution'],
    ['1364430', 'Sevelamer carbonate 800 MG Oral Tablet'],
    ['104375',  'Epoetin alfa 4000 UNT/ML Injectable Solution'],
    ['242438',  'Sertraline 50 MG Oral Tablet'],
    ['312961',  'Alprazolam 0.5 MG Oral Tablet'],
    ['313782',  'Hydrocodone Bitartrate 5 MG / Acetaminophen 325 MG Oral Tablet'],
    ['1735006', 'Empagliflozin 10 MG Oral Tablet'],
    ['1043400', 'Semaglutide 1 MG/ML Injectable Solution'],
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
  g.registerValueSet({ id: 'vs:validated-assessments', title: 'Validated assessment instruments', description: 'PHQ-9, GAD-7, MoCA, Braden, Morse, ADL/IADL, MNA, KDQOL, AUDIT-C, CAGE', includes: [{ kind: 'filter', system: 'loinc', attribute: 'category', op: 'equals', value: 'assessment' }], bindingStrength: 'required', steward: 'harness' });
  g.registerValueSet({ id: 'vs:renal-labs', title: 'Renal labs', description: 'Creatinine, eGFR, Ca, P, K, Na, Cl, Kt/V', includes: [{ kind: 'codes', system: 'loinc', codes: ['2160-0','48642-3','17861-6','2777-1','2823-3','2951-2','2075-0','33914-3','70969-1'] }], bindingStrength: 'required', steward: 'harness' });
  g.registerValueSet({ id: 'vs:lipid-panel', title: 'Lipid panel', description: 'Total, HDL, LDL, triglycerides', includes: [{ kind: 'filter', system: 'loinc', attribute: 'category', op: 'equals', value: 'lipids' }], bindingStrength: 'required', steward: 'harness' });
  g.registerValueSet({ id: 'vs:kt-v-adequate', title: 'Kt/V adequate result', description: 'Kt/V LOINCs (value threshold checked at runtime)', includes: [{ kind: 'codes', system: 'loinc', codes: ['33914-3','70969-1'] }], bindingStrength: 'required', steward: 'harness' });
  g.registerValueSet({ id: 'vs:transplant-status-any-organ', title: 'Transplant status (any organ)', description: 'Kidney, heart, liver, lung, pancreas transplant status', includes: [{ kind: 'codes', system: 'icd-10-cm', codes: ['Z94.0','Z94.1','Z94.4'] }], bindingStrength: 'required', steward: 'harness' });
  g.registerValueSet({ id: 'vs:hospice-or-palliative', title: 'Hospice / palliative care', description: 'Palliative or hospice encounter', includes: [{ kind: 'codes', system: 'snomed-ct', codes: ['225336008'] }, { kind: 'codes', system: 'icd-10-cm', codes: ['Z51.5'] }], bindingStrength: 'required', steward: 'harness' });

  return g;
}
