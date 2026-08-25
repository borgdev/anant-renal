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

// Canned healthcare queries over a HypergraphSnapshot — back the admin screens
// (spec.md §5.4). Each is a pure function over the snapshot, so they work on
// any store (in-memory materialize, persisted, or future Postgres projection).

import type { HypergraphSnapshot } from '../store.js';
import type { HyperEdge, HyperNode } from '../types.js';

export function nodesByType(snap: HypergraphSnapshot, type: string): HyperNode[] {
  return [...snap.nodes.values()].filter((n) => n.type === type);
}

export function nodeById(snap: HypergraphSnapshot, id: string): HyperNode | undefined {
  return snap.nodes.get(id);
}

export function nodesForRealm(snap: HypergraphSnapshot, realmId: string): HyperNode[] {
  return [...snap.nodes.values()].filter((n) => n.attributes['realmId'] === realmId);
}

export function countsByType(snap: HypergraphSnapshot): Record<string, number> {
  const c: Record<string, number> = {};
  for (const n of snap.nodes.values()) c[n.type] = (c[n.type] ?? 0) + 1;
  return c;
}

export function edgesByType(snap: HypergraphSnapshot, type: string): HyperEdge[] {
  return [...snap.edges.values()].filter((e) => e.type === type);
}

/** Find a patient node by short id (patientId attr, id suffix, or urn). */
export function findPatientNode(snap: HypergraphSnapshot, patientId: string): HyperNode | undefined {
  return [...snap.nodes.values()].find((n) => (
    n.type === 'patient' && (n.attributes['patientId'] === patientId || n.id === patientId || n.id.endsWith(`:${patientId}`))
  ));
}

/** care-team: attending/nurse/pharmacist/consulting for a patient. */
export function careTeamFor(snap: HypergraphSnapshot, patientId: string): { patient: HyperNode | undefined; staff: HyperNode[] } {
  const patient = findPatientNode(snap, patientId);
  const staff = new Map<string, HyperNode>();
  for (const e of snap.edges.values()) {
    if (e.type !== 'care-team') continue;
    const pid = e.roles['patient']?.[0];
    if (!patient || !pid || pid !== patient.id) continue;
    for (const roleName of ['attending', 'nurse', 'pharmacist', 'consulting']) {
      for (const sid of e.roles[roleName] ?? []) {
        const s = snap.nodes.get(sid);
        if (s) staff.set(sid, s);
      }
    }
  }
  return { patient, staff: [...staff.values()] };
}

/** Encounters bound to a patient via encounter-context. */
export function encountersForPatient(snap: HypergraphSnapshot, patientId: string): HyperNode[] {
  const patient = findPatientNode(snap, patientId);
  if (!patient) return [];
  const out: HyperNode[] = [];
  for (const e of snap.edges.values()) {
    if (e.type !== 'encounter-context') continue;
    if ((e.roles['patient']?.[0]) === patient.id) {
      const encId = e.roles['encounter']?.[0];
      if (encId) { const n = snap.nodes.get(encId); if (n) out.push(n); }
    }
  }
  return out;
}

/** The effect-attribution edge for an effect node. */
export function effectAttributionFor(snap: HypergraphSnapshot, effectId: string): HyperEdge | undefined {
  const effect = [...snap.nodes.values()].find((n) => n.type === 'effect' && (n.attributes['effectId'] === effectId || n.id.endsWith(`:${effectId}`)));
  if (!effect) return undefined;
  return [...snap.edges.values()].find((e) => e.type === 'effect-attribution' && (e.roles['effect']?.[0]) === effect.id);
}

/** Subgraph for a realm: its nodes + any edge that binds at least one of them. */
export function realmGraph(snap: HypergraphSnapshot, realmId: string): { nodes: HyperNode[]; edges: HyperEdge[] } {
  const nodes = nodesForRealm(snap, realmId);
  const ids = new Set(nodes.map((n) => n.id));
  const edges = [...snap.edges.values()].filter((e) => Object.values(e.roles).some((idsArr) => idsArr.some((id) => ids.has(id))));
  return { nodes, edges };
}

/** Source fanout — every edge that binds a given node id (spec's many-to-many view). */
export function edgesForNode(snap: HypergraphSnapshot, nodeId: string): HyperEdge[] {
  return [...snap.edges.values()].filter((e) => Object.values(e.roles).some((idsArr) => idsArr.includes(nodeId)));
}
