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

import { describe, expect, it } from 'vitest';
import { validateAgentSpec, AgentSpecError } from '../src/agents/spec.js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import type { PostgresEventStore } from '../src/server/postgres-event-store.js';
import type { CanonicalEvent } from '../src/healthcare-core/events.js';
import type { LedgerEntry } from '../src/hypergraph/ledger.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import type { ActorContext } from '../src/server/scoped-persistence.js';
import { SwarmWorkspaceStore, type WorkspacePersistence } from '../src/swarm/workspace.js';
import {
  agentSpecDrift,
  agentSpecSummary,
  importAgentSpecs,
  materializeAgentSpec,
  sha256,
  validateSpecYaml,
} from '../src/server/agent-spec-store.js';

const minimalSpec = {
  id: 'demo',
  version: '1.0.0',
  packId: 'test-pack',
  displayName: 'Demo Agent',
  scope: 'facility',
  trigger: { kind: 'manual' },
  plan: { type: 'step', step: { id: 's1', skill: 'llm.call', inputs: { prompt: 'hi' } } },
  governance: { phiHandling: 'none', purposeOfUse: ['operations'], clearanceRequired: 'internal' },
  billing: {},
};

describe('validateAgentSpec', () => {
  it('accepts a minimal spec and applies defaults', () => {
    const spec = validateAgentSpec(minimalSpec);
    expect(spec.id).toBe('demo');
    expect(spec.governance.hitlGates).toEqual([]);
    expect(spec.governance.breakGlassAllowed).toBe(false);
    expect(spec.billing.baseFeeUsd).toBe(0);
  });

  it('rejects bad version', () => {
    expect(() => validateAgentSpec({ ...minimalSpec, version: '1.0' })).toThrow(AgentSpecError);
  });

  it('accepts nested plan graph (sequence with parallel branch)', () => {
    const spec = validateAgentSpec({
      ...minimalSpec,
      plan: {
        type: 'sequence',
        children: [
          { type: 'step', step: { id: 'a', skill: 'llm.call', inputs: {} } },
          {
            type: 'parallel',
            children: [
              { type: 'step', step: { id: 'b', skill: 'sql.query', inputs: {} } },
              { type: 'step', step: { id: 'c', skill: 'http.call', inputs: {} } },
            ],
          },
          {
            type: 'conditional',
            when: 'state.a.ok === true',
            then: { type: 'step', step: { id: 'd', skill: 'hitl.approve', inputs: {} } },
          },
        ],
      },
    });
    expect(spec.plan.type).toBe('sequence');
  });

  it('rejects wrong purpose enum', () => {
    expect(() => validateAgentSpec({ ...minimalSpec, governance: { ...minimalSpec.governance, purposeOfUse: ['bogus'] } })).toThrow(AgentSpecError);
  });
});

/* ===========================================================================
 * Durable authoring (src/server/agent-spec-store.ts)
 *
 * Agent specs used to live only as `packs/<pack>/agents/*.yaml`, read with
 * readFileSync, with "publishing" implemented as a file RENAME. These tests
 * hold the replacement to its promises: a row per spec, import that is
 * idempotent per content hash, publish as a state transition, and materialize
 * as an EXPORT rather than the source of truth.
 * ======================================================================== */

const NOW = () => '2026-02-01T00:00:00.000Z';

function memPersistence(): WorkspacePersistence {
  const rows = new Map<string, { kind: string; id: string; entityJson: string; createdAt: string; updatedAt: string }>();
  return {
    async list(kind) {
      return [...rows.values()]
        .filter((r) => r.kind === kind)
        .map((r) => ({ id: r.id, entityJson: r.entityJson, createdAt: r.createdAt, updatedAt: r.updatedAt }));
    },
    async save(kind, id, entityJson, createdAt, updatedAt) {
      const at = updatedAt ?? NOW();
      rows.set(`${kind}:${id}`, { kind, id, entityJson, createdAt: createdAt ?? at, updatedAt: at });
    },
    async remove(kind, id) {
      rows.delete(`${kind}:${id}`);
    },
  };
}

function newStore(): SwarmWorkspaceStore {
  return new SwarmWorkspaceStore(memPersistence(), NOW);
}

const trees: string[] = [];

/** A spec tree built per test — never the 400-file repository tree. */
function mkTree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-specs-'));
  trees.push(dir);
  return dir;
}

