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

// M15/M16/M17/M18 — module tests.
import { describe, it, expect, beforeEach } from 'vitest';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { validateAgentSpec } from '../src/agents/spec.js';
import {
  createOrgWithFacilities,
  parseFacilitiesCsv,
  ONBOARDING_TEMPLATES,
  findTemplate,
  startWizard,
  saveWizard,
  completeWizard,
  getWizard,
} from '../src/onboarding/bootstrap.js';
import {
  IdentityRegistry,
  Scim,
  createInvite,
  claimInvite,
  revokeInvite,
  activateBreakGlass,
  endBreakGlass,
  reviewBreakGlass,
  pendingReviews,
  setInviteSecret,
} from '../src/identity/index.js';
import { SelfServeAdmin } from '../src/self-serve/admin.js';
import { Federation } from '../src/realm/federation.js';
import { RealmRegistry } from '../src/realm/registry.js';

beforeEach(() => {
  IdentityRegistry.reset();
  Scim.resetForTests();
  setInviteSecret('test-secret-please-rotate');
  // Clean up any prior realms + orgs for isolation
  for (const r of [...RealmRegistry.list()]) RealmRegistry.remove(r.id);
  for (const o of Federation.listOrgs()) Federation.removeOrg(o.orgId);
});

// ============================================================
// M15 — Vertical pack YAML validation
// ============================================================
describe('M15 · Vertical packs', () => {
  const VERTICAL_PACKS = [
    'behavioral-health', 'oncology-deep', 'home-health', 'long-term-care',
    'radiology', 'ed-throughput', 'revenue-cycle', 'hospital-at-home',
  ];
  const EXPECTED_MIN = { 'behavioral-health': 30, 'oncology-deep': 40, 'home-health': 35, 'long-term-care': 35, 'radiology': 20, 'ed-throughput': 25, 'revenue-cycle': 30, 'hospital-at-home': 25 };

  it('all 8 vertical packs exist with expected agent counts', () => {
    const packsRoot = join(process.cwd(), 'packs');
    for (const pack of VERTICAL_PACKS) {
      const agentsDir = join(packsRoot, pack, 'agents');
      expect(existsSync(agentsDir), `${pack}/agents/ missing`).toBe(true);
      const count = readdirSync(agentsDir).filter((f) => f.endsWith('.yaml')).length;
      expect(count).toBeGreaterThanOrEqual(EXPECTED_MIN[pack as keyof typeof EXPECTED_MIN]);
    }
  });

  it('every vertical-pack agent YAML validates against AgentSpec schema', () => {
    const packsRoot = join(process.cwd(), 'packs');
    let total = 0;
    for (const pack of VERTICAL_PACKS) {
      const agentsDir = join(packsRoot, pack, 'agents');
      for (const file of readdirSync(agentsDir)) {
        if (!file.endsWith('.yaml')) continue;
        const doc = parseYaml(readFileSync(join(agentsDir, file), 'utf8'));
        expect(() => validateAgentSpec(doc)).not.toThrow();
        total++;
      }
    }
    expect(total).toBeGreaterThanOrEqual(240);
  });

  it('sample HITL-gated agents include a real hitlGate object', () => {
    const path = join(process.cwd(), 'packs/behavioral-health/agents/suicidality-columbia-screen.yaml');
    const doc = parseYaml(readFileSync(path, 'utf8')) as { governance: { hitlGates: Array<{ afterStepId: string; role: string; slaMinutes: number }> } };
    expect(doc.governance.hitlGates.length).toBeGreaterThan(0);
    expect(doc.governance.hitlGates[0]!.role).toBeTruthy();
    expect(doc.governance.hitlGates[0]!.slaMinutes).toBeGreaterThan(0);
  });
});

