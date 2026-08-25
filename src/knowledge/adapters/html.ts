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

// Generic HTML adapter used for society/CDC/OSHA/NCQA/CAP/etc. pages.
// Strategy: fetch homepage + any listed child anchors (bounded), strip nav/scripts,
// extract main text, record provenance. Preserves the source URL as the primary
// citation locator so agents can link back to exactly what a clinician would open.

import type { KnowledgeAdapter, SyncInput, AdapterEvent, SyncSummary } from '../types.js';
import { buildArtifact, diffArtifact, httpFetch, loadManifest, nowIso, openSourceStore, saveManifest, sha256, writeArtifact } from './base.js';

interface HtmlConfig { base: string; followSelector?: string; maxPages?: number; }
const EX_VERSION = '0.20.0';

export const htmlAdapter: KnowledgeAdapter<HtmlConfig> = {
  kind: 'html-page', version: EX_VERSION,
  async *sync(input: SyncInput<HtmlConfig>): AsyncGenerator<AdapterEvent, SyncSummary, void> {
    const store = openSourceStore(input.storeDir, input.spec.id);
    const manifest = loadManifest(store, input.spec.id);
    const current: { id: string; contentHash: string }[] = [];
    const seen = new Set<string>();
    const maxPages = Math.min(input.config.maxPages ?? 10, 20);
    const queue: string[] = [input.config.base];
    let done = 0;
    while (queue.length > 0 && done < maxPages) {
      const url = queue.shift()!;
      if (seen.has(url)) continue;
      seen.add(url);
      const res = await httpFetch(url, { accept: 'text/html' });
      yield { type: 'fetch', url, ok: res.ok, status: res.status, bytes: res.bytes };
      if (!res.ok) continue;
      const { title, text, links } = extractHtml(res.bodyText, url);
      const id = `page_${sha256(url).slice(0, 12)}`;
      const structured = { url, title, textLen: text.length, links: links.slice(0, 20) };
      const json = JSON.stringify(structured);
      const hash = sha256(res.body);
      const artifact = buildArtifact({
        sourceSpec: input.spec, id, title: title.slice(0, 200), summary: text.slice(0, 500), body: text.slice(0, 20000),
        structured,
        raw: { url, contentType: 'text/html', bytes: res.bytes, hash, fetchedAt: nowIso() },
        extractorId: 'html-page', extractorVersion: EX_VERSION,
      });
      writeArtifact(store, artifact);
      current.push({ id, contentHash: hash });
      done++;
      // Enqueue in-domain children (bounded)
      if (done === 1) {
        const domain = new URL(url).origin;
        for (const l of links) {
          try {
            const abs = new URL(l, url).toString();
            if (abs.startsWith(domain) && !seen.has(abs) && !abs.includes('#')) queue.push(abs);
          } catch { /* ignore */ }
          if (queue.length >= maxPages * 3) break;
        }
      }
      yield { type: 'progress', done, total: maxPages, message: `${title.slice(0, 60)}` };
    }
    const changes = diffArtifact(manifest.artifactIndex, current);
    saveManifest(store, {
      sourceId: input.spec.id, lastSyncedAt: nowIso(),
      artifactIndex: current.map((c) => ({ id: c.id, contentHash: c.contentHash, path: `artifacts/${c.id}.json` })),
    });
    return { totalFetched: done, totalExtracted: current.length, changes };
  },
};

function extractHtml(html: string, url: string): { title: string; text: string; links: string[] } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = decode(titleMatch?.[1] ?? new URL(url).pathname);
  // Remove script/style/nav/header/footer/aside
  let body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ');
  const links: string[] = [];
  body.replace(/<a[^>]+href="([^"]+)"/gi, (_m, h) => { links.push(h); return ''; });
  const text = decode(body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
  return { title, text, links };
}

function decode(s: string): string {
  return s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
}
