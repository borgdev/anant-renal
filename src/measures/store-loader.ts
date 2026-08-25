/******************************************************************************
 *
 * Copyright (c) 2026 AnantHQ Inc.
 * All Rights Reserved.
 *
 * This software is licensed, not sold.
 *
 * The contents of this file constitute confidential and proprietary
 * information belonging exclusively to Unison Software Technologies Pvt. Ltd.
 *
 * This source code incorporates proprietary algorithms, software architecture,
 * business logic, computational methods, optimization techniques,
 * workflows, data structures, APIs, and implementation details that are
 * protected by copyright law, patent law, trade secret law, and
 * international intellectual property treaties.
 *
 * Except as expressly permitted by a written license agreement,
 * no person or organization may:
 *
 *   • Copy or reproduce this software.
 *   • Modify or create derivative works.
 *   • Reverse engineer, decompile, or disassemble.
 *   • Benchmark or publicly disclose performance.
 *   • Redistribute, sublicense, lease, rent, or sell.
 *   • Use this software for competitive analysis.
 *   • Disclose any implementation details.
 *
 * Any unauthorized use is strictly prohibited and may result in
 * civil damages, injunctive relief, criminal prosecution,
 * and all other remedies available under applicable law.
 *
 ******************************************************************************/

// M21: Hydrate StoredMeasure/StoredLibrary from the local disk store
// populated by the source-registry sync. Base64-decodes ELM JSON.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { StoredMeasure, StoredLibrary, UpstreamRef, ISODate } from './types.js';

interface LoaderOptions { root: string }

interface RepoManifest {
  repo: string;
  branch: string;
  commitSha: string;
  syncedAt: ISODate;
  measures: { id: string; cmsId: string; version: string; blobSha: string; contentHash: string; path: string }[];
  libraries: { id: string; name: string; version: string; blobSha: string; contentHash: string; path: string }[];
}

function decodeContent(content: unknown): { cql?: string; elmJson?: unknown; elmXml?: string } {
  if (!Array.isArray(content)) return {};
  const out: { cql?: string; elmJson?: unknown; elmXml?: string } = {};
  for (const c of content as Array<{ contentType?: string; data?: string }>) {
    if (typeof c?.data !== 'string') continue;
    const bytes = Buffer.from(c.data, 'base64').toString('utf8');
    if (c.contentType === 'application/elm+json') {
      try { out.elmJson = JSON.parse(bytes); } catch { /* ignore malformed */ }
    } else if (c.contentType === 'text/cql') {
      out.cql = bytes;
    } else if (c.contentType === 'application/elm+xml') {
      out.elmXml = bytes;
    }
  }
  return out;
}

function extractRefs(elm: unknown): { valueSetRefs: string[]; codeSystemRefs: string[] } {
  const valueSetRefs: string[] = [];
  const codeSystemRefs: string[] = [];
  const lib = (elm as { library?: { valueSets?: { def?: Array<{ id?: string }> }; codeSystems?: { def?: Array<{ id?: string }> } } })?.library;
  for (const v of lib?.valueSets?.def ?? []) if (v?.id) valueSetRefs.push(v.id);
  for (const c of lib?.codeSystems?.def ?? []) if (c?.id) codeSystemRefs.push(c.id);
  return { valueSetRefs, codeSystemRefs };
}

export interface LoadedStore {
  measures: StoredMeasure[];
  libraries: StoredLibrary[];
  repoSlugs: string[];
}

export function loadFromDisk(opts: LoaderOptions): LoadedStore {
  const measures: StoredMeasure[] = [];
  const libraries: StoredLibrary[] = [];
  const repoSlugs: string[] = [];
  if (!existsSync(opts.root)) return { measures, libraries, repoSlugs };

  for (const slug of readdirSync(opts.root)) {
    const repoDir = join(opts.root, slug);
    const manifestPath = join(repoDir, 'manifest.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as RepoManifest;
    repoSlugs.push(slug);

    const measuresDir = join(repoDir, 'measure');
    if (existsSync(measuresDir)) {
      for (const f of readdirSync(measuresDir)) {
        if (!f.endsWith('.json')) continue;
        const raw = JSON.parse(readFileSync(join(measuresDir, f), 'utf8')) as {
          id?: string; name?: string; title?: string; version?: string; status?: StoredMeasure['status'];
          effectivePeriod?: { start?: string; end?: string };
          library?: string[];
        };
        const entry = manifest.measures.find((m) => m.path.endsWith('/' + f) || m.path === f);
        const cmsId = entry?.cmsId ?? (raw.id ?? f.replace(/\.json$/, ''));
        const version = entry?.version ?? raw.version ?? '0.0.0';
        const upstream: UpstreamRef = {
          repo: manifest.repo,
          path: entry?.path ?? `measure/${f}`,
          blobSha: entry?.blobSha ?? 'unknown',
          commitSha: manifest.commitSha,
          rawUrl: `https://raw.githubusercontent.com/${manifest.repo}/${manifest.commitSha}/${entry?.path ?? f}`,
          fetchedAt: manifest.syncedAt,
          contentHash: entry?.contentHash ?? 'unknown',
        };
        measures.push({
          id: `ecqm:${raw.id ?? cmsId}/${version}`,
          cmsId,
          name: raw.name ?? cmsId,
          title: raw.title ?? cmsId,
          version,
          status: raw.status ?? 'unknown',
          ...(raw.effectivePeriod ? { effectivePeriod: raw.effectivePeriod } : {}),
          libraryRefs: raw.library ?? [],
          raw,
          upstream,
        });
      }
    }

    const librariesDir = join(repoDir, 'library');
    if (existsSync(librariesDir)) {
      for (const f of readdirSync(librariesDir)) {
        if (!f.endsWith('.json')) continue;
        const raw = JSON.parse(readFileSync(join(librariesDir, f), 'utf8')) as {
          id?: string; name?: string; version?: string; url?: string; content?: unknown;
        };
        const decoded = decodeContent(raw.content);
        const refs = extractRefs(decoded.elmJson);
        const entry = manifest.libraries.find((l) => l.path.endsWith('/' + f) || l.path === f);
        const name = raw.name ?? entry?.name ?? f.replace(/\.json$/, '');
        const version = raw.version ?? entry?.version ?? '0.0.0';
        const upstream: UpstreamRef = {
          repo: manifest.repo,
          path: entry?.path ?? `library/${f}`,
          blobSha: entry?.blobSha ?? 'unknown',
          commitSha: manifest.commitSha,
          rawUrl: `https://raw.githubusercontent.com/${manifest.repo}/${manifest.commitSha}/${entry?.path ?? f}`,
          fetchedAt: manifest.syncedAt,
          contentHash: entry?.contentHash ?? 'unknown',
        };
        libraries.push({
          id: `${name}/${version}`,
          name,
          version,
          ...(raw.url ? { url: raw.url } : {}),
          content: decoded,
          valueSetRefs: refs.valueSetRefs,
          codeSystemRefs: refs.codeSystemRefs,
          upstream,
        });
      }
    }
  }
  return { measures, libraries, repoSlugs };
}
