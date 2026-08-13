// M20 Knowledge Layer — canonical pack ⇄ source subscriptions.
//
// Each pack the harness ships with declares WHICH sources it consumes,
// SCOPED to the slice it needs, with the WORKFLOWS/AGENTS/MEASURES that
// use it, and a criticality + freshness requirement.
//
// This is the ground truth for the hypergraph edges. When a new pack is
// created via the operator UI, this file is extended (or overridden per
// facility) rather than duplicating source registration.
//
// Naming: every entry is a PackSourceSubscription minus createdAt/updatedAt
// (the registry stamps those on subscribe()).

import type { PackSourceSubscription } from './types.js';

type SubDraft = Omit<PackSourceSubscription, 'createdAt' | 'updatedAt'>;

const now = (): string => new Date().toISOString();
export const withTimestamps = (d: SubDraft): PackSourceSubscription => ({ ...d, createdAt: now(), updatedAt: now() });

/**
 * ckd-navigation pack — CKD stage tracking, modality education, ESRD transition.
 * The bread-and-butter of a nephrology navigation program.
 */
export const CKD_NAVIGATION: SubDraft[] = [
  {
    packId: 'ckd-navigation', sourceId: 'nlm.rxnorm',
    scope: { clinicalDomains: ['nephrology'], codeFilters: [{ system: 'RxClass', valueSetUrl: 'renal-dose-adjusted-drugs' }] },
    usedBy: [
      { workflowId: 'renal-dose-adjust', agentId: 'medication-reconciler', purpose: 'renal-adjusted drug dosing' },
      { workflowId: 'nephrotoxin-avoidance', agentId: 'medication-safety', purpose: 'flag nephrotoxic meds by RxClass' },
    ],
    freshnessRequirement: 'monthly', criticality: 'blocking',
  },
  {
    packId: 'ckd-navigation', sourceId: 'loinc.fhir',
    scope: { codeFilters: [{ system: 'LOINC', codePrefixes: ['33914-', '2160-', '48642-', '48643-', '32294-'] }] },
    usedBy: [
      { workflowId: 'ckd-stage-classification', measureId: 'kdigo-ckd-stage', purpose: 'eGFR + UACR lab code binding' },
      { workflowId: 'labs-trend-review', agentId: 'labs-reviewer', purpose: 'consistent lab code interpretation' },
    ],
    freshnessRequirement: 'quarterly', criticality: 'blocking',
  },
  {
    packId: 'ckd-navigation', sourceId: 'cms.ecqm.qicore.2025',
    scope: { artifactIds: ['CMS165', 'CMS122', 'CMS134'] },
    usedBy: [
      { measureId: 'CMS165', purpose: 'controlling high BP (frequently paired with CKD)' },
      { measureId: 'CMS122', purpose: 'A1C poor control (CKD + DM comorbidity)' },
      { measureId: 'CMS134', purpose: 'diabetes: medical attention for nephropathy' },
    ],
    freshnessRequirement: 'annual', criticality: 'blocking',
  },
  {
    packId: 'ckd-navigation', sourceId: 'nlm.vsac',
    scope: { custom: { oids: ['2.16.840.1.113883.3.526.3.1550', '2.16.840.1.113883.3.464.1003.109.12.1017'] } },
    usedBy: [{ measureId: 'CMS165', purpose: 'BP + antihypertensive value set expansions' }, { measureId: 'CMS122', purpose: 'DM value sets' }, { measureId: 'CMS134', purpose: 'CKD + nephropathy value sets' }],
    freshnessRequirement: 'weekly', criticality: 'blocking',
  },
  {
    packId: 'ckd-navigation', sourceId: 'nlm.pubmed',
    scope: { clinicalDomains: ['nephrology'] },
    usedBy: [{ workflowId: 'evidence-lookup', agentId: 'research-copilot', purpose: 'ad-hoc evidence queries by care team' }],
    freshnessRequirement: 'daily', criticality: 'degraded',
  },
];

/**
 * dialysis-deep pack — in-center + home dialysis operations.
 * Overlaps ckd-navigation on nephrology sources but adds dialysis-specific.
 */
