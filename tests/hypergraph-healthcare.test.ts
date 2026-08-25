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

// Phase 1 — healthcare hypergraph population: schema registration, entity-record
// bridge, and canned queries (spec.md §5).

import { describe, expect, it } from 'vitest';
import {
  buildHealthcareHypergraphSchema, createHealthcareHypergraph,
  HEALTHCARE_NODE_SCHEMAS, HEALTHCARE_EDGE_SCHEMAS, NODE_TYPES,
} from '../packs/healthcare-core/hypergraph.js';
import { EntityGraph } from '../src/realm/entity-graph.js';
import { materializeEntityGraph, effectToHyperNode, effectAttributionEdge } from '../src/realm/entity-record.js';
import {
  countsByType, careTeamFor, encountersForPatient, effectAttributionFor, realmGraph, edgesForNode,
} from '../src/hypergraph/queries/healthcare.js';

describe('healthcare hypergraph schema (Phase 1)', () => {
  it('registers all node + edge types without duplicates, roles reference real types', () => {
    const schema = buildHealthcareHypergraphSchema();
    expect(HEALTHCARE_NODE_SCHEMAS.length).toBeGreaterThanOrEqual(22); // 21 EntityKinds + realm
    expect(HEALTHCARE_EDGE_SCHEMAS.length).toBe(17);
    // duplicate registration throws
    expect(() => schema.registerNode({ type: 'patient', attributes: {} })).toThrow(/already registered/);
    // every edge-role node type is a registered node type
    for (const e of HEALTHCARE_EDGE_SCHEMAS) {
      for (const spec of Object.values(e.roles)) {
        for (const t of spec.nodeTypes) expect(NODE_TYPES).toContain(t);
      }
    }
  });

  it('validates nodes: required realmId enforced', () => {
    const schema = buildHealthcareHypergraphSchema();
    expect(() => schema.validateNode({ id: 'u', type: 'patient', attributes: { realmId: 'realm:r', patientId: 'p1', facilityId: 'f1' } })).not.toThrow();
    expect(() => schema.validateNode({ id: 'u', type: 'patient', attributes: { patientId: 'p1', facilityId: 'f1' } })).toThrow(/realmId/);
  });
});

describe('entity-record bridge', () => {
  it('materializes a realm graph into typed nodes + realm-membership edges', () => {
    const schema = buildHealthcareHypergraphSchema();
    const graph = new EntityGraph('realm:r1');
    graph.create('facility', 'f1', { name: 'Northside', facilityKind: 'dialysis' });
    graph.create('patient', 'p1', { mrn: 'M1', name: 'Jane', age: 45 });
    graph.create('patient', 'p2', { mrn: 'M2', name: 'Bob' });
    const { store, nodeCount, edgeCount } = materializeEntityGraph(graph, schema, { actorRef: 'u', scopeId: 's' });
    expect(nodeCount).toBe(4); // realm root + facility + 2 patients
    expect(edgeCount).toBe(3); // one membership edge per entity
    const snap = store.now();
    expect(countsByType(snap)).toMatchObject({ realm: 1, facility: 1, patient: 2 });
    expect(snap.edges.size).toBe(3);
    // every node validates against its schema
    for (const n of snap.nodes.values()) expect(() => schema.validateNode(n)).not.toThrow();
  });

  it('queries care-team + encounters over a materialized graph', () => {
    const schema = buildHealthcareHypergraphSchema();
    const graph = new EntityGraph('realm:r1');
    graph.create('facility', 'f1', { name: 'N' });
    graph.create('patient', 'p1', { mrn: 'M1' });
    graph.create('staff', 's1', { role: 'md' });
    graph.create('staff', 's2', { role: 'rn' });
    graph.create('encounter', 'e1', { patientId: 'p1', facilityId: 'f1', startAt: 'x', encounterKind: 'inpatient' });
    const { store } = materializeEntityGraph(graph, schema, { actorRef: 'u', scopeId: 's' });
    const at = new Date().toISOString();
    const pId = graph.urnFor('patient', 'p1');
    const fId = graph.urnFor('facility', 'f1');
    const s1Id = graph.urnFor('staff', 's1');
    const s2Id = graph.urnFor('staff', 's2');
    const e1Id = graph.urnFor('encounter', 'e1');
    store.assertEdge({ id: 'ct1', type: 'care-team', roles: { patient: [pId], attending: [s1Id], nurse: [s2Id], facility: [fId] }, attributes: { establishedAt: at } }, { validFrom: at, actorRef: 'u', scopeId: 's' });
    store.assertEdge({ id: 'ec1', type: 'encounter-context', roles: { encounter: [e1Id], patient: [pId], facility: [fId] }, attributes: { startAt: 'x' } }, { validFrom: at, actorRef: 'u', scopeId: 's' });
    const snap = store.now();
    const team = careTeamFor(snap, 'p1');
    expect(team.patient?.id).toBe(pId);
    expect(team.staff.map((s) => s.id)).toEqual(expect.arrayContaining([s1Id, s2Id]));
    const enc = encountersForPatient(snap, 'p1');
    expect(enc.map((n) => n.id)).toContain(e1Id);
    const rg = realmGraph(snap, 'realm:r1');
    expect(rg.nodes.length).toBeGreaterThanOrEqual(6);
    expect(edgesForNode(snap, pId).length).toBe(3); // membership + care-team + encounter-context
  });

  it('projects emitted effects + attribution edges (the write path)', () => {
    const schema = buildHealthcareHypergraphSchema();
    const { store } = createHealthcareHypergraph();
    const at = new Date().toISOString();
    store.assertNode(effectToHyperNode({ effectId: 'fx', presenceId: 'pr1', agentSpecId: 'ag1', realmAt: at, effectKind: 'order-lab', status: 'bound', realmId: 'realm:r1' }), { validFrom: at, actorRef: 'u', scopeId: 's' });
    store.assertNode({ id: 'urn:realm:realm:r1:presence:pr1', type: 'presence', attributes: { realmId: 'realm:r1', presenceId: 'pr1', agentSpecId: 'ag1', role: 'nurse', clearance: 'phi', attention: 'active', spawnedAt: at } }, { validFrom: at, actorRef: 'u', scopeId: 's' });
    store.assertNode({ id: 'urn:realm:realm:r1:agent-run:ag1', type: 'agent-run', attributes: { realmId: 'realm:r1', runId: 'ag1', agentSpecId: 'ag1', startedAt: at, status: 'succeeded' } }, { validFrom: at, actorRef: 'u', scopeId: 's' });
    store.assertEdge(effectAttributionEdge({ effectId: 'fx', presenceId: 'pr1', agentSpecId: 'ag1', realmId: 'realm:r1' }), { validFrom: at, actorRef: 'u', scopeId: 's' });
    const snap = store.now();
    expect(effectAttributionFor(snap, 'fx')?.id).toBe('attr:fx');
  });
});
