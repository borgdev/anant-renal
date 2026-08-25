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

import type { OrganizationId, PersonId, ScopeId } from '../kernel/ids.js';
import type { ScopeKind, OrganizationDirectory } from '../kernel/organization.js';

// Zero-trust access: every request is evaluated against RBAC grants AND ABAC
// rules AND environment conditions. The default answer is `deny`. No implicit
// trust based on network position, session age, or role membership alone.

export type AccessAction = 'read' | 'write' | 'export' | 'execute' | 'publish' | 'approve' | 'admin';
export type AccessDecision = 'allow' | 'deny' | 'step-up-required';
export type Classification = 'public' | 'internal' | 'confidential' | 'phi' | 'restricted-phi';

export interface AccessSubject {
  id: PersonId | OrganizationId;
  organizationId: OrganizationId;
  roles: readonly string[];
  attributes: Readonly<Record<string, unknown>>;
}

export interface AccessResource {
  id: string;
  type: string;
  scopeId: ScopeId;
  scopeKind: ScopeKind;
  ownerOrganizationId: OrganizationId;
  classification: Classification;
  attributes: Readonly<Record<string, unknown>>;
}

export interface AccessEnvironment {
  purposeOfUse: string;
  managedDevice: boolean;
  sessionAgeMinutes: number;
  mfaAgeMinutes: number;
  emergency?: boolean;
  now: string;
}

export interface AccessRequest {
  subject: AccessSubject;
  resource: AccessResource;
  action: AccessAction;
  environment: AccessEnvironment;
}

export interface AbacRule {
  id: string;
  effect: AccessDecision;
  reason: string;
  matches(request: AccessRequest, ctx: { directory: OrganizationDirectory }): boolean;
}

export interface RoleGrant {
  role: string;
  actions: readonly AccessAction[];
  resourceTypes: readonly string[];
}

export interface AccessEvaluation {
  decision: AccessDecision;
  reasons: string[];
  matchedRules: string[];
  policyVersion: string;
}

const CLASSIFICATION_RANK: Record<Classification, number> = {
  'public': 0,
  'internal': 1,
  'confidential': 2,
  'phi': 3,
  'restricted-phi': 4,
};

export class AccessEvaluator {
  constructor(
    private readonly directory: OrganizationDirectory,
    private readonly grants: readonly RoleGrant[],
    private readonly rules: readonly AbacRule[],
    private readonly policyVersion: string = 'policy:0.1.0',
  ) {}

  evaluate(request: AccessRequest): AccessEvaluation {
    const reasons: string[] = [];
    const matchedRules: string[] = [];
    const rank = CLASSIFICATION_RANK[request.resource.classification];

    // Zero-trust environmental floors — apply BEFORE role grants so a missing
    // MFA on PHI never leaks through a permissive role.
    if (rank >= CLASSIFICATION_RANK.phi && !request.environment.managedDevice) {
      return {
        decision: 'deny',
        reasons: ['PHI requires a managed device'],
        matchedRules: ['env.managed-device-required'],
        policyVersion: this.policyVersion,
      };
    }
    if (rank >= CLASSIFICATION_RANK.phi && request.environment.mfaAgeMinutes > 60 && !request.environment.emergency) {
      return {
        decision: 'step-up-required',
        reasons: ['MFA older than 60 minutes for PHI access'],
        matchedRules: ['env.mfa-freshness'],
        policyVersion: this.policyVersion,
      };
    }
    if (rank >= CLASSIFICATION_RANK['restricted-phi'] && request.action === 'export' && !request.environment.emergency) {
      return {
        decision: 'step-up-required',
        reasons: ['Restricted-PHI export requires explicit approval'],
        matchedRules: ['env.restricted-phi-export'],
        policyVersion: this.policyVersion,
      };
    }

    // Scope containment — subject must belong to a scope that contains (or
    // equals) the resource's scope, unless the subject is at the organization
    // level and owns the resource organization.
    if (!this.subjectCoversResourceScope(request)) {
      return {
        decision: 'deny',
        reasons: [`Subject scope does not cover resource scope ${request.resource.scopeId}`],
        matchedRules: ['env.scope-containment'],
        policyVersion: this.policyVersion,
      };
    }

    const granted = request.subject.roles.some((role) =>
      this.grants.some((g) => g.role === role && g.actions.includes(request.action) && g.resourceTypes.includes(request.resource.type)),
    );
    if (!granted) {
      return {
        decision: 'deny',
        reasons: ['No RBAC grant for role/action/resource combination'],
        matchedRules: ['rbac.no-grant'],
        policyVersion: this.policyVersion,
      };
    }

    // ABAC layer: deny wins, step-up second, allow accumulates reasons.
    const rules = this.rules.filter((rule) => rule.matches(request, { directory: this.directory }));
    for (const rule of rules) {
      matchedRules.push(rule.id);
      reasons.push(rule.reason);
    }
    const denial = rules.find((r) => r.effect === 'deny');
    if (denial) {
      return { decision: 'deny', reasons: [denial.reason], matchedRules: [denial.id], policyVersion: this.policyVersion };
    }
    const stepUp = rules.find((r) => r.effect === 'step-up-required');
    if (stepUp) {
      return { decision: 'step-up-required', reasons: [stepUp.reason], matchedRules: [stepUp.id], policyVersion: this.policyVersion };
    }

    return { decision: 'allow', reasons, matchedRules, policyVersion: this.policyVersion };
  }

  private subjectCoversResourceScope(request: AccessRequest): boolean {
    // Organization-level subjects cover any scope they own.
    if (request.subject.id.startsWith('org:')) {
      return request.resource.ownerOrganizationId === request.subject.organizationId;
    }
    // Person subjects: check they belong to a scope that is or contains the resource scope.
    const scope = safe(() => this.directory.scope(request.resource.scopeId));
    if (!scope) return false;
    if (scope.organizationId !== request.subject.organizationId) return false;
    // A person is "in" a scope if they are listed as a member of that scope
    // or any of its ancestors.
    const chain = this.directory.scopeAncestry(request.resource.scopeId);
    return chain.some((s) => s.memberIds.includes(request.subject.id as PersonId));
  }
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
