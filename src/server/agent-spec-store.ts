/*
 * Copyright (c) 2026 AnantHQ Inc. All rights reserved.
 *
 * Agent specs — durable authoring over the repository YAML tree.
 *
 * THE GAP THIS CLOSES
 * -------------------
 * 438 agent specifications lived only as YAML — 437 in `packs/<packId>/agents/`
 * and 1 in `packs/<packId>/drafts/` — read with `readFileSync` and `readdirSync`.
 * (The other 14 YAML files under `packs/` are per-pack `manifest.yaml`, which is
 * a different document and is deliberately not scanned here.) Authoring wrote the
 * filesystem directly and "publishing" was a file RENAME — so there was:
 *
 *   - no row, therefore no audit record the API could serve and no content hash a
 *     console could display;
 *   - no way to author an agent from either console: the Agent Studio read a
 *     hardcoded 6-pack list (`PACK_ROOTS` in admin-routes.ts) and so reported
 *     172 of the 437 specs, none of which it could change. The count and the
 *     list are both now known to be wrong, which is a direct result of having a
 *     registry to compare against;
 *   - nothing to reconcile: a hand-edited file and the registry silently disagreed.
 *
 * Every other configuration in the product is a durable `swarm_workspace` document.
 * This module makes agent specs the same, with the YAML tree as an IMPORT SOURCE
 * and an EXPORT TARGET rather than the source of truth.
 *
 * Importing is idempotent per content hash, so it can run on every boot: a file
 * that already matches its row is skipped, a file that changed is updated, and a
 * row whose file disappeared keeps its content and reports itself as not on disk.
 ******************************************************************************/

import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import type { SwarmWorkspaceStore, AgentSpecRecord, AgentSpecStatus } from '../swarm/workspace.js';
import { validateAgentSpec, type AgentSpec } from '../agents/index.js';

export interface SpecValidation {
  ok: boolean;
  errors: string[];
  spec?: AgentSpec;
}

export interface ImportReport {
  scanned: number;
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  errors: Array<{ path: string; error: string }>;
  published: number;
  drafts: number;
}

