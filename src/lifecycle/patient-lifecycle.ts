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

// Patient lifecycle — the canonical stages the harness models across every
// care setting. Each stage has: entry criteria, sub-stages, required
// artifacts, agent hooks, and outbound transitions. Agents subscribe to stage
// transitions via canonical events (`patient.stage.transition`) and receive
// context necessary to run.

export type LifecycleStage =
  | 'pre-registration'      // referral received, insurance capture, scheduling
  | 'onboarding'            // consent, identity, coverage verification, initial assessments
  | 'active-care'           // ongoing encounters, treatments, meds, monitoring
  | 'transition-of-care'    // discharge, transfer, level-of-care change
  | 'transplant-workup'     // evaluation, listing, waitlist, pre-op
  | 'post-transplant'       // immunosuppression, rejection surveillance, long-term follow-up
  | 'palliative'            // symptom-focused, comfort-oriented
  | 'hospice'               // 6-month prognosis, terminal
  | 'bereavement'           // family/care-team support after death
  | 'inactive'              // moved, opted out, lost to follow-up
  | 'discharged';           // completed episode of care

export interface LifecycleTransition {
  readonly from: LifecycleStage;
  readonly to: LifecycleStage;
  readonly triggeredByEvents: readonly string[];
  readonly requiredArtifacts: readonly string[];
  readonly firesAgents: readonly string[];
}

export interface LifecycleStageDefinition {
  readonly stage: LifecycleStage;
  readonly description: string;
  readonly typicalSettings: readonly ('primary-care' | 'urgent-care' | 'specialty' | 'ed' | 'inpatient' | 'dialysis' | 'home-health' | 'hospice' | 'ltc' | 'pharmacy' | 'transplant-center')[];
  readonly entryCriteria: readonly string[];
  readonly requiredArtifacts: readonly string[];
  readonly recommendedAssessments: readonly string[]; // assessment ids
  readonly agentHooks: readonly {
    readonly onEvent: string;
    readonly agentId: string;
    readonly description: string;
  }[];
  readonly outboundTransitions: readonly LifecycleStage[];
}

