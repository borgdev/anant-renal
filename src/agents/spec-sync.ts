// Two-way sync between YAML files (git source of truth) and the Postgres
// mirror table used by the Studio editor.
//
// Sync direction rules:
//   • Git → Postgres: on boot and on git push webhook, load every YAML file,
//     validate, upsert into `harness.agent_spec_mirror` with `source='git'`.
//   • Postgres → Git: when Studio saves a spec, write to Postgres with
//     `source='studio'`, then open a PR against the pack (via GitHub API).
//     Merged PRs flow back to Postgres via the git→postgres path.
//
// Conflict handling: Postgres holds a `git_sha` column; Studio saves reject
// if the sha does not match the current git HEAD for that file (optimistic
// lock). Callers must fetch the latest, merge, and retry.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { validateAgentSpec, type AgentSpec } from './spec.js';
import type { AgentRegistry } from './registry.js';
import type { PostgresEventStore } from '../server/postgres-event-store.js';

export interface SpecFileRecord {
  readonly packId: string;
  readonly filePath: string;
  readonly spec: AgentSpec;
}

/** Walk `packs/<pack>/agents/*.yaml`, validate each, return records. */
export function loadSpecsFromDisk(packsRoot: string): SpecFileRecord[] {
  const out: SpecFileRecord[] = [];
  if (!existsSync(packsRoot)) return out;
  for (const packDir of readdirSync(packsRoot)) {
    const agentsDir = join(packsRoot, packDir, 'agents');
    if (!existsSync(agentsDir)) continue;
    for (const file of readdirSync(agentsDir)) {
      if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
      const filePath = join(agentsDir, file);
      const raw = readFileSync(filePath, 'utf8');
      const parsed = parseYaml(raw) as unknown;
      const spec = validateAgentSpec(parsed);
      out.push({ packId: packDir, filePath, spec });
    }
  }
  return out;
}

export function loadIntoRegistry(records: readonly SpecFileRecord[], registry: AgentRegistry): void {
  for (const r of records) registry.register(r.spec);
}

/** Mirror table DDL — appended to PostgresEventStore.MIGRATIONS. */
export const AGENT_SPEC_MIRROR_DDL = `
CREATE TABLE IF NOT EXISTS __schema__.agent_spec_mirror (
  agent_id TEXT NOT NULL,
  version TEXT NOT NULL,
  pack_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('git', 'studio')),
  git_sha TEXT,
  yaml_body TEXT NOT NULL,
  parsed_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT NOT NULL,
  PRIMARY KEY (agent_id, version)
);
CREATE INDEX IF NOT EXISTS agent_spec_mirror_pack_idx ON __schema__.agent_spec_mirror (pack_id);
`;

export interface UpsertOptions {
  readonly actorRef: string;
  readonly source: 'git' | 'studio';
  readonly gitSha?: string;
}

export async function upsertSpec(store: PostgresEventStore, spec: AgentSpec, opts: UpsertOptions): Promise<void> {
  const yaml = stringifyYaml(spec);
  await store.execRaw(
    `INSERT INTO __schema__.agent_spec_mirror (agent_id, version, pack_id, source, git_sha, yaml_body, parsed_json, updated_at, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8)
     ON CONFLICT (agent_id, version) DO UPDATE
       SET source = EXCLUDED.source,
           git_sha = EXCLUDED.git_sha,
           yaml_body = EXCLUDED.yaml_body,
           parsed_json = EXCLUDED.parsed_json,
           updated_at = NOW(),
           updated_by = EXCLUDED.updated_by`,
    [spec.id, spec.version, spec.packId, opts.source, opts.gitSha ?? null, yaml, JSON.stringify(spec), opts.actorRef],
  );
}

export async function listMirror(store: PostgresEventStore): Promise<readonly { agentId: string; version: string; packId: string; source: string; updatedAt: string }[]> {
  const rows = await store.queryRaw<{ agent_id: string; version: string; pack_id: string; source: string; updated_at: string }>(
    `SELECT agent_id, version, pack_id, source, updated_at FROM __schema__.agent_spec_mirror ORDER BY agent_id, version`,
    [],
  );
  return rows.map((r) => ({ agentId: r.agent_id, version: r.version, packId: r.pack_id, source: r.source, updatedAt: r.updated_at }));
}

export async function fetchMirroredSpec(store: PostgresEventStore, agentId: string, version: string): Promise<AgentSpec | undefined> {
  const rows = await store.queryRaw<{ parsed_json: unknown }>(
    `SELECT parsed_json FROM __schema__.agent_spec_mirror WHERE agent_id = $1 AND version = $2 LIMIT 1`,
    [agentId, version],
  );
  const first = rows[0];
  if (!first) return undefined;
  return validateAgentSpec(first.parsed_json);
}
