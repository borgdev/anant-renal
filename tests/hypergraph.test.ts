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

import { describe, expect, it } from 'vitest';
import {
  HypergraphSchema, MutationLedger, HypergraphStore,
  buildEdgeChain, headOfChain, isChainRetracted, chainRoots,
  between, cycleThrough, nodeHistory,
  graphProjection, tableProjection, worklistProjection, timelineProjection,
} from '../src/hypergraph/index.js';

function fixedClock(seq: string[]) {
  let i = 0;
  return () => new Date(seq[i++] ?? seq[seq.length - 1]!);
}

function buildDialysisSchema(): HypergraphSchema {
  const s = new HypergraphSchema();
  s.registerNode({ type: 'patient', attributes: { mrn: { required: true, validate: (v) => typeof v === 'string' } } });
  s.registerNode({ type: 'facility', attributes: {} });
  s.registerNode({ type: 'nephrologist', attributes: {} });
  s.registerNode({ type: 'chair', attributes: {} });
  s.registerEdge({
    type: 'treatment-episode',
    roles: {
      patient: { required: true, nodeTypes: ['patient'] },
      facility: { required: true, nodeTypes: ['facility'] },
      md: { required: false, nodeTypes: ['nephrologist'] },
      chair: { required: false, nodeTypes: ['chair'] },
    },
    attributes: {
      cycleAnchor: { required: true, validate: (v) => typeof v === 'string' },
      assignedTo: { required: false, validate: (v) => typeof v === 'string' },
      dueAt: { required: false, validate: (v) => typeof v === 'string' },
      summary: { required: false, validate: (v) => typeof v === 'string' },
    },
  });
  return s;
}

describe('hypergraph schema', () => {
  it('rejects unknown node types', () => {
    const s = new HypergraphSchema();
    expect(() => s.validateNode({ id: 'n', type: 'nope', attributes: {} })).toThrow(/unknown node type/);
  });
  it('rejects missing required attributes', () => {
    const s = buildDialysisSchema();
    expect(() => s.validateNode({ id: 'p', type: 'patient', attributes: {} })).toThrow(/missing required/);
  });
  it('rejects edge referencing wrong node type', () => {
    const s = buildDialysisSchema();
    const nodeType = new Map<string, string>([['n1', 'facility']]);
    expect(() => s.validateEdge(
      { id: 'e1', type: 'treatment-episode', roles: { patient: ['n1'], facility: ['n1'] }, attributes: { cycleAnchor: 'x' } },
      (id) => nodeType.get(id),
    )).toThrow(/rejects node type/);
  });
});

describe('mutation ledger + store', () => {
  it('produces snapshots at as-of positions', () => {
    const schema = buildDialysisSchema();
    const ledger = new MutationLedger(fixedClock(['2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z', '2026-01-01T00:02:00Z']));
    const store = new HypergraphStore(schema, ledger);
    store.assertNode({ id: 'p1', type: 'patient', attributes: { mrn: 'M1' } }, { validFrom: '2026-01-01', actorRef: 'u', scopeId: 's1' });
    store.assertNode({ id: 'f1', type: 'facility', attributes: {} }, { validFrom: '2026-01-01', actorRef: 'u', scopeId: 's1' });
    store.assertEdge(
      { id: 'te1', type: 'treatment-episode', roles: { patient: ['p1'], facility: ['f1'] }, attributes: { cycleAnchor: 'p1' } },
      { validFrom: '2026-01-01', actorRef: 'u', scopeId: 's1' },
    );
    const snap = store.snapshot({ validAt: '2026-01-05', transactionAt: '2026-01-05' });
    expect(snap.nodes.size).toBe(2);
    expect(snap.edges.size).toBe(1);
  });
  it('honors bitemporal belief cutoff', () => {
    const schema = buildDialysisSchema();
    const ledger = new MutationLedger(fixedClock(['2026-02-01T00:00:00Z']));
    const store = new HypergraphStore(schema, ledger);
    store.assertNode({ id: 'p2', type: 'patient', attributes: { mrn: 'M2' } }, { validFrom: '2026-01-01', actorRef: 'u', scopeId: 's1' });
    // Asking as of a transaction time BEFORE the entry was recorded returns nothing.
    const snap = store.snapshot({ validAt: '2026-01-15', transactionAt: '2026-01-20' });
    expect(snap.nodes.size).toBe(0);
  });
  it('supports edge supersession via chains', () => {
    const schema = buildDialysisSchema();
    const ledger = new MutationLedger(fixedClock(['2026-03-01T00:00:00Z', '2026-03-02T00:00:00Z', '2026-03-03T00:00:00Z', '2026-03-04T00:00:00Z']));
    const store = new HypergraphStore(schema, ledger);
    store.assertNode({ id: 'p3', type: 'patient', attributes: { mrn: 'M3' } }, { validFrom: '2026-03-01', actorRef: 'u', scopeId: 's1' });
    store.assertNode({ id: 'f3', type: 'facility', attributes: {} }, { validFrom: '2026-03-01', actorRef: 'u', scopeId: 's1' });
    store.assertEdge(
      { id: 'te3', type: 'treatment-episode', roles: { patient: ['p3'], facility: ['f3'] }, attributes: { cycleAnchor: 'p3', summary: 'v1' } },
      { validFrom: '2026-03-01', actorRef: 'u', scopeId: 's1' },
    );
    ledger.append({
      kind: 'edge.supersede', predecessorEdgeId: 'te3',
      successor: { id: 'te3-v2', type: 'treatment-episode', roles: { patient: ['p3'], facility: ['f3'] }, attributes: { cycleAnchor: 'p3', summary: 'v2' } },
      validFrom: '2026-03-02', actorRef: 'u', scopeId: 's1',
    });
    const versions = buildEdgeChain(ledger.all(), 'te3');
    expect(versions.length).toBe(2);
    const head = headOfChain(versions, { validAt: '2026-03-05', transactionAt: '2026-03-05' });
    expect(head?.edge.attributes['summary']).toBe('v2');
    expect(isChainRetracted(versions, '2026-03-10')).toBe(false);
    expect(chainRoots(ledger.all())).toContain('te3');
  });
});