export const LIFECYCLE_STAGES: readonly LifecycleStageDefinition[] = Object.freeze([
  {
    stage: 'pre-registration',
    description: 'Referral received or self-scheduled; identity captured; insurance eligibility run; appointment scheduled.',
    typicalSettings: ['primary-care', 'urgent-care', 'specialty', 'dialysis', 'transplant-center'],
    entryCriteria: ['referral-received OR self-scheduled', 'demographics-minimum'],
    requiredArtifacts: ['patient-demographics', 'insurance-primary', 'consent-to-treat-draft'],
    recommendedAssessments: [],
    agentHooks: [
      { onEvent: 'referral.received', agentId: 'insurance-eligibility-check', description: '270/271 real-time eligibility, benefits summary' },
      { onEvent: 'appointment.scheduled', agentId: 'pre-visit-questionnaire', description: 'Sends pre-visit intake + reason-for-visit prep' },
      { onEvent: 'appointment.scheduled', agentId: 'prior-authorization-check', description: 'Determines if PA required and initiates 278' },
    ],
    outboundTransitions: ['onboarding', 'inactive'],
  },
  {
    stage: 'onboarding',
    description: 'First encounter or admission; consent, identity confirmation, med rec, baseline assessments, care team assignment.',
    typicalSettings: ['primary-care', 'urgent-care', 'specialty', 'ed', 'inpatient', 'dialysis', 'home-health', 'transplant-center'],
    entryCriteria: ['patient-present OR admitted', 'consent-executable'],
    requiredArtifacts: ['consent-to-treat', 'hipaa-notice-ack', 'medication-list-baseline', 'allergies-baseline', 'problem-list-baseline', 'advance-directive-status'],
    recommendedAssessments: ['assessment:phq-9', 'assessment:audit-c', 'assessment:sdoh-5-domain', 'assessment:katz-adl', 'assessment:morse'],
    agentHooks: [
      { onEvent: 'patient.arrived', agentId: 'identity-verification', description: 'Two-identifier match + duplicate MRN detection' },
      { onEvent: 'patient.arrived', agentId: 'medication-reconciliation', description: 'Pulls Rx history, resolves conflicts, generates rec list' },
      { onEvent: 'patient.arrived', agentId: 'allergy-verification', description: 'Confirms allergies, checks against active meds' },
      { onEvent: 'patient.arrived', agentId: 'baseline-assessment-runner', description: 'Administers appropriate baseline instruments' },
      { onEvent: 'patient.arrived', agentId: 'advance-directive-capture', description: 'Prompts, uploads, files POLST/DNR' },
      { onEvent: 'onboarding.complete', agentId: 'care-plan-drafter', description: 'Drafts initial care plan for clinician review' },
    ],
    outboundTransitions: ['active-care', 'transition-of-care', 'transplant-workup', 'discharged'],
  },
  {
    stage: 'active-care',
    description: 'Longitudinal management; visits, treatments, med changes, monitoring, chronic condition management, prevention.',
    typicalSettings: ['primary-care', 'urgent-care', 'specialty', 'dialysis', 'home-health', 'ltc', 'pharmacy'],
    entryCriteria: ['onboarding.complete OR active-episode-open'],
    requiredArtifacts: ['problem-list', 'medication-list', 'active-care-plan', 'quality-measure-attribution'],
    recommendedAssessments: ['assessment:phq-9', 'assessment:gad-7', 'assessment:mna-sf', 'assessment:kdqol-36'],
    agentHooks: [
      { onEvent: 'encounter.opened', agentId: 'pre-visit-briefing', description: 'Composes clinician briefing: gaps, recent labs, high-risk flags' },
      { onEvent: 'lab.resulted', agentId: 'lab-result-critical-value', description: 'Detects critical/panic values and pages responsible clinician' },
      { onEvent: 'lab.resulted', agentId: 'measure-attribution-updater', description: 'Updates CMS measure numerators/denominators' },
      { onEvent: 'medication.prescribed', agentId: 'drug-drug-interaction-check', description: 'DDI check against active med list + labs' },
      { onEvent: 'encounter.closed', agentId: 'quality-gap-closer', description: 'Identifies quality gaps and books/orders closure' },
      { onEvent: 'daily.batch', agentId: 'chronic-condition-risk-stratification', description: 'Re-scores CKD, HF, DM risk cohorts' },
      { onEvent: 'daily.batch', agentId: 'preventive-care-outreach', description: 'Batch outreach for due-for-screening cohorts' },
    ],
    outboundTransitions: ['transition-of-care', 'palliative', 'transplant-workup', 'discharged', 'inactive'],
  },
  {
    stage: 'transition-of-care',
    description: 'Discharge from inpatient, level-of-care change, transfer between facilities, admission from ED.',
    typicalSettings: ['inpatient', 'ed', 'specialty', 'ltc', 'home-health'],
    entryCriteria: ['discharge-order OR transfer-order'],
    requiredArtifacts: ['discharge-summary', 'discharge-medication-list', 'follow-up-appointment', 'patient-instructions', 'referral-packet'],
    recommendedAssessments: ['assessment:braden', 'assessment:morse', 'assessment:frail'],
    agentHooks: [
      { onEvent: 'discharge.ordered', agentId: 'discharge-medication-reconciliation', description: 'Reconciles home vs inpatient meds; flags high-risk changes' },
      { onEvent: 'discharge.ordered', agentId: 'discharge-summary-drafter', description: 'Drafts CCDA discharge summary + patient instructions' },
      { onEvent: 'discharge.ordered', agentId: 'follow-up-appointment-scheduler', description: 'Books 7-day, 30-day, and specialty follow-ups' },
      { onEvent: 'discharge.ordered', agentId: 'transitions-of-care-hie-send', description: 'CCDA push to PCP + receiving facility via HIE (CMS-0057-F)' },
      { onEvent: 'discharge.completed', agentId: 'readmission-risk-score', description: 'LACE / HOSPITAL / CMS SRR-style risk scoring; triggers outreach if high' },
      { onEvent: 'day+2', agentId: 'post-discharge-callback', description: 'Callback for symptom check + med adherence' },
    ],
    outboundTransitions: ['active-care', 'palliative', 'hospice', 'inactive', 'discharged'],
  },
  {
    stage: 'transplant-workup',
    description: 'Evaluation, waitlist listing, pre-op optimization for solid organ transplant (kidney, heart, liver, lung, pancreas).',
    typicalSettings: ['transplant-center', 'specialty', 'dialysis'],
    entryCriteria: ['referral-to-transplant-center', 'organ-failure-diagnosis'],
    requiredArtifacts: ['transplant-eval-panel', 'psychosocial-eval', 'financial-clearance', 'unos-listing-form', 'donor-antibody-panel'],
    recommendedAssessments: ['assessment:phq-9', 'assessment:moca', 'assessment:frail', 'assessment:sdoh-5-domain'],
    agentHooks: [
      { onEvent: 'transplant.eval.ordered', agentId: 'transplant-eval-orchestrator', description: 'Sequences cardiac clearance, dental, psychosocial, imaging' },
      { onEvent: 'transplant.eval.complete', agentId: 'transplant-listing-packet', description: 'Assembles UNOS/OPTN listing packet + submits to OPO' },
      { onEvent: 'transplant.waitlist.listed', agentId: 'waitlist-status-monitor', description: 'Weekly CPRA/PRA + labs; keeps status active' },
      { onEvent: 'organ.offer.received', agentId: 'organ-offer-decision-support', description: 'Ranks acceptance likelihood; alerts on-call' },
    ],
    outboundTransitions: ['post-transplant', 'active-care', 'hospice'],
  },
  {
    stage: 'post-transplant',
    description: 'Immunosuppression titration, rejection surveillance, infection prophylaxis, long-term follow-up.',
    typicalSettings: ['transplant-center', 'specialty', 'primary-care', 'pharmacy'],
    entryCriteria: ['transplant.completed'],
    requiredArtifacts: ['immunosuppression-plan', 'prophylaxis-plan', 'rejection-surveillance-schedule'],
    recommendedAssessments: ['assessment:kdqol-36', 'assessment:phq-9'],
    agentHooks: [
      { onEvent: 'transplant.completed', agentId: 'immunosuppression-titration', description: 'Trough-based tacrolimus/CNI titration with pharmacist HITL' },
      { onEvent: 'lab.resulted', agentId: 'rejection-surveillance', description: 'Detects rising creatinine or DSA; triggers biopsy pathway' },
      { onEvent: 'weekly.batch', agentId: 'opportunistic-infection-prophylaxis', description: 'Bactrim/valganciclovir schedule + adherence' },
      { onEvent: 'weekly.batch', agentId: 'graft-survival-risk-score', description: 'Updates iBox / graft survival prediction' },
    ],
    outboundTransitions: ['active-care', 'palliative', 'inactive'],
  },
  {
    stage: 'palliative',
    description: 'Symptom-focused care alongside disease-modifying treatment; goals-of-care conversations.',
    typicalSettings: ['inpatient', 'primary-care', 'specialty', 'home-health', 'ltc'],
    entryCriteria: ['serious-illness OR palliative-consult-ordered'],
    requiredArtifacts: ['goals-of-care-note', 'symptom-management-plan', 'polst-status'],
    recommendedAssessments: ['assessment:phq-9', 'assessment:frail'],
    agentHooks: [
      { onEvent: 'palliative.consult.ordered', agentId: 'goals-of-care-conversation-prep', description: 'Drafts personalized conversation guide + Serious Illness Conversation Guide' },
      { onEvent: 'symptom.reported', agentId: 'symptom-management-titrator', description: 'Recommends analgesic ladder + antiemetic + dyspnea management' },
    ],
    outboundTransitions: ['hospice', 'active-care', 'discharged'],
  },
  {
    stage: 'hospice',
    description: 'Six-month prognosis certification; comfort-focused; MHB election.',
    typicalSettings: ['hospice', 'home-health', 'ltc'],
    entryCriteria: ['prognosis-6-months', 'hospice-election'],
    requiredArtifacts: ['hospice-cert', 'plan-of-care', 'idg-notes'],
    recommendedAssessments: ['assessment:phq-9', 'assessment:braden'],
    agentHooks: [
      { onEvent: 'hospice.admitted', agentId: 'hospice-plan-of-care', description: 'Assembles IDG plan of care per CoP §418.56' },
      { onEvent: 'weekly.batch', agentId: 'hospice-recertification-monitor', description: 'Monitors decline criteria and cert cycles' },
    ],
    outboundTransitions: ['bereavement', 'active-care'],
  },
  {
    stage: 'bereavement',
    description: 'Post-death family support (13 months per hospice CoP).',
    typicalSettings: ['hospice'],
    entryCriteria: ['patient.deceased'],
    requiredArtifacts: ['bereavement-plan'],
    recommendedAssessments: [],
    agentHooks: [
      { onEvent: 'patient.deceased', agentId: 'bereavement-plan-orchestrator', description: 'Schedules 13-month bereavement contacts + risk screen' },
    ],
    outboundTransitions: [],
  },
  {
    stage: 'inactive',
    description: 'Lost to follow-up, opted out, moved. Retained for record continuity but no active outreach.',
    typicalSettings: [],
    entryCriteria: ['no-encounter-in-24-months OR patient-opted-out OR moved'],
    requiredArtifacts: [],
    recommendedAssessments: [],
    agentHooks: [
      { onEvent: 'inactive.enter', agentId: 'reactivation-outreach', description: 'Attempts contact, updates status if unreachable' },
    ],
    outboundTransitions: ['active-care', 'discharged'],
  },
  {
    stage: 'discharged',
    description: 'Episode of care complete; no ongoing panel membership.',
    typicalSettings: [],
    entryCriteria: ['discharge.completed'],
    requiredArtifacts: [],
    recommendedAssessments: [],
    agentHooks: [],
    outboundTransitions: ['pre-registration'],
  },
]);

