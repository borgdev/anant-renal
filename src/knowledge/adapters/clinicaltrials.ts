// ClinicalTrials.gov v2 API adapter.

import type { KnowledgeAdapter, SyncInput, AdapterEvent, SyncSummary } from '../types.js';
import { buildArtifact, diffArtifact, httpFetch, loadManifest, nowIso, openSourceStore, saveManifest, sha256, writeArtifact } from './base.js';

interface CtConfig { base: string; queryTerms?: string[]; pageSize?: number; }
const EX_VERSION = '0.20.0';

export const clinicalTrialsAdapter: KnowledgeAdapter<CtConfig> = {
  kind: 'clinicaltrials-v2', version: EX_VERSION,
  async *sync(input: SyncInput<CtConfig>): AsyncGenerator<AdapterEvent, SyncSummary, void> {
    const store = openSourceStore(input.storeDir, input.spec.id);
    const manifest = loadManifest(store, input.spec.id);
    const current: { id: string; contentHash: string }[] = [];
    const terms = input.config.queryTerms ?? ['diabetes', 'chronic kidney disease', 'sepsis', 'copd', 'depression'];
    const pageSize = input.config.pageSize ?? 20;
    for (const term of terms) {
      const url = `${input.config.base}/studies?query.term=${encodeURIComponent(term)}&pageSize=${pageSize}&fields=NCTId,BriefTitle,OverallStatus,Condition,LastUpdatePostDate,StartDate`;
      const res = await httpFetch(url, { accept: 'application/json' });
      yield { type: 'fetch', url, ok: res.ok, status: res.status, bytes: res.bytes };
      if (!res.ok) continue;
      const parsed = JSON.parse(res.bodyText) as { studies?: { protocolSection?: Record<string, unknown> }[] };
      const studies = parsed.studies ?? [];
      for (const s of studies) {
        const p = s.protocolSection ?? {};
        const idModule = (p['identificationModule'] ?? {}) as Record<string, unknown>;
        const statusModule = (p['statusModule'] ?? {}) as Record<string, unknown>;
        const conditions = ((p['conditionsModule'] ?? {}) as { conditions?: string[] }).conditions ?? [];
        const nct = String(idModule['nctId'] ?? '');
        if (!nct) continue;
        const title = String(idModule['briefTitle'] ?? nct).slice(0, 200);
        const structured = { protocolSection: p, term };
        const json = JSON.stringify(structured);
        const hash = sha256(json);
        const artifact = buildArtifact({
          sourceSpec: input.spec, id: nct, title,
          summary: `${statusModule['overallStatus'] ?? ''} · conditions: ${conditions.slice(0, 3).join(', ')}`,
          structured, clinicalDomains: [term],
          raw: { url, contentType: 'application/json', bytes: json.length, hash, fetchedAt: nowIso() },
          extractorId: 'clinicaltrials-v2', extractorVersion: EX_VERSION,
        });
        writeArtifact(store, artifact);
        current.push({ id: nct, contentHash: hash });
      }
      yield { type: 'progress', done: current.length, total: terms.length * pageSize, message: `${term}: ${studies.length}` };
    }
    const changes = diffArtifact(manifest.artifactIndex, current);
    saveManifest(store, {
      sourceId: input.spec.id, lastSyncedAt: nowIso(),
      artifactIndex: current.map((c) => ({ id: c.id, contentHash: c.contentHash, path: `artifacts/${c.id}.json` })),
    });
    return { totalFetched: current.length, totalExtracted: current.length, changes };
  },
};
