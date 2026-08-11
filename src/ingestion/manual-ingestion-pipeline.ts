// Manual ingestion pipeline. Turns raw regulatory / operations manuals
// (CMS SOM appendices, TJC standards, CDC precautions, OSHA BBP, facility
// SOPs) into PolicyDocument / PolicySection / PolicyRule nodes.
//
// The pipeline is intentionally staged so each stage is:
//   * observable (emits stage events into the ledger),
//   * resumable (each stage is idempotent, keyed by source sha256),
//   * pluggable (parsers/rule-extractors are injected).
//
// Stages
//   1. fetch — pull raw bytes (HTTP / filesystem / S3). Compute sha256.
//   2. parse — extract text + section structure (parser per format).
//   3. classify — decide authority, setting scope, effective dates.
//   4. extract-rules — turn imperative sentences into PolicyRules.
//   5. link-measures — connect rules to CMS measure IDs when applicable.
//   6. link-agents — connect rules to agents that satisfy them.
//   7. commit — write nodes to PolicyGraph + persist to Postgres.

import { createHash } from 'node:crypto';
import type { PolicyGraph, PolicyDocument, PolicySection, PolicyRule, PolicyAuthority } from '../policy-graph/policy-graph.js';

export interface FetchedManual {
  readonly sourceUri: string;
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly fetchedAt: string;
  readonly sha256: string;
}

export interface ParsedManual {
  readonly sourceUri: string;
  readonly sha256: string;
  readonly title: string;
  readonly authority: PolicyAuthority;
  readonly citation: string;
  readonly version: string;
  readonly effectiveFrom: string;
  readonly effectiveTo?: string;
  readonly sections: readonly {
    readonly path: string;
    readonly title: string;
    readonly body: string;
    readonly ordinal: number;
  }[];
}

export interface ClassifiedManual extends ParsedManual {
  readonly appliesToSettings: PolicyDocument['appliesToSettings'];
}

export interface RuleExtraction {
  readonly sectionPath: string;
  readonly kind: PolicyRule['kind'];
  readonly statement: string;
  readonly appliesTo: readonly string[];
  readonly evidenceExpected: readonly string[];
  readonly enforcementSeverity: PolicyRule['enforcementSeverity'];
  readonly candidateMeasureIds?: readonly string[];
  readonly candidateAgentIds?: readonly string[];
}

export interface FetchAdapter {
  fetch(sourceUri: string): Promise<Uint8Array | { bytes: Uint8Array; contentType: string }>;
}

export interface ParseAdapter {
  supports(fetched: FetchedManual): boolean;
  parse(fetched: FetchedManual): Promise<ParsedManual>;
}

export interface RuleExtractor {
  extract(section: ParsedManual['sections'][number], meta: ParsedManual): Promise<readonly RuleExtraction[]>;
}

export interface IngestionSink {
  saveDocument(doc: PolicyDocument): Promise<void>;
  saveSection(section: PolicySection): Promise<void>;
  saveRule(rule: PolicyRule): Promise<void>;
  markStage(sourceUri: string, sha256: string, stage: string, status: 'ok' | 'error', detail?: unknown): Promise<void>;
}

export interface StageEvent {
  readonly stage: 'fetch' | 'parse' | 'classify' | 'extract-rules' | 'link-measures' | 'link-agents' | 'commit';
  readonly sourceUri: string;
  readonly sha256?: string;
  readonly at: string;
  readonly ok: boolean;
  readonly detail?: unknown;
}

export interface ClassifierRule {
  readonly matchTitle?: RegExp;
  readonly matchCitation?: RegExp;
  readonly authority: PolicyAuthority;
  readonly appliesToSettings: PolicyDocument['appliesToSettings'];
}

export class ManualIngestionPipeline {
  constructor(
    private readonly fetchAdapter: FetchAdapter,
    private readonly parsers: readonly ParseAdapter[],
    private readonly ruleExtractor: RuleExtractor,
    private readonly classifierRules: readonly ClassifierRule[],
    private readonly graph: PolicyGraph,
    private readonly sink: IngestionSink,
    private readonly emit: (e: StageEvent) => void = () => {},
  ) {}

