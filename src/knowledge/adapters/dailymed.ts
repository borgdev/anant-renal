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

// NLM DailyMed SPL adapter. Uses the v2 REST service.

import type { KnowledgeAdapter, SyncInput, AdapterEvent, SyncSummary } from '../types.js';
import { buildArtifact, diffArtifact, httpFetch, loadManifest, nowIso, openSourceStore, saveManifest, sha256, writeArtifact } from './base.js';

interface DailyMedConfig { searchBase: string; splBase: string; }
const EX_VERSION = '0.20.0';

/**
 * Sync a bounded slice of DailyMed labels — we pull the most recently
 * published set. Operators can widen scope via subscription filters.
 */
export const dailymedAdapter: KnowledgeAdapter<DailyMedConfig> = {
  kind: 'dailymed-spl', version: EX_VERSION,
  async *sync(input: SyncInput<DailyMedConfig>): AsyncGenerator<AdapterEvent, SyncSummary, void> {
    const store = openSourceStore(input.storeDir, input.spec.id);
    const manifest = loadManifest(store, input.spec.id);
    const current: { id: string; contentHash: string }[] = [];
    const url = `${input.config.searchBase}?pagesize=100&page=1`;
    const res = await httpFetch(url, { accept: 'application/json' });
    yield { type: 'fetch', url, ok: res.ok, status: res.status, bytes: res.bytes };
    if (!res.ok) {
      yield { type: 'error', message: `DailyMed returned ${res.status}`, url };
      return { totalFetched: 0, totalExtracted: 0, changes: [] };
    }
    const parsed = JSON.parse(res.bodyText) as { data?: { spl_version?: number; published_date?: string; title?: string; setid?: string }[] };
    const list = parsed.data ?? [];
    let done = 0;
    for (const row of list) {
      const setid = row.setid ?? '';
      if (!setid) continue;
      if (input.filter && !input.filter(setid)) continue;
      const structured = { title: row.title, splVersion: row.spl_version, publishedDate: row.published_date, setId: setid };
      const json = JSON.stringify(structured);
      const hash = sha256(json);
      const artifact = buildArtifact({
        sourceSpec: input.spec,
        id: setid,
        title: (row.title ?? setid).slice(0, 200),
        summary: `SPL v${row.spl_version ?? '?'} published ${row.published_date ?? '?'}`,
        structured,
        raw: { url, contentType: 'application/json', bytes: json.length, hash, upstreamVersion: String(row.published_date ?? ''), fetchedAt: nowIso() },
        extractorId: 'dailymed-spl', extractorVersion: EX_VERSION,
      });
      writeArtifact(store, artifact);
      current.push({ id: setid, contentHash: hash });
      done++;
      if (done % 25 === 0) yield { type: 'progress', done, total: list.length };
    }
    const changes = diffArtifact(manifest.artifactIndex, current);
    saveManifest(store, {
      sourceId: input.spec.id, lastSyncedAt: nowIso(),
      artifactIndex: current.map((c) => ({ id: c.id, contentHash: c.contentHash, path: `artifacts/${c.id}.json` })),
    });
    return { totalFetched: list.length, totalExtracted: current.length, changes };
  },
};
