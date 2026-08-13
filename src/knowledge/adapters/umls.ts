// UMLS UTS REST adapter — pulls current UMLS release identifier + a small
// crosswalk sample so packs can prove connectivity and version.

import type { KnowledgeAdapter, SyncInput, AdapterEvent, SyncSummary } from '../types.js';
import { buildArtifact, diffArtifact, httpFetch, loadManifest, nowIso, openSourceStore, saveManifest, sha256, writeArtifact } from './base.js';

interface UmlsConfig { base: string; }
const EX_VERSION = '0.20.0';

export const umlsAdapter: KnowledgeAdapter<UmlsConfig> = {
  kind: 'umls', version: EX_VERSION,
  async *sync(input: SyncInput<UmlsConfig>): AsyncGenerator<AdapterEvent, SyncSummary, void> {
    const store = openSourceStore(input.storeDir, input.spec.id);
    const manifest = loadManifest(store, input.spec.id);
    const key = input.secrets['UMLS_API_KEY'];
    if (!key) { yield { type: 'error', message: 'UMLS_API_KEY missing' }; return { totalFetched: 0, totalExtracted: 0, changes: [] }; }
    // Metadata: current version
    const url = `${input.config.base}/content/current/CUI/C0018799?apiKey=${encodeURIComponent(key)}`;
    const res = await httpFetch(url, { accept: 'application/json' });
    yield { type: 'fetch', url, ok: res.ok, status: res.status, bytes: res.bytes };
    if (!res.ok) { yield { type: 'error', message: `UMLS returned ${res.status}` }; return { totalFetched: 0, totalExtracted: 0, changes: [] }; }
    const parsed = JSON.parse(res.bodyText) as { result?: { name?: string; ui?: string; semanticTypes?: unknown[] } };
    const id = 'sample_heart-disease';
    const structured = { probe: 'C0018799 (Heart Disease)', result: parsed.result };
    const hash = sha256(res.body);
    const artifact = buildArtifact({
      sourceSpec: input.spec, id, title: `UMLS probe · ${parsed.result?.name ?? ''}`, summary: 'Connectivity + metadata probe',
      structured,
      raw: { url, contentType: 'application/json', bytes: res.bytes, hash, fetchedAt: nowIso() },
      extractorId: 'umls', extractorVersion: EX_VERSION,
    });
    writeArtifact(store, artifact);
    const current = [{ id, contentHash: hash }];
    const changes = diffArtifact(manifest.artifactIndex, current);
    saveManifest(store, {
      sourceId: input.spec.id, lastSyncedAt: nowIso(),
      artifactIndex: current.map((c) => ({ id: c.id, contentHash: c.contentHash, path: `artifacts/${c.id}.json` })),
    });
    return { totalFetched: 1, totalExtracted: 1, changes };
  },
  async testCredentials(input) {
    const key = input.secrets['UMLS_API_KEY'];
    if (!key) return { ok: false, message: 'UMLS_API_KEY missing' };
    const r = await httpFetch(`${(input.spec.fetchConfig as UmlsConfig).base}/content/current/CUI/C0018799?apiKey=${encodeURIComponent(key)}`, { accept: 'application/json' });
    if (r.status === 401) return { ok: false, message: 'Unauthorized — UMLS rejected the key' };
    if (!r.ok) return { ok: false, message: `UMLS returned ${r.status}` };
    return { ok: true, message: 'UMLS accepted the key.' };
  },
};
