/******************************************************************************
 *
 * Copyright (c) 2026 AnantHQ Inc.
 * All Rights Reserved.
 *
 * This software is licensed, not sold.
 *
 * The contents of this file constitute proprietary and confidential
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

// P6 — the PREVENTION half: deterministic, auditable state machines over CDC
// dialysis core interventions.
//
// This module deliberately imports NOTHING that can produce a prediction. There
// is no model import in its dependency graph, and `tests/infection.test.ts`
// asserts that the same records always produce byte-identical tasks, so a model
// change can never move a prevention task. That is the report's rule made
// executable: "Never ML for infection-prevention compliance."
//
// Each task answers: WHAT is due, WHY (the rule + the record it read), WHEN it
// becomes overdue, WHO owns it, and which approval class it carries. Tasks are
// generated from records (immunisations, serology, audits, access state) only.

import type { ImmunisationRecord, InfectionInput } from './infection-types.js';
export type PreventionTaskKind =
  | 'vaccination-due'
  | 'serology-followup'
  | 'audit-due'
  | 'catheter-escalation'
  | 'access-care-review'
  | 'immunisation-series-incomplete';

export interface PreventionRuleRef {
  /** stable rule id — the audit trail joins on this */
  ruleId: string;
  /** the guideline the rule implements */
  source: string;
  /** the record(s) the rule read, with the value it saw */
  read: Array<{ record: string; value: string }>;
  /** the threshold/interval the rule applied */
  threshold: string;
}

export interface PreventionTask {
  id: string;
  kind: PreventionTaskKind;
  label: string;
  /** why this task exists, in one auditable sentence */
  because: string;
  dueAt: string;
  overdue: boolean;
  daysUntilDue: number;
  ownerRole: string;
  approvalClass: 'A' | 'B' | 'C';
  /** deterministic = computed from records + rules; NO model output is involved */
  deterministic: true;
  /** the model input surface this task ignores, stated explicitly */
  modelFree: true;
  rule: PreventionRuleRef;
  /** the completion state derived from the records (not from a task store) */
  satisfied: boolean;
}

export interface PreventionPlan {
  patientId: string;
  asOf: string;
  tasks: PreventionTask[];
  dueCount: number;
  overdueCount: number;
  /** the vaccine schedule the engine applied, for the audit trail */
  schedule: Array<{ vaccine: string; label: string; intervalDays: number; seriesDoses: number }>;
}

/** CDC/ACIP schedule as applied to dialysis patients (documented in the MDR). */
export const VACCINE_SCHEDULE = [
  { vaccine: 'hepatitis-b', label: 'Hepatitis B (3-dose series)', intervalDays: 365, seriesDoses: 3 },
  { vaccine: 'influenza', label: 'Influenza (annual)', intervalDays: 365, seriesDoses: 1 },
  { vaccine: 'pneumococcal', label: 'Pneumococcal (per ACIP interval)', intervalDays: 1_825, seriesDoses: 1 },
  { vaccine: 'sars-cov-2', label: 'SARS-CoV-2 (current recommendation)', intervalDays: 365, seriesDoses: 1 },
] as const;

/** Prevention audit cadence (hand hygiene + access care are monthly core interventions). */
export const AUDIT_CADENCE = [
  { id: 'hand-hygiene-audit', label: 'Hand-hygiene audit', intervalDays: 30 },
  { id: 'access-care-audit', label: 'Access-care (AVF/AVG/catheter) audit', intervalDays: 30 },
] as const;

export const SEROLOGY = {
  /** hepatitis B surface antibody protective threshold, mIU/mL */
  protectiveIuL: 10,
  followUpDays: 365,
  /** when the series was incomplete, recheck earlier */
  afterIncompleteSeriesDays: 180,
} as const;

const DAY_MS = 86_400_000;

const at = (iso: string | undefined): number | undefined => {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : undefined;
};

const iso = (ms: number): string => new Date(ms).toISOString();

function daysUntil(dueMs: number, asOfMs: number): number {
  return Math.round((dueMs - asOfMs) / DAY_MS);
}

/** Latest administration of a vaccine in the ring (records are append-only). */
function latestDose(records: readonly ImmunisationRecord[], vaccine: string): ImmunisationRecord | undefined {
  let best: ImmunisationRecord | undefined;
  let bestAt = Number.NEGATIVE_INFINITY;
  for (const record of records) {
    if (record.vaccine !== vaccine) continue;
    const t = at(record.at) ?? Number.NEGATIVE_INFINITY;
    if (t >= bestAt) { best = record; bestAt = t; }
  }
  return best;
}

/**
 * The prevention state machine. Pure function of (records, rules, asOf).
 *
 * Reading order is fixed and the output is sorted by (kind, id) so the task list
 * is reproducible and diffable — an auditor can regenerate it from the same
 * records and get the same list, byte for byte.
 */
