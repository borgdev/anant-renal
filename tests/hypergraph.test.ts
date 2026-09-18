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

describe('hypergraph write path', () => {
  /**
   * A ledger that counts full replays.
   *
   * `snapshot()` is built on `liveAt()`, so counting it measures exactly what a write
   * used to cost: `assertEdge` called `now()` — one replay allocating two fresh Maps —
   * twice per edge, and the bridge asserts a membership edge plus one edge per
   * relation for every effect in a realm. N writes therefore cost O(N^2) against a
   * ledger that only grows. Measured on the dev server: 33% of CPU in `snapshot`,
   * 14% in `assertEdge`, event loop starved.
   */
  class CountingLedger extends MutationLedger {
    replays = 0;
    override liveAt(validAt: string, asOf: string): ReturnType<MutationLedger['liveAt']> {
      this.replays += 1;
      return super.liveAt(validAt, asOf);
    }
  }

  const WRITE = { validFrom: '2026-05-01', actorRef: 'u', scopeId: 's1' };
  const episodeEdge = (id: string, patient = 'p', facility = 'f') => ({
    id,
    type: 'treatment-episode' as const,
    roles: { patient: [patient], facility: [facility] },
    attributes: { cycleAnchor: 'p' },
  });

  function graphWith(edgeCount: number) {
    const ledger = new CountingLedger();
    const store = new HypergraphStore(buildDialysisSchema(), ledger);
    store.assertNode({ id: 'p', type: 'patient', attributes: { mrn: 'M' } }, WRITE);
    store.assertNode({ id: 'f', type: 'facility', attributes: {} }, WRITE);
    for (let i = 0; i < edgeCount; i++) store.assertEdge(episodeEdge(`e${i}`), WRITE);
    return { store, ledger };
  }

  it('does NOT replay the ledger to assert an edge', () => {
    const { ledger } = graphWith(200);
    expect(ledger.replays).toBe(0);
  });

  it('replays only on the read path — so the counter above is not vacuous', () => {
    const { store, ledger } = graphWith(3);
    expect(ledger.replays).toBe(0);
    const snap = store.now();
    expect(ledger.replays).toBeGreaterThan(0);
    expect(snap.nodes.size).toBe(2);
    expect(snap.edges.size).toBe(3);
  });

  it('still refuses a duplicate live edge id', () => {
    const { store } = graphWith(1);
    expect(() => store.assertEdge(episodeEdge('e0'), WRITE)).toThrow(/already live; use supersede/);
  });

  it('still validates role bindings against node TYPES, not just presence', () => {
    const { store } = graphWith(0);
    // `patient` bound to a facility: present in the index, wrong type.
    expect(() => store.assertEdge(episodeEdge('wrongType', 'f', 'f'), WRITE)).toThrow(/role|type/i);
    // an id that was never asserted at all
    expect(() => store.assertEdge(episodeEdge('ghost', 'ghost', 'f'), WRITE)).toThrow(/role|type/i);
  });

  it('an in-place ledger.retract() UNDOES the entry, so a re-assert revives the node', () => {
    // `ledger.retract()` rewrites the target entry in place, and `asOfTransaction` filters
    // out any entry carrying `retractedAt`. So it does not leave a tombstone — it removes
    // the assertion from history. Re-asserting the id therefore brings the node BACK, in
    // the replay and in the index alike.
    //
    // Measured, not assumed: the first version of this test asserted the opposite and
    // failed. The index had to be made to agree with the code, not with my reading of it.
    const ledger = new CountingLedger();
    const store = new HypergraphStore(buildDialysisSchema(), ledger);
    const patientEntry = store.assertNode({ id: 'p', type: 'patient', attributes: { mrn: 'M' } }, WRITE);
    store.assertNode({ id: 'f', type: 'facility', attributes: {} }, WRITE);
    store.assertEdge(episodeEdge('e0'), WRITE);

    ledger.retract(patientEntry.id, 'u', 'recorded in error');
    expect(store.now().nodes.has('p')).toBe(false);
    expect(() => store.assertEdge(episodeEdge('e1'), WRITE)).toThrow(/role|type/i);

    store.assertNode({ id: 'p', type: 'patient', attributes: { mrn: 'M2' } }, WRITE);
    expect(store.now().nodes.has('p')).toBe(true);
    expect(() => store.assertEdge(episodeEdge('e2'), WRITE)).not.toThrow();
  });

  it('a node.retract() ENTRY does tombstone the id, and the index mirrors that', () => {
    // The other retraction mechanism: an explicit `node.retract` ledger entry. That one
    // DOES leave a tombstone — `snapshot()` keeps a permanent `retracted` set and ignores
    // any later `node.assert` of the same id.
    //
    // Nothing in src/ appends this kind today (`ledger.retract()` is the only retraction
    // in use, and it does not go through `append`), which is exactly why the index's
    // handling of it needs a test rather than a hope: it is unreachable code that a future
    // caller can reach.
    const ledger = new CountingLedger();
    const store = new HypergraphStore(buildDialysisSchema(), ledger);
    store.assertNode({ id: 'p', type: 'patient', attributes: { mrn: 'M' } }, WRITE);
    store.assertNode({ id: 'f', type: 'facility', attributes: {} }, WRITE);
    store.assertEdge(episodeEdge('e0'), WRITE);

    ledger.append({ kind: 'node.retract', nodeId: 'p', validFrom: '2026-05-02', actorRef: 'u', scopeId: 's1' });
    expect(store.now().nodes.has('p')).toBe(false);
    expect(() => store.assertEdge(episodeEdge('e1'), WRITE)).toThrow(/role|type/i);

    // The replay ignores the re-assert, so the index must too — otherwise the write path
    // would accept an edge bound to a node the store never shows.
    store.assertNode({ id: 'p', type: 'patient', attributes: { mrn: 'M2' } }, WRITE);
    expect(store.now().nodes.has('p')).toBe(false);
    expect(() => store.assertEdge(episodeEdge('e2'), WRITE)).toThrow(/role|type/i);
  });

  it('agrees with the replay about a superseded edge id', () => {
    // `snapshot()` keeps a PERMANENT `supersededEdges` shadow set, so re-asserting a
    // superseded id is accepted and then silently ignored by the replay forever. The
    // index mirrors that rather than inventing a stricter rule: if the two disagreed,
    // the write path would accept an edge the store never shows.
    const ledger = new CountingLedger();
    const store = new HypergraphStore(buildDialysisSchema(), ledger);
    store.assertNode({ id: 'p', type: 'patient', attributes: { mrn: 'M' } }, WRITE);
    store.assertNode({ id: 'f', type: 'facility', attributes: {} }, WRITE);
    store.assertEdge(episodeEdge('e0'), WRITE);

    ledger.append({
      kind: 'edge.supersede',
      predecessorEdgeId: 'e0',
      successor: episodeEdge('e1'),
      validFrom: '2026-05-02',
      actorRef: 'u',
      scopeId: 's1',
    });
    expect(store.now().edges.has('e0')).toBe(false);
    expect(store.now().edges.has('e1')).toBe(true);

    // The id is free again, exactly as it is for the replay…
    expect(() => store.assertEdge(episodeEdge('e0'), WRITE)).not.toThrow();
    // …and the re-assertion stays inert in BOTH, which is the parity being pinned.
    expect(store.now().edges.has('e0')).toBe(false);
    expect(() => store.assertEdge(episodeEdge('e0'), WRITE)).not.toThrow();
  });
});
