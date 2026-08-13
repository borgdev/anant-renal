#!/usr/bin/env node
// Generate 8 vertical packs (behavioral-health, oncology-deep, home-health,
// long-term-care, radiology, ed-throughput, revenue-cycle, hospital-at-home)
// with real agent YAML specs and pack index.ts files. All specs follow the
// same schema as dialysis-deep, so agent-registry / spec-sync / billing all
// work with no runtime changes.

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';

const ROOT = new URL('../packs/', import.meta.url).pathname;

// ---------- Agent factory ----------
function agentYaml({ id, packId, displayName, description, trigger, plan, phi = 'read-write', purpose = ['treatment'], clearance = 'phi', baseFee = 0.10, hitl = false, labels = {} }) {
  const planYaml = plan.map(step => `    - type: step
      step:
        id: ${step.id}
        skill: ${step.skill}
        inputs: {}`).join('\n');
  const labelYaml = Object.entries(labels).map(([k, v]) => `  ${k}: ${v}`).join('\n');
  return `id: ${id}
version: 1.0.0
packId: ${packId}
displayName: "${displayName.replace(/"/g, '\\"')}"
description: >
  ${description}
scope: facility
trigger:
  kind: ${trigger.kind}
${trigger.eventType ? `  eventType: ${trigger.eventType}` : ''}${trigger.cron ? `  cron: "${trigger.cron}"` : ''}
inputs:
  patientId:
    type: string
    required: true
    description: Patient identifier
outputs:
  resultRef:
    type: string
    description: Result artifact
plan:
  type: sequence
  children:
${planYaml}

governance:
  phiHandling: ${phi}
  purposeOfUse: [${purpose.join(', ')}]
  clearanceRequired: ${clearance}
  hitlGates:${hitl ? `
    - afterStepId: step-3
      role: clinician
      slaMinutes: 60` : ' []'}
  breakGlassAllowed: false
  evidenceRequired: []
billing:
  baseFeeUsd: ${baseFee}
  meteredUnits:
    - unit: llm.tokens.input
      priceUsdPerUnit: 0.000003
    - unit: llm.tokens.output
      priceUsdPerUnit: 0.000015
    - unit: tool.call
      priceUsdPerUnit: 0.002${hitl ? `
    - unit: hitl.minutes
      priceUsdPerUnit: 0.05` : ''}
  budgetCapMonthlyUsd: 200
slas:
  p95LatencyMs: 30000
  maxCostUsd: 0.75
labels:
${labelYaml || '  domain: general'}
`;
}

function stdPlan(skills) {
  return skills.map((s, i) => ({ id: `step-${i+1}`, skill: s }));
}