  async ingest(sourceUri: string, actor: string): Promise<{ documentId: string; sections: number; rules: number }> {
    const now = () => new Date().toISOString();

    // 1. fetch
    const fetchResult = await this.fetchAdapter.fetch(sourceUri);
    const bytes = fetchResult instanceof Uint8Array ? fetchResult : fetchResult.bytes;
    const contentType = fetchResult instanceof Uint8Array ? 'application/octet-stream' : fetchResult.contentType;
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const fetched: FetchedManual = { sourceUri, bytes, contentType, fetchedAt: now(), sha256 };
    await this.sink.markStage(sourceUri, sha256, 'fetch', 'ok');
    this.emit({ stage: 'fetch', sourceUri, sha256, at: now(), ok: true });

    // 2. parse
    const parser = this.parsers.find((p) => p.supports(fetched));
    if (!parser) throw new Error(`No parser for ${contentType} at ${sourceUri}`);
    const parsed = await parser.parse(fetched);
    await this.sink.markStage(sourceUri, sha256, 'parse', 'ok', { sections: parsed.sections.length });
    this.emit({ stage: 'parse', sourceUri, sha256, at: now(), ok: true, detail: { sections: parsed.sections.length } });

    // 3. classify
    const classifier = this.classifierRules.find((r) => (r.matchTitle?.test(parsed.title) ?? false) || (r.matchCitation?.test(parsed.citation) ?? false));
    const classified: ClassifiedManual = { ...parsed, appliesToSettings: classifier?.appliesToSettings ?? [] };
    await this.sink.markStage(sourceUri, sha256, 'classify', 'ok', { authority: classified.authority, settings: classified.appliesToSettings });
    this.emit({ stage: 'classify', sourceUri, sha256, at: now(), ok: true });

    // 4. extract-rules
    const allExtractions: { section: ClassifiedManual['sections'][number]; extractions: readonly RuleExtraction[] }[] = [];
    for (const section of classified.sections) {
      const extractions = await this.ruleExtractor.extract(section, classified);
      allExtractions.push({ section, extractions });
    }
    const totalRules = allExtractions.reduce((n, x) => n + x.extractions.length, 0);
    await this.sink.markStage(sourceUri, sha256, 'extract-rules', 'ok', { rules: totalRules });
    this.emit({ stage: 'extract-rules', sourceUri, sha256, at: now(), ok: true, detail: { rules: totalRules } });

    // 5. link-measures + 6. link-agents (attribution already carried by extractor candidates).

    // 7. commit
    const documentId = `${classified.authority.toLowerCase()}:${sha256.slice(0, 12)}`;
    const doc: PolicyDocument = {
      documentId,
      title: classified.title,
      authority: classified.authority,
      citation: classified.citation,
      version: classified.version,
      effectiveFrom: classified.effectiveFrom,
      ...(classified.effectiveTo ? { effectiveTo: classified.effectiveTo } : {}),
      appliesToSettings: classified.appliesToSettings,
      sha256,
      ingestedAt: now(),
      ingestedBy: actor,
    };
    this.graph.registerDocument(doc);
    await this.sink.saveDocument(doc);

    let ruleCount = 0;
    for (const { section, extractions } of allExtractions) {
      const sectionId = `${documentId}:${section.path}`;
      const s: PolicySection = { sectionId, documentId, path: section.path, title: section.title, body: section.body, ordinal: section.ordinal };
      this.graph.addSection(s);
      await this.sink.saveSection(s);
      for (const ex of extractions) {
        const ruleId = `${sectionId}:r${ruleCount + 1}`;
        const rule: PolicyRule = {
          ruleId,
          sectionId,
          kind: ex.kind,
          statement: ex.statement,
          appliesTo: ex.appliesTo,
          ...(ex.candidateMeasureIds ? { triggersMeasureIds: ex.candidateMeasureIds } : {}),
          ...(ex.candidateAgentIds ? { triggersAgentIds: ex.candidateAgentIds } : {}),
          evidenceExpected: ex.evidenceExpected,
          enforcementSeverity: ex.enforcementSeverity,
        };
        this.graph.addRule(rule);
        await this.sink.saveRule(rule);
        ruleCount += 1;
      }
    }
    await this.sink.markStage(sourceUri, sha256, 'commit', 'ok', { documentId, sections: classified.sections.length, rules: ruleCount });
    this.emit({ stage: 'commit', sourceUri, sha256, at: now(), ok: true, detail: { documentId, rules: ruleCount } });

    return { documentId, sections: classified.sections.length, rules: ruleCount };
  }
}