// ============================================================
// M16 — Onboarding
// ============================================================
describe('M16 · Onboarding bootstrap', () => {
  it('creates an org + facility realms idempotently', () => {
    const first = createOrgWithFacilities({
      orgId: 'org-a', displayName: 'Test Org A', sampleData: true,
      facilities: [{ facilityId: 'f1', kind: 'dialysis', name: 'Site 1', units: ['A', 'B'], patientCount: 5 }],
    });
    expect(first.createdOrg).toBe(true);
    expect(first.realms).toHaveLength(1);
    expect(first.totalPatients).toBe(5);
    // Re-run with same input → no duplicates
    const second = createOrgWithFacilities({
      orgId: 'org-a', displayName: 'Test Org A', sampleData: false,
      facilities: [{ facilityId: 'f1', kind: 'dialysis', name: 'Site 1', units: ['A', 'B'], patientCount: 5 }],
    });
    expect(second.createdOrg).toBe(false);
    expect(second.realms[0]!.created).toBe(false);
    expect(Federation.getOrg('org-a')!.realmIds).toEqual(['org-a-f1']);
  });

  it('all named templates produce valid bootstrap results', () => {
    expect(ONBOARDING_TEMPLATES.length).toBeGreaterThanOrEqual(4);
    for (const t of ONBOARDING_TEMPLATES) {
      const tmpl = t.build(`org-${t.id}`, `Org for ${t.id}`);
      const result = createOrgWithFacilities(tmpl);
      expect(result.totalFacilities).toBe(tmpl.facilities.length);
      expect(result.totalPatients).toBeGreaterThan(0);
    }
    expect(findTemplate('independent-dialysis-clinic')).toBeDefined();
  });

  it('parses CSV facility rows into specs', () => {
    const csv = `facility_id,kind,name,units,patient_count
uc-north,urgent-care,North Clinic,ROOM-1;ROOM-2,10
uc-south,urgent-care,South Clinic,ROOM-1;ROOM-2;ROOM-3,15`;
    const facilities = parseFacilitiesCsv(csv);
    expect(facilities).toHaveLength(2);
    expect(facilities[0]!.units).toEqual(['ROOM-1', 'ROOM-2']);
    expect(facilities[1]!.patientCount).toBe(15);
  });

  it('CSV parser rejects unknown facility kinds', () => {
    expect(() => parseFacilitiesCsv(`facility_id,kind,name,units\nx,spaceship,X,ROOM-1`)).toThrow(/invalid kind/);
  });

  it('wizard save-and-resume then complete produces the same result as direct API', () => {
    const w = startWizard();
    w.orgId = 'org-wiz';
    w.displayName = 'Wizard Org';
    w.facilities = [{ facilityId: 'f1', kind: 'primary-care', name: 'Wiz Clinic', units: ['GEN'], patientCount: 8 }];
    w.sampleData = true;
    w.currentStep = 'review';
    saveWizard(w);
    // Simulate reload
    const reloaded = getWizard(w.wizardId);
    expect(reloaded).toBeDefined();
    const result = completeWizard(w.wizardId);
    expect(result.totalFacilities).toBe(1);
    expect(result.totalPatients).toBe(8);
    expect(getWizard(w.wizardId)!.currentStep).toBe('complete');
  });
});

