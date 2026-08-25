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

// EntityRecord → hypergraph bridge (spec.md §5.3).
//
// Projects the realm's loose EntityRecords into typed HyperNodes, and a realm's
// EntityGraph into a HypergraphStore (nodes + realm-membership edges), so the
// typed engine is populated from the world the effects already maintain.

import type { EntityGraph } from './entity-graph.js';
import type { EntityRecord } from './types.js';
import type { HyperNode, HyperEdge } from '../hypergraph/types.js';
import { MutationLedger, HypergraphStore, type HypergraphSchema } from '../hypergraph/index.js';

/** Parse `urn:realm:<realmId>:<kind>:<id>` — realmId itself may contain colons. */
export function realmIdFromUrn(urn: string): string {
  const rest = urn.startsWith('urn:realm:') ? urn.slice('urn:realm:'.length) : urn;
  const parts = rest.split(':');
  const realmParts = parts.slice(0, -2); // last two = kind + id
  return realmParts.length > 0 ? realmParts.join(':') : (parts[0] ?? 'unknown');
}

/** EntityKind → its id attribute in the hypergraph node schema. */
const KIND_ID_ATTR: Record<string, string> = {
  facility: 'facilityId', unit: 'unitId', patient: 'patientId', encounter: 'encounterId',
  order: 'orderId', result: 'resultId', medication: 'medOrderId', staff: 'staffId',
  equipment: 'equipmentId', insurance: 'insuranceId', 'agent-run': 'runId', presence: 'presenceId',
  effect: 'effectId', 'org-node': 'orgNodeId', 'physical-object': 'objectId',
  'work-artifact': 'artifactId', intent: 'intentId', plan: 'planId', approval: 'approvalId',
  'cost-record': 'costRecordId', 'operator-directive': 'directiveId',
  condition: 'conditionId', allergy: 'allergyId', procedure: 'procedureId',
  immunization: 'immunizationId', 'diagnostic-report': 'reportId', 'medication-admin': 'adminId',
  'questionnaire-response': 'responseId', 'document-reference': 'documentId', communication: 'communicationId',
  appointment: 'appointmentId', schedule: 'scheduleId', slot: 'slotId',
  'explanation-of-benefit': 'eobId', invoice: 'invoiceId', account: 'accountId',
  'claim-response': 'claimResponseId', 'care-team': 'careTeamId', goal: 'goalId',
  subscription: 'subscriptionId', questionnaire: 'questionnaireId', consent: 'consentId',
  'adverse-event': 'adverseEventId', 'medication-statement': 'medStatementId', 'medication-dispense': 'medDispenseId',
  'imaging-study': 'studyId', specimen: 'specimenId', 'detected-issue': 'detectedIssueId',
  'payment-reconciliation': 'reconciliationId', composition: 'compositionId',
  'vision-prescription': 'visionRxId', 'device-use': 'deviceUseId', 'nutrition-order': 'nutritionOrderId',
  'supply-delivery': 'supplyDeliveryId', 'healthcare-service': 'serviceId', endpoint: 'endpointId',
  'org-affiliation': 'affiliationId', substance: 'substanceId',
};

/** Project an EntityRecord into a HyperNode (kind → type, urn → id, state → attributes). */
export function entityRecordToHyperNode(rec: EntityRecord): HyperNode {
  const idAttr = KIND_ID_ATTR[rec.kind];
  return {
    id: rec.urn,
    type: rec.kind,
    attributes: {
      ...rec.state,
      realmId: realmIdFromUrn(rec.urn),
      kind: rec.kind,
      id: rec.id,
      ...(idAttr ? { [idAttr]: rec.id } : {}),
    },
  };
}

export interface MaterializeResult {
  store: HypergraphStore;
  nodeCount: number;
  edgeCount: number;
}

export interface BridgeOpts {
  actorRef: string;
  scopeId: string;
}

/**
 * Build a fresh hypergraph store from a realm's entity graph: one `realm` node,
 * one HyperNode per EntityRecord, and a `realm-membership` edge per member.
 * Fresh store per call → assert-once, no duplicate ledger entries.
 */
export function materializeEntityGraph(graph: EntityGraph, schema: HypergraphSchema, opts: BridgeOpts): MaterializeResult {
  const store = new HypergraphStore(schema, new MutationLedger());
  const at = new Date().toISOString();
  const realmId = realmIdFromUrn(graph.urnFor('facility', 'x')); // derive realm id from a urn prefix
  // Realm root node.
  store.assertNode({ id: realmId, type: 'realm', attributes: { realmId } }, { validFrom: at, actorRef: opts.actorRef, scopeId: opts.scopeId, reason: 'realm-root' });
  let nodeCount = 1;
  let edgeCount = 0;
  for (const rec of graph.snapshot().entities) {
    store.assertNode(entityRecordToHyperNode(rec), { validFrom: at, actorRef: opts.actorRef, scopeId: opts.scopeId, reason: 'realm-sync' });
    nodeCount += 1;
    store.assertEdge(
      { id: `membership:${realmId}:${rec.urn}`, type: 'realm-membership', roles: { realm: [realmId], member: [rec.urn] }, attributes: { joinedAt: at, role: rec.kind } },
      { validFrom: at, actorRef: opts.actorRef, scopeId: opts.scopeId, reason: 'realm-sync' },
    );
    edgeCount += 1;
  }
  return { store, nodeCount, edgeCount };
}

/** Build a HyperNode for an emitted effect (the write-path projection). */
export function effectToHyperNode(input: {
  effectId: string;
  presenceId: string;
  agentSpecId: string;
  realmAt: string;
  effectKind: string;
  status: string;
  realmId: string;
}): HyperNode {
  return {
    id: `urn:realm:${input.realmId}:effect:${input.effectId}`,
    type: 'effect',
    attributes: {
      realmId: input.realmId,
      effectId: input.effectId,
      presenceId: input.presenceId,
      agentSpecId: input.agentSpecId,
      emittedAt: input.realmAt,
      realmAt: input.realmAt,
      effectKind: input.effectKind,
      status: input.status,
    },
  };
}

/** The effect-attribution hyperedge for an emitted effect (actor + subject). */
export function effectAttributionEdge(input: {
  effectId: string;
  presenceId: string;
  agentSpecId: string;
  realmId: string;
  /** Agent-run id the presence ran under; defaults to agentSpecId for cold-path materialization. */
  agentRunId?: string;
  subjectUrn?: string;
}): HyperEdge {
  const runId = input.agentRunId ?? input.agentSpecId;
  return {
    id: `attr:${input.effectId}`,
    type: 'effect-attribution',
    roles: {
      effect: [`urn:realm:${input.realmId}:effect:${input.effectId}`],
      presence: [`urn:realm:${input.realmId}:presence:${input.presenceId}`],
      'agent-run': [`urn:realm:${input.realmId}:agent-run:${runId}`],
      ...(input.subjectUrn ? { subject: [input.subjectUrn] } : {}),
    },
    attributes: {},
  };
}
