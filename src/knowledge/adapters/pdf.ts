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

// Generic PDF adapter. Downloads a PDF, hashes it, extracts basic metadata,
// and produces a KnowledgeArtifact with the raw bytes stored on disk and a
// text-extraction stub that captures the number of pages. Full paragraph-
// level extraction lands in M20g (dedicated PDF extractor with pdf.js).

import type { KnowledgeAdapter, SyncInput, AdapterEvent, SyncSummary } from '../types.js';
import { buildArtifact, diffArtifact, httpFetch, loadManifest, nowIso, openSourceStore, saveManifest, sha256, writeArtifact, writeRaw } from './base.js';

interface PdfConfig { pdfUrl: string; }
const EX_VERSION = '0.20.0';

export const pdfAdapter: KnowledgeAdapter<PdfConfig> = {
  kind: 'pdf-doc', version: EX_VERSION,
  async *sync(input: SyncInput<PdfConfig>): AsyncGenerator<AdapterEvent, SyncSummary, void> {
    const store = openSourceStore(input.storeDir, input.spec.id);
    const manifest = loadManifest(store, input.spec.id);
    const url = input.config.pdfUrl;
    const res = await httpFetch(url, { accept: 'application/pdf' });
    yield { type: 'fetch', url, ok: res.ok, status: res.status, bytes: res.bytes };
    if (!res.ok) {
      yield { type: 'error', message: `PDF fetch ${res.status}`, url };
      return { totalFetched: 0, totalExtracted: 0, changes: [] };
    }
    const hash = sha256(res.body);
    const pages = countPdfPages(res.body);
    const rawWrite = writeRaw(store, `${input.spec.id}.pdf`, res.body);
    const id = `pdf_${hash.slice(0, 12)}`;
    const structured = { url, pages, byteLen: res.bytes, storedAt: rawWrite.path, note: 'Full text extraction pending PDF extractor (M20g)' };
    const artifact = buildArtifact({
      sourceSpec: input.spec, id, title: `${input.spec.name} (PDF, ${pages} pages)`,
      summary: `Downloaded ${res.bytes.toLocaleString()} bytes; sha256 ${hash.slice(0, 12)}…`,
      structured,
      raw: { url, contentType: res.contentType, bytes: res.bytes, hash, fetchedAt: nowIso() },
      extractorId: 'pdf-doc', extractorVersion: EX_VERSION,
      locator: { page: 1 },
    });
    writeArtifact(store, artifact);
    const current = [{ id, contentHash: hash }];
    const changes = diffArtifact(manifest.artifactIndex, current);
    saveManifest(store, {
      sourceId: input.spec.id, lastSyncedAt: nowIso(),
      artifactIndex: current.map((c) => ({ id: c.id, contentHash: c.contentHash, path: `artifacts/${c.id}.json` })),
    });
    return { totalFetched: 1, totalExtracted: 1, changes };
  },
};

/** Count PDF pages by counting /Type/Page (non-Pages) markers. Cheap heuristic. */
function countPdfPages(buf: Buffer): number {
  const s = buf.toString('latin1', 0, Math.min(buf.length, 5_000_000));
  const matches = s.match(/\/Type\s*\/Page(?!s)\b/g);
  return matches ? matches.length : 0;
}
