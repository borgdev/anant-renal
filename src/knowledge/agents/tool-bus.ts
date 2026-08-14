// Knowledge-aware tool bus. Every tool call is logged to the effect ledger
// so both ReAct and Plan-and-Execute runners share the same provenance path.

import type { KnowledgeLayer } from '../index.js';
import { MeasureEvaluator } from '../../measures/evaluator.js';
import { ValueSetRegistry } from '../../measures/value-set-registry.js';
import { loadFromDisk } from '../../measures/store-loader.js';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';

let _sharedEvaluator: MeasureEvaluator | null = null;
function sharedEvaluator(): MeasureEvaluator | null {
  if (_sharedEvaluator) return _sharedEvaluator;
  const root = process.env['HH_MEASURES_ROOT'] ?? pathJoin(process.cwd(), '.harness', 'measures');
  if (!existsSync(root)) return null;
  const store = loadFromDisk({ root });
  if (store.measures.length === 0) return null;
  const cacheDir = pathJoin(tmpdir(), 'hh-vsr-cache');
  mkdirSync(cacheDir, { recursive: true });
  const vsr = new ValueSetRegistry(cacheDir);
  _sharedEvaluator = new MeasureEvaluator({ measures: store.measures, libraries: store.libraries, valueSetRegistry: vsr });
  return _sharedEvaluator;
}

export interface EventPublisher { publish(e: unknown): Promise<void> | void; }

export type ToolCall = {
  readonly name: string;
  readonly args: Record<string, unknown>;
};

export type ToolResult = {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: string;
  readonly citations?: readonly {
    readonly sourceId: string;
    readonly artifactId?: string;
    readonly upstream?: { readonly rawUrl: string; readonly contentHash: string };
  }[];
};

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>; // JSON-schema-ish
  invoke(args: Record<string, unknown>): Promise<ToolResult>;
}

export interface ToolBusOptions {
  readonly layer: KnowledgeLayer;
  readonly bus?: EventPublisher | undefined;
  readonly actorId: string;
  readonly episodeId: string;
}

