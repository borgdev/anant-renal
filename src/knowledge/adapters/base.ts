// Shared helpers for KnowledgeAdapter implementations.
// - HTTP with retries/backoff + honest error surfacing
// - Content hashing
// - On-disk store layout per source: <storeDir>/<sourceId>/{manifest.json, artifacts/*, raw/*}
// - Artifact write helpers with provenance stamping

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { KnowledgeArtifact, UpstreamRef, KnowledgeSourceSpec, SourceChange } from '../types.js';

export function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}
export function shortHash(s: string): string { return sha256(s).slice(0, 16); }

export function nowIso(): string { return new Date().toISOString(); }

export interface HttpOpts {
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  method?: 'GET' | 'POST';
  body?: string | Buffer;
  accept?: string;
}

export interface HttpResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: Buffer;
  bodyText: string;
  contentType: string;
  bytes: number;
  url: string;
}

export async function httpFetch(url: string, opts: HttpOpts = {}): Promise<HttpResponse> {
  const attempts = Math.max(1, opts.retries ?? 3);
  const timeoutMs = opts.timeoutMs ?? 20_000;
  let lastErr: unknown = null;
  for (let i = 0; i < attempts; i++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: opts.method ?? 'GET',
        headers: {
          'user-agent': 'healthcare-harness-knowledge/0.20 (contact: ops)',
          ...(opts.accept ? { accept: opts.accept } : {}),
          ...(opts.headers ?? {}),
        },
        ...(opts.body ? { body: opts.body } : {}),
        signal: ac.signal,
      });
      clearTimeout(t);
      const ab = await res.arrayBuffer();
      const body = Buffer.from(ab);
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => { headers[k] = v; });
      const contentType = headers['content-type'] ?? 'application/octet-stream';
      const bodyText = looksBinary(contentType) ? '' : body.toString('utf8');
      // Retry on 429/5xx
      if ((res.status === 429 || res.status >= 500) && i < attempts - 1) {
        const backoff = 500 * Math.pow(2, i) + Math.floor(Math.random() * 250);
        await sleep(backoff);
        continue;
      }
      return { status: res.status, ok: res.ok, headers, body, bodyText, contentType, bytes: body.byteLength, url };
    } catch (e) {
      clearTimeout(t);
      lastErr = e;
      if (i < attempts - 1) {
        const backoff = 500 * Math.pow(2, i) + Math.floor(Math.random() * 250);
        await sleep(backoff);
        continue;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`httpFetch failed: ${url}`);
}

function looksBinary(ct: string): boolean {
  return /^(application\/(pdf|zip|octet-stream|x-)|image\/|audio\/|video\/)/.test(ct);
}
export function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

// ---- Store layout ----

export interface SourceStore {
  root: string;
  raw: string;
  artifacts: string;
  manifestPath: string;
  cachePath: string;
}

export function openSourceStore(baseDir: string, sourceId: string): SourceStore {
  const root = join(baseDir, sourceId);
  const raw = join(root, 'raw');
  const artifacts = join(root, 'artifacts');
  mkdirSync(raw, { recursive: true });
  mkdirSync(artifacts, { recursive: true });
  return { root, raw, artifacts, manifestPath: join(root, 'manifest.json'), cachePath: join(root, 'cache.json') };
}

export interface SourceManifest {
  sourceId: string;
  upstreamVersion?: string;
  lastSyncedAt?: string;
  artifactIndex: { id: string; contentHash: string; upstreamVersion?: string; path: string }[];
}

export function loadManifest(store: SourceStore, sourceId: string): SourceManifest {
  if (!existsSync(store.manifestPath)) return { sourceId, artifactIndex: [] };
  return JSON.parse(readFileSync(store.manifestPath, 'utf8')) as SourceManifest;
}

export function saveManifest(store: SourceStore, manifest: SourceManifest): void {
  writeFileSync(store.manifestPath, JSON.stringify(manifest, null, 2));
}

// ---- Artifact builder ----

export interface BuildArtifactInput {
  sourceSpec: KnowledgeSourceSpec;
  id: string;
  title: string;
  summary?: string;
  body?: string;
  structured?: unknown;
  clinicalDomains?: string[];
  effective?: { start?: string; end?: string };
  raw: {
    url: string;
    contentType: string;
    bytes: number;
    hash: string;
    upstreamVersion?: string;
    fetchedAt: string;
  };
  extractorId: string;
  extractorVersion: string;
  locator?: UpstreamRef['locator'];
}

export function buildArtifact(input: BuildArtifactInput): KnowledgeArtifact {
  const nowStamp = nowIso();
  const upstream: UpstreamRef = {
    sourceId: input.sourceSpec.id,
    sourceVersion: input.raw.upstreamVersion ?? 'unversioned',
    canonicalUrl: input.sourceSpec.homepage,
    rawUrl: input.raw.url,
    fetchedAt: input.raw.fetchedAt,
    contentHash: input.raw.hash,
    contentType: input.raw.contentType,
    contentBytes: input.raw.bytes,
    extractorId: input.extractorId,
    extractorVersion: input.extractorVersion,
    ...(input.locator ? { locator: input.locator } : {}),
  };
  return {
    id: input.id,
    sourceId: input.sourceSpec.id,
    category: input.sourceSpec.category,
    title: input.title,
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
    ...(input.body !== undefined ? { body: input.body } : {}),
    ...(input.structured !== undefined ? { structured: input.structured } : {}),
    clinicalDomains: input.clinicalDomains ?? input.sourceSpec.clinicalDomains,
    ...(input.effective ? { effective: input.effective } : {}),
    upstream,
    createdAt: nowStamp,
    updatedAt: nowStamp,
  };
}

export function writeArtifact(store: SourceStore, artifact: KnowledgeArtifact): { path: string } {
  const safeId = artifact.id.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
  const path = join(store.artifacts, `${safeId}.json`);
  writeFileSync(path, JSON.stringify(artifact, null, 2));
  return { path };
}

export function writeRaw(store: SourceStore, name: string, buf: Buffer | string): { path: string; hash: string } {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
  const path = join(store.raw, safe);
  writeFileSync(path, buf);
  const hash = sha256(typeof buf === 'string' ? Buffer.from(buf) : buf);
  return { path, hash };
}

// ---- Change diff ----

export function diffArtifact(prevIndex: SourceManifest['artifactIndex'], current: { id: string; contentHash: string }[]): SourceChange[] {
  const prevMap = new Map(prevIndex.map((x) => [x.id, x.contentHash]));
  const curMap = new Map(current.map((x) => [x.id, x.contentHash]));
  const changes: SourceChange[] = [];
  for (const [id, h] of curMap.entries()) {
    if (!prevMap.has(id)) changes.push({ kind: 'added', artifactId: id, after: h });
    else if (prevMap.get(id) !== h) {
      const before = prevMap.get(id);
      changes.push({ kind: 'updated', artifactId: id, ...(before !== undefined ? { before } : {}), after: h });
    }
  }
  for (const [id, h] of prevMap.entries()) {
    if (!curMap.has(id)) changes.push({ kind: 'removed', artifactId: id, before: h });
  }
  return changes;
}

// ---- Concurrency ----

export async function pMap<T, R>(items: T[], fn: (item: T, index: number) => Promise<R>, concurrency: number): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  const workers = new Array(Math.min(concurrency, items.length)).fill(0).map(async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}
