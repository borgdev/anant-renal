import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapKnowledgeLayer } from '../src/knowledge/index.js';

/**
 * Adapter contract tests. We don't hit the real network — we point the sync
 * engine at an in-process HTTP server that mirrors just enough of each API to
 * exercise the pagination / hashing / manifest / provenance path deterministically.
 */
import { createServer, type Server } from 'node:http';

let server: Server;
let baseUrl = '';

beforeAll(async () => {
  await new Promise<void>((resolveReady) => {
    server = createServer((req, res) => {
      const url = req.url ?? '/';
      res.setHeader('content-type', 'application/json');
      if (url.startsWith('/openfda/enforcement')) {
        res.end(JSON.stringify({
          meta: { results: { total: 2 } },
          results: [
            { recall_number: 'R1', product_description: 'Test drug', reason_for_recall: 'Wrong label' },
            { recall_number: 'R2', product_description: 'Other drug', reason_for_recall: 'Sterility' },
          ],
        }));
      } else if (url.startsWith('/rxnav/version')) {
        res.end(JSON.stringify({ version: '2026-01-15' }));
      } else if (url.startsWith('/rxnav/rxclass/classMembers')) {
        res.end(JSON.stringify({ drugMemberGroup: { drugMember: [{ minConcept: { rxcui: '1', name: 'DrugA', tty: 'SCD' } }] } }));
      } else {
        res.statusCode = 404; res.end('{}');
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') baseUrl = `http://127.0.0.1:${addr.port}`;
      resolveReady();
    });
  });
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('M20 knowledge adapters', () => {
  const storeDir = mkdtempSync(join(tmpdir(), 'hh-knowledge-'));
  const layer = bootstrapKnowledgeLayer({ storeDir, reseedSubscriptions: false });

  it('boots substrate with all 36 canonical sources and adapters', () => {
    expect(layer.sources.list().length).toBe(36);
    expect(layer.adapters.list().length).toBe(36);
  });

  it('openfda-enforcement adapter fetches, hashes, and writes artifacts', async () => {
    // Override the base URL for this run without polluting the registry.
    const result = await layer.engine.run({
      sourceId: 'openfda.drug.enforcement',
      overridesConfig: { base: `${baseUrl}/openfda/enforcement` },
    });
    expect(result.ok).toBe(true);
    expect(result.summary?.totalExtracted).toBeGreaterThanOrEqual(2);
    const dir = join(storeDir, 'openfda.drug.enforcement', 'artifacts');
    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(dir).length).toBeGreaterThanOrEqual(2);
  });

  it('sync is idempotent — a re-run produces zero net changes', async () => {
    const second = await layer.engine.run({
      sourceId: 'openfda.drug.enforcement',
      overridesConfig: { base: `${baseUrl}/openfda/enforcement` },
    });
    expect(second.ok).toBe(true);
    expect(second.summary?.changes.length ?? 0).toBe(0);
  });

  it('rxnav-rxnorm adapter writes an ATC-class artifact per level-1 class', async () => {
    const r = await layer.engine.run({
      sourceId: 'nlm.rxnorm',
      overridesConfig: { base: `${baseUrl}/rxnav`, versionEndpoint: '/version.json' },
    });
    expect(r.ok).toBe(true);
    expect(r.summary?.totalExtracted).toBeGreaterThan(0);
  });

  afterAll(() => rmSync(storeDir, { recursive: true, force: true }));
});
