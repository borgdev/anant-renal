// NLM MedlinePlus health topics adapter (XML API).

import type { KnowledgeAdapter, SyncInput, AdapterEvent, SyncSummary } from '../types.js';
import { buildArtifact, diffArtifact, httpFetch, loadManifest, nowIso, openSourceStore, saveManifest, sha256, writeArtifact } from './base.js';

interface MpConfig { base: string; terms?: string[]; }
const EX_VERSION = '0.20.0';

export const medlinePlusAdapter: KnowledgeAdapter<MpConfig> = {
  kind: 'medlineplus', version: EX_VERSION,
  async *sync(input: SyncInput<MpConfig>): AsyncGenerator<AdapterEvent, SyncSummary, void> {
    const store = openSourceStore(input.storeDir, input.spec.id);
    const manifest = loadManifest(store, input.spec.id);
    const current: { id: string; contentHash: string }[] = [];
    const terms = input.config.terms ?? ['diabetes', 'hypertension', 'chronic kidney disease', 'depression', 'copd', 'sepsis'];
    for (const term of terms) {
      const url = `${input.config.base}?db=healthTopics&term=${encodeURIComponent(term)}&retmax=10`;
      const res = await httpFetch(url, { accept: 'text/xml' });
      yield { type: 'fetch', url, ok: res.ok, status: res.status, bytes: res.bytes };
      if (!res.ok) continue;
      // Extract <document url="...">…<content name="title">…</content>…</document>
      const docBlocks = res.bodyText.match(/<document [\s\S]*?<\/document>/g) ?? [];
      for (const block of docBlocks) {
        const urlMatch = block.match(/<document url="([^"]+)"/);
        const titleMatch = block.match(/<content name="title">([\s\S]*?)<\/content>/);
        const summaryMatch = block.match(/<content name="FullSummary">([\s\S]*?)<\/content>/);
        const docUrl = urlMatch?.[1] ?? '';
        const title = decode(titleMatch?.[1] ?? term).slice(0, 200);
        const summary = decode(summaryMatch?.[1] ?? '').slice(0, 500);
        const id = docUrl ? `topic_${sha256(docUrl).slice(0, 12)}` : `topic_${sha256(title).slice(0, 12)}`;
        const structured = { term, url: docUrl, title, summary };
        const json = JSON.stringify(structured);
        const hash = sha256(json);
        const artifact = buildArtifact({
          sourceSpec: input.spec, id, title, summary, structured, clinicalDomains: [term],
          raw: { url, contentType: 'text/xml', bytes: json.length, hash, fetchedAt: nowIso() },
          extractorId: 'medlineplus', extractorVersion: EX_VERSION,
        });
        writeArtifact(store, artifact);
        current.push({ id, contentHash: hash });
      }
      yield { type: 'progress', done: current.length, total: terms.length * 10, message: `${term}: ${docBlocks.length}` };
    }
    const changes = diffArtifact(manifest.artifactIndex, current);
    saveManifest(store, {
      sourceId: input.spec.id, lastSyncedAt: nowIso(),
      artifactIndex: current.map((c) => ({ id: c.id, contentHash: c.contentHash, path: `artifacts/${c.id}.json` })),
    });
    return { totalFetched: current.length, totalExtracted: current.length, changes };
  },
};

function decode(s: string): string {
  return s.replace(/<span class="qt0">|<\/span>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
}