export function buildKnowledgeToolBus(opts: ToolBusOptions): ToolDefinition[] {
  const { layer, bus, actorId, episodeId } = opts;
  const log = async (name: string, args: Record<string, unknown>, result: ToolResult): Promise<void> => {
    if (!bus) return;
    await bus.publish({
      kind: 'agent.tool.invoked',
      occurredAt: new Date().toISOString(),
      payload: { episodeId, actorId, tool: name, args, ok: result.ok, error: result.error ?? null, citations: result.citations ?? [] },
    } as never);
  };
  const wrap = (name: string, description: string, parameters: Record<string, unknown>, fn: (args: Record<string, unknown>) => Promise<ToolResult>): ToolDefinition => ({
    name, description, parameters,
    invoke: async (args) => {
      let r: ToolResult;
      try { r = await fn(args); }
      catch (e) { r = { ok: false, error: (e as Error).message }; }
      await log(name, args, r);
      return r;
    },
  });
  return [
    wrap('list_sources', 'List knowledge sources filtered by category, tier, or clinical domain',
      { type: 'object', properties: { category: { type: 'string' }, tier: { type: 'string' }, clinicalDomain: { type: 'string' } } },
      async (a) => {
        const q: { category?: string; tier?: string; clinicalDomain?: string } = {};
        if (typeof a['category'] === 'string') q.category = a['category'];
        if (typeof a['tier'] === 'string') q.tier = a['tier'];
        if (typeof a['clinicalDomain'] === 'string') q.clinicalDomain = a['clinicalDomain'];
        const list = layer.sources.list(q as never);
        return { ok: true, data: list.map(s => ({ id: s.id, name: s.name, tier: s.tier, category: s.category, publisher: s.publisher })) };
      }),
    wrap('describe_source', 'Get full spec + current manifest for a source',
      { type: 'object', required: ['sourceId'], properties: { sourceId: { type: 'string' } } },
      async (a) => {
        const id = String(a['sourceId']);
        const spec = layer.sources.get(id);
        if (!spec) return { ok: false, error: `unknown-source:${id}` };
        const manifest = await layer.readManifest(id);
        return { ok: true, data: { spec, manifest } };
      }),
    wrap('sync_source', 'Fetch latest content from a source and update the store; returns extraction summary',
      { type: 'object', required: ['sourceId'], properties: { sourceId: { type: 'string' } } },
      async (a) => {
        const id = String(a['sourceId']);
        const outcome = await layer.engine.run({ sourceId: id, actor: actorId });
        return outcome.ok
          ? { ok: true, data: outcome }
          : { ok: false, error: outcome.error ?? 'sync-failed', data: outcome };
      }),
    wrap('list_artifacts', 'List artifacts for a source (paged)',
      { type: 'object', required: ['sourceId'], properties: { sourceId: { type: 'string' }, limit: { type: 'number' }, offset: { type: 'number' } } },
      async (a) => {
        const id = String(a['sourceId']);
        const limit = Number(a['limit'] ?? 20);
        const offset = Number(a['offset'] ?? 0);
        const { total, artifacts } = await layer.listArtifacts(id, offset, limit);
        return {
          ok: true,
          data: { total, artifacts },
          citations: artifacts.map(x => ({ sourceId: id, artifactId: x.id, upstream: { rawUrl: x.upstream.rawUrl, contentHash: x.upstream.contentHash } })),
        };
      }),
    wrap('trace_provenance', 'Return the exact upstream URL, hash, fetch time for an artifact',
      { type: 'object', required: ['sourceId', 'artifactId'], properties: { sourceId: { type: 'string' }, artifactId: { type: 'string' } } },
      async (a) => {
        const id = String(a['sourceId']); const aid = String(a['artifactId']);
        const art = await layer.readArtifact(id, aid);
        if (!art) return { ok: false, error: 'artifact-not-found' };
        return {
          ok: true,
          data: { sourceId: id, artifactId: aid, title: art.title, upstream: art.upstream },
          citations: [{ sourceId: id, artifactId: aid, upstream: { rawUrl: art.upstream.rawUrl, contentHash: art.upstream.contentHash } }],
        };
      }),
    wrap('pack_reach', 'For a source, list every pack and agent that depends on it',
      { type: 'object', required: ['sourceId'], properties: { sourceId: { type: 'string' } } },
      async (a) => {
        const id = String(a['sourceId']);
        const fanout = layer.sources.fanout(id);
        return { ok: true, data: fanout };
      }),
    wrap('evaluate_measure', 'Evaluate a CMS FHIR measure against a supplied FHIR bundle. Returns per-population membership and score.',
      {
        type: 'object',
        required: ['measureId', 'bundle'],
        properties: {
          measureId: { type: 'string', description: 'Canonical id (ecqm:X/version) or plain CMS id' },
          bundle: { type: 'object', description: 'FHIR R4 Bundle or array of resources' },
          measurementPeriod: {
            type: 'object',
            properties: { start: { type: 'string' }, end: { type: 'string' } },
          },
        },
      },
      async (a) => {
        const evaluator = sharedEvaluator();
        if (!evaluator) return { ok: false, error: 'measure-store-not-loaded' };
        const measureId = String(a['measureId']);
        const measure = evaluator.getMeasure(measureId);
        if (!measure) return { ok: false, error: 'measure-not-found' };
        try {
          const period = a['measurementPeriod'] as { start?: string; end?: string } | undefined;
          const result = await evaluator.evaluate({
            measureId: measure.id,
            bundle: a['bundle'],
            ...(period && period.start && period.end ? { measurementPeriod: { start: period.start, end: period.end } } : {}),
          });
          return {
            ok: true,
            data: result,
            citations: [
              { sourceId: 'cqframework', upstream: { rawUrl: measure.upstream.rawUrl, contentHash: measure.upstream.contentHash } },
            ],
          };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }),
  ];
}
