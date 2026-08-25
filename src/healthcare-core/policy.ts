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

// Policy documents are the executable metadata layer. A regulation, an
// operator SOP, or a CMS Condition for Coverage enters the harness as a
// PolicyDocument with a hash and provenance, and gets decomposed into
// RuleCandidates that packs and workflows can consume.

export type DocumentAuthority = 'CMS' | 'CDC' | 'FDA' | 'payer' | 'provider-org' | 'facility' | 'professional-society';

export interface PolicyDocument {
  id: string;
  title: string;
  authority: DocumentAuthority;
  scopeId: string;
  sourceUri: string;
  contentHash: string;
  effectiveFrom?: string;
  effectiveTo?: string;
  classification: 'public' | 'internal' | 'confidential' | 'phi';
}

export interface RuleCandidate {
  id: string;
  documentId: string;
  excerpt: string;
  statement: string;
  authority: DocumentAuthority;
  status: 'proposed' | 'approved' | 'rejected' | 'superseded';
  approvedBy?: string;
  approvedAt?: string;
}

export class PolicyLibrary {
  private readonly documents = new Map<string, PolicyDocument>();
  private readonly rules = new Map<string, RuleCandidate>();

  registerDocument(doc: PolicyDocument): void {
    if (this.documents.has(doc.id)) throw new Error(`Policy document already registered: ${doc.id}`);
    this.documents.set(doc.id, Object.freeze({ ...doc }));
  }

  registerRule(rule: RuleCandidate): void {
    if (!this.documents.has(rule.documentId)) {
      throw new Error(`Rule ${rule.id} references unknown document ${rule.documentId}`);
    }
    if (this.rules.has(rule.id)) throw new Error(`Rule already registered: ${rule.id}`);
    this.rules.set(rule.id, Object.freeze({ ...rule }));
  }

  approveRule(id: string, approvedBy: string, approvedAt: string): RuleCandidate {
    const existing = this.rules.get(id);
    if (!existing) throw new Error(`Unknown rule: ${id}`);
    const next: RuleCandidate = Object.freeze({ ...existing, status: 'approved', approvedBy, approvedAt });
    this.rules.set(id, next);
    return next;
  }

  approvedRules(): RuleCandidate[] {
    return [...this.rules.values()].filter((r) => r.status === 'approved');
  }

  document(id: string): PolicyDocument {
    const d = this.documents.get(id);
    if (!d) throw new Error(`Unknown document: ${id}`);
    return d;
  }
}