// ---------- Pack: behavioral-health (30 agents) ----------
const BEHAVIORAL_HEALTH = {
  id: 'behavioral-health',
  displayName: 'Behavioral Health',
  description: 'Ambulatory behavioral & mental-health, controlled-substance ledgers, 42 CFR Part 2 protections.',
  facilityKinds: ['behavioral-health', 'primary-care', 'outpatient'],
  capabilities: ['phq9-tracking', 'gad7-tracking', 'controlled-substance-mgmt', '42cfr-part2', 'crisis-triage', 'group-therapy-ops'],
  agents: [
    { id: 'phq9-serial-tracker', name: 'PHQ-9 Serial Tracker', desc: 'Longitudinal PHQ-9 with band change alerts.', domain: 'assessment' },
    { id: 'gad7-serial-tracker', name: 'GAD-7 Serial Tracker', desc: 'Longitudinal anxiety tracking with escalation.', domain: 'assessment' },
    { id: 'suicidality-columbia-screen', name: 'C-SSRS Suicidality Screen', desc: 'Columbia Suicide Severity Rating Scale with immediate escalation.', hitl: true, domain: 'crisis' },
    { id: 'crisis-safety-plan-builder', name: 'Crisis Safety Plan Builder', desc: 'Stanley-Brown safety plan generator.', hitl: true, domain: 'crisis' },
    { id: 'controlled-substance-ledger', name: 'Controlled-Substance Ledger', desc: 'Track buprenorphine/methadone dispensing with PDMP cross-check.', hitl: true, domain: 'meds' },
    { id: 'pdmp-check', name: 'PDMP Query', desc: 'Query state PDMP before controlled-substance Rx.', domain: 'meds' },
    { id: '42cfr-part2-consent-tracker', name: '42 CFR Part 2 Consent Tracker', desc: 'Track SUD-record disclosure consents.', domain: 'compliance' },
    { id: 'therapy-progress-note-drafter', name: 'Therapy Progress Note Drafter', desc: 'DAP/SOAP note draft from session recording.', hitl: true, domain: 'documentation' },
    { id: 'group-therapy-attendance', name: 'Group Therapy Attendance', desc: 'Roll-call, no-show tracking, session billing.', domain: 'ops' },
    { id: 'medication-adherence-check-in', name: 'Med Adherence Check-in', desc: 'SMS/IVR check-in on psych meds.', domain: 'ops' },
    { id: 'psychiatric-emergency-triage', name: 'Psychiatric Emergency Triage', desc: 'Route to ED / crisis line / stepdown.', hitl: true, domain: 'crisis' },
    { id: 'substance-use-audit-c', name: 'AUDIT-C Screening', desc: 'Alcohol use disorder screening.', domain: 'assessment' },
    { id: 'dast-10-screening', name: 'DAST-10 Screening', desc: 'Drug abuse screening test.', domain: 'assessment' },
    { id: 'buprenorphine-induction', name: 'Buprenorphine Induction Protocol', desc: 'Home induction guidance.', hitl: true, domain: 'meds' },
    { id: 'naltrexone-monitoring', name: 'Naltrexone Monitoring', desc: 'LFT/CK monitoring for naltrexone.', domain: 'meds' },
    { id: 'telehealth-consent', name: 'Telehealth Consent', desc: 'Capture and log telehealth consent per state law.', domain: 'compliance' },
    { id: 'no-show-outreach', name: 'No-Show Outreach', desc: 'Same-day re-engagement for missed sessions.', domain: 'ops' },
    { id: 'discharge-summary-behavioral', name: 'Behavioral Discharge Summary', desc: 'IOP/PHP discharge with warm handoff.', domain: 'documentation' },
    { id: 'caregiver-collateral-intake', name: 'Caregiver Collateral Intake', desc: 'Collateral history capture with consent.', domain: 'assessment' },
    { id: 'aces-screening', name: 'ACEs Screening', desc: 'Adverse childhood experiences questionnaire.', domain: 'assessment' },
    { id: 'trauma-informed-intake', name: 'Trauma-Informed Intake', desc: 'Sensitive intake with trigger check.', hitl: true, domain: 'assessment' },
    { id: 'behavioral-referral-tracker', name: 'Referral Tracker', desc: 'Track referrals to psychiatry / TMS / ECT.', domain: 'ops' },
    { id: 'group-note-composite', name: 'Group Note Composite', desc: 'Individual notes rolled up from group session.', domain: 'documentation' },
    { id: 'medication-titration-ssri', name: 'SSRI Titration', desc: 'Weekly titration guidance with side-effect check.', hitl: true, domain: 'meds' },
    { id: 'metabolic-monitoring-antipsychotics', name: 'Antipsychotic Metabolic Monitoring', desc: 'Quarterly HbA1c / lipids for antipsychotic patients.', domain: 'meds' },
    { id: 'tardive-dyskinesia-aims', name: 'AIMS Assessment', desc: 'Tardive dyskinesia screening.', domain: 'assessment' },
    { id: 'therapy-outcome-reporter', name: 'Therapy Outcome Reporter', desc: 'Aggregated outcomes for MIPS reporting.', domain: 'reporting' },
    { id: 'crisis-hotline-followup', name: 'Post-Crisis Follow-up', desc: '48-hr follow-up after ED discharge for suicidality.', hitl: true, domain: 'crisis' },
    { id: 'peer-support-scheduler', name: 'Peer Support Scheduler', desc: 'Match peer support specialists.', domain: 'ops' },
    { id: 'ect-preop-checklist', name: 'ECT Pre-op Checklist', desc: 'Anesthesia clearance, consent, NPO status.', hitl: true, domain: 'procedure' },
  ],
};