function putFile(baseDir: string, relPath: string, content: string): string {
  const full = join(baseDir, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
  return full;
}

/** The smallest YAML that satisfies AgentSpecSchema (billing is required). */
function specYaml(id: string, packId: string, overrides: { version?: string; extra?: string } = {}): string {
  return [
    `id: ${id}`,
    `version: ${overrides.version ?? '1.0.0'}`,
    `packId: ${packId}`,
    `displayName: ${id.replace(/-/g, ' ')}`,
    'description: fixture',
    'scope: patient',
    'trigger:',
    '  kind: manual',
    'plan:',
    '  type: step',
    '  step:',
    '    id: s1',
    '    skill: llm.call',
    'governance:',
    '  phiHandling: none',
    '  purposeOfUse: [treatment]',
    '  clearanceRequired: internal',
    'billing: {}',
    ...(overrides.extra ? overrides.extra.split('\n') : []),
    '',
  ].join('\n');
}

describe('validateSpecYaml', () => {
  it('accepts a valid spec and returns the parsed identity', () => {
    const result = validateSpecYaml(specYaml('triage', 'demo-pack'));
    expect(result.ok).toBe(true);
    expect(result.spec?.id).toBe('triage');
    expect(result.spec?.packId).toBe('demo-pack');
    expect(result.spec?.version).toBe('1.0.0');
  });

  it('names the schema issues instead of throwing the way validateAgentSpec does', () => {
    const result = validateSpecYaml(['id: broken', 'version: not-semver', 'packId: p', ''].join('\n'));
    expect(result.ok).toBe(false);
    expect(result.spec).toBeUndefined();
    expect(result.errors.length).toBeGreaterThan(1);
    expect(result.errors.some((e) => /version/.test(e))).toBe(true);
    expect(result.errors.every((e) => typeof e === 'string' && e.length > 0)).toBe(true);
  });
});

describe('importAgentSpecs', () => {
  it('creates a row per file, marks published/draft, and is idempotent per content hash', async () => {
    const store = newStore();
    const base = mkTree();
    putFile(base, 'demo-pack/agents/triage.yaml', specYaml('triage', 'demo-pack'));
    putFile(base, 'demo-pack/drafts/new-agent.yaml', specYaml('new-agent', 'demo-pack'));

    const first = await importAgentSpecs(store, { baseDir: base });
    expect(first).toMatchObject({ scanned: 2, created: 2, published: 1, drafts: 1, skipped: 0 });

    // A file in agents/ is published, and the tree's implication is stamped.
    const triage = await store.getAgentSpec('demo-pack', 'triage');
    expect(triage?.status).toBe('published');
    expect(triage?.publishedAt).toBe(NOW());
    expect(triage?.publishedBy).toBe('import:packs-tree');
    expect(triage?.contentSha256).toBe(sha256(specYaml('triage', 'demo-pack')));
    expect(triage?.importedFrom).toContain(join('demo-pack', 'agents', 'triage.yaml'));

    const draft = await store.getAgentSpec('demo-pack', 'new-agent');
    expect(draft?.status).toBe('draft');
    expect(draft?.publishedAt).toBeUndefined();

    const second = await importAgentSpecs(store, { baseDir: base });
    expect(second).toMatchObject({ created: 0, updated: 0, unchanged: 2, skipped: 0 });
  });

  it('updates a changed file, and lets a draft declare in-review in its front matter', async () => {
    const store = newStore();
    const base = mkTree();
    const path = putFile(base, 'p/agents/a.yaml', specYaml('a', 'p'));
    putFile(base, 'p/drafts/b.yaml', `# status: in-review\n${specYaml('b', 'p')}`);

    await importAgentSpecs(store, { baseDir: base });
    expect((await store.getAgentSpec('p', 'b'))?.status).toBe('in-review');

    const changed = specYaml('a', 'p', { version: '2.0.0', extra: 'labels:\n  team: renal' });
    writeFileSync(path, changed);
    const report = await importAgentSpecs(store, { baseDir: base });
    expect(report).toMatchObject({ updated: 1, unchanged: 1 });

    const updated = await store.getAgentSpec('p', 'a');
    expect(updated?.version).toBe('2.0.0');
    expect(updated?.contentSha256).toBe(sha256(changed));
  });

  it('skips an invalid spec and names the file, rather than importing something broken', async () => {
    const store = newStore();
    const base = mkTree();
    putFile(base, 'p/agents/good.yaml', specYaml('good', 'p'));
    putFile(base, 'p/agents/bad.yaml', 'id: bad\nversion: nope\n');

    const report = await importAgentSpecs(store, { baseDir: base });
    expect(report).toMatchObject({ scanned: 2, created: 1, skipped: 1 });
    expect(report.errors.some((e) => e.path.endsWith('bad.yaml'))).toBe(true);
    expect(await store.getAgentSpec('p', 'bad')).toBeUndefined();
  });

  it('never deletes a row because a file vanished — it reports the drift instead', async () => {
    const store = newStore();
    const base = mkTree();
    const path = putFile(base, 'p/agents/gone.yaml', specYaml('gone', 'p'));
    await importAgentSpecs(store, { baseDir: base });

    unlinkSync(path);
    const report = await importAgentSpecs(store, { baseDir: base });
    expect(report.scanned).toBe(0);
    // Deletion is an explicit act; a missing file is a state the row reports.
    expect(await store.getAgentSpec('p', 'gone')).toBeTruthy();
    expect(await agentSpecDrift(store, base)).toMatchObject({ onlyInStore: ['p:gone'], onlyOnDisk: [], inSync: 0 });
  });

  it('dryRun reports what it would do and writes nothing', async () => {
    const store = newStore();
    const base = mkTree();
    putFile(base, 'p/agents/a.yaml', specYaml('a', 'p'));
    const report = await importAgentSpecs(store, { baseDir: base, dryRun: true });
    expect(report.created).toBe(1);
    expect(await store.listAgentSpecs()).toHaveLength(0);
  });
});

describe('agentSpecDrift', () => {
  it('reports onlyOnDisk and differing against the rows without importing', async () => {
    const store = newStore();
    const base = mkTree();
    const path = putFile(base, 'p/agents/a.yaml', specYaml('a', 'p'));
    await importAgentSpecs(store, { baseDir: base });

    putFile(base, 'p/agents/never-imported.yaml', specYaml('never-imported', 'p'));
    writeFileSync(path, specYaml('a', 'p', { version: '3.0.0' }));

    expect(await agentSpecDrift(store, base)).toMatchObject({
      onlyOnDisk: ['p:never-imported'],
      differing: ['p:a'],
      inSync: 0,
    });
  });

  it('agentSpecSummary counts statuses and says whether the tree was ever imported', async () => {
    const store = newStore();
    const base = mkTree();
    putFile(base, 'p/agents/a.yaml', specYaml('a', 'p'));
    putFile(base, 'p/drafts/b.yaml', specYaml('b', 'p'));

    const before = await agentSpecSummary(store, base);
    expect(before.total).toBe(0);
    // The console must be told to import rather than shown "no agents".
    expect(before.imported).toBe(false);

    await importAgentSpecs(store, { baseDir: base });
    const after = await agentSpecSummary(store, base);
    expect(after.total).toBe(2);
    expect(after.byStatus).toMatchObject({ published: 1, draft: 1 });
    expect(after.imported).toBe(true);
    expect(after.drift.inSync).toBe(2);
  });
});

describe('publish is a state transition, not a rename', () => {
  it('keeps the row, stamps who/when, and an edit does not unpublish it', async () => {
    const store = newStore();
    const base = mkTree();
    putFile(base, 'p/drafts/a.yaml', specYaml('a', 'p'));
    await importAgentSpecs(store, { baseDir: base });

    const published = await store.publishAgentSpec('p', 'a', 'console:operator');
    expect(published).toMatchObject({ status: 'published', publishedAt: NOW(), publishedBy: 'console:operator' });
    expect(await store.getAgentSpec('p', 'a')).toBeTruthy();

    const edited = await store.saveAgentSpec({
      packId: 'p',
      agentId: 'a',
      yaml: specYaml('a', 'p', { version: '1.1.0' }),
      contentSha256: sha256(specYaml('a', 'p', { version: '1.1.0' })),
      authorRef: 'console:operator',
      version: '1.1.0',
    });
    expect(edited).toMatchObject({ status: 'published', publishedBy: 'console:operator', version: '1.1.0' });

    expect(await store.publishAgentSpec('p', 'missing', 'console:operator')).toBeUndefined();
  });

  it('lists published rows before drafts and filters by status', async () => {
    const store = newStore();
    const base = mkTree();
    putFile(base, 'p/agents/zzz.yaml', specYaml('zzz', 'p'));
    putFile(base, 'p/drafts/aaa.yaml', specYaml('aaa', 'p'));
    await importAgentSpecs(store, { baseDir: base });

    expect((await store.listAgentSpecs('published')).map((r) => r.agentId)).toEqual(['zzz']);
    expect((await store.listAgentSpecs()).map((r) => r.agentId)).toEqual(['zzz', 'aaa']);
  });

  it('deletes explicitly, and says so when there was nothing to delete', async () => {
    const store = newStore();
    const base = mkTree();
    putFile(base, 'p/agents/a.yaml', specYaml('a', 'p'));
    await importAgentSpecs(store, { baseDir: base });

    expect(await store.deleteAgentSpec('p', 'a')).toBe(true);
    expect(await store.getAgentSpec('p', 'a')).toBeUndefined();
    expect(await store.deleteAgentSpec('p', 'a')).toBe(false);
  });
});

describe('materializeAgentSpec', () => {
  it('exports a published row to agents/ and records the hash it wrote', async () => {
    const store = newStore();
    const base = mkTree();
    putFile(base, 'p/drafts/a.yaml', specYaml('a', 'p'));
    await importAgentSpecs(store, { baseDir: base });
    await store.publishAgentSpec('p', 'a', 'console:operator');

    const result = await materializeAgentSpec(store, 'p', 'a', join(base, 'out'));
    expect(result?.path).toContain(join('p', 'agents', 'a.yaml'));
    const written = readFileSync(result!.path, 'utf8');
    expect(result?.contentSha256).toBe(sha256(written));
    // The row remembers the bytes it exported, so "edited after export" is visible.
    expect((await store.getAgentSpec('p', 'a'))?.materializedSha256).toBe(result?.contentSha256);
    expect((await store.getAgentSpec('p', 'a'))?.materializedAt).toBe(NOW());
  });

  it('exports a draft to drafts/ with a self-describing status comment', async () => {
    const store = newStore();
    const base = mkTree();
    putFile(base, 'p/drafts/a.yaml', specYaml('a', 'p'));
    await importAgentSpecs(store, { baseDir: base });

    const result = await materializeAgentSpec(store, 'p', 'a', join(base, 'out'));
    expect(result?.path).toContain(join('p', 'drafts', 'a.yaml'));
    const written = readFileSync(result!.path, 'utf8');
    expect(written.startsWith('# status: draft\n')).toBe(true);
    expect(result?.contentSha256).toBe(sha256(written));
  });

  it('returns undefined for a row that does not exist', async () => {
    expect(await materializeAgentSpec(newStore(), 'p', 'nope', mkTree())).toBeUndefined();
  });
});

/* ---------- the ops-console routes ---------- */

function inMemoryStore(): PostgresEventStore {
  const events: CanonicalEvent[] = [];
  const ledger: LedgerEntry[] = [];
  const audit: unknown[] = [];
  return {
    async applyMigrations() { /* noop */ },
    async appendEvent(_scope: { scopeId: string; actorRef: string }, ev: CanonicalEvent) { events.push(ev); },
    async queryEvents() { return events; },
    async ledgerAppend(_scope: { scopeId: string; actorRef: string }, e: LedgerEntry) { ledger.push(e); },
    async ledgerQuery() { return ledger; },
    async appendAudit(_scope: { scopeId: string; actorRef: string }, row: unknown) { audit.push(row); },
    async queryAudit() { return audit; },
    async recordFhirResource() { /* noop */ },
    async listFhirResources() { return []; },
  } as unknown as PostgresEventStore;
}

const actor: ActorContext = {
  actorRef: 'user:test',
  scopeIds: ['scope:*'],
  clearance: 'restricted-phi',
  purposeOfUse: 'operations',
} as ActorContext;

async function build() {
  // adminApiAuth: true → /admin/* needs a session + role.
  return buildApp({
    store: inMemoryStore(),
    telemetry: new Telemetry('test', new InMemorySink()),
    packs: [healthcareCorePack],
    authenticate: async () => actor,
    checkHealth: async () => ({ db: true, redis: true }),
    adminApiAuth: true,
  });
}

type App = Awaited<ReturnType<typeof build>>;

async function login(app: App, username: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { username, password } });
  const setCookie = res.headers['set-cookie'];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';')[0] ?? '';
  expect(res.statusCode).toBe(200);
  return cookie;
}

