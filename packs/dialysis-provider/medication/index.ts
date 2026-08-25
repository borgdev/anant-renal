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

// Medication management sub-pack — ESA, iron, phosphate binders, vitamin D,
// antihypertensives. Tracks orders, administration, response, and adverse
// events. Governs the anemia-management protocol tied to the QIP hemoglobin
// measure but keeps the rules attached to policy documents, not hard-coded.

export interface MedicationOrder {
  readonly orderId: string;
  readonly patientId: string;
  readonly rxnormCode: string;
  readonly doseAmount: number;
  readonly doseUnit: 'mcg' | 'mg' | 'units' | 'mL';
  readonly frequency: 'per-treatment' | 'twice-weekly' | 'weekly' | 'monthly' | 'daily' | 'prn';
  readonly startedAt: string;
  readonly discontinuedAt?: string;
  readonly indication: string;
  readonly prescriberRef: string;
}

export interface MedicationAdministration {
  readonly administrationId: string;
  readonly orderId: string;
  readonly administeredAt: string;
  readonly doseAmount: number;
  readonly route: 'IV' | 'SC' | 'PO' | 'ID';
  readonly administeredByRef: string;
  readonly holdReason?: string;
}

export type AnemiaResponseFlag =
  | 'hgb-below-9-not-on-esa'
  | 'hgb-above-11-on-esa'
  | 'esa-dose-escalated-without-response-90d'
  | 'iron-not-checked-quarterly';

export function evaluateAnemia(input: {
  currentHgb: number;
  onESA: boolean;
  esaEscalationsLast90d: number;
  hgbTrendLast90d: readonly number[];
  lastIronPanelAt?: string;
  asOf: string;
}): AnemiaResponseFlag[] {
  const flags: AnemiaResponseFlag[] = [];
  if (!input.onESA && input.currentHgb < 9.0) flags.push('hgb-below-9-not-on-esa');
  if (input.onESA && input.currentHgb > 11.0) flags.push('hgb-above-11-on-esa');
  if (input.onESA && input.esaEscalationsLast90d >= 2) {
    const first = input.hgbTrendLast90d[0];
    const last = input.hgbTrendLast90d[input.hgbTrendLast90d.length - 1];
    if (first !== undefined && last !== undefined && (last - first) < 0.5) {
      flags.push('esa-dose-escalated-without-response-90d');
    }
  }
  if (!input.lastIronPanelAt) {
    flags.push('iron-not-checked-quarterly');
  } else {
    const asOf = Date.parse(input.asOf);
    const last = Date.parse(input.lastIronPanelAt);
    if (Number.isFinite(asOf) && Number.isFinite(last)) {
      const days = (asOf - last) / 86400000;
      if (days > 90) flags.push('iron-not-checked-quarterly');
    }
  }
  return flags;
}