// ---------- Pack: oncology-deep (40 agents) ----------
const ONCOLOGY_DEEP = {
  id: 'oncology-deep',
  displayName: 'Oncology (deep)',
  description: 'Chemo compounding safety, tumor board prep, symptom triage, survivorship, port care.',
  facilityKinds: ['oncology', 'infusion', 'hospital'],
  capabilities: ['chemo-safety', 'tumor-board-prep', 'symptom-triage', 'port-care', 'survivorship', 'clinical-trials-match'],
  agents: [
    'chemo-order-safety-check', 'chemo-compound-verify', 'chemo-double-check', 'infusion-chair-scheduler',
    'port-flush-scheduler', 'port-complication-triage', 'central-line-infection-surveil', 'neutropenia-precautions',
    'febrile-neutropenia-triage', 'chemo-induced-nausea-triage', 'mucositis-management', 'chemo-induced-neuropathy-tracker',
    'immunotherapy-irae-triage', 'car-t-crs-monitor', 'car-t-icans-monitor', 'radiation-side-effect-tracker',
    'tumor-board-case-prep', 'molecular-tumor-board-prep', 'genomic-testing-orderer', 'clinical-trial-matcher',
    'goals-of-care-oncology', 'palliative-care-integrator', 'hospice-timing-advisor', 'survivorship-care-planner',
    'oncology-nutrition-assessment', 'cachexia-tracker', 'oncology-financial-toxicity-screener', 'oncology-distress-screening',
    'sperm-egg-banking-referral', 'fertility-counseling-scheduler', 'chemo-brain-cog-screening', 'oncology-rehab-referral',
    'lymphedema-monitoring', 'end-of-treatment-summary', 'oncology-mips-reporter', 'oral-chemo-adherence',
    'antiemetic-regimen-selector', 'growth-factor-eligibility-check', 'bone-metastasis-pain-triage', 'brain-mets-screening',
  ].map(id => ({ id, name: id.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' '), desc: `Oncology workflow: ${id.replace(/-/g, ' ')}.`, domain: 'oncology', hitl: id.includes('safety') || id.includes('goals') || id.includes('board') || id.includes('triage') })),
};

// ---------- Pack: home-health (35 agents) ----------
const HOME_HEALTH = {
  id: 'home-health',
  displayName: 'Home Health',
  description: 'Home-health agency ops: OASIS, PDGM, visit routing, telemonitoring triage.',
  facilityKinds: ['home-health', 'home-based'],
  capabilities: ['oasis-e', 'pdgm-billing', 'visit-routing', 'telemonitoring', 'wound-care', 'fall-prevention-home'],
  agents: [
    'oasis-e-start-of-care', 'oasis-e-resumption', 'oasis-e-recert', 'oasis-e-discharge', 'oasis-e-transfer',
    'pdgm-clinical-grouping', 'pdgm-comorbidity-adjust', 'pdgm-lupa-monitor', 'visit-routing-optimizer', 'visit-verification-evv',
    'telemonitoring-vitals-triage', 'telemonitoring-weight-triage', 'chf-home-alert', 'copd-home-alert', 'fall-risk-home-assessment',
    'wound-photo-tracker', 'wound-vac-monitoring', 'home-safety-eval', 'medication-mgmt-home', 'medication-adherence-blister-pack',
    'caregiver-burden-screening', 'caregiver-training-tracker', 'diabetes-self-mgmt-home', 'insulin-titration-home',
    'home-oxygen-management', 'home-infusion-management', 'iv-antibiotic-home', 'palliative-home-support', 'hospice-home-transition',
    'physical-therapy-home-plan', 'occupational-therapy-home-plan', 'speech-therapy-home-plan', 'social-worker-home-referral',
    'home-health-outcomes-reporter', 'catheter-mgmt-home',
  ].map(id => ({ id, name: id.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' '), desc: `Home-health workflow: ${id.replace(/-/g, ' ')}.`, domain: 'home-health', hitl: id.includes('alert') || id.includes('titration') })),
};

