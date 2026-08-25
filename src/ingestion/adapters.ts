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

// Batteries-included adapters for the ingestion pipeline. Each is small,
// deterministic, and swappable in production. The plain-text parser handles
// pre-normalised CMS SOM appendices, TJC standards, CDC precaution pages.
// Real PDFs go through an upstream OCR step that emits the same shape.

import { readFile, stat } from 'node:fs/promises';
import type { FetchAdapter, FetchedManual, ParseAdapter, ParsedManual, RuleExtractor, RuleExtraction, IngestionSink } from './manual-ingestion-pipeline.js';
import type { PolicyDocument, PolicySection, PolicyRule } from '../policy-graph/policy-graph.js';

/** Fetch from local filesystem (used by tests and by the file-drop ingestor). */
export class FilesystemFetchAdapter implements FetchAdapter {
  async fetch(sourceUri: string): Promise<{ bytes: Uint8Array; contentType: string }> {
    const path = sourceUri.replace(/^file:\/\//, '');
    await stat(path);
    const bytes = await readFile(path);
    const contentType = path.endsWith('.txt') ? 'text/plain' : path.endsWith('.json') ? 'application/json' : 'application/octet-stream';
    return { bytes: new Uint8Array(bytes), contentType };
  }
}

/**
 * Parses a policy manual serialised as JSON with the shape
 * `{ title, authority, citation, version, effectiveFrom, effectiveTo?, sections: [...] }`.
 * This is the canonical intake format — PDFs / DOCX / HTML upstream get
 * normalised into this JSON envelope, so parsers stay swappable.
 */
export class JsonPolicyParser implements ParseAdapter {
  supports(f: FetchedManual): boolean { return f.contentType.startsWith('application/json'); }
  async parse(f: FetchedManual): Promise<ParsedManual> {
    const text = new TextDecoder().decode(f.bytes);
    const obj = JSON.parse(text) as Omit<ParsedManual, 'sourceUri' | 'sha256'>;
    return { ...obj, sourceUri: f.sourceUri, sha256: f.sha256 };
  }
}

/**
 * Heuristic rule extractor. Splits the section body on sentence boundaries
 * and classifies each sentence:
 *   * `must` / `must-not` — imperative verbs, "shall", "must", "is required to"
 *   * `should`            — "should", "is recommended"
 *   * `may`               — "may", "as permitted"
 *   * `documentation`     — sentences that reference records, logs, forms
 *   * `training`          — sentences that reference training, competency
 *   * `reporting`         — sentences that reference reporting to CMS/CDC/state
 *   * `measure`           — sentences that reference numerators, denominators
 * Real deployments swap in an LLM extractor; the interface is unchanged.
 */
export class HeuristicRuleExtractor implements RuleExtractor {
  async extract(section: ParsedManual['sections'][number]): Promise<readonly RuleExtraction[]> {
    const sentences = section.body
      .split(/(?<=[.!?])\s+(?=[A-Z])/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    const out: RuleExtraction[] = [];
    for (const sentence of sentences) {
      const lower = sentence.toLowerCase();
      let kind: RuleExtraction['kind'] = 'may';
      let severity: RuleExtraction['enforcementSeverity'] = 'advisory';

      if (/(shall not|must not|may not|is prohibited)/.test(lower)) { kind = 'must-not'; severity = 'condition-level'; }
      else if (/(shall|must|is required to|are required to)/.test(lower)) { kind = 'must'; severity = 'condition-level'; }
      else if (/(should|is recommended|recommends?)/.test(lower)) { kind = 'should'; severity = 'standard-level'; }
      else if (/\bmay\b/.test(lower)) { kind = 'may'; severity = 'advisory'; }

      if (/(document(ed|ation)?|record|log|form|entry)/.test(lower) && kind === 'may') kind = 'documentation';
      if (/(train(ed|ing)|competency|orientation|in-service)/.test(lower) && kind === 'may') kind = 'training';
      if (/(report|reporting|submit(ted)?|notify|notification)/.test(lower) && (lower.includes('cms') || lower.includes('cdc') || lower.includes('state') || lower.includes('nhsn'))) kind = 'reporting';
      if (/(numerator|denominator|measure|rate|ratio)/.test(lower)) kind = 'measure';

      out.push({
        sectionPath: section.path,
        kind,
        statement: sentence,
        appliesTo: [],
        evidenceExpected: kind === 'documentation' ? ['artifact:log', 'artifact:record'] : kind === 'training' ? ['training-log'] : kind === 'reporting' ? ['audit-log:submission'] : [],
        enforcementSeverity: severity,
      });
    }
    return out;
  }
}

/** In-memory sink — useful for tests, dry-runs, and previews. */
export class InMemoryIngestionSink implements IngestionSink {
  readonly documents: PolicyDocument[] = [];
  readonly sections: PolicySection[] = [];
  readonly rules: PolicyRule[] = [];
  readonly stageEvents: { sourceUri: string; sha256: string; stage: string; status: string; detail?: unknown }[] = [];

  async saveDocument(d: PolicyDocument): Promise<void> { this.documents.push(d); }
  async saveSection(s: PolicySection): Promise<void> { this.sections.push(s); }
  async saveRule(r: PolicyRule): Promise<void> { this.rules.push(r); }
  async markStage(sourceUri: string, sha256: string, stage: string, status: 'ok' | 'error', detail?: unknown): Promise<void> {
    this.stageEvents.push({ sourceUri, sha256, stage, status, ...(detail !== undefined ? { detail } : {}) });
  }
}
