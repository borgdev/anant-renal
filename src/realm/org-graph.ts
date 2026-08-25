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

// M12 — Organizational graph
//
// Models the org hierarchy as first-class entities with typed edges:
//   department -> team -> role
//   role -> role via 'reports-to', 'covers-for', 'escalates-to', 'approves-for'
//
// The org-graph is a pack: declare nodes and edges once, and agents can traverse
// them at runtime (e.g. to compute the escalation target for a given role).

import type { EntityGraph } from './entity-graph.js';

export type OrgNodeKind = 'department' | 'team' | 'role';

export interface OrgNodeSpec {
  id: string;
  nodeKind: OrgNodeKind;
  name: string;
  parentId?: string; // reports-to for role, contained-by for team/department
}

export type OrgEdgeKind = 'reports-to' | 'covers-for' | 'escalates-to' | 'approves-for' | 'contains';

export interface OrgEdgeSpec {
  fromRoleId: string;
  toRoleId: string;
  edgeKind: OrgEdgeKind;
  note?: string;
}

export interface OrgPack {
  packId: string;
  name: string;
  nodes: OrgNodeSpec[];
  edges: OrgEdgeSpec[];
}

/** Load an org pack into the entity graph as first-class entities + relations. */
export function loadOrgPack(g: EntityGraph, pack: OrgPack): void {
  for (const n of pack.nodes) {
    g.create('org-node', n.id, {
      nodeKind: n.nodeKind,
      name: n.name,
      parentId: n.parentId ?? null,
      packId: pack.packId,
    });
  }
  // Wire parent containment as an edge (child -> parent as 'contained-by')
  for (const n of pack.nodes) {
    if (n.parentId) {
      const childUrn = g.urnFor('org-node', n.id);
      const parentUrn = g.urnFor('org-node', n.parentId);
      g.addRelation(childUrn, 'contained-by', parentUrn);
    }
  }
  for (const e of pack.edges) {
    const fromUrn = g.urnFor('org-node', e.fromRoleId);
    const toUrn = g.urnFor('org-node', e.toRoleId);
    g.addRelation(fromUrn, e.edgeKind, toUrn);
  }
}

export class OrgGraphQuery {
  constructor(private g: EntityGraph) {}

  /** Find the escalation target for a role id, walking 'escalates-to' then 'reports-to' as fallback. */
  escalationTargetFor(roleId: string): string | undefined {
    const urn = this.g.urnFor('org-node', roleId);
    const esc = this.g.related(urn, 'escalates-to');
    if (esc.length > 0 && esc[0]) return this.g.get(esc[0])?.id;
    const rep = this.g.related(urn, 'reports-to');
    if (rep.length > 0 && rep[0]) return this.g.get(rep[0])?.id;
    return undefined;
  }

  /** Who approves for a given role. */
  approverFor(roleId: string): string | undefined {
    const urn = this.g.urnFor('org-node', roleId);
    const app = this.g.related(urn, 'approves-for-inv'); // reverse edge (someone approves-for me)
    if (app.length > 0 && app[0]) return this.g.get(app[0])?.id;
    // fallback: escalation target
    return this.escalationTargetFor(roleId);
  }

  /** Full team/department containment path for a role id. */
  containmentPath(roleId: string): string[] {
    const path: string[] = [];
    let currentId: string | undefined = roleId;
    let hops = 0;
    while (currentId && hops < 20) {
      path.push(currentId);
      const rec = this.g.get(this.g.urnFor('org-node', currentId)) as { state?: { parentId?: string } } | undefined;
      const parentId: string | undefined = rec?.state?.parentId;
      if (!parentId) break;
      currentId = parentId;
      hops++;
    }
    return path;
  }
}