// ---------- Pack: long-term-care (35 agents) ----------
const LTC = {
  id: 'long-term-care',
  displayName: 'Long-Term Care / SNF',
  description: 'SNF/NF ops: MDS 3.0, PDPM billing, care-planning cadence, quality measures.',
  facilityKinds: ['snf', 'nursing-facility', 'assisted-living'],
  capabilities: ['mds-3.0', 'pdpm-billing', 'care-plan-cadence', 'ltc-quality-measures', 'infection-preventionist'],
  agents: [
    'mds-admission-assessment', 'mds-quarterly', 'mds-annual', 'mds-significant-change', 'mds-discharge',
    'pdpm-classification', 'pdpm-cmi-tracker', 'pdpm-billing-optimizer', 'care-plan-quarterly', 'care-plan-conference-scheduler',
    'ltc-fall-prevention', 'pressure-ulcer-prevention', 'pressure-ulcer-staging', 'wound-photo-ltc',
    'infection-preventionist-log', 'covid-outbreak-monitor', 'flu-vaccination-tracker', 'antibiotic-stewardship-ltc',
    'polypharmacy-review', 'psychotropic-med-review', 'weight-loss-monitoring', 'dehydration-monitoring',
    'behavior-management-plan', 'dementia-care-plan', 'end-of-life-care-plan', 'physician-visit-tracker',
    'therapy-caseload-mgr', 'restorative-nursing-plan', 'ltc-quality-measures-report', 'staffing-hprd-tracker',
    'ppd-nursing-hours-tracker', 'resident-council-tracker', 'grievance-tracker', 'discharge-planning-ltc', 'hospice-transition-ltc',
  ].map(id => ({ id, name: id.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' '), desc: `LTC/SNF workflow: ${id.replace(/-/g, ' ')}.`, domain: 'long-term-care', hitl: id.includes('mds') || id.includes('care-plan') })),
};

// ---------- Pack: radiology (20 agents) ----------
const RADIOLOGY = {
  id: 'radiology',
  displayName: 'Radiology',
  description: 'Worklist prioritization, critical-result callback, ACR appropriateness.',
  facilityKinds: ['radiology', 'imaging-center', 'hospital'],
  capabilities: ['worklist-priority', 'critical-result-comm', 'acr-appropriateness', 'peer-learning', 'contrast-safety'],
  agents: [
    'worklist-priority-scorer', 'stroke-code-worklist-elevator', 'pe-suspected-worklist-elevator', 'trauma-priority',
    'critical-result-callback', 'critical-result-audit', 'acr-appropriateness-check', 'contrast-allergy-check',
    'contrast-renal-safety-check', 'egfr-precheck', 'incidental-nodule-followup', 'lung-rads-tracker',
    'bi-rads-tracker', 'li-rads-tracker', 'pi-rads-tracker', 'ti-rads-tracker',
    'peer-learning-case-flagger', 'discrepancy-tracker', 'over-read-scheduler', 'mammo-recall-scheduler',
  ].map(id => ({ id, name: id.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' '), desc: `Radiology workflow: ${id.replace(/-/g, ' ')}.`, domain: 'radiology', hitl: id.includes('critical') || id.includes('discrepancy') })),
};