// ============================================================
// M17 — Identity
// ============================================================
describe('M17 · Identity', () => {
  it('role mapper resolves IdP groups to role/clearance/purpose', () => {
    IdentityRegistry.setMapping({
      orgId: 'org-x',
      defaultRole: 'nurse',
      entries: [
        { idpGroup: 'okta-admins', role: 'admin', clearance: 'phi', purposeOfUse: ['operations', 'quality'] },
        { idpGroup: 'okta-doctors', role: 'md', clearance: 'phi', purposeOfUse: ['treatment'] },
      ],
    });
    const admin = IdentityRegistry.resolveRole('org-x', ['okta-admins']);
    expect(admin.role).toBe('admin');
    expect(admin.purposeOfUse).toContain('quality');
    const unmapped = IdentityRegistry.resolveRole('org-x', ['random-group']);
    expect(unmapped.role).toBe('nurse');
  });

  it('magic-link invite flow: create → claim → principal exists; revoke blocks claim', () => {
    const { token } = createInvite({
      orgId: 'org-inv', email: 'nurse@example.com', role: 'nurse',
      clearance: 'phi', purposeOfUse: ['treatment', 'operations'],
    });
    const principal = claimInvite(token, { displayName: 'Nurse Nightingale' });
    expect(principal.email).toBe('nurse@example.com');
    expect(principal.source).toBe('invite');
    expect(principal.clearance).toBe('phi');
    expect(IdentityRegistry.getPrincipal(principal.subjectId)).toBeDefined();
    // Second claim of same token: idempotent — returns existing principal
    const again = claimInvite(token, { displayName: 'Nurse N' });
    expect(again.subjectId).toBe(principal.subjectId);
    // Revoke a new invite → claim throws
    const { invId, token: t2 } = createInvite({ orgId: 'org-inv', email: 'md@example.com', role: 'md' });
    expect(revokeInvite(invId)).toBe(true);
    expect(() => claimInvite(t2)).toThrow(/revoked/);
  });

  it('signature tampering rejects the invite token', () => {
    const { token } = createInvite({ orgId: 'org-t', email: 'x@y.com', role: 'nurse' });
    const [json, mac] = token.split('.');
    const tampered = `${json}.${mac?.slice(0, -2)}ff`;
    expect(() => claimInvite(tampered)).toThrow(/signature-invalid/);
  });

  it('SCIM: create user, patch to deactivate → principal deprovisioned', () => {
    // Set org role mapping so SCIM users get proper role
    IdentityRegistry.setMapping({
      orgId: 'org-scim', defaultRole: 'nurse',
      entries: [{ idpGroup: 'clinicians', role: 'nurse', clearance: 'phi', purposeOfUse: ['treatment'] }],
    });
    const user = Scim.createUser('org-scim', {
      userName: 'jane@ex.com',
      emails: [{ value: 'jane@ex.com', primary: true }],
      name: { givenName: 'Jane', familyName: 'Doe' },
      groups: [{ value: 'clinicians', display: 'clinicians' }],
      active: true,
    });
    expect(IdentityRegistry.getPrincipal(user.id)?.role).toBe('nurse');
    // Deactivate via PATCH — auto-deprovision
    Scim.patchUser('org-scim', user.id, [{ op: 'replace', path: 'active', value: false }]);
    expect(IdentityRegistry.getPrincipal(user.id)).toBeUndefined();
  });

  it('SCIM: group membership updates re-resolve the user role', () => {
    IdentityRegistry.setMapping({
      orgId: 'org-scim2', defaultRole: 'nurse',
      entries: [
        { idpGroup: 'md-group', role: 'md', clearance: 'phi', purposeOfUse: ['treatment'] },
      ],
    });
    const u = Scim.createUser('org-scim2', {
      userName: 'joe@ex.com',
      emails: [{ value: 'joe@ex.com', primary: true }],
      active: true,
    });
    expect(IdentityRegistry.getPrincipal(u.id)?.role).toBe('nurse');
    // Create group with the user as member
    Scim.createGroup('org-scim2', {
      displayName: 'md-group',
      members: [{ value: u.id, display: 'joe@ex.com' }],
    });
    expect(IdentityRegistry.getPrincipal(u.id)?.role).toBe('md');
  });

  it('break-glass activates elevated clearance and creates audit + pending review', () => {
    // Bootstrap a principal
    const { token } = createInvite({ orgId: 'org-bg', email: 'md@ex.com', role: 'md' });
    const md = claimInvite(token);
    // Activate
    const { session } = activateBreakGlass({ subjectId: md.subjectId, reason: 'Cardiac arrest, must access external records.' });
    expect(session.reviewed).toBe(false);
    const upgraded = IdentityRegistry.getPrincipal(md.subjectId)!;
    expect(upgraded.clearance).toBe('break-glass');
    expect(upgraded.purposeOfUse).toContain('treatment');
    // Reason too short — reject
    expect(() => activateBreakGlass({ subjectId: md.subjectId, reason: 'x' })).toThrow(/reason-too-short/);
    // Pending review shows it
    expect(pendingReviews().some((s) => s.sessionId === session.sessionId)).toBe(true);
    // End + review
    expect(endBreakGlass(md.subjectId)).toBe(true);
    expect(reviewBreakGlass(session.sessionId, 'auditor-1', 'Justified, real emergency.', true)).toBe(true);
    expect(pendingReviews().some((s) => s.sessionId === session.sessionId)).toBe(false);
    // Audit includes activation + end + review
    const audit = IdentityRegistry.listAudit();
    const kinds = audit.map((a) => a.kind);
    expect(kinds).toContain('break-glass.activated');
    expect(kinds).toContain('break-glass.ended');
    expect(kinds).toContain('break-glass.reviewed.approved');
  });
});

