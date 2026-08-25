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

// Medication reconciliation.
//
// Compares three sources of truth — prior-to-admission (PTA / home meds),
// inpatient / current-orders, and discharge / next-setting — to produce a
// reconciled list with change annotations and clinician-facing rationale.
// The result feeds back into the longitudinal record and satisfies the
// Joint Commission NPSG.03.06.01 medication reconciliation standard.

export type MedSource = 'home' | 'inpatient' | 'discharge' | 'reconciled';
export type MedChangeType = 'continued' | 'new' | 'held' | 'discontinued' | 'modified';

export interface MedEntry {
  readonly rxnorm: string;              // RxNorm SCD/SBD id
  readonly display: string;
  readonly dose?: string;
  readonly route?: string;
  readonly frequency?: string;
  readonly indication?: string;
  readonly source: MedSource;
  readonly startedAt?: string;
  readonly stoppedAt?: string;
  readonly prescriberRef?: string;
  readonly high: boolean;               // BEERS / ISMP high-alert flag
}

export interface MedReconciliationInput {
  readonly patientId: string;
  readonly encounterId: string;
  readonly homeList: readonly MedEntry[];
  readonly currentList: readonly MedEntry[];
  readonly targetSource: 'inpatient' | 'discharge';
}

export interface MedChange {
  readonly rxnorm: string;
  readonly display: string;
  readonly changeType: MedChangeType;
  readonly rationale?: string;
  readonly requiresClinicianReview: boolean;
  readonly ismpHighAlert: boolean;
}

export interface MedReconciliationResult {
  readonly patientId: string;
  readonly encounterId: string;
  readonly targetSource: 'inpatient' | 'discharge';
  readonly reconciledList: readonly MedEntry[];
  readonly changes: readonly MedChange[];
  readonly flags: readonly string[];
  readonly summaryForPatient: string;
  readonly summaryForClinician: string;
}

// Very simple ISMP high-alert class check (real impl loads full ISMP list).
const HIGH_ALERT_CLASSES: readonly string[] = ['insulin', 'warfarin', 'heparin', 'opioid', 'chemotherapy', 'apixaban', 'rivaroxaban'];
function isHighAlert(display: string): boolean {
  const d = display.toLowerCase();
  return HIGH_ALERT_CLASSES.some((c) => d.includes(c));
}

export function reconcileMedications(input: MedReconciliationInput): MedReconciliationResult {
  const homeByCode = new Map(input.homeList.map((m) => [m.rxnorm, m]));
  const currentByCode = new Map(input.currentList.map((m) => [m.rxnorm, m]));
  const reconciled: MedEntry[] = [];
  const changes: MedChange[] = [];
  const flags: string[] = [];

  for (const home of input.homeList) {
    const current = currentByCode.get(home.rxnorm);
    if (!current) {
      changes.push({ rxnorm: home.rxnorm, display: home.display, changeType: 'held', rationale: 'Not on current order set', requiresClinicianReview: true, ismpHighAlert: isHighAlert(home.display) });
      if (isHighAlert(home.display)) flags.push(`high-alert-med-held:${home.display}`);
    } else if (current.dose !== home.dose || current.frequency !== home.frequency || current.route !== home.route) {
      changes.push({ rxnorm: home.rxnorm, display: home.display, changeType: 'modified', rationale: `home=${home.dose ?? ''} ${home.frequency ?? ''} → current=${current.dose ?? ''} ${current.frequency ?? ''}`, requiresClinicianReview: true, ismpHighAlert: isHighAlert(home.display) });
      reconciled.push({ ...current, source: 'reconciled', high: isHighAlert(current.display) });
    } else {
      changes.push({ rxnorm: home.rxnorm, display: home.display, changeType: 'continued', requiresClinicianReview: false, ismpHighAlert: isHighAlert(home.display) });
      reconciled.push({ ...current, source: 'reconciled', high: isHighAlert(current.display) });
    }
  }
  for (const current of input.currentList) {
    if (!homeByCode.has(current.rxnorm)) {
      changes.push({ rxnorm: current.rxnorm, display: current.display, changeType: 'new', rationale: 'Not in home list', requiresClinicianReview: isHighAlert(current.display), ismpHighAlert: isHighAlert(current.display) });
      reconciled.push({ ...current, source: 'reconciled', high: isHighAlert(current.display) });
      if (isHighAlert(current.display)) flags.push(`high-alert-new:${current.display}`);
    }
  }
  const patientLines = reconciled.map((m) => `• ${m.display} — ${m.dose ?? ''} ${m.frequency ?? ''}`).join('\n');
  const clinicianLines = changes.map((c) => `[${c.changeType.toUpperCase()}] ${c.display}${c.rationale ? ' — ' + c.rationale : ''}${c.ismpHighAlert ? ' ⚠ HIGH-ALERT' : ''}`).join('\n');
  return {
    patientId: input.patientId,
    encounterId: input.encounterId,
    targetSource: input.targetSource,
    reconciledList: reconciled,
    changes,
    flags,
    summaryForPatient: `Your medications for the next setting of care:\n${patientLines}`,
    summaryForClinician: `Reconciliation summary (${input.targetSource}):\n${clinicianLines}`,
  };
}
