// PolicyGraph — turns operations manuals + regulatory policies into
// structured, queryable, versioned nodes that agents can bind to.
//
// A PolicyDocument is any source manual (CMS Interpretive Guidelines, TJC
// Standards, CDC Isolation Precautions, OSHA BBP, facility SOP). Each doc
// is decomposed into PolicySection -> PolicyRule -> PolicyEvidence. Rules
// reference measures, coding-system codes, workflow steps, and can be
// consumed by agents ("what does the SOM Appendix H say about IV
// medications in ESRD?") or by compliance surveys.

export type PolicyAuthority =
  | 'CMS'              // Centers for Medicare & Medicaid Services
  | 'CDC'              // Centers for Disease Control
  | 'OSHA'             // Occupational Safety and Health Administration
  | 'FDA'              // Food & Drug Administration
  | 'TJC'              // The Joint Commission
  | 'DNV'              // DNV Healthcare
  | 'CIHQ'             // Center for Improvement in Healthcare Quality
  | 'AAAHC'            // Accreditation Association for Ambulatory Health Care
  | 'CARF'             // Rehab accreditation
  | 'HRSA'             // Health Resources & Services Administration
  | 'HHS-OCR'          // HHS Office for Civil Rights (HIPAA)
  | 'ONC'              // Office of the National Coordinator
  | 'STATE'            // State health department / DOH
  | 'FACILITY'         // Facility-authored policy
  | 'ORG'              // Organization-wide policy
  | 'PROFESSIONAL';    // Specialty society guideline (AMA, ANA, ASN, etc.)

export interface PolicyDocument {
  readonly documentId: string;
  readonly title: string;
  readonly authority: PolicyAuthority;
  readonly citation: string;           // e.g. "42 CFR 494.60"
  readonly url?: string;
  readonly effectiveFrom: string;
  readonly effectiveTo?: string;
  readonly version: string;
  readonly appliesToSettings: readonly ('primary-care' | 'urgent-care' | 'specialty' | 'ed' | 'inpatient' | 'dialysis' | 'home-health' | 'hospice' | 'ltc' | 'pharmacy' | 'transplant-center' | 'health-plan' | 'lab' | 'imaging' | 'clinical-research')[];
  readonly sha256?: string;
  readonly ingestedAt?: string;
  readonly ingestedBy?: string;
}

export interface PolicySection {
  readonly sectionId: string;
  readonly documentId: string;
  readonly path: string;               // e.g. "V-A-1" or "Standard PC.02.03.01"
  readonly title: string;
  readonly body: string;
  readonly ordinal: number;
}

export interface PolicyRule {
  readonly ruleId: string;
  readonly sectionId: string;
  readonly kind: 'must' | 'must-not' | 'should' | 'may' | 'measure' | 'documentation' | 'training' | 'reporting';
  readonly statement: string;
  readonly appliesTo: readonly string[];        // roles, patient states, service types
  readonly triggersMeasureIds?: readonly string[];
  readonly triggersAgentIds?: readonly string[];
  readonly evidenceExpected: readonly string[]; // artifact tags
  readonly enforcementSeverity: 'condition-level' | 'standard-level' | 'immediate-jeopardy' | 'advisory';
}

export interface PolicyEvidence {
  readonly evidenceId: string;
  readonly ruleId: string;
  readonly evidenceType: 'artifact' | 'observation' | 'record' | 'training-log' | 'audit-log' | 'signed-attestation';
  readonly whereFound: string;                   // system reference / URI
  readonly capturedAt: string;
  readonly actorRef: string;
}

export class PolicyGraph {
  private readonly docs = new Map<string, PolicyDocument>();
  private readonly sectionsByDoc = new Map<string, PolicySection[]>();
  private readonly rulesBySection = new Map<string, PolicyRule[]>();
  private readonly evidenceByRule = new Map<string, PolicyEvidence[]>();

  registerDocument(d: PolicyDocument): void { this.docs.set(d.documentId, d); }
  addSection(s: PolicySection): void {
    const arr = this.sectionsByDoc.get(s.documentId) ?? [];
    arr.push(s);
    this.sectionsByDoc.set(s.documentId, arr);
  }
  addRule(r: PolicyRule): void {
    const arr = this.rulesBySection.get(r.sectionId) ?? [];
    arr.push(r);
    this.rulesBySection.set(r.sectionId, arr);
  }
  attachEvidence(e: PolicyEvidence): void {
    const arr = this.evidenceByRule.get(e.ruleId) ?? [];
    arr.push(e);
    this.evidenceByRule.set(e.ruleId, arr);
  }

  getDocument(id: string): PolicyDocument | undefined { return this.docs.get(id); }
  listDocuments(): readonly PolicyDocument[] { return [...this.docs.values()]; }
  sectionsFor(docId: string): readonly PolicySection[] { return this.sectionsByDoc.get(docId) ?? []; }
  rulesFor(sectionId: string): readonly PolicyRule[] { return this.rulesBySection.get(sectionId) ?? []; }
  evidenceFor(ruleId: string): readonly PolicyEvidence[] { return this.evidenceByRule.get(ruleId) ?? []; }

  /** All rules across all docs matching a filter — used by agents and audits. */
  queryRules(filter: { authority?: PolicyAuthority; setting?: PolicyDocument['appliesToSettings'][number]; kind?: PolicyRule['kind']; measureId?: string }): readonly (PolicyRule & { documentId: string; sectionPath: string })[] {
    const out: (PolicyRule & { documentId: string; sectionPath: string })[] = [];
    for (const doc of this.docs.values()) {
      if (filter.authority && doc.authority !== filter.authority) continue;
      if (filter.setting && !doc.appliesToSettings.includes(filter.setting)) continue;
      for (const s of this.sectionsFor(doc.documentId)) {
        for (const r of this.rulesFor(s.sectionId)) {
          if (filter.kind && r.kind !== filter.kind) continue;
          if (filter.measureId && !r.triggersMeasureIds?.includes(filter.measureId)) continue;
          out.push({ ...r, documentId: doc.documentId, sectionPath: s.path });
        }
      }
    }
    return out;
  }

  countDocuments(): number { return this.docs.size; }
  countRules(): number {
    let total = 0;
    for (const arr of this.rulesBySection.values()) total += arr.length;
    return total;
  }
}
