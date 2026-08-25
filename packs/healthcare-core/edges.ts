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

// packs/healthcare-core/edges.ts — hyperedge schemas for the healthcare domain.
//
// The domain hyperedges from spec.md §3.2. Every edge binds the realm via its
// member nodes (invariant), and role node types are drawn from NODE_TYPES.

import type { EdgeRoleSpec, EdgeSchema } from '../../src/hypergraph/types.js';
import { NODE_TYPES } from './nodes.js';

const role = (nodeTypes: readonly string[], required = true, multi = false): EdgeRoleSpec => ({
  required,
  nodeTypes,
  ...(multi ? { multi: true } : {}),
});

export const HEALTHCARE_EDGE_SCHEMAS: readonly EdgeSchema[] = [
  {
    type: 'realm-membership',
    roles: { realm: role(['realm']), member: role(NODE_TYPES, true, true) },
    attributes: { joinedAt: {}, role: {} },
  },
  {
    type: 'care-team',
    roles: {
      patient: role(['patient']), attending: role(['staff']), nurse: role(['staff'], false, true),
      pharmacist: role(['staff'], false), consulting: role(['staff'], false, true), facility: role(['facility']),
    },
    attributes: { establishedAt: {} },
  },
  {
    type: 'encounter-context',
    roles: {
      encounter: role(['encounter']), patient: role(['patient']), facility: role(['facility']),
      unit: role(['unit'], false), admitting: role(['staff'], false), attending: role(['staff'], false),
    },
    attributes: { startAt: {}, endAt: {} },
  },
  {
    type: 'order-context',
    roles: {
      order: role(['order']), patient: role(['patient']), encounter: role(['encounter']),
      'ordering-provider': role(['staff']), result: role(['result'], false, true), medication: role(['medication'], false),
    },
    attributes: { at: {}, priority: {} },
  },
  {
    type: 'medication-administration',
    roles: { medication: role(['medication']), patient: role(['patient']), 'administering-staff': role(['staff']), equipment: role(['equipment'], false) },
    attributes: { givenAt: {}, dose: {} },
  },
  {
    type: 'chair-assignment',
    roles: { chair: role(['equipment']), patient: role(['patient']), unit: role(['unit']), 'assigning-staff': role(['staff']), 'treatment-encounter': role(['encounter']) },
    attributes: { assignedAt: {}, releasedAt: {} },
  },
  {
    type: 'insurance-coverage',
    roles: { insurance: role(['insurance']), patient: role(['patient']), payer: role(['org-node']), 'plan-artifact': role(['knowledge-artifact'], false) },
    attributes: { effectiveStart: {}, effectiveEnd: {} },
  },
  {
    type: 'prior-auth-thread',
    roles: {
      priorAuth: role(['prior-auth']), patient: role(['patient']), payer: role(['org-node']),
      'service-code-artifact': role(['knowledge-artifact'], false), 'submitter-staff': role(['staff']), 'related-order': role(['order'], false),
    },
    attributes: {},
  },
  {
    type: 'claim-thread',
    roles: {
      claim: role(['claim']), encounter: role(['encounter']), patient: role(['patient']), payer: role(['org-node']),
      'coder-staff': role(['staff'], false), 'resubmitted-from': role(['claim'], false),
    },
    attributes: {},
  },
  {
    type: 'effect-attribution',
    roles: { effect: role(['effect']), presence: role(['presence']), 'agent-run': role(['agent-run']), experience: role(['experience'], false), subject: role(NODE_TYPES, false) },
    attributes: {},
  },
  {
    type: 'hitl-approval-thread',
    roles: {
      approval: role(['approval']), 'pending-effect': role(['effect']), 'requester-presence': role(['presence']),
      'approver-staff': role(['staff']), 'related-work-artifact': role(['work-artifact'], false),
    },
    attributes: {},
  },
  {
    type: 'intent-plan-tree',
    roles: { intent: role(['intent']), plan: role(['plan']), 'owner-staff': role(['staff']), subject: role(NODE_TYPES, false) },
    attributes: {},
  },
  {
    type: 'safety-event-rca',
    roles: {
      'safety-event': role(['safety-event']), patient: role(['patient']), 'reporter-staff': role(['staff']),
      'rca-work-artifact': role(['work-artifact'], false), 'related-medication': role(['medication'], false), 'related-equipment': role(['equipment'], false),
    },
    attributes: {},
  },
  {
    type: 'care-plan-lineage',
    roles: { 'care-plan': role(['care-plan']), patient: role(['patient']), 'author-staff': role(['staff'], false, true), 'derived-from-measure': role(['measure'], false, true) },
    attributes: {},
  },
  {
    type: 'measure-evaluation-provenance',
    roles: {
      evaluation: role(['measure-evaluation']), measure: role(['measure']), library: role(['measure-library'], false, true),
      'value-set': role(['value-set'], false, true), source: role(['knowledge-source'], false, true),
      'patients-evaluated': role(['patient'], false, true), realm: role(['realm']),
    },
    attributes: { evaluatedAt: {}, measurementPeriodStart: {}, measurementPeriodEnd: {} },
  },
  {
    type: 'ambient-delivery',
    roles: {
      nudge: role(['nudge']), 'subject-twin': role(['twin.persona']), 'via-channel': role(['voice-channel'], false),
      'via-equipment': role(['equipment'], false), 'ack-memory-entry': role(['memory-entry'], false),
    },
    attributes: { deliveredAt: {}, ackedAt: {} },
  },
  {
    // Substrate edge: materializes an EntityRecord relation (e.g. `of-order`, `about-patient`)
    // as a typed edge so no relation is ever lost from the graph.
    type: 'derived-reference',
    roles: { from: role(NODE_TYPES, true, true), to: role(NODE_TYPES, true, true) },
    attributes: { relation: {}, realmId: {} },
  },
];
