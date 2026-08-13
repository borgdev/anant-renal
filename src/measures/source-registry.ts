// M20: Fetch real FHIR Measure + Library resources from the authoritative
// cqframework GitHub repos (published by CMS/ONC via MADiE). Persist raw
// bytes + provenance to disk. Idempotent.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { StoredMeasure, StoredLibrary, UpstreamRef, MeasureChange, ISODate } from './types.js';

const GH_API = 'https://api.github.com';
const RAW_BASE = 'https://raw.githubusercontent.com';

const DEFAULT_REPOS = [
  { repo: 'cqframework/ecqm-content-qicore-2025', branch: 'main', measureDir: 'input/resources/measure', libraryDir: 'input/resources/library' },
] as const;

function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

function nowIso(): ISODate { return new Date().toISOString(); }

async function ghFetch(url: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = { 'user-agent': 'healthcare-harness/1.0', 'accept': 'application/vnd.github+json' };
  if (token) headers['authorization'] = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
    throw new Error(`GitHub rate-limited. Set GITHUB_TOKEN env var to raise the limit. Reset: ${res.headers.get('x-ratelimit-reset')}`);
  }
  if (!res.ok) throw new Error(`GH ${res.status} ${url}: ${(await res.text()).slice(0, 200)}`);
  return res;
}

async function ghRaw(rawUrl: string): Promise<{ body: Buffer; contentHash: string }> {
  const res = await fetch(rawUrl, { headers: { 'user-agent': 'healthcare-harness/1.0' } });
  if (!res.ok) throw new Error(`raw ${res.status} ${rawUrl}`);
  const body = Buffer.from(await res.arrayBuffer());
  return { body, contentHash: sha256(body) };
}

async function listDir(repo: string, branch: string, path: string, token?: string): Promise<Array<{ name: string; path: string; sha: string }>> {
  const url = `${GH_API}/repos/${repo}/contents/${path}?ref=${branch}`;
  const res = await ghFetch(url, token);
  const arr = await res.json() as Array<{ name: string; path: string; sha: string; type: string }>;
  return arr.filter((x) => x.type === 'file' && x.name.endsWith('.json')).map(({ name, path, sha }) => ({ name, path, sha }));
}

async function resolveCommitSha(repo: string, branch: string, token?: string): Promise<string> {
  const res = await ghFetch(`${GH_API}/repos/${repo}/commits/${branch}`, token);
  const j = await res.json() as { sha: string };
  return j.sha;
}

// -------- Local store --------

export interface StoreLayout {
  root: string; // e.g. /home/user/workspace/.harness/measures
}

function paths(layout: StoreLayout, repo: string) {
  const repoSlug = repo.replace('/', '__');
  return {
    measuresDir: join(layout.root, repoSlug, 'measure'),
    librariesDir: join(layout.root, repoSlug, 'library'),
    manifest: join(layout.root, repoSlug, 'manifest.json'),
  };
}

interface RepoManifest {
  repo: string;
  branch: string;
  commitSha: string;
  syncedAt: ISODate;
  measures: { id: string; cmsId: string; version: string; blobSha: string; contentHash: string; path: string }[];
  libraries: { id: string; name: string; version: string; blobSha: string; contentHash: string; path: string }[];
}

function readManifest(p: string): RepoManifest | null {
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8')) as RepoManifest;
}

function writeManifest(p: string, m: RepoManifest): void {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(m, null, 2));
}

function extractCmsId(name: string): string {
  // Repo files look like 'CMS0334FHIRPCCesareanBirth.json' -> CMS0334, but the
  // CMS numbering the world uses is often trimmed of leading zeros. Preserve
  // exactly what the resource says internally when parsed.
  const m = /^CMS(\d+)/.exec(name);
  return m ? `CMS${Number(m[1])}` : name.replace(/\.json$/, '');
}

// -------- Sync (real network) --------

export interface SyncOptions {
  layout: StoreLayout;
  token?: string; // GITHUB_TOKEN to avoid rate limits
  repos?: readonly { repo: string; branch: string; measureDir: string; libraryDir: string }[];
  /** Skip if commit sha hasn't moved. Default true. */
  skipIfUnchanged?: boolean;
  /** Optional filter: only sync measure filenames matching this substring. */
  filter?: string;
  /** Max concurrent raw fetches. Default 8. */
  concurrency?: number;
}

export interface SyncResult {
  repo: string;
  branch: string;
  commitSha: string;
  measuresSynced: number;
  librariesSynced: number;
  changes: MeasureChange[];
  skipped: boolean;
}

