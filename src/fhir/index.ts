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

// FHIR module (Phase 2) — typed R4 model + entity registry + ingest/export bridges.
//
// F0/F1 added the EMR connection layer: vendor profiles, auth providers,
// capability discovery/negotiation, an error discipline, and a hardened client.

export * from './types.js';
export * from './fhir-bundle.js';
export * from './effect-map.js';
export * from './mapping.js';
export * from './canonical.js';
export * from './export.js';
export * from './client.js';
export * from './subscription.js';
export * from './cds-hooks.js';
export * from './routes.js';
export * from './vendor-profile.js';
export * from './capability.js';
export * from './http.js';
export * from './metadata.js';
export * from './auth.js';

// `operation-outcome.ts` declares its own `OperationOutcome`-shaped types, which
// would collide with the ones in `types.js` under a star export. Re-export the
// behaviour explicitly instead, so the barrel stays unambiguous.
export {
  operationOutcome,
  operationOutcomeFrom,
  httpStatusForIssue,
  FhirOperationError,
  isFhirOperationError,
  errorToFhirReply,
  issuesFromBody,
  summarizeOutcome,
} from './operation-outcome.js';
export type { IssueCode, IssueSeverity } from './operation-outcome.js';
