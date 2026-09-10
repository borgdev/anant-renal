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

// P6 — the shared infection INPUT CONTRACT.
//
// This module exists so the two halves of P6 can share one window type without a
// module cycle: the TRIAGE half (infection.ts, statistical) and the PREVENTION
// half (infection-prevention.ts, deterministic rules) both read it, and the
// prevention half never imports anything that can produce a prediction.

export interface ImmunisationRecord {
  vaccine: string;
  seriesDose: number;
  seriesTotal?: number | undefined;
  at?: string | undefined;
}

export interface InfectionInput {
  patientId: string;
  /** current temperature (°C) — the latest temporal/pre-dialysis reading */
  temperatureC?: number | undefined;
  /** serial temperatures (°C), oldest → newest */
  temperatureSeries?: readonly number[] | undefined;
  procalcitoninNgMl?: number | undefined;
  neutrophilPct?: number | undefined;
  lymphocytePct?: number | undefined;
  /** or supply the ratio directly */
  nlr?: number | undefined;
  wbc?: number | undefined;
  crp?: number | undefined;
  albumin?: number | undefined;
  heartRate?: number | undefined;
  systolicBp?: number | undefined;
  accessType?: 'avf' | 'avg' | 'catheter' | undefined;
  catheterDays?: number | undefined;
  accessAgeDays?: number | undefined;
  matureAvfAvailable?: boolean | undefined;
  accessInfectionSigns?: boolean | undefined;
  /** systemic symptoms (rigors, hypotension, confusion, …) */
  symptoms?: readonly string[] | undefined;
  hospitalisedLast30d?: boolean | undefined;
  dialysisVintageYears?: number | undefined;
  /** culture result: 1 = organism grown, 0 = no growth */
  cultureResult?: number | undefined;
  cultureAt?: string | undefined;
  /** immunisation records — read by the PREVENTION half only */
  immunisations?: readonly ImmunisationRecord[] | undefined;
  hepatitisBSurfaceAntibodyIuL?: number | undefined;
  serologyAt?: string | undefined;
  lastHandHygieneAuditAt?: string | undefined;
  lastAccessCareAuditAt?: string | undefined;
  asOf?: string | undefined;
}
