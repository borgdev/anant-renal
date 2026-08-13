// NLM VSAC FHIR terminology adapter — value set expansion via UMLS API key.

import type { KnowledgeAdapter, SyncInput, AdapterEvent, SyncSummary } from '../types.js';
import { buildArtifact, diffArtifact, httpFetch, loadManifest, nowIso, openSourceStore, saveManifest, sha256, writeArtifact } from './base.js';

interface VsacConfig { base: string; seedOids?: string[]; }
const EX_VERSION = '0.20.0';

/**
 * Sync a set of value-set OIDs. If none provided, pull the ones referenced by
 * the subscribed packs (via scope.custom.oids).
 */
export const vsacAdapter: KnowledgeAdapter<VsacConfig> = {
  kind: 'vsac', version: EX_VERSION,
  async *sync(input: SyncInput<VsacConfig>): AsyncGenerator<AdapterEvent, SyncSummary, void> {
    const store = openSourceStore(input.storeDir, input.spec.id);
    const manifest = loadManifest(store, input.spec.id);
    const key = input.secrets['UMLS_API_KEY'];
    if (!key) {
      yield { type: 'error', message: 'UMLS_API_KEY not provided; cannot expand value sets.' };
      return { totalFetched: 0, totalExtracted: 0, changes: [] };
    }
    const auth = 'Basic ' + Buffer.from(`apikey:${key}`).toString('base64');
    const oids = input.config.seedOids ?? ['2.16.840.1.113883.3.526.3.1550', '2.16.840.1.113883.3.464.1003.109.12.1017'];
    const current: { id: string; contentHash: string }[] = [];
    for (const oid of oids) {
      const url = `${input.config.base}/ValueSet/${oid}/$expand`;
      const res = await httpFetch(url, { headers: { authorization: auth, accept: 'application/fhir+json' } });
      yield { type: 'fetch', url, ok: res.ok, status: res.status, bytes: res.bytes };
      if (!res.ok) {
        yield { type: 'warning', message: `VSAC ${oid} returned ${res.status}`, url };
        continue;
      }
      const parsed = JSON.parse(res.bodyText) as { url?: string; version?: string; expansion?: { total?: number; contains?: unknown[] } };
      const id = `vs_${oid}`;
      const structured = parsed;
      const hash = sha256(res.body);
      const total = parsed.expansion?.total ?? (parsed.expansion?.contains ?? []).length;
      const artifact = buildArtifact({
        sourceSpec: input.spec, id, title: `Value Set ${oid}`, summary: `${total} codes · v${parsed.version ?? ''}`,
        structured,
        raw: { url, contentType: res.contentType, bytes: res.bytes, hash, ...(parsed.version !== undefined ? { upstreamVersion: parsed.version } : {}), fetchedAt: nowIso() },
        extractorId: 'vsac', extractorVersion: EX_VERSION,
      });
      writeArtifact(store, artifact);
      current.push({ id, contentHash: hash });
      yield { type: 'progress', done: current.length, total: oids.length, message: `expanded ${oid}: ${total} codes` };
    }
    const changes = diffArtifact(manifest.artifactIndex, current);
    saveManifest(store, {
      sourceId: input.spec.id, lastSyncedAt: nowIso(),
      artifactIndex: current.map((c) => ({ id: c.id, contentHash: c.contentHash, path: `artifacts/${c.id}.json` })),
    });
    return { totalFetched: oids.length, totalExtracted: current.length, changes };
  },
  async testCredentials(input) {
    const key = input.secrets['UMLS_API_KEY'];
    if (!key) return { ok: false, message: 'UMLS_API_KEY missing' };
    const auth = 'Basic ' + Buffer.from(`apikey:${key}`).toString('base64');
    const r = await httpFetch(`${(input.spec.fetchConfig as VsacConfig).base}/CodeSystem?_summary=count`, { headers: { authorization: auth, accept: 'application/fhir+json' } });
    if (r.status === 401) return { ok: false, message: 'Unauthorized — key rejected by VSAC' };
    if (!r.ok) return { ok: false, message: `VSAC returned ${r.status}: ${r.bodyText.slice(0, 160)}` };
    return { ok: true, message: 'VSAC accepted the key.' };
  },
};