export const DIALYSIS_DEEP: SubDraft[] = [
  {
    packId: 'dialysis-deep', sourceId: 'nlm.rxnorm',
    scope: { codeFilters: [{ system: 'RxClass', codePrefixes: ['erythropoiesis-stim', 'iron-iv', 'phosphate-binder', 'calcimimetic', 'anticoag'] }] },
    usedBy: [
      { workflowId: 'esa-dosing', agentId: 'anemia-manager', purpose: 'ESA dose titration by Hgb' },
      { workflowId: 'mbd-management', agentId: 'mineral-bone', purpose: 'phosphate binders + calcimimetics' },
      { workflowId: 'anticoag-protocol', agentId: 'circuit-anticoag', purpose: 'heparin vs citrate anticoag' },
    ],
    freshnessRequirement: 'monthly', criticality: 'blocking',
  },
  {
    packId: 'dialysis-deep', sourceId: 'cdc.nhsn.psc.manual',
    scope: { sections: ['Dialysis Event', 'BSI', 'CLABSI', 'Access Infection'] },
    usedBy: [
      { workflowId: 'access-infection-surveillance', agentId: 'nhsn-reporter', purpose: 'NHSN Dialysis Event reporting definitions' },
      { workflowId: 'bsi-classification', agentId: 'infection-preventionist', purpose: 'BSI attribution rules per NHSN' },
    ],
    freshnessRequirement: 'annual', criticality: 'blocking',
  },
  {
    packId: 'dialysis-deep', sourceId: 'cdc.acip.schedules',
    scope: { custom: { populations: ['dialysis-adults', 'immunocompromised'] } },
    usedBy: [{ workflowId: 'vaccination-clinic', agentId: 'vaccine-scheduler', purpose: 'dialysis-modified vax schedule (Hep B high-dose, pneumo, flu)' }],
    freshnessRequirement: 'annual', criticality: 'degraded',
  },
  {
    packId: 'dialysis-deep', sourceId: 'openfda.drug.label',
    scope: { codeFilters: [{ system: 'RxNorm', codePrefixes: ['epoetin', 'darbepoetin', 'sevelamer', 'lanthanum', 'cinacalcet'] }] },
    usedBy: [{ agentId: 'medication-reconciler', purpose: 'labeling + BBW for dialysis-specific drugs' }],
    freshnessRequirement: 'weekly', criticality: 'degraded',
  },
  {
    packId: 'dialysis-deep', sourceId: 'cms.ioms.list',
    scope: { sections: ['Pub 100-02 Chapter 11 (ESRD)', 'Pub 100-04 Chapter 8'] },
    usedBy: [{ workflowId: 'billing-compliance', agentId: 'coding-auditor', purpose: 'ESRD PPS billing + composite rate rules' }],
    freshnessRequirement: 'quarterly', criticality: 'blocking',
  },
  {
    packId: 'dialysis-deep', sourceId: 'nlm.pubmed',
    scope: { clinicalDomains: ['nephrology', 'dialysis'] },
    usedBy: [{ workflowId: 'evidence-lookup', agentId: 'research-copilot', purpose: 'evidence queries' }],
    freshnessRequirement: 'daily', criticality: 'degraded',
  },
];

/**
 * payer pack — prior auth, utilization management, appeals.
 * Draws HEAVILY from CMS coverage + coding + guidelines to build PA rules.
 */
export const PAYER: SubDraft[] = [
  {
    packId: 'payer', sourceId: 'cms.ioms.list',
    scope: { sections: ['Pub 100-03 NCD Manual', 'Pub 100-04 Claims Processing'] },
    usedBy: [{ workflowId: 'coverage-review', agentId: 'pa-adjudicator', purpose: 'NCD + claims processing rules' }],
    freshnessRequirement: 'quarterly', criticality: 'blocking',
  },
  {
    packId: 'payer', sourceId: 'cms.ecqm.qicore.2025',
    scope: {},
    usedBy: [{ workflowId: 'quality-bonus-tracking', agentId: 'quality-actuary', purpose: 'MIPS/HEDIS-adjacent quality tracking' }],
    freshnessRequirement: 'annual', criticality: 'degraded',
  },
  {
    packId: 'payer', sourceId: 'nlm.rxnorm',
    scope: {},
    usedBy: [
      { workflowId: 'formulary-management', agentId: 'formulary-manager', purpose: 'drug identity normalization for PA + coverage' },
      { workflowId: 'medication-pa', agentId: 'pa-adjudicator', purpose: 'PA lookup on requested drug' },
    ],
    freshnessRequirement: 'monthly', criticality: 'blocking',
  },
  {
    packId: 'payer', sourceId: 'openfda.drug.label',
    scope: {},
    usedBy: [{ agentId: 'pa-adjudicator', purpose: 'on-label vs off-label check for medical necessity' }],
    freshnessRequirement: 'weekly', criticality: 'blocking',
  },
  {
    packId: 'payer', sourceId: 'clinicaltrials.v2',
    scope: {},
    usedBy: [{ workflowId: 'experimental-review', agentId: 'appeals-analyst', purpose: 'investigational-use verification for appeals' }],
    freshnessRequirement: 'weekly', criticality: 'degraded',
  },
  {
    packId: 'payer', sourceId: 'nlm.vsac',
    scope: {},
    usedBy: [{ workflowId: 'quality-bonus-tracking', purpose: 'measure value set expansions' }],
    freshnessRequirement: 'weekly', criticality: 'degraded',
  },
];

