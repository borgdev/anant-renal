// openFDA adapters (labels, adverse events, enforcement).
// Real endpoints, real pagination, real provenance.

import type { KnowledgeAdapter, SyncInput, AdapterEvent, SyncSummary, KnowledgeArtifact } from '../types.js';
import { buildArtifact, diffArtifact, httpFetch, loadManifest, nowIso, openSourceStore, pMap, saveManifest, sha256, writeArtifact } from './base.js';

interface OpenFdaConfig { base: string; pageLimit?: number; keyParam?: string; }
const EX_VERSION = '0.20.0';

type MappedShape = { id: string; title: string; summary?: string; structured: Record<string, unknown>; clinicalDomains?: string[]; };
async function *syncOpenFda(input: SyncInput<OpenFdaConfig>, extractorId: string, mapArtifact: (raw: Record<string, unknown>) => MappedShape): AsyncGenerator<AdapterEvent, SyncSummary, void> {
  const store = openSourceStore(input.storeDir, input.spec.id);
  const manifest = loadManifest(store, input.spec.id);
  const key = input.secrets['OPENFDA_API_KEY'];
  const base = input.config.base;
  const pageLimit = input.config.pageLimit ?? 100;
  const scopeIds = input.filter;
  const changes = [];
  const current: { id: string; contentHash: string }[] = [];
  const totalFetched = { n: 0 };
  const upstreamVersion = new Date().toISOString().slice(0, 10);

  // Query for a manageable slice — new-since-last-sync when possible, otherwise last 30 days.
  const dateFrom = manifest.lastSyncedAt ? manifest.lastSyncedAt.slice(0, 10).replace(/-/g, '') : (() => {
    const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().slice(0, 10).replace(/-/g, '');
  })();
  const dateTo = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const searchField = extractorId === 'openfda-label' ? 'effective_time' : (extractorId === 'openfda-enforcement' ? 'report_date' : 'receivedate');
  const searchQ = `${searchField}:[${dateFrom}+TO+${dateTo}]`;
  let skip = 0; let total: number | null = null;
  while (true) {
    const url = `${base}?search=${searchQ}&limit=${pageLimit}&skip=${skip}${key ? `&${input.config.keyParam ?? 'api_key'}=${encodeURIComponent(key)}` : ''}`;
    const res = await httpFetch(url, { accept: 'application/json' });
    yield { type: 'fetch', url, ok: res.ok, status: res.status, bytes: res.bytes };
    if (!res.ok) {
      if (res.status === 404 && skip > 0) break;
      yield { type: 'warning', message: `openFDA ${res.status}: ${res.bodyText.slice(0, 200)}`, url };
      break;
    }
    const parsed = JSON.parse(res.bodyText) as { meta?: { results?: { total?: number } }; results?: Record<string, unknown>[] };
    if (total == null) total = parsed.meta?.results?.total ?? null;
    const results = parsed.results ?? [];
    if (results.length === 0) break;

    await pMap(results, async (raw) => {
      const shaped = mapArtifact(raw);
      if (scopeIds && !scopeIds(shaped.id)) return;
      const rawJson = JSON.stringify(raw);
      const hash = sha256(rawJson);
      const artifact = buildArtifact({
        sourceSpec: input.spec,
        id: shaped.id,
        title: shaped.title,
        ...(shaped.summary !== undefined ? { summary: shaped.summary } : {}),
        structured: shaped.structured,
        ...(shaped.clinicalDomains !== undefined ? { clinicalDomains: shaped.clinicalDomains } : {}),
        raw: { url, contentType: 'application/json', bytes: rawJson.length, hash, upstreamVersion, fetchedAt: nowIso() },
        extractorId, extractorVersion: EX_VERSION,
      });
      writeArtifact(store, artifact);
      current.push({ id: artifact.id, contentHash: hash });
      totalFetched.n++;
    }, input.concurrency ?? 6);

    yield { type: 'progress', done: skip + results.length, total, message: `fetched ${skip + results.length}${total ? ` / ${total}` : ''}` };
    skip += pageLimit;
    if (results.length < pageLimit) break;
    if (skip > 5000) break; // safety cap per sync (openFDA hard limit is 25000)
  }
  const diffed = diffArtifact(manifest.artifactIndex, current);
  changes.push(...diffed);
  saveManifest(store, {
    sourceId: input.spec.id,
    upstreamVersion,
    lastSyncedAt: nowIso(),
    artifactIndex: current.map((c) => ({ id: c.id, contentHash: c.contentHash, path: `artifacts/${c.id}.json` })),
  });
  return { upstreamVersion, totalFetched: totalFetched.n, totalExtracted: current.length, changes };
}

export const openFdaLabelAdapter: KnowledgeAdapter<OpenFdaConfig> = {
  kind: 'openfda-label', version: EX_VERSION,
  async *sync(input) {
    return yield* syncOpenFda(input, 'openfda-label', (raw) => {
      const set_id = String(raw['set_id'] ?? raw['id'] ?? '');
      const openfda = (raw['openfda'] ?? {}) as Record<string, unknown>;
      const brand = (openfda['brand_name'] as string[] | undefined)?.[0];
      const generic = (openfda['generic_name'] as string[] | undefined)?.[0];
      const boxed = (raw['boxed_warning'] as string[] | undefined)?.[0];
      const summary = boxed?.slice(0, 300);
      return {
        id: set_id || `unknown_${Date.now()}`,
        title: brand ? `${brand} (${generic ?? 'unknown'})` : (generic ?? 'unknown drug'),
        ...(summary !== undefined ? { summary } : {}),
        structured: raw,
      };
    });
  },
};

export const openFdaEventAdapter: KnowledgeAdapter<OpenFdaConfig> = {
  kind: 'openfda-event', version: EX_VERSION,
  async *sync(input) {
    return yield* syncOpenFda(input, 'openfda-event', (raw) => {
      const safetyreportid = String(raw['safetyreportid'] ?? Date.now());
      const patient = (raw['patient'] ?? {}) as Record<string, unknown>;
      const drugs = (patient['drug'] as { medicinalproduct?: string }[] | undefined) ?? [];
      const first = drugs[0]?.medicinalproduct ?? 'unknown';
      return {
        id: safetyreportid,
        title: `FAERS ${safetyreportid} · ${first}`,
        structured: raw,
      };
    });
  },
};

export const openFdaEnforcementAdapter: KnowledgeAdapter<OpenFdaConfig> = {
  kind: 'openfda-enforcement', version: EX_VERSION,
  async *sync(input) {
    return yield* syncOpenFda(input, 'openfda-enforcement', (raw) => {
      const recall_number = String(raw['recall_number'] ?? Date.now());
      const product = String(raw['product_description'] ?? 'unknown').slice(0, 120);
      const reason = String(raw['reason_for_recall'] ?? '').slice(0, 300);
      return {
        id: recall_number,
        title: `Recall ${recall_number} · ${product}`,
        summary: reason,
        structured: raw,
      };
    });
  },
};
