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

// packs/healthcare-core/hypergraph.ts — assemble + validate the healthcare schema.
//
// This is the population plan from spec.md §5.1–5.2 made concrete: registering the
// node + edge schemas against HypergraphSchema so the typed engine is no longer
// test-only. `createHealthcareHypergraph()` gives a ready store for a realm.

import { HypergraphSchema, MutationLedger, HypergraphStore } from '../../src/hypergraph/index.js';
import { HEALTHCARE_NODE_SCHEMAS, NODE_TYPES } from './nodes.js';
import { HEALTHCARE_EDGE_SCHEMAS } from './edges.js';

export { NODE_TYPES, HEALTHCARE_NODE_SCHEMAS, HEALTHCARE_EDGE_SCHEMAS };

/** Register every healthcare node + edge schema. Throws SchemaError on duplicates. */
export function buildHealthcareHypergraphSchema(): HypergraphSchema {
  const schema = new HypergraphSchema();
  for (const n of HEALTHCARE_NODE_SCHEMAS) schema.registerNode(n);
  for (const e of HEALTHCARE_EDGE_SCHEMAS) schema.registerEdge(e);
  return schema;
}

/** A ready-to-use healthcare hypergraph (schema + ledger + store). */
export function createHealthcareHypergraph(): { schema: HypergraphSchema; store: HypergraphStore } {
  const schema = buildHealthcareHypergraphSchema();
  const store = new HypergraphStore(schema, new MutationLedger());
  return { schema, store };
}