describe('cyclic temporal operators', () => {
  it('between + cycleThrough', () => {
    const schema = buildDialysisSchema();
    const ledger = new MutationLedger(fixedClock(['2026-04-01T00:00:00Z', '2026-04-02T00:00:00Z', '2026-04-03T00:00:00Z', '2026-04-04T00:00:00Z']));
    const store = new HypergraphStore(schema, ledger);
    store.assertNode({ id: 'p4', type: 'patient', attributes: { mrn: 'M4' } }, { validFrom: '2026-04-01', actorRef: 'u', scopeId: 's1' });
    store.assertNode({ id: 'f4', type: 'facility', attributes: {} }, { validFrom: '2026-04-01', actorRef: 'u', scopeId: 's1' });
    store.assertEdge(
      { id: 'te4a', type: 'treatment-episode', roles: { patient: ['p4'], facility: ['f4'] }, attributes: { cycleAnchor: 'p4' } },
      { validFrom: '2026-04-01', actorRef: 'u', scopeId: 's1' },
    );
    store.assertEdge(
      { id: 'te4b', type: 'treatment-episode', roles: { patient: ['p4'], facility: ['f4'] }, attributes: { cycleAnchor: 'p4' } },
      { validFrom: '2026-04-03', actorRef: 'u', scopeId: 's1' },
    );
    const window = between(ledger, { from: '2026-04-02', to: '2026-04-04' }, '2026-04-05');
    expect(window.some((e) => e.kind === 'edge.assert' && e.edge.id === 'te4b')).toBe(true);
    const grouped = cycleThrough(ledger, { path: ['cycleAnchor'] }, '2026-04-05');
    expect(grouped.get('p4')?.length).toBeGreaterThanOrEqual(2);
    expect(nodeHistory(ledger, 'p4').length).toBe(1);
  });
});

describe('projections', () => {
  it('all four projections produce sensible output', () => {
    const schema = buildDialysisSchema();
    const ledger = new MutationLedger(fixedClock(['2026-05-01T00:00:00Z', '2026-05-01T00:01:00Z', '2026-05-01T00:02:00Z']));
    const store = new HypergraphStore(schema, ledger);
    store.assertNode({ id: 'p5', type: 'patient', attributes: { mrn: 'M5' } }, { validFrom: '2026-05-01', actorRef: 'u', scopeId: 's1' });
    store.assertNode({ id: 'f5', type: 'facility', attributes: {} }, { validFrom: '2026-05-01', actorRef: 'u', scopeId: 's1' });
    store.assertEdge(
      { id: 'te5', type: 'treatment-episode', roles: { patient: ['p5'], facility: ['f5'] }, attributes: { cycleAnchor: 'p5', assignedTo: 'md-1', dueAt: '2026-05-02', summary: 'Prep chair' } },
      { validFrom: '2026-05-01', actorRef: 'u', scopeId: 's1' },
    );
    const snap = store.now();
    const g = graphProjection(snap);
    expect(g.edges[0]?.participants.length).toBeGreaterThan(0);
    const t = tableProjection(snap, 'treatment-episode');
    expect(t.rows.length).toBe(1);
    expect(t.columns).toContain('role:patient');
    const w = worklistProjection(snap, { edgeTypes: ['treatment-episode'], assignedAttr: 'assignedTo', dueAttr: 'dueAt', summaryAttr: 'summary' });
    expect(w[0]?.assignedTo).toBe('md-1');
    const tl = timelineProjection(ledger.all());
    expect(tl.length).toBe(3);
    expect(tl[0]!.at <= tl[tl.length - 1]!.at).toBe(true);
  });
});
