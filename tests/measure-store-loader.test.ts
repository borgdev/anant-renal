// M21e: verify the disk loader hydrates the real cqframework store into the
// evaluator shape, and the agent tool `evaluate_measure` is registered.

import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadFromDisk } from '../src/measures/store-loader.js';
import { buildKnowledgeToolBus } from '../src/knowledge/agents/tool-bus.js';
import { bootstrapKnowledgeLayer } from '../src/knowledge/index.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const REAL_ROOT = join(process.cwd(), '.harness/measures');

describe('M21 measure store loader', () => {
  it('hydrates measures and libraries from the on-disk cqframework store', () => {
    // Use a relative resolution: the harness workspace root may be
    // /tmp/healthcare-harness while the measures cache is under /home/user/workspace.
    // Skip cleanly if the fixture snapshot isn't present on this machine.
    const candidate = existsSync(REAL_ROOT) ? REAL_ROOT : '/home/user/workspace/.harness/measures';
    if (!existsSync(candidate)) {
      // Nothing synced locally in this environment; the loader must still
      // handle the absent-root case without throwing.
      const store = loadFromDisk({ root: '/tmp/does-not-exist' });
      expect(store.measures).toHaveLength(0);
      expect(store.libraries).toHaveLength(0);
      return;
    }
    const store = loadFromDisk({ root: candidate });
    expect(store.measures.length).toBeGreaterThan(0);
    expect(store.libraries.length).toBeGreaterThan(0);
    const cms165 = store.measures.find((m) => m.cmsId?.includes('CMS165'));
    if (cms165) {
      expect(cms165.libraryRefs.length).toBeGreaterThan(0);
      expect(cms165.upstream.repo).toMatch(/cqframework/);
      expect(cms165.upstream.rawUrl).toMatch(/^https:\/\//);
    }
    // Every hydrated library that has ELM contains a parsed library identifier.
    const withElm = store.libraries.filter((l) => l.content.elmJson !== undefined);
    expect(withElm.length).toBeGreaterThan(0);
    for (const lib of withElm.slice(0, 5)) {
      const elm = lib.content.elmJson as { library?: { identifier?: { id?: string } } };
      expect(elm.library?.identifier?.id).toBeDefined();
    }
  });

  it('registers evaluate_measure on the knowledge tool bus', () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'hh-kl-'));
    const layer = bootstrapKnowledgeLayer({ storeDir });
    const tools = buildKnowledgeToolBus({ layer, actorId: 'test', episodeId: 'test' });
    const names = tools.map((t) => t.name);
    expect(names).toContain('evaluate_measure');
    const t = tools.find((x) => x.name === 'evaluate_measure')!;
    expect(t.description).toMatch(/measure/i);
    expect((t.parameters as { required: string[] }).required).toContain('measureId');
    expect((t.parameters as { required: string[] }).required).toContain('bundle');
  });
});
