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

/* The FHIR adapter that used to live here (`fhir-lite.ts`) was retired in F0.6.
 * It mapped only `Encounter` and `Observation` into the same canonical-event
 * vocabulary as the `treatment.*` producers, while `src/fhir/` hydrates every
 * mapped resource type into a live realm. Two FHIR ingest paths with different
 * fidelity is a drift bug waiting to happen, and the -lite one had no production
 * caller — only its own test. `src/fhir/` is now the single FHIR path. */
export * from './hl7v2-lite.js';
export * from './csv.js';
export * from './x12.js';
export * from './cda-lite.js';
export * from './hie.js';
export * from './sql.js';
export * from './event-stream.js';
export * from './sftp.js';
export * from './claims-file.js';