// ---------- Pack: ed-throughput (25 agents) ----------
const ED_THROUGHPUT = {
  id: 'ed-throughput',
  displayName: 'ED Throughput',
  description: 'Triage, bed-flow, boarding tracker, EMTALA guardrails.',
  facilityKinds: ['emergency-department', 'hospital'],
  capabilities: ['esi-triage', 'bed-flow', 'boarding-mgmt', 'emtala', 'sepsis-alert'],
  agents: [
    'esi-triage-scorer', 'chief-complaint-router', 'sepsis-early-alert', 'stroke-code-activator',
    'stemi-activator', 'trauma-team-activator', 'psych-hold-tracker', 'boarding-tracker',
    'bed-flow-optimizer', 'admission-transfer-orchestrator', 'discharge-lounge-router', 'ed-observation-monitor',
    'emtala-compliance-check', 'lwbs-monitor', 'left-ama-tracker', 'return-visit-72h-tracker',
    'ed-crowding-nedocs', 'ambulance-diversion-monitor', 'peds-dose-safety', 'geriatric-fall-screen-ed',
    'ed-imaging-appropriateness', 'ed-lab-turnaround-tracker', 'ed-satisfaction-survey', 'behavioral-hold-1013', 'high-frequency-ed-user-flag',
  ].map(id => ({ id, name: id.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' '), desc: `ED throughput workflow: ${id.replace(/-/g, ' ')}.`, domain: 'ed', hitl: id.includes('activator') || id.includes('psych') || id.includes('emtala') })),
};

// ---------- Pack: revenue-cycle (30 agents) ----------
const REVENUE_CYCLE = {
  id: 'revenue-cycle',
  displayName: 'Revenue Cycle',
  description: 'Denial mgmt, coding review, prior-auth, AR aging, payment posting.',
  facilityKinds: ['*'],
  capabilities: ['denial-mgmt', 'coding-review', 'prior-auth', 'ar-aging', 'payment-posting', 'eligibility'],
  agents: [
    'eligibility-realtime-check', 'benefits-verification', 'prior-auth-initiator', 'prior-auth-followup',
    'prior-auth-appeal', 'coding-review-e-and-m', 'coding-review-procedures', 'ncci-edit-check',
    'lcd-ncd-check', 'claim-scrubber', 'claim-submitter-837', 'era-poster-835',
    'denial-triage', 'denial-appeal-drafter', 'medical-necessity-appeal', 'timely-filing-monitor',
    'ar-aging-analyzer', 'small-balance-writeoff', 'patient-statement-generator', 'payment-plan-negotiator',
    'collections-workflow', 'bad-debt-classifier', 'charity-care-screening', 'financial-assistance-application',
    'undercoding-detector', 'overcoding-risk-flag', 'modifier-usage-audit', 'refund-processor', 'credit-balance-resolver', 'contract-variance-tracker',
  ].map(id => ({ id, name: id.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' '), desc: `Revenue-cycle workflow: ${id.replace(/-/g, ' ')}.`, domain: 'revenue-cycle', hitl: id.includes('appeal') || id.includes('writeoff') })),
};

// ---------- Pack: hospital-at-home (25 agents) ----------
const HOSPITAL_AT_HOME = {
  id: 'hospital-at-home',
  displayName: 'Hospital-at-Home',
  description: 'CMS waiver hospital-at-home ops: admission, telemetry, escalation, discharge.',
  facilityKinds: ['hospital-at-home', 'hospital'],
  capabilities: ['h-at-h-eligibility', 'remote-telemetry', 'escalation-plan', 'in-home-clinical-team'],
  agents: [
    'hah-eligibility-screen', 'hah-consent-capture', 'hah-admission-orchestrator', 'in-home-vitals-monitor',
    'in-home-labs-orchestrator', 'in-home-imaging-orchestrator', 'in-home-iv-therapy', 'in-home-oxygen-mgmt',
    'in-home-nurse-visit-scheduler', 'in-home-md-visit-scheduler', 'community-paramedic-dispatch', 'escalation-to-facility',
    'telemetry-alert-triage', 'medication-delivery-orchestrator', 'dme-delivery-orchestrator', 'caregiver-education-hah',
    'hah-fall-risk', 'hah-daily-huddle', 'hah-discharge-planning', 'hah-clinical-documentation',
    'hah-billing-cms-waiver', 'hah-quality-measures', 'hah-satisfaction-survey', 'hah-length-of-stay-optimizer', 'hah-readmission-monitor',
  ].map(id => ({ id, name: id.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' '), desc: `Hospital-at-home workflow: ${id.replace(/-/g, ' ')}.`, domain: 'hospital-at-home', hitl: id.includes('escalation') || id.includes('alert') })),
};