// ============================================================
// M18 — Self-serve admin
// ============================================================
describe('M18 · Self-serve admin', () => {
  it('non-admin cannot mutate; admin can', () => {
    // Create nurse via invite
    const { token: nurseToken } = createInvite({ orgId: 'org-ss', email: 'nurse@ex.com', role: 'nurse' });
    const nurse = claimInvite(nurseToken);
    expect(() => SelfServeAdmin.setPackToggles({ realmId: 'r1', enabledPacks: ['flagship-agents'], disabledAgents: [] }, nurse.subjectId)).toThrow(/not-admin/);
    // Create admin via invite
    const { token: adminToken } = createInvite({ orgId: 'org-ss', email: 'admin@ex.com', role: 'admin' });
    const admin = claimInvite(adminToken);
    const rec = SelfServeAdmin.setPackToggles({ realmId: 'r1', enabledPacks: ['flagship-agents', 'oncology-deep'], disabledAgents: [] }, admin.subjectId);
    expect(rec.updatedBy).toBe(admin.subjectId);
    expect(SelfServeAdmin.getPackToggles('r1')?.enabledPacks).toContain('oncology-deep');
  });

  it('meter override, custom effect, HITL gate, branding all round-trip', () => {
    const { token } = createInvite({ orgId: 'org-ss2', email: 'admin@ex.com', role: 'admin' });
    const admin = claimInvite(token);
    SelfServeAdmin.addMeterOverride({ realmId: 'r1', unit: 'llm.tokens.input', priceUsdPerUnit: 0.00001, budgetCapMonthlyUsd: 500 }, admin.subjectId);
    expect(SelfServeAdmin.listMeterOverrides('r1')).toHaveLength(1);
    SelfServeAdmin.registerCustomEffect({ realmId: 'r1', kind: 'notify-pharmacy', schema: { patientId: 'string' }, purpose: 'treatment', hitlRequired: false }, admin.subjectId);
    expect(SelfServeAdmin.listCustomEffects('r1')[0]!.kind).toBe('notify-pharmacy');
    const gate = SelfServeAdmin.addHitlGate({ realmId: 'r1', agentSelector: 'oncology-*', afterStepId: 'step-3', role: 'md', slaMinutes: 120 }, admin.subjectId);
    expect(SelfServeAdmin.listHitlGates('r1')).toHaveLength(1);
    expect(SelfServeAdmin.removeHitlGate('r1', gate.gateId, admin.subjectId)).toBe(true);
    SelfServeAdmin.setBranding({ realmId: 'r1', logoUrl: 'https://cdn.ex.com/logo.svg', primaryColor: '#03A9F4', brandName: 'FooHealth' }, admin.subjectId);
    expect(SelfServeAdmin.getBranding('r1')?.brandName).toBe('FooHealth');
  });
});