/** Default org pack for a dialysis clinic — realistic, small, complete. */
export const DIALYSIS_CLINIC_ORG_PACK: OrgPack = {
  packId: 'org.dialysis-clinic.v1',
  name: 'Dialysis Clinic — Standard Org',
  nodes: [
    // Departments
    { id: 'dept.clinical', nodeKind: 'department', name: 'Clinical' },
    { id: 'dept.operations', nodeKind: 'department', name: 'Operations' },
    { id: 'dept.revenue-cycle', nodeKind: 'department', name: 'Revenue Cycle' },
    { id: 'dept.it', nodeKind: 'department', name: 'IT' },
    // Teams
    { id: 'team.floor-nursing', nodeKind: 'team', name: 'Floor Nursing', parentId: 'dept.clinical' },
    { id: 'team.medical', nodeKind: 'team', name: 'Medical Staff', parentId: 'dept.clinical' },
    { id: 'team.pharmacy', nodeKind: 'team', name: 'Pharmacy', parentId: 'dept.clinical' },
    { id: 'team.safety', nodeKind: 'team', name: 'Safety Monitors', parentId: 'dept.clinical' },
    { id: 'team.facilities', nodeKind: 'team', name: 'Facilities', parentId: 'dept.operations' },
    { id: 'team.billing', nodeKind: 'team', name: 'Billing', parentId: 'dept.revenue-cycle' },
    { id: 'team.coding', nodeKind: 'team', name: 'Coding', parentId: 'dept.revenue-cycle' },
    { id: 'team.helpdesk', nodeKind: 'team', name: 'Helpdesk', parentId: 'dept.it' },
    // Roles
    { id: 'role.nurse', nodeKind: 'role', name: 'Floor Nurse', parentId: 'team.floor-nursing' },
    { id: 'role.charge-nurse', nodeKind: 'role', name: 'Charge Nurse', parentId: 'team.floor-nursing' },
    { id: 'role.md', nodeKind: 'role', name: 'Attending Physician', parentId: 'team.medical' },
    { id: 'role.pa', nodeKind: 'role', name: 'Physician Assistant', parentId: 'team.medical' },
    { id: 'role.pharmacist', nodeKind: 'role', name: 'Pharmacist', parentId: 'team.pharmacy' },
    { id: 'role.safety-monitor', nodeKind: 'role', name: 'Safety Monitor', parentId: 'team.safety' },
    { id: 'role.tech', nodeKind: 'role', name: 'PCT', parentId: 'team.floor-nursing' },
    { id: 'role.facilities-tech', nodeKind: 'role', name: 'Facilities Tech', parentId: 'team.facilities' },
    { id: 'role.coder', nodeKind: 'role', name: 'Medical Coder', parentId: 'team.coding' },
    { id: 'role.billing-specialist', nodeKind: 'role', name: 'Billing Specialist', parentId: 'team.billing' },
    { id: 'role.helpdesk-l1', nodeKind: 'role', name: 'IT Helpdesk L1', parentId: 'team.helpdesk' },
    { id: 'role.helpdesk-l2', nodeKind: 'role', name: 'IT Helpdesk L2', parentId: 'team.helpdesk' },
    { id: 'role.admin', nodeKind: 'role', name: 'Facility Administrator', parentId: 'dept.operations' },
    { id: 'role.auditor', nodeKind: 'role', name: 'Compliance Auditor', parentId: 'dept.operations' },
  ],
  edges: [
    // reports-to
    { fromRoleId: 'role.nurse', toRoleId: 'role.charge-nurse', edgeKind: 'reports-to' },
    { fromRoleId: 'role.tech', toRoleId: 'role.charge-nurse', edgeKind: 'reports-to' },
    { fromRoleId: 'role.charge-nurse', toRoleId: 'role.admin', edgeKind: 'reports-to' },
    { fromRoleId: 'role.pa', toRoleId: 'role.md', edgeKind: 'reports-to' },
    { fromRoleId: 'role.md', toRoleId: 'role.admin', edgeKind: 'reports-to' },
    { fromRoleId: 'role.helpdesk-l1', toRoleId: 'role.helpdesk-l2', edgeKind: 'reports-to' },
    // escalates-to (fast-path)
    { fromRoleId: 'role.nurse', toRoleId: 'role.charge-nurse', edgeKind: 'escalates-to' },
    { fromRoleId: 'role.safety-monitor', toRoleId: 'role.md', edgeKind: 'escalates-to' },
    { fromRoleId: 'role.pharmacist', toRoleId: 'role.md', edgeKind: 'escalates-to' },
    { fromRoleId: 'role.charge-nurse', toRoleId: 'role.md', edgeKind: 'escalates-to' },
    { fromRoleId: 'role.helpdesk-l1', toRoleId: 'role.helpdesk-l2', edgeKind: 'escalates-to' },
    // approves-for
    { fromRoleId: 'role.md', toRoleId: 'role.pa', edgeKind: 'approves-for' },
    { fromRoleId: 'role.admin', toRoleId: 'role.charge-nurse', edgeKind: 'approves-for' },
    { fromRoleId: 'role.auditor', toRoleId: 'role.admin', edgeKind: 'approves-for' },
  ],
};