const PACKS = [BEHAVIORAL_HEALTH, ONCOLOGY_DEEP, HOME_HEALTH, LTC, RADIOLOGY, ED_THROUGHPUT, REVENUE_CYCLE, HOSPITAL_AT_HOME];

// ---------- Generate ----------
let agentCount = 0;
for (const pack of PACKS) {
  const dir = `${ROOT}${pack.id}`;
  const agentsDir = `${dir}/agents`;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(agentsDir)) mkdirSync(agentsDir, { recursive: true });

  // manifest.yaml (declarative)
  const capYaml = pack.capabilities.map(c => `  - ${c}`).join('\n');
  const facYaml = pack.facilityKinds.map(f => `    - ${f}`).join('\n');
  writeFileSync(`${dir}/manifest.yaml`, `id: ${pack.id}
version: 1.0.0
extends:
  - id: healthcare-core
    version_range: ^0.2.0
applies_to:
  organization_kinds: [provider, health-system, practice]
  facility_kinds:
${facYaml}
capabilities:
${capYaml}
required_controls:
  - access-policy
  - audit-provenance
  - phi-handling
`);

  // index.ts (runtime registration)
  writeFileSync(`${dir}/index.ts`, `// ${pack.id} pack — ${pack.agents.length} agents for ${pack.displayName}.
// Generated by scripts/gen-vertical-packs.mjs
import type { DomainPack } from '../../src/control-plane/pack-registry.js';

export const ${camel(pack.id)}Pack: DomainPack = Object.freeze({
  id: '${pack.id}',
  version: '1.0.0',
  extends: [{ id: 'healthcare-core', versionRange: '^0.2.0' }],
  appliesTo: { organizationKinds: ['provider', 'health-system', 'practice'], facilityKinds: [${pack.facilityKinds.map(f => `'${f}'`).join(', ')}] },
  capabilities: [${pack.capabilities.map(c => `'${c}'`).join(', ')}],
  cmsUniverse: [],
  requiredControls: ['audit-provenance', 'phi-handling', 'access-policy'],
});
`);

  // Agent yamls
  for (const a of pack.agents) {
    const yaml = agentYaml({
      id: a.id,
      packId: pack.id,
      displayName: a.name,
      description: a.desc,
      trigger: { kind: 'event', eventType: 'patient.arrived' },
      plan: stdPlan(['sql.query', 'llm.call', a.hitl ? 'hitl.approve' : 'http.call']),
      hitl: !!a.hitl,
      labels: { setting: pack.id, domain: a.domain || 'general' },
    });
    writeFileSync(`${agentsDir}/${a.id}.yaml`, yaml);
    agentCount++;
  }
  console.log(`  ${pack.id.padEnd(24)} ${pack.agents.length} agents`);
}

// Update packs/index.ts to export the new packs
const packsIndexPath = `${ROOT}index.ts`;
let idx = `export { healthcareCorePack } from './healthcare-core/index.js';
export * from './dialysis-provider/index.js';
export { dialysisProviderPack } from './dialysis-provider/index.js';
export { ckdNavigationPack } from './ckd-navigation/index.js';
export { payerPack } from './payer/index.js';
export { cmsUniversePack } from './cms-universe/index.js';
export { oncologyProviderPack } from './oncology-provider/index.js';
export { infusionProviderPack } from './infusion-provider/index.js';
export { careManagementPack } from './care-management/index.js';
`;
for (const p of PACKS) idx += `export { ${camel(p.id)}Pack } from './${p.id}/index.js';\n`;
writeFileSync(packsIndexPath, idx);

console.log(`\nGenerated ${agentCount} agents across ${PACKS.length} packs.`);

function camel(s) { return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase()); }
