import { describe, expect, it } from 'vitest';
import {
  ManualIngestionPipeline,
  FilesystemFetchAdapter,
  JsonPolicyParser,
  HeuristicRuleExtractor,
  InMemoryIngestionSink,
} from '../src/ingestion/index.js';
import { PolicyGraph } from '../src/policy-graph/index.js';
import { STARTER_POLICY_FILES } from '../packs/policy-templates/index.js';

describe('Manual ingestion pipeline (M3)', () => {
  it('ingests all four starter policy documents end-to-end', async () => {
    const graph = new PolicyGraph();
    const sink = new InMemoryIngestionSink();
    const pipeline = new ManualIngestionPipeline(
      new FilesystemFetchAdapter(),
      [new JsonPolicyParser()],
      new HeuristicRuleExtractor(),
      [
        { matchCitation: /42 CFR 494/, authority: 'CMS', appliesToSettings: ['dialysis'] },
        { matchCitation: /CDC/, authority: 'CDC', appliesToSettings: ['primary-care', 'urgent-care', 'inpatient', 'dialysis', 'home-health', 'hospice', 'ltc'] },
        { matchCitation: /1910\.1030/, authority: 'OSHA', appliesToSettings: ['primary-care', 'urgent-care', 'inpatient', 'dialysis', 'home-health', 'lab'] },
        { matchTitle: /National Patient Safety/, authority: 'TJC', appliesToSettings: ['inpatient', 'ed'] },
      ],
      graph,
      sink,
    );

    for (const f of STARTER_POLICY_FILES) {
      const uri = `file://${process.cwd()}/packs/policy-templates/${f}`;
      const res = await pipeline.ingest(uri, 'test-actor');
      expect(res.sections).toBeGreaterThan(0);
      expect(res.rules).toBeGreaterThan(0);
    }
    expect(graph.countDocuments()).toBe(4);
    expect(graph.countRules()).toBeGreaterThan(20);
  });

  it('classifies rule kinds and enforcement severity', async () => {
    const graph = new PolicyGraph();
    const sink = new InMemoryIngestionSink();
    const pipeline = new ManualIngestionPipeline(
      new FilesystemFetchAdapter(),
      [new JsonPolicyParser()],
      new HeuristicRuleExtractor(),
      [{ matchCitation: /42 CFR 494/, authority: 'CMS', appliesToSettings: ['dialysis'] }],
      graph,
      sink,
    );
    await pipeline.ingest(`file://${process.cwd()}/packs/policy-templates/cms-esrd-conditions-for-coverage.json`, 'test-actor');

    const musts = sink.rules.filter((r) => r.kind === 'must');
    expect(musts.length).toBeGreaterThan(0);
    const conditionLevel = sink.rules.filter((r) => r.enforcementSeverity === 'condition-level');
    expect(conditionLevel.length).toBeGreaterThan(0);
  });

  it('emits stage events for every stage', async () => {
    const graph = new PolicyGraph();
    const sink = new InMemoryIngestionSink();
    const pipeline = new ManualIngestionPipeline(
      new FilesystemFetchAdapter(),
      [new JsonPolicyParser()],
      new HeuristicRuleExtractor(),
      [{ matchCitation: /CDC/, authority: 'CDC', appliesToSettings: ['primary-care'] }],
      graph,
      sink,
    );
    await pipeline.ingest(`file://${process.cwd()}/packs/policy-templates/cdc-standard-precautions.json`, 'test-actor');
    const stages = new Set(sink.stageEvents.map((e) => e.stage));
    for (const s of ['fetch', 'parse', 'classify', 'extract-rules', 'commit']) {
      expect(stages.has(s)).toBe(true);
    }
  });

  it('supports queryRules by authority and setting', async () => {
    const graph = new PolicyGraph();
    const sink = new InMemoryIngestionSink();
    const pipeline = new ManualIngestionPipeline(
      new FilesystemFetchAdapter(),
      [new JsonPolicyParser()],
      new HeuristicRuleExtractor(),
      [{ matchCitation: /1910\.1030/, authority: 'OSHA', appliesToSettings: ['primary-care', 'urgent-care', 'inpatient', 'dialysis', 'home-health', 'lab'] }],
      graph,
      sink,
    );
    await pipeline.ingest(`file://${process.cwd()}/packs/policy-templates/osha-bloodborne-pathogens.json`, 'test-actor');
    const oshaMusts = graph.queryRules({ authority: 'OSHA', kind: 'must' });
    expect(oshaMusts.length).toBeGreaterThan(0);
    const dialysisRules = graph.queryRules({ setting: 'dialysis' });
    expect(dialysisRules.length).toBeGreaterThan(0);
  });
});