/**
 * ed-throughput pack — emergency department flow, sepsis, stroke, chest pain, boarding.
 */
export const ED_THROUGHPUT: SubDraft[] = [
  {
    packId: 'ed-throughput', sourceId: 'cms.ecqm.qicore.2025',
    scope: { artifactIds: ['CMS0530', 'CMS0996', 'CMS1028'] },
    usedBy: [{ measureId: 'CMS0530', purpose: 'sepsis bundle SEP-1-like measures' }],
    freshnessRequirement: 'annual', criticality: 'blocking',
  },
  {
    packId: 'ed-throughput', sourceId: 'cdc.nhsn.psc.manual',
    scope: { sections: ['CAUTI', 'CLABSI'] },
    usedBy: [{ workflowId: 'hai-surveillance', agentId: 'infection-preventionist', purpose: 'ED-inserted line + catheter definitions' }],
    freshnessRequirement: 'annual', criticality: 'degraded',
  },
  {
    packId: 'ed-throughput', sourceId: 'nlm.rxnorm',
    scope: { codeFilters: [{ system: 'RxClass', codePrefixes: ['antibiotic', 'opioid', 'thrombolytic', 'antiplatelet'] }] },
    usedBy: [{ agentId: 'medication-safety', purpose: 'high-alert med checks' }],
    freshnessRequirement: 'monthly', criticality: 'blocking',
  },
  {
    packId: 'ed-throughput', sourceId: 'cdc.opioid.rx',
    scope: {},
    usedBy: [{ workflowId: 'opioid-stewardship', agentId: 'opioid-stewardship', purpose: 'CDC 2022 prescribing guideline' }],
    freshnessRequirement: 'annual', criticality: 'blocking',
  },
  {
    packId: 'ed-throughput', sourceId: 'openfda.drug.enforcement',
    scope: {},
    usedBy: [{ agentId: 'medication-safety', purpose: 'active recall check on any dispensed med' }],
    freshnessRequirement: 'daily', criticality: 'blocking',
  },
  {
    packId: 'ed-throughput', sourceId: 'aacn.practice.alerts',
    scope: {},
    usedBy: [{ workflowId: 'nursing-protocols', agentId: 'nursing-shift-lead', purpose: 'evidence-based critical-care nursing alerts' }],
    freshnessRequirement: 'monthly', criticality: 'degraded',
  },
];

/**
 * home-health pack — home visits, OASIS, medication management at home.
 */
export const HOME_HEALTH: SubDraft[] = [
  {
    packId: 'home-health', sourceId: 'cms.ioms.list',
    scope: { sections: ['Pub 100-02 Chapter 7 (Home Health)', 'Pub 100-01 Chapter 4'] },
    usedBy: [{ workflowId: 'oasis-compliance', agentId: 'oasis-coordinator', purpose: 'Home Health Conditions of Participation' }],
    freshnessRequirement: 'quarterly', criticality: 'blocking',
  },
  { packId: 'home-health', sourceId: 'nlm.medlineplus', scope: { clinicalDomains: ['all'] }, usedBy: [{ agentId: 'patient-educator', purpose: 'patient-friendly education materials' }], freshnessRequirement: 'weekly', criticality: 'informational' },
  { packId: 'home-health', sourceId: 'nlm.rxnorm', scope: {}, usedBy: [{ agentId: 'medication-reconciler', purpose: 'home medication reconciliation' }], freshnessRequirement: 'monthly', criticality: 'blocking' },
  { packId: 'home-health', sourceId: 'openfda.drug.label', scope: {}, usedBy: [{ agentId: 'medication-reconciler', purpose: 'label lookup during home med review' }], freshnessRequirement: 'weekly', criticality: 'degraded' },
  { packId: 'home-health', sourceId: 'cdc.acip.schedules', scope: {}, usedBy: [{ workflowId: 'in-home-vax', agentId: 'vaccine-scheduler', purpose: 'in-home vax eligibility' }], freshnessRequirement: 'annual', criticality: 'degraded' },
];