async function pmap<T, R>(items: T[], concurrency: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function syncMeasures(opts: SyncOptions): Promise<SyncResult[]> {
  const repos = opts.repos ?? DEFAULT_REPOS;
  const results: SyncResult[] = [];
  for (const rc of repos) {
    const commitSha = await resolveCommitSha(rc.repo, rc.branch, opts.token);
    const p = paths(opts.layout, rc.repo);
    const prev = readManifest(p.manifest);
    if (opts.skipIfUnchanged !== false && prev && prev.commitSha === commitSha) {
      results.push({ repo: rc.repo, branch: rc.branch, commitSha, measuresSynced: 0, librariesSynced: 0, changes: [], skipped: true });
      continue;
    }

    // List + filter
    let measureFiles = await listDir(rc.repo, rc.branch, rc.measureDir, opts.token);
    if (opts.filter) measureFiles = measureFiles.filter((f) => f.name.includes(opts.filter!));
    let libraryFiles = await listDir(rc.repo, rc.branch, rc.libraryDir, opts.token);

    mkdirSync(p.measuresDir, { recursive: true });
    mkdirSync(p.librariesDir, { recursive: true });

    // Fetch measures
    const measureEntries = await pmap(measureFiles, opts.concurrency ?? 8, async (f) => {
      const rawUrl = `${RAW_BASE}/${rc.repo}/${commitSha}/${f.path}`;
      const { body, contentHash } = await ghRaw(rawUrl);
      writeFileSync(join(p.measuresDir, f.name), body);
      const parsed = JSON.parse(body.toString('utf8')) as { name?: string; version?: string };
      const cmsId = extractCmsId(f.name);
      const id = `ecqm:${parsed.name ?? f.name.replace(/\.json$/, '')}/v${parsed.version ?? '0.0.0'}`;
      return { id, cmsId, version: parsed.version ?? '0.0.0', blobSha: f.sha, contentHash, path: f.path };
    });

    // Fetch libraries
    const libraryEntries = await pmap(libraryFiles, opts.concurrency ?? 8, async (f) => {
      const rawUrl = `${RAW_BASE}/${rc.repo}/${commitSha}/${f.path}`;
      const { body, contentHash } = await ghRaw(rawUrl);
      writeFileSync(join(p.librariesDir, f.name), body);
      const parsed = JSON.parse(body.toString('utf8')) as { name?: string; version?: string };
      const id = `${parsed.name ?? f.name.replace(/\.json$/, '')}/${parsed.version ?? '0.0.0'}`;
      return { id, name: parsed.name ?? f.name.replace(/\.json$/, ''), version: parsed.version ?? '0.0.0', blobSha: f.sha, contentHash, path: f.path };
    });

    // Change detection vs previous manifest
    const changes: MeasureChange[] = [];
    const prevMeasureById = new Map<string, RepoManifest['measures'][0]>();
    if (prev) for (const m of prev.measures) prevMeasureById.set(m.id.split('/v')[0]!, m);
    const nowMeasureByBase = new Map<string, typeof measureEntries[0]>();
    for (const m of measureEntries) nowMeasureByBase.set(m.id.split('/v')[0]!, m);

    for (const [base, m] of nowMeasureByBase) {
      const prevRec = prevMeasureById.get(base);
      if (!prevRec) changes.push({ kind: 'added', measureId: m.id, after: m.version, detectedAt: nowIso() });
      else if (prevRec.contentHash !== m.contentHash) {
        changes.push({ kind: prevRec.version !== m.version ? 'version-updated' : 'library-updated', measureId: m.id, before: prevRec.version, after: m.version, detectedAt: nowIso(), detail: `content hash ${prevRec.contentHash.slice(0, 8)} \u2192 ${m.contentHash.slice(0, 8)}` });
      }
    }
    for (const [base, prevRec] of prevMeasureById) {
      if (!nowMeasureByBase.has(base)) changes.push({ kind: 'removed', measureId: prevRec.id, before: prevRec.version, detectedAt: nowIso() });
    }

    writeManifest(p.manifest, {
      repo: rc.repo, branch: rc.branch, commitSha, syncedAt: nowIso(),
      measures: measureEntries, libraries: libraryEntries,
    });

    results.push({ repo: rc.repo, branch: rc.branch, commitSha, measuresSynced: measureEntries.length, librariesSynced: libraryEntries.length, changes, skipped: false });
  }
  return results;
}

// -------- Load (from local store, offline) --------

function toUpstream(repo: string, branch: string, commitSha: string, m: { path: string; blobSha: string; contentHash: string }, fetchedAt: ISODate): UpstreamRef {
  return {
    repo, path: m.path, blobSha: m.blobSha, commitSha,
    rawUrl: `${RAW_BASE}/${repo}/${commitSha}/${m.path}`,
    fetchedAt, contentHash: m.contentHash,
  };
}

export function loadStoredMeasures(layout: StoreLayout): StoredMeasure[] {
  const out: StoredMeasure[] = [];
  if (!existsSync(layout.root)) return out;
  for (const repoSlug of readdirSync(layout.root)) {
    const p = paths(layout, repoSlug.replace('__', '/'));
    const manifest = readManifest(p.manifest);
    if (!manifest) continue;
    for (const entry of manifest.measures) {
      const filePath = join(p.measuresDir, entry.path.split('/').pop()!);
      if (!existsSync(filePath)) continue;
      const raw = JSON.parse(readFileSync(filePath, 'utf8')) as {
        name: string; title: string; version: string; status: StoredMeasure['status'];
        effectivePeriod?: { start?: string; end?: string };
        library?: string[];
      };
      out.push({
        id: entry.id,
        cmsId: entry.cmsId,
        name: raw.name,
        title: raw.title,
        version: raw.version,
        status: raw.status,
        ...(raw.effectivePeriod ? { effectivePeriod: raw.effectivePeriod } : {}),
        libraryRefs: raw.library ?? [],
        raw,
        upstream: toUpstream(manifest.repo, manifest.branch, manifest.commitSha, entry, manifest.syncedAt),
      });
    }
  }
  return out;
}

export function loadStoredLibraries(layout: StoreLayout): StoredLibrary[] {
  const out: StoredLibrary[] = [];
  if (!existsSync(layout.root)) return out;
  for (const repoSlug of readdirSync(layout.root)) {
    const p = paths(layout, repoSlug.replace('__', '/'));
    const manifest = readManifest(p.manifest);
    if (!manifest) continue;
    for (const entry of manifest.libraries) {
      const filePath = join(p.librariesDir, entry.path.split('/').pop()!);
      if (!existsSync(filePath)) continue;
      const raw = JSON.parse(readFileSync(filePath, 'utf8')) as {
        name: string; version: string; url?: string;
        content?: { contentType: string; data?: string }[];
        dataRequirement?: { codeFilter?: { valueSet?: string }[] }[];
        relatedArtifact?: { type?: string; resource?: string }[];
      };
      const content: StoredLibrary['content'] = {};
      for (const c of raw.content ?? []) {
        if (!c.data) continue;
        const decoded = Buffer.from(c.data, 'base64').toString('utf8');
        if (c.contentType === 'text/cql') content.cql = decoded;
        else if (c.contentType === 'application/elm+json') content.elmJson = JSON.parse(decoded);
        else if (c.contentType === 'application/elm+xml') content.elmXml = decoded;
      }
      const valueSetRefs = new Set<string>();
      for (const dr of raw.dataRequirement ?? []) for (const cf of dr.codeFilter ?? []) if (cf.valueSet) valueSetRefs.add(cf.valueSet);
      const codeSystemRefs = new Set<string>();
      for (const ra of raw.relatedArtifact ?? []) if (ra.type === 'depends-on' && ra.resource?.includes('CodeSystem')) codeSystemRefs.add(ra.resource);
      out.push({
        id: entry.id,
        name: raw.name,
        version: raw.version,
        ...(raw.url ? { url: raw.url } : {}),
        content,
        valueSetRefs: [...valueSetRefs],
        codeSystemRefs: [...codeSystemRefs],
        upstream: toUpstream(manifest.repo, manifest.branch, manifest.commitSha, entry, manifest.syncedAt),
      });
    }
  }
  return out;
}

// -------- Change detection against local store (compare persisted vs upstream head) --------
export async function detectChanges(opts: { layout: StoreLayout; token?: string; repos?: readonly typeof DEFAULT_REPOS[number][] }): Promise<{ repo: string; hasUpstreamChange: boolean; localSha: string | null; upstreamSha: string }[]> {
  const repos = opts.repos ?? DEFAULT_REPOS;
  const out: { repo: string; hasUpstreamChange: boolean; localSha: string | null; upstreamSha: string }[] = [];
  for (const rc of repos) {
    const p = paths(opts.layout, rc.repo);
    const prev = readManifest(p.manifest);
    const upstream = await resolveCommitSha(rc.repo, rc.branch, opts.token);
    out.push({ repo: rc.repo, hasUpstreamChange: !prev || prev.commitSha !== upstream, localSha: prev?.commitSha ?? null, upstreamSha: upstream });
  }
  return out;
}
