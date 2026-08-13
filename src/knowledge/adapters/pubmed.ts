// NCBI PubMed E-utilities adapter. Small parameterized slice per sync.

import type { KnowledgeAdapter, SyncInput, AdapterEvent, SyncSummary } from '../types.js';
import { buildArtifact, diffArtifact, httpFetch, loadManifest, nowIso, openSourceStore, saveManifest, sha256, writeArtifact } from './base.js';

interface PubMedConfig { base: string; searchTerms?: string[]; perTermMax?: number; }
const EX_VERSION = '0.20.0';

export const pubmedAdapter: KnowledgeAdapter<PubMedConfig> = {
  kind: 'pubmed-eutils', version: EX_VERSION,
  async *sync(input: SyncInput<PubMedConfig>): AsyncGenerator<AdapterEvent, SyncSummary, void> {
    const store = openSourceStore(input.storeDir, input.spec.id);
    const manifest = loadManifest(store, input.spec.id);
    const current: { id: string; contentHash: string }[] = [];
    // Pack subscriptions inject clinicalDomains as search terms via config;
    // default to a domain-broad sweep covering our seeded packs.
    const terms = input.config.searchTerms ?? ['chronic kidney disease', 'dialysis', 'sepsis', 'opioid', 'diabetes', 'depression', 'contrast media', 'pediatric preventive'];
    const per = input.config.perTermMax ?? 20;
    for (const term of terms) {
      const esearch = `${input.config.base}/esearch.fcgi?db=pubmed&term=${encodeURIComponent(term)}&retmax=${per}&retmode=json&sort=most+recent`;
      const res = await httpFetch(esearch, { accept: 'application/json' });
      yield { type: 'fetch', url: esearch, ok: res.ok, status: res.status, bytes: res.bytes };
      if (!res.ok) continue;
      const parsed = JSON.parse(res.bodyText) as { esearchresult?: { idlist?: string[]; count?: string } };
      const ids = parsed.esearchresult?.idlist ?? [];
      if (ids.length === 0) continue;
      // esummary for metadata
      const esummary = `${input.config.base}/esummary.fcgi?db=pubmed&id=${ids.join(',')}&retmode=json`;
      const sres = await httpFetch(esummary, { accept: 'application/json' });
      yield { type: 'fetch', url: esummary, ok: sres.ok, status: sres.status, bytes: sres.bytes };
      if (!sres.ok) continue;
      const summary = JSON.parse(sres.bodyText) as { result?: Record<string, unknown> };
      for (const pmid of ids) {
        const item = summary.result?.[pmid] as Record<string, unknown> | undefined;
        if (!item) continue;
        const title = String(item['title'] ?? `PMID ${pmid}`);
        const structured = { term, item };
        const json = JSON.stringify(structured);
        const hash = sha256(json);
        const artifact = buildArtifact({
          sourceSpec: input.spec, id: `pmid_${pmid}`, title, summary: String(item['sortpubdate'] ?? ''),
          structured, clinicalDomains: [term],
          raw: { url: esummary, contentType: 'application/json', bytes: json.length, hash, fetchedAt: nowIso() },
          extractorId: 'pubmed-eutils', extractorVersion: EX_VERSION,
        });
        writeArtifact(store, artifact);
        current.push({ id: `pmid_${pmid}`, contentHash: hash });
      }
      yield { type: 'progress', done: current.length, total: terms.length * per, message: `term "${term}" → ${ids.length} PMIDs` };
    }
    const changes = diffArtifact(manifest.artifactIndex, current);
    saveManifest(store, {
      sourceId: input.spec.id, lastSyncedAt: nowIso(),
      artifactIndex: current.map((c) => ({ id: c.id, contentHash: c.contentHash, path: `artifacts/${c.id}.json` })),
    });
    return { totalFetched: current.length, totalExtracted: current.length, changes };
  },
};
