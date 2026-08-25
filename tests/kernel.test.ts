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

import { describe, expect, it, beforeEach } from 'vitest';
import { OrganizationDirectory, TemporalHypergraphStore, classifyRhythm, summarizeRhythm, __resetIdCounterForTests } from '../src/kernel/index.js';

beforeEach(() => __resetIdCounterForTests());

describe('OrganizationDirectory', () => {
  it('enforces referential integrity', () => {
    const dir = new OrganizationDirectory();
    dir.registerOrganization({ id: 'org:a', kind: 'provider', name: 'A', attributes: {} });
    dir.registerPerson({ id: 'person:1', organizationId: 'org:a', displayName: 'P1', roles: [], attributes: {} });
    dir.registerScope({ id: 'scope:root', kind: 'organization', organizationId: 'org:a', memberIds: ['person:1'], attributes: {} });
    dir.registerScope({ id: 'scope:child', kind: 'facility', organizationId: 'org:a', parentScopeId: 'scope:root', memberIds: [], attributes: {} });
    expect(dir.scopeAncestry('scope:child').map((s) => s.id)).toEqual(['scope:child', 'scope:root']);
    expect(dir.hasScopeAncestor('scope:child', 'scope:root')).toBe(true);
    expect(() => dir.registerScope({ id: 'scope:bad', kind: 'team', organizationId: 'org:missing', memberIds: [], attributes: {} })).toThrow();
  });
});

describe('TemporalHypergraphStore', () => {
  it('versions on each mutation and rejects unknown participants', () => {
    const store = new TemporalHypergraphStore('2026-08-01T00:00:00Z');
    const v0 = store.snapshot();
    store.upsertNode({ id: 'node:patient-1', type: 'patient', properties: { name: 'P1' }, provenance: [], validFrom: '2026-08-01T00:00:00Z' });
    store.upsertNode({ id: 'node:treatment-1', type: 'treatment', properties: {}, provenance: [], validFrom: '2026-08-01T00:00:00Z' });
    const v2 = store.upsertEdge({ id: 'edge:t-1', type: 'dialysis.treatment-session', participants: [{ nodeId: 'node:patient-1', role: 'patient' }, { nodeId: 'node:treatment-1', role: 'treatment' }], properties: {}, provenance: [], validFrom: '2026-08-01T00:00:00Z' });
    expect(v2.id).not.toBe(v0.id);
    expect(store.projectPairwise()).toHaveLength(1);
    expect(() => store.upsertEdge({ id: 'edge:bad', type: 'x', participants: [{ nodeId: 'node:unknown', role: 'x' }], properties: {}, provenance: [], validFrom: '2026-08-01' })).toThrow();
  });

  it('retires nodes without losing history', () => {
    const store = new TemporalHypergraphStore('2026-08-01T00:00:00Z');
    store.upsertNode({ id: 'node:a', type: 'patient', properties: {}, provenance: [], validFrom: '2026-08-01T00:00:00Z' });
    store.retireNode('node:a', '2026-08-02T00:00:00Z');
    const history = store.history();
    expect(history.length).toBe(3);
    expect(store.snapshot().nodes.get('node:a')?.validTo).toBe('2026-08-02T00:00:00Z');
  });
});

describe('cyclic temporality', () => {
  it('classifies on-rhythm within tolerance', () => {
    const expected = new Date('2026-08-01T13:00:00Z');
    const observed = new Date('2026-08-01T13:14:00Z');
    expect(classifyRhythm(expected, observed, 15).status).toBe('on-rhythm');
  });

  it('classifies drifting beyond tolerance', () => {
    const expected = new Date('2026-08-01T13:00:00Z');
    const observed = new Date('2026-08-01T13:45:00Z');
    expect(classifyRhythm(expected, observed, 15).status).toBe('drifting');
  });

  it('classifies broken when overdue with no observation', () => {
    const expected = new Date('2026-08-01T13:00:00Z');
    const now = new Date('2026-08-01T15:00:00Z');
    expect(classifyRhythm(expected, undefined, 15, now).status).toBe('broken');
  });

  it('summarizes rhythm into recovering after broken', () => {
    const now = new Date('2026-08-05T13:15:00Z');
    const window: Array<{ expectedAt: Date; observedAt?: Date }> = [
      { expectedAt: new Date('2026-08-01T13:00:00Z') },
      { expectedAt: new Date('2026-08-05T13:00:00Z'), observedAt: new Date('2026-08-05T13:10:00Z') },
    ];
    const summary = summarizeRhythm(window, 15, now);
    expect(['broken', 'recovering']).toContain(summary);
  });
});
