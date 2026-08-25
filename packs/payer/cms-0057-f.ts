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

// CMS-0057-F metadata (Advancing Interoperability and Improving Prior
// Authorization Processes). The rule imposes FHIR APIs + timeliness on
// impacted payers starting January 1, 2027. This module carries the metadata
// the harness needs to prove compliance and generate reports.

export interface CMS0057FCompliance {
  readonly planId: string;
  readonly impactedPayerType: 'medicare-advantage' | 'medicaid' | 'chip' | 'medicaid-managed' | 'chip-managed' | 'qhp-fed-marketplace';
  readonly patientAccessApi: { readonly baseUrl: string; readonly implementationGuide: string; readonly conformanceValidatedAt: string };
  readonly providerAccessApi: { readonly baseUrl: string; readonly implementationGuide: string; readonly conformanceValidatedAt: string };
  readonly payerToPayerApi: { readonly baseUrl: string; readonly implementationGuide: string; readonly conformanceValidatedAt: string };
  readonly priorAuthApi: {
    readonly baseUrl: string;
    readonly implementationGuide: string; // Da Vinci PAS / CRD / DTR
    readonly conformanceValidatedAt: string;
    readonly standardDecisionMaxHours: 168; // 7 days
    readonly expeditedDecisionMaxHours: 72;
    readonly reportingMetrics: readonly [
      'auth-approved-count',
      'auth-denied-count',
      'auth-average-time-hours',
      'auth-appeal-overturn-rate',
    ];
  };
  readonly effectiveFrom: '2027-01-01';
}

export const cmsO57FImplementationGuides = {
  patientAccess: 'HL7 FHIR US Core + CARIN Blue Button',
  providerAccess: 'Da Vinci PDex Payer Data Exchange',
  payerToPayer: 'Da Vinci PDex Payer-to-Payer',
  priorAuth: 'Da Vinci PAS + CRD + DTR',
} as const;