export const LIFECYCLE_TRANSITIONS: readonly LifecycleTransition[] = Object.freeze(
  LIFECYCLE_STAGES.flatMap((s) =>
    s.outboundTransitions.map((to) => ({
      from: s.stage,
      to,
      triggeredByEvents: [`patient.stage.transition.${s.stage}.to.${to}`],
      requiredArtifacts: [] as readonly string[],
      firesAgents: [] as readonly string[],
    })),
  ),
);

export class LifecycleRegistry {
  private readonly byStage = new Map<LifecycleStage, LifecycleStageDefinition>();
  constructor(seed: readonly LifecycleStageDefinition[] = LIFECYCLE_STAGES) {
    for (const s of seed) this.byStage.set(s.stage, s);
  }
  get(stage: LifecycleStage): LifecycleStageDefinition | undefined { return this.byStage.get(stage); }
  list(): readonly LifecycleStageDefinition[] { return [...this.byStage.values()]; }
  agentsFor(stage: LifecycleStage, event: string): readonly string[] {
    const s = this.get(stage);
    if (!s) return [];
    return s.agentHooks.filter((h) => h.onEvent === event).map((h) => h.agentId);
  }
  canTransition(from: LifecycleStage, to: LifecycleStage): boolean {
    return this.get(from)?.outboundTransitions.includes(to) ?? false;
  }
}