describe('agent spec routes', () => {
  it('refuses YAML the schema rejects, naming the fields', async () => {
    const app = await build();
    const cookie = await login(app, 'nurse', 'nurse123');
    const res = await app.inject({
      method: 'POST',
      url: '/admin/platform/agent-specs',
      headers: { cookie },
      payload: { packId: 'p', agentId: 'a', yaml: 'id: a\nversion: nope\n' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('agent-spec-invalid');
    expect(res.json().issues.length).toBeGreaterThan(0);
  });

  it('refuses YAML whose identity disagrees with the request', async () => {
    const app = await build();
    const cookie = await login(app, 'nurse', 'nurse123');
    const res = await app.inject({
      method: 'POST',
      url: '/admin/platform/agent-specs',
      headers: { cookie },
      payload: { packId: 'p', agentId: 'a', yaml: specYaml('other', 'p') },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('agent-spec-identity-mismatch');
  });

  it('requires packId, agentId and yaml', async () => {
    const app = await build();
    const cookie = await login(app, 'nurse', 'nurse123');
    const res = await app.inject({
      method: 'POST',
      url: '/admin/platform/agent-specs',
      headers: { cookie },
      payload: { packId: 'p', agentId: 'a' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('packId-agentId-and-yaml-required');
  });

  it('creates, reads, publishes and deletes a spec through the ops surface', async () => {
    const app = await build();
    const cookie = await login(app, 'nurse', 'nurse123');
    const packId = 'route-test-pack';
    const agentId = 'route-test-agent';

    const created = await app.inject({
      method: 'POST',
      url: '/admin/platform/agent-specs',
      headers: { cookie },
      payload: { packId, agentId, yaml: specYaml(agentId, packId) },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().created).toBe(true);
    expect(created.json().spec.status).toBe('draft');
    expect(created.json().spec.contentSha256).toMatch(/^[0-9a-f]{64}$/);

    const read = await app.inject({
      method: 'GET',
      url: `/admin/platform/agent-specs/${packId}/${agentId}`,
      headers: { cookie },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().spec.agentId).toBe(agentId);

    const published = await app.inject({
      method: 'POST',
      url: `/admin/platform/agent-specs/${packId}/${agentId}/publish`,
      headers: { cookie },
      payload: { note: 'route test' },
    });
    expect(published.statusCode).toBe(200);
    expect(published.json().spec).toMatchObject({ status: 'published', publishedBy: 'console:operator' });
    // publish must not write into the repository tree unless asked.
    expect(published.json().exported).toBeUndefined();

    const removed = await app.inject({
      method: 'DELETE',
      url: `/admin/platform/agent-specs/${packId}/${agentId}`,
      headers: { cookie },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().ok).toBe(true);

    const gone = await app.inject({
      method: 'GET',
      url: `/admin/platform/agent-specs/${packId}/${agentId}`,
      headers: { cookie },
    });
    expect(gone.statusCode).toBe(404);
    expect(gone.json().error).toBe('agent-spec-not-found');
  });

  it('404s publish and delete for an unknown spec', async () => {
    const app = await build();
    const cookie = await login(app, 'nurse', 'nurse123');
    const publish = await app.inject({
      method: 'POST',
      url: '/admin/platform/agent-specs/nope-pack/nope-agent/publish',
      headers: { cookie },
      payload: {},
    });
    expect(publish.statusCode).toBe(404);
    const del = await app.inject({
      method: 'DELETE',
      url: '/admin/platform/agent-specs/nope-pack/nope-agent',
      headers: { cookie },
    });
    expect(del.statusCode).toBe(404);
  });

  it('a read-only role may read agent specs but may not change them', async () => {
    const app = await build();
    const cookie = await login(app, 'auditor', 'audit123');

    const drift = await app.inject({ method: 'GET', url: '/admin/platform/agent-specs/drift', headers: { cookie } });
    expect(drift.statusCode).toBe(200);
    expect(drift.json().drift).toBeTruthy();

    const list = await app.inject({ method: 'GET', url: '/admin/platform/agent-specs', headers: { cookie } });
    expect(list.statusCode).toBe(200);

    const write = await app.inject({
      method: 'POST',
      url: '/admin/platform/agent-specs',
      headers: { cookie },
      payload: { packId: 'p', agentId: 'a', yaml: specYaml('a', 'p') },
    });
    expect(write.statusCode).toBe(403);
    expect(write.json().error).toBe('read-only-role');

    const remove = await app.inject({ method: 'DELETE', url: '/admin/platform/agent-specs/p/anything', headers: { cookie } });
    expect(remove.statusCode).toBe(403);
    expect(remove.json().error).toBe('read-only-role');

    const publish = await app.inject({
      method: 'POST',
      url: '/admin/platform/agent-specs/p/anything/publish',
      headers: { cookie },
      payload: {},
    });
    expect(publish.statusCode).toBe(403);
    expect(publish.json().error).toBe('read-only-role');

    const imported = await app.inject({
      method: 'POST',
      url: '/admin/platform/agent-specs/import',
      headers: { cookie },
      payload: { dryRun: true },
    });
    expect(imported.statusCode).toBe(403);
    expect(imported.json().error).toBe('read-only-role');
  });

  it('is 401 unauthenticated, like the rest of /admin/*', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/admin/platform/agent-specs/drift' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('not-authenticated');
  });
});

describe('temp spec trees', () => {
  it('are removed', () => {
    expect(trees.length).toBeGreaterThan(0);
    for (const dir of trees) rmSync(dir, { recursive: true, force: true });
  });
});