export function preventionPlan(input: InfectionInput, now: () => string = () => new Date().toISOString()): PreventionTask[] {
  const asOfIso = input.asOf ?? now();
  const asOfMs = at(asOfIso) ?? Date.now();
  const immunisations = input.immunisations ?? [];
  const tasks: PreventionTask[] = [];

  // ---- 1. vaccination due / series incomplete ----
  for (const entry of VACCINE_SCHEDULE) {
    const last = latestDose(immunisations, entry.vaccine);
    const lastMs = at(last?.at);
    const dosesGiven = last?.seriesDose ?? 0;
    const seriesTotal = last?.seriesTotal ?? entry.seriesDoses;
    const seriesIncomplete = dosesGiven < seriesTotal;
    // the interval starts at the LAST dose; with no record at all the vaccine is
    // due immediately (the patient is unprotected, not merely un-documented)
    const dueMs = lastMs === undefined ? asOfMs : lastMs + entry.intervalDays * DAY_MS;
    const due = seriesIncomplete || dueMs <= asOfMs;
    if (!due) continue;
    const kind: PreventionTaskKind = seriesIncomplete && dosesGiven > 0 ? 'immunisation-series-incomplete' : 'vaccination-due';
    tasks.push({
      id: `vaccination:${entry.vaccine}`,
      kind,
      label: `${entry.label} — dose ${Math.min(dosesGiven + 1, seriesTotal)} of ${seriesTotal}`,
      because: last === undefined
        ? `No ${entry.label} record exists for this patient; the schedule requires it for dialysis patients.`
        : seriesIncomplete
          ? `Series incomplete: dose ${dosesGiven} of ${seriesTotal} recorded (last ${last.at ?? 'undated'}).`
          : `Interval elapsed: last dose ${last.at ?? 'undated'} is older than ${entry.intervalDays} days.`,
      dueAt: iso(dueMs),
      overdue: dueMs < asOfMs,
      daysUntilDue: daysUntil(dueMs, asOfMs),
      ownerRole: 'nurse',
      approvalClass: 'B',
      deterministic: true,
      modelFree: true,
      satisfied: false,
      rule: {
        ruleId: `cdc.immunisation.${entry.vaccine}`,
        source: 'CDC dialysis core interventions / ACIP schedule',
        read: [
          { record: 'immunisations', value: last ? `${entry.vaccine} dose ${dosesGiven}/${seriesTotal} @ ${last.at ?? 'undated'}` : 'none' },
          { record: 'intervalDays', value: String(entry.intervalDays) },
        ],
        threshold: `due when series incomplete OR last dose older than ${entry.intervalDays} days`,
      },
    });
  }

  // ---- 2. serology follow-up (hepatitis B surface antibody) ----
  const hbsab = input.hepatitisBSurfaceAntibodyIuL;
  const serologyMs = at(input.serologyAt);
  const seriesIncomplete = immunisations.some((r) => r.vaccine === 'hepatitis-b' && r.seriesDose < (r.seriesTotal ?? 3));
  const serologyInterval = seriesIncomplete ? SEROLOGY.afterIncompleteSeriesDays : SEROLOGY.followUpDays;
  const serologyDueMs = serologyMs === undefined ? asOfMs : serologyMs + serologyInterval * DAY_MS;
  const nonProtective = hbsab !== undefined && hbsab < SEROLOGY.protectiveIuL;
  if (hbsab === undefined || nonProtective || serologyDueMs <= asOfMs) {
    tasks.push({
      id: 'serology:hepatitis-b-surface-antibody',
      kind: 'serology-followup',
      label: 'Hepatitis B surface antibody recheck',
      because: hbsab === undefined
        ? 'No hepatitis B surface antibody result is on file — protection is unverified.'
        : nonProtective
          ? `Titre ${hbsab} mIU/mL is below the protective threshold of ${SEROLOGY.protectiveIuL} mIU/mL — recheck and revaccinate if still non-protective.`
          : `Last titre ${hbsab} mIU/mL is older than the ${serologyInterval}-day follow-up interval.`,
      dueAt: iso(serologyDueMs),
      overdue: serologyDueMs < asOfMs,
      daysUntilDue: daysUntil(serologyDueMs, asOfMs),
      ownerRole: 'nurse',
      approvalClass: 'B',
      deterministic: true,
      modelFree: true,
      satisfied: false,
      rule: {
        ruleId: 'cdc.serology.hepatitis-b',
        source: 'CDC dialysis core interventions — hepatitis B protection',
        read: [
          { record: 'hepatitisBSurfaceAntibodyIuL', value: hbsab === undefined ? 'none' : String(hbsab) },
          { record: 'serologyAt', value: input.serologyAt ?? 'none' },
        ],
        threshold: `protective ≥ ${SEROLOGY.protectiveIuL} mIU/mL, recheck every ${serologyInterval} days${seriesIncomplete ? ' (series incomplete)' : ''}`,
      },
    });
  }

  // ---- 3. prevention audits on cadence ----
  const auditState: Array<{ id: string; label: string; intervalDays: number; lastAt?: string | undefined }> = [
    { id: 'hand-hygiene-audit', label: 'Hand-hygiene audit', intervalDays: 30, lastAt: input.lastHandHygieneAuditAt },
    { id: 'access-care-audit', label: 'Access-care audit', intervalDays: 30, lastAt: input.lastAccessCareAuditAt },
  ];
  for (const audit of auditState) {
    const lastMs = at(audit.lastAt);
    const dueMs = lastMs === undefined ? asOfMs : lastMs + audit.intervalDays * DAY_MS;
    if (dueMs > asOfMs) continue;
    tasks.push({
      id: `audit:${audit.id}`,
      kind: 'audit-due',
      label: audit.label,
      because: audit.lastAt === undefined
        ? `No ${audit.label.toLowerCase()} has ever been recorded for this unit/patient.`
        : `Last ${audit.label.toLowerCase()} was ${audit.lastAt}, older than the ${audit.intervalDays}-day cadence.`,
      dueAt: iso(dueMs),
      overdue: dueMs < asOfMs,
      daysUntilDue: daysUntil(dueMs, asOfMs),
      ownerRole: 'infection-prevention',
      approvalClass: 'B',
      deterministic: true,
      modelFree: true,
      satisfied: false,
      rule: {
        ruleId: `cdc.audit.${audit.id}`,
        source: 'CDC dialysis BSI prevention core interventions (audit cadence)',
        read: [{ record: audit.id, value: audit.lastAt ?? 'none' }],
        threshold: `every ${audit.intervalDays} days`,
      },
    });
  }

  // ---- 4. catheter-day escalation (only when a mature alternative exists) ----
  const catheterDays = input.catheterDays ?? 0;
  const matureAccessDays = input.accessAgeDays !== undefined && input.matureAvfAvailable && input.accessType === 'catheter'
    ? input.accessAgeDays
    : undefined;
  if (input.accessType === 'catheter' && catheterDays > 90) {
    const removable = input.matureAvfAvailable === true;
    tasks.push({
      id: 'catheter:escalation',
      kind: 'catheter-escalation',
      label: removable ? 'Catheter removal escalation (mature access available)' : 'Catheter review (no mature access yet)',
      because: removable
        ? `${catheterDays} catheter days exceeds the 90-day threshold and a mature access is documented — escalate removal to the access team.`
        : `${catheterDays} catheter days exceeds the 90-day threshold but no mature access is documented — escalate a plan for definitive access, not removal.`,
      dueAt: iso(asOfMs),
      overdue: true,
      daysUntilDue: 0,
      ownerRole: 'access-team',
      approvalClass: 'B',
      deterministic: true,
      modelFree: true,
      satisfied: false,
      rule: {
        ruleId: 'cdc.catheter.escalation',
        source: 'CDC dialysis BSI prevention — catheter necessity review',
        read: [
          { record: 'accessType', value: input.accessType },
          { record: 'catheterDays', value: String(catheterDays) },
          { record: 'accessAgeDays', value: matureAccessDays === undefined ? 'none' : String(matureAccessDays) },
        ],
        threshold: '> 90 catheter days with a mature access available ⇒ removal escalation',
      },
    });
  }

  // ---- 5. access-care review when infection signs are documented ----
  if (input.accessInfectionSigns === true) {
    tasks.push({
      id: 'access-care:review',
      kind: 'access-care-review',
      label: 'Access-site care review',
      because: 'Access-site infection signs are documented — a structured access-care review is required under the CDC core interventions.',
      dueAt: iso(asOfMs),
      overdue: true,
      daysUntilDue: 0,
      ownerRole: 'nurse',
      approvalClass: 'B',
      deterministic: true,
      modelFree: true,
      satisfied: false,
      rule: {
        ruleId: 'cdc.access-care.review',
        source: 'CDC dialysis BSI prevention — access care',
        read: [{ record: 'accessInfectionSigns', value: 'true' }],
        threshold: 'any documented access-site infection sign ⇒ review',
      },
    });
  }

  return tasks.sort((a, b) => (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind.localeCompare(b.kind)));
}

/** The full plan wrapper with counts (used by routes + the console). */
export function preventionPlanWithSummary(input: InfectionInput, now: () => string = () => new Date().toISOString()): PreventionPlan {
  const tasks = preventionPlan(input, now);
  return {
    patientId: input.patientId,
    asOf: input.asOf ?? now(),
    tasks,
    // due = an obligation approaching its date; overdue = an obligation already past it.
    // The two must partition the task list, so the console can never double-count.
    dueCount: tasks.filter((t) => !t.overdue).length,
    overdueCount: tasks.filter((t) => t.overdue).length,
    schedule: VACCINE_SCHEDULE.map((v) => ({ vaccine: v.vaccine, label: v.label, intervalDays: v.intervalDays, seriesDoses: v.seriesDoses })),
  };
}

/**
 * Determinism self-check used by the governance gate: re-running the plan over
 * the same records must produce an identical task list. The comparison is
 * structural (ids + due dates + reasons), so a failure is a real behaviour
 * change, not a formatting artefact.
 */
export function preventionDeterminismSignature(tasks: readonly PreventionTask[]): string {
  return JSON.stringify(tasks.map((t) => ({ id: t.id, dueAt: t.dueAt, because: t.because, rule: t.rule.ruleId })));
}
