// LOINC-FHIR adapter — Basic auth against fhir.loinc.org.

import type { KnowledgeAdapter, SyncInput, AdapterEvent, SyncSummary } from '../types.js';
import { buildArtifact, diffArtifact, httpFetch, loadManifest, nowIso, openSourceStore, saveManifest, sha256, writeArtifact } from './base.js';

interface LoincConfig { base: string; probeCodes?: string[]; }
const EX_VERSION = '0.20.0';

export const loincAdapter: KnowledgeAdapter<LoincConfig> = {
  kind: 'loinc-fhir', version: EX_VERSION,
  async *sync(input: SyncInput<LoincConfig>): AsyncGenerator<AdapterEvent, SyncSummary, void> {
    const store = openSourceStore(input.storeDir, input.spec.id);
    const manifest = loadManifest(store, input.spec.id);
    const user = input.secrets['LOINC_USER']; const pass = input.secrets['LOINC_PASS'];
    if (!user || !pass) { yield { type: 'error', message: 'LOINC_USER / LOINC_PASS missing' }; return { totalFetched: 0, totalExtracted: 0, changes: [] }; }
    const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
    const codes = input.config.probeCodes ?? ['48642-3', '48643-1', '2160-0', '2951-2']; // eGFR (non-Black), eGFR (Black), Creatinine, Sodium
    const current: { id: string; contentHash: string }[] = [];
    for (const code of codes) {
      const url = `${input.config.base}/CodeSystem/$lookup?system=http://loinc.org&code=${code}`;
      const res = await httpFetch(url, { headers: { authorization: auth, accept: 'application/fhir+json' } });
      yield { type: 'fetch', url, ok: res.ok, status: res.status, bytes: res.bytes };
      if (!res.ok) continue;
      const parsed = JSON.parse(res.bodyText);
      const id = `loinc_${code}`;
      const structured = parsed;
      const hash = sha256(res.body);
      const artifact = buildArtifact({
        sourceSpec: input.spec, id, title: `LOINC ${code}`, summary: `Concept lookup for ${code}`,
        structured,
        raw: { url, contentType: res.contentType, bytes: res.bytes, hash, fetchedAt: nowIso() },
        extractorId: 'loinc-fhir', extractorVersion: EX_VERSION,
      });
      writeArtifact(store, artifact);
      current.push({ id, contentHash: hash });
    }
    const changes = diffArtifact(manifest.artifactIndex, current);
    saveManifest(store, {
      sourceId: input.spec.id, lastSyncedAt: nowIso(),
      artifactIndex: current.map((c) => ({ id: c.id, contentHash: c.contentHash, path: `artifacts/${c.id}.json` })),
    });
    return { totalFetched: codes.length, totalExtracted: current.length, changes };
  },
  async testCredentials(input) {
    const user = input.secrets['LOINC_USER']; const pass = input.secrets['LOINC_PASS'];
    if (!user || !pass) return { ok: false, message: 'LOINC_USER / LOINC_PASS missing' };
    const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
    const r = await httpFetch(`${(input.spec.fetchConfig as LoincConfig).base}/CodeSystem?_summary=count`, { headers: { authorization: auth, accept: 'application/fhir+json' } });
    if (r.status === 401) return { ok: false, message: 'Unauthorized' };
    if (!r.ok) return { ok: false, message: `LOINC returned ${r.status}` };
    return { ok: true, message: 'LOINC accepted the credentials.' };
  },
};
