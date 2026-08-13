// cqframework GitHub adapter for CMS eCQMs (PY 2025 QI-Core).
// Fetches Measure + Library FHIR JSON resources from a public repo.

import type { KnowledgeAdapter, SyncInput, AdapterEvent, SyncSummary } from '../types.js';
import { buildArtifact, diffArtifact, httpFetch, loadManifest, nowIso, openSourceStore, pMap, saveManifest, sha256, writeArtifact } from './base.js';

interface CqfConfig { repo: string; branch: string; measureDir: string; libraryDir: string; }
const EX_VERSION = '0.20.0';

const GH_API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';

export const cqframeworkAdapter: KnowledgeAdapter<CqfConfig> = {
  kind: 'cqframework-gh', version: EX_VERSION,
  async *sync(input: SyncInput<CqfConfig>): AsyncGenerator<AdapterEvent, SyncSummary, void> {
    const store = openSourceStore(input.storeDir, input.spec.id);
    const manifest = loadManifest(store, input.spec.id);
    const token = input.secrets['GITHUB_TOKEN'];
    const authHeader = token ? { authorization: `Bearer ${token}` } : {};
    const { repo, branch, measureDir, libraryDir } = input.config;
    const current: { id: string; contentHash: string }[] = [];

    // 1. Resolve branch commit sha for versioning
    const commitUrl = `${GH_API}/repos/${repo}/commits/${branch}`;
    const commitRes = await httpFetch(commitUrl, { headers: { accept: 'application/vnd.github+json', ...authHeader } });
    yield { type: 'fetch', url: commitUrl, ok: commitRes.ok, status: commitRes.status, bytes: commitRes.bytes };
    if (!commitRes.ok) {
      yield { type: 'error', message: `GitHub API returned ${commitRes.status} for branch ${branch}. Set GITHUB_TOKEN to raise the anonymous rate limit (60/hr → 5000/hr).`, url: commitUrl };
      return { totalFetched: 0, totalExtracted: 0, changes: [] };
    }
    const commitSha = (JSON.parse(commitRes.bodyText) as { sha?: string }).sha ?? branch;

    // 2. Skip fast if unchanged
    if (manifest.upstreamVersion === commitSha) {
      yield { type: 'progress', done: 0, total: 0, message: `already synced at commit ${commitSha.slice(0, 8)}` };
      return { upstreamVersion: commitSha, totalFetched: 0, totalExtracted: manifest.artifactIndex.length, changes: [] };
    }

    // 3. List measures + libraries via git tree at that sha
    const treeUrl = `${GH_API}/repos/${repo}/git/trees/${commitSha}?recursive=1`;
    const treeRes = await httpFetch(treeUrl, { headers: { accept: 'application/vnd.github+json', ...authHeader } });
    yield { type: 'fetch', url: treeUrl, ok: treeRes.ok, status: treeRes.status, bytes: treeRes.bytes };
    if (!treeRes.ok) {
      yield { type: 'error', message: `GitHub tree lookup failed ${treeRes.status}`, url: treeUrl };
      return { totalFetched: 0, totalExtracted: 0, changes: [] };
    }
    const tree = (JSON.parse(treeRes.bodyText) as { tree?: { path: string; sha: string; type: string; size?: number }[] }).tree ?? [];
    const wants = tree.filter((t) => t.type === 'blob' && (t.path.startsWith(`${measureDir}/`) || t.path.startsWith(`${libraryDir}/`)) && t.path.endsWith('.json'));

    let done = 0;
    await pMap(wants, async (file) => {
      const rawUrl = `${RAW}/${repo}/${commitSha}/${file.path}`;
      const res = await httpFetch(rawUrl, { accept: 'application/fhir+json' });
      if (!res.ok) return;
      const hash = sha256(res.body);
      // Filter by subscription filter if any (matches on filename base)
      const baseName = file.path.split('/').pop()!.replace(/\.json$/, '');
      if (input.filter && !input.filter(baseName)) return;
      const parsed = JSON.parse(res.bodyText) as { resourceType?: string; id?: string; title?: string; name?: string; version?: string; url?: string; status?: string };
      const id = (parsed.resourceType === 'Measure' ? 'measure_' : 'library_') + (parsed.id ?? baseName);
      const title = parsed.title ?? parsed.name ?? id;
      const summary = `${parsed.resourceType} · v${parsed.version ?? '?'} · status ${parsed.status ?? '?'}`;
      const artifact = buildArtifact({
        sourceSpec: input.spec, id, title, summary, structured: parsed,
        raw: {
          url: rawUrl, contentType: 'application/fhir+json', bytes: res.bytes, hash,
          upstreamVersion: commitSha, fetchedAt: nowIso(),
        },
        extractorId: 'cqframework-gh', extractorVersion: EX_VERSION,
        locator: { fhirResourceId: parsed.id ?? baseName },
      });
      writeArtifact(store, artifact);
      current.push({ id, contentHash: hash });
      done++;
    }, input.concurrency ?? 6);

    yield { type: 'progress', done, total: wants.length, message: `commit ${commitSha.slice(0, 8)}: ${done}/${wants.length} JSON resources` };
    const changes = diffArtifact(manifest.artifactIndex, current);
    saveManifest(store, {
      sourceId: input.spec.id, upstreamVersion: commitSha, lastSyncedAt: nowIso(),
      artifactIndex: current.map((c) => ({ id: c.id, contentHash: c.contentHash, path: `artifacts/${c.id}.json`, upstreamVersion: commitSha })),
    });
    return { upstreamVersion: commitSha, totalFetched: wants.length, totalExtracted: current.length, changes };
  },
  async testCredentials(input) {
    // If GITHUB_TOKEN present, test rate-limit endpoint; otherwise return public-mode ok.
    const token = input.secrets['GITHUB_TOKEN'];
    if (!token) return { ok: true, message: 'Public mode (60 req/hr anonymous)' };
    const r = await httpFetch(`${GH_API}/rate_limit`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' } });
    if (!r.ok) return { ok: false, message: `GitHub rate_limit returned ${r.status}` };
    return { ok: true, message: `Authenticated (${r.headers['x-ratelimit-remaining'] ?? '?'} req remaining)` };
  },
};