/**
 * long-term-care pack — SNF/NH operations, MDS, infection control, dementia care.
 */
export const LONG_TERM_CARE: SubDraft[] = [
  { packId: 'long-term-care', sourceId: 'cms.ioms.list', scope: { sections: ['Pub 100-07 State Operations (LTC)'] }, usedBy: [{ workflowId: 'ftag-compliance', agentId: 'compliance-officer', purpose: 'F-tag citation avoidance' }], freshnessRequirement: 'quarterly', criticality: 'blocking' },
  { packId: 'long-term-care', sourceId: 'cdc.nhsn.psc.manual', scope: { sections: ['LTCF UTI', 'LTCF SSTI', 'LTCF Respiratory'] }, usedBy: [{ workflowId: 'hai-surveillance', agentId: 'infection-preventionist', purpose: 'LTCF-specific HAI definitions' }], freshnessRequirement: 'annual', criticality: 'blocking' },
  { packId: 'long-term-care', sourceId: 'cdc.acip.schedules', scope: { custom: { populations: ['older-adults', 'immunocompromised'] } }, usedBy: [{ agentId: 'vaccine-scheduler', purpose: 'resident vax schedule' }], freshnessRequirement: 'annual', criticality: 'blocking' },
  { packId: 'long-term-care', sourceId: 'nlm.rxnorm', scope: { codeFilters: [{ system: 'RxClass', codePrefixes: ['antipsychotic', 'anticholinergic', 'beers'] }] }, usedBy: [{ workflowId: 'beers-review', agentId: 'geriatric-pharmacist', purpose: 'Beers Criteria + potentially-inappropriate meds' }], freshnessRequirement: 'monthly', criticality: 'blocking' },
  { packId: 'long-term-care', sourceId: 'openfda.drug.enforcement', scope: {}, usedBy: [{ agentId: 'medication-safety', purpose: 'facility-wide recall response' }], freshnessRequirement: 'daily', criticality: 'blocking' },
  { packId: 'long-term-care', sourceId: 'ana.nursing.standards', scope: {}, usedBy: [{ agentId: 'director-of-nursing', purpose: 'scope of practice' }], freshnessRequirement: 'annual', criticality: 'informational' },
];

/**
 * hospital-at-home pack — CMS AHCaH waiver operations.
 */
export const HOSPITAL_AT_HOME: SubDraft[] = [
  { packId: 'hospital-at-home', sourceId: 'cms.ioms.list', scope: { sections: ['Acute Hospital Care at Home Waiver'] }, usedBy: [{ workflowId: 'waiver-compliance', agentId: 'compliance-officer', purpose: 'AHCaH conditions and reporting' }], freshnessRequirement: 'quarterly', criticality: 'blocking' },
  { packId: 'hospital-at-home', sourceId: 'nlm.rxnorm', scope: {}, usedBy: [{ agentId: 'medication-reconciler', purpose: 'home-delivered medication reconciliation' }], freshnessRequirement: 'monthly', criticality: 'blocking' },
  { packId: 'hospital-at-home', sourceId: 'aacn.practice.alerts', scope: {}, usedBy: [{ agentId: 'home-hospital-nurse', purpose: 'critical-care nursing adapted to home setting' }], freshnessRequirement: 'monthly', criticality: 'degraded' },
];

/**
 * behavioral-health pack — outpatient BH, MAT, crisis.
 */
export const BEHAVIORAL_HEALTH: SubDraft[] = [
  { packId: 'behavioral-health', sourceId: 'cdc.opioid.rx', scope: {}, usedBy: [{ workflowId: 'mat-program', agentId: 'mat-coordinator', purpose: 'CDC opioid guideline for taper and MAT integration' }], freshnessRequirement: 'annual', criticality: 'blocking' },
  { packId: 'behavioral-health', sourceId: 'nlm.rxnorm', scope: { codeFilters: [{ system: 'RxClass', codePrefixes: ['ssri', 'snri', 'antipsychotic', 'benzodiazepine', 'buprenorphine', 'methadone', 'naltrexone'] }] }, usedBy: [{ agentId: 'psychopharmacology', purpose: 'BH pharmacology reference' }], freshnessRequirement: 'monthly', criticality: 'blocking' },
  { packId: 'behavioral-health', sourceId: 'openfda.drug.label', scope: {}, usedBy: [{ agentId: 'psychopharmacology', purpose: 'BBW + boxed warnings for psych meds' }], freshnessRequirement: 'weekly', criticality: 'blocking' },
  { packId: 'behavioral-health', sourceId: 'cms.ecqm.qicore.2025', scope: { artifactIds: ['CMS128', 'CMS159', 'CMS177'] }, usedBy: [{ measureId: 'CMS128', purpose: 'antidepressant med management' }, { measureId: 'CMS159', purpose: 'depression remission at 12 months' }, { measureId: 'CMS177', purpose: 'adolescent suicide risk assessment' }], freshnessRequirement: 'annual', criticality: 'blocking' },
];