export interface MaterializeResult {
  packId: string;
  agentId: string;
  path: string;
  bytes: number;
  contentSha256: string;
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Validate a spec's YAML and pull out the identity the store keys on.
 *  `validateAgentSpec` THROWS on an invalid spec rather than returning a result,
 *  so the failure is caught here and turned into a reportable error. */
export function validateSpecYaml(yaml: string): SpecValidation {
  try {
    const parsed = parseYaml(yaml);
    return { ok: true, errors: [], spec: validateAgentSpec(parsed) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const issues = (err as { issues?: Array<{ path?: Array<string | number>; message?: string }> }).issues;
    const detail = Array.isArray(issues) && issues.length
      ? issues.map((i) => `${(i.path ?? []).join('.') || 'spec'}: ${i.message ?? 'invalid'}`)
      : [message];
    return { ok: false, errors: detail };
  }
}

/** The pack tree's layout: `packs/<packId>/agents/` and `packs/<packId>/drafts/`. */
interface LocatedSpec {
  packId: string;
  agentId: string;
  status: AgentSpecStatus;
  yaml: string;
  path: string;
}

function listPackDirs(baseDir: string): string[] {
  if (!existsSync(baseDir)) return [];
  return readdirSync(baseDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => name !== 'node_modules' && !name.startsWith('.'));
}

/** Read the repository tree once. Never throws on a single bad directory. */
export function scanSpecTree(baseDir = 'packs'): { located: LocatedSpec[]; errors: Array<{ path: string; error: string }> } {
  const located: LocatedSpec[] = [];
  const errors: Array<{ path: string; error: string }> = [];
  for (const packId of listPackDirs(baseDir)) {
    const dirs: Array<{ dir: string; status: AgentSpecStatus }> = [
      { dir: 'agents', status: 'published' },
      { dir: 'drafts', status: 'draft' },
    ];
    for (const { dir, status } of dirs) {
      const full = join(baseDir, packId, dir);
      let files: string[];
      try {
        if (!existsSync(full)) continue;
        files = readdirSync(full).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
      } catch (err) {
        errors.push({ path: full, error: err instanceof Error ? err.message : String(err) });
        continue;
      }
      for (const file of files) {
        const path = join(full, file);
        try {
          const yaml = readFileSync(path, 'utf8');
          // The draft's own front-matter can say `in-review`; the directory says draft.
          const declared = /^#\s*status:\s*(draft|in-review)/m.exec(yaml)?.[1] as AgentSpecStatus | undefined;
          located.push({
            packId,
            agentId: file.replace(/\.ya?ml$/, ''),
            status: status === 'published' ? 'published' : (declared ?? 'draft'),
            yaml,
            path,
          });
        } catch (err) {
          errors.push({ path, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  }
  return { located, errors };
}

/**
 * Seed the durable store from the repository tree. Idempotent per content hash:
 * run it on every boot and it costs one read per file and zero writes when nothing
 * changed. A row is never deleted because a file is missing — the row is the
 * source of truth, and "not on disk" is a state it reports.
 */
export async function importAgentSpecs(store: SwarmWorkspaceStore, opts: { baseDir?: string; actorRef?: string; dryRun?: boolean } = {}): Promise<ImportReport> {
  const baseDir = opts.baseDir ?? 'packs';
  const actorRef = opts.actorRef ?? 'import:packs-tree';
  const { located, errors } = scanSpecTree(baseDir);
  const report: ImportReport = { scanned: located.length, created: 0, updated: 0, unchanged: 0, skipped: 0, errors, published: 0, drafts: 0 };

  for (const found of located) {
    const validation = validateSpecYaml(found.yaml);
    if (!validation.ok || !validation.spec) {
      report.skipped += 1;
      report.errors.push({ path: found.path, error: `invalid: ${validation.errors.join('; ')}` });
      continue;
    }
    const contentSha256 = sha256(found.yaml);
    if (found.status === 'published') report.published += 1; else report.drafts += 1;

    const existing = await store.getAgentSpec(found.packId, found.agentId);
    if (existing && existing.contentSha256 === contentSha256 && existing.status === found.status) {
      report.unchanged += 1;
      continue;
    }
    if (opts.dryRun) {
      if (existing) report.updated += 1; else report.created += 1;
      continue;
    }
    await store.saveAgentSpec({
      packId: found.packId,
      agentId: found.agentId,
      yaml: found.yaml,
      contentSha256,
      authorRef: actorRef,
      status: found.status,
      version: validation.spec.version,
      displayName: validation.spec.displayName ?? found.agentId,
      note: `imported from ${found.path}`,
      importedFrom: found.path,
    });
    // An imported published file is published: record the stamp the tree implies.
    if (found.status === 'published' && !existing?.publishedAt) {
      await store.publishAgentSpec(found.packId, found.agentId, actorRef, `imported from ${found.path}`);
    }
    if (existing) report.updated += 1; else report.created += 1;
  }
  return report;
}

/**
 * Write a row back out to the repository tree. This is the EXPORT path: it exists
 * so a deployment that wants the YAML on disk (git review, the pack loader) can
 * have it, not because the file is the source of truth.
 */
export async function materializeAgentSpec(store: SwarmWorkspaceStore, packId: string, agentId: string, baseDir = 'packs'): Promise<MaterializeResult | undefined> {
  const record = await store.getAgentSpec(packId, agentId);
  if (!record) return undefined;
  const dir = join(baseDir, packId, record.status === 'published' ? 'agents' : 'drafts');
  const path = join(dir, `${agentId}.yaml`);
  mkdirSync(dir, { recursive: true });
  const yaml = record.status === 'published' ? record.yaml : withDraftFrontMatter(record.yaml, record.status);
  writeFileSync(path, yaml);
  const contentSha256 = sha256(yaml);
  await store.markAgentSpecMaterialized(packId, agentId, contentSha256);
  return { packId, agentId, path, bytes: Buffer.byteLength(yaml), contentSha256 };
}

/** A draft's status lives in a front-matter comment so the file is self-describing. */
function withDraftFrontMatter(yaml: string, status: AgentSpecStatus): string {
  const stripped = yaml.replace(/^#\s*status:\s*.*\n/m, '');
  return `# status: ${status}\n${stripped}`;
}

/** Diff the durable rows against the tree — what a "drift" panel shows. */
export interface SpecDrift {
  /** On disk, no row: authoring has never imported this file. */
  onlyOnDisk: string[];
  /** In the store, no file: the row is ahead of the tree (expected after console authoring). */
  onlyInStore: string[];
  /** Both exist with different content. */
  differing: string[];
  inSync: number;
}

export async function agentSpecDrift(store: SwarmWorkspaceStore, baseDir = 'packs'): Promise<SpecDrift> {
  const { located } = scanSpecTree(baseDir);
  const rows = await store.listAgentSpecs();
  const onDisk = new Map(located.map((l) => [`${l.packId}:${l.agentId}`, sha256(l.yaml)]));
  const inStore = new Map(rows.map((r) => [`${r.packId}:${r.agentId}`, r.contentSha256]));
  const drift: SpecDrift = { onlyOnDisk: [], onlyInStore: [], differing: [], inSync: 0 };
  for (const [key, diskSha] of onDisk) {
    const rowSha = inStore.get(key);
    if (rowSha === undefined) drift.onlyOnDisk.push(key);
    else if (rowSha !== diskSha) drift.differing.push(key);
    else drift.inSync += 1;
  }
  for (const key of inStore.keys()) if (!onDisk.has(key)) drift.onlyInStore.push(key);
  return drift;
}

/** Convenience for a route: the whole authoring surface in one payload. */
export async function agentSpecSummary(store: SwarmWorkspaceStore, baseDir = 'packs') {
  const rows = await store.listAgentSpecs();
  const byStatus = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  const drift = await agentSpecDrift(store, baseDir);
  return {
    total: rows.length,
    byStatus,
    drift,
    /** False until the tree has been imported at least once — the console says so
     *  rather than showing an empty registry as if there were no agents. */
    imported: rows.some((r) => r.importedFrom !== undefined),
  };
}