/**
 * radiology pack — imaging appropriateness, incidental findings, contrast safety.
 */
export const RADIOLOGY: SubDraft[] = [
  { packId: 'radiology', sourceId: 'openfda.drug.label', scope: { codeFilters: [{ system: 'RxNorm', codePrefixes: ['iodinated-contrast', 'gadolinium'] }] }, usedBy: [{ agentId: 'contrast-safety', purpose: 'contrast media label + BBW' }], freshnessRequirement: 'weekly', criticality: 'blocking' },
  { packId: 'radiology', sourceId: 'ats.pulmonary.statements', scope: {}, usedBy: [{ workflowId: 'incidental-nodule', agentId: 'pulmonary-nodule', purpose: 'Fleischner Society follow-up recommendations (via ATS statements)' }], freshnessRequirement: 'annual', criticality: 'informational' },
  { packId: 'radiology', sourceId: 'nlm.rxnorm', scope: {}, usedBy: [{ agentId: 'contrast-safety', purpose: 'contrast identity + prior reactions' }], freshnessRequirement: 'monthly', criticality: 'blocking' },
  { packId: 'radiology', sourceId: 'cap.lab.accreditation', scope: {}, usedBy: [{ agentId: 'imaging-quality', purpose: 'related accreditation touchpoints' }], freshnessRequirement: 'annual', criticality: 'informational' },
];

/**
 * mixed-sample-clinic pack — the demo/fixture pack.
 */
export const MIXED_SAMPLE_CLINIC: SubDraft[] = [
  { packId: 'mixed-sample-clinic', sourceId: 'nlm.rxnorm', scope: {}, usedBy: [{ agentId: 'medication-reconciler', purpose: 'basic RxNorm demo' }], freshnessRequirement: 'monthly', criticality: 'degraded' },
  { packId: 'mixed-sample-clinic', sourceId: 'openfda.drug.label', scope: {}, usedBy: [{ agentId: 'medication-reconciler', purpose: 'demo label lookup' }], freshnessRequirement: 'weekly', criticality: 'degraded' },
  { packId: 'mixed-sample-clinic', sourceId: 'cms.ecqm.qicore.2025', scope: { artifactIds: ['CMS165', 'CMS122'] }, usedBy: [{ measureId: 'CMS165', purpose: 'demo measure' }, { measureId: 'CMS122', purpose: 'demo measure' }], freshnessRequirement: 'annual', criticality: 'degraded' },
];

/**
 * cms-universe pack — the meta-pack that consumes the entire CMS surface.
 */
export const CMS_UNIVERSE: SubDraft[] = [
  { packId: 'cms-universe', sourceId: 'cms.ecqm.qicore.2025', scope: {}, usedBy: [{ purpose: 'all CMS eCQMs' }], freshnessRequirement: 'annual', criticality: 'blocking' },
  { packId: 'cms-universe', sourceId: 'cms.ioms.list', scope: {}, usedBy: [{ purpose: 'all CMS IOMs' }], freshnessRequirement: 'quarterly', criticality: 'blocking' },
  { packId: 'cms-universe', sourceId: 'cms.data.provider.utilization', scope: {}, usedBy: [{ purpose: 'CMS provider utilization data' }], freshnessRequirement: 'annual', criticality: 'informational' },
  { packId: 'cms-universe', sourceId: 'nlm.vsac', scope: {}, usedBy: [{ purpose: 'measure value sets' }], freshnessRequirement: 'weekly', criticality: 'blocking' },
];

/** All canonical subscriptions. */
export const CANONICAL_SUBSCRIPTIONS: SubDraft[] = [
  ...CKD_NAVIGATION, ...DIALYSIS_DEEP, ...PAYER, ...ED_THROUGHPUT,
  ...HOME_HEALTH, ...LONG_TERM_CARE, ...HOSPITAL_AT_HOME,
  ...BEHAVIORAL_HEALTH, ...RADIOLOGY, ...MIXED_SAMPLE_CLINIC, ...CMS_UNIVERSE,
];
