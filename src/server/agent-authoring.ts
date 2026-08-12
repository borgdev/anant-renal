// Agent-authoring service — draft → review → publish workflow.
//
// Drafts live in `packs/<packId>/drafts/*.yaml` with a `status: draft|in-review`
// front-matter comment. Publishing:
//   1. Validates the YAML via `validateAgentSpec`
//   2. Rejects duplicate ids across the whole registry
//   3. Moves the file into `packs/<packId>/agents/*.yaml`
//   4. Appends an audit-chain entry recording actor, timestamp, and content hash
//
// Everything is versioned on disk so the operator flow is inspectable in git
// and reversible.

import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, renameSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { validateAgentSpec, type AgentSpec } from '../agents/index.js';

export type DraftStatus = 'draft' | 'in-review';

export interface DraftRecord {
  packId: string;
  id: string;
  status: DraftStatus;
  yaml: string;
  path: string;
  updatedAt: string;
  authorRef: string;
  validation: { ok: boolean; errors: string[] };
}

export interface PublishAuditEntry {
  actorRef: string;
  action: 'create-draft' | 'update-draft' | 'submit-review' | 'publish' | 'reject';
  packId: string;
  agentId: string;
  contentSha256: string;
  timestamp: string;
  note?: string;
}

const PACKS_DIR = 'packs';
const AUDIT_LOG = 'packs/.authoring-audit.jsonl';

export class AgentAuthoringService {
  listDrafts(): DraftRecord[] {
    const out: DraftRecord[] = [];
    for (const pack of readdirSync(PACKS_DIR)) {
      const draftsDir = `${PACKS_DIR}/${pack}/drafts`;
      if (!existsSync(draftsDir)) continue;
      for (const f of readdirSync(draftsDir).filter((x) => x.endsWith('.yaml'))) {
        const path = `${draftsDir}/${f}`;
        const yaml = readFileSync(path, 'utf8');
        const status: DraftStatus = /^#\s*status:\s*in-review/m.test(yaml) ? 'in-review' : 'draft';
        const author = /^#\s*author:\s*(.+)$/m.exec(yaml)?.[1] ?? 'unknown';
        const validation = this.validateYaml(yaml);
        const id = f.replace(/\.yaml$/, '');
        out.push({
          packId: pack,
          id,
          status,
          yaml,
          path,
          updatedAt: statSync(path).mtime.toISOString(),
          authorRef: author,
          validation,
        });
      }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getDraft(packId: string, id: string): DraftRecord | null {
    const path = `${PACKS_DIR}/${packId}/drafts/${id}.yaml`;
    if (!existsSync(path)) return null;
    const yaml = readFileSync(path, 'utf8');
    const status: DraftStatus = /^#\s*status:\s*in-review/m.test(yaml) ? 'in-review' : 'draft';
    const author = /^#\s*author:\s*(.+)$/m.exec(yaml)?.[1] ?? 'unknown';
    return {
      packId, id, status, yaml, path,
      updatedAt: statSync(path).mtime.toISOString(),
      authorRef: author,
      validation: this.validateYaml(yaml),
    };
  }

  validateYaml(yaml: string): { ok: boolean; errors: string[]; spec?: AgentSpec } {
    let parsed: unknown;
    try { parsed = parseYaml(yaml); }
    catch (e) { return { ok: false, errors: [`YAML parse: ${(e as Error).message}`] }; }
    try {
      const spec = validateAgentSpec(parsed);
      return { ok: true, errors: [], spec };
    } catch (e) {
      const err = e as Error & { errors?: Array<{ path: unknown[]; message: string }> };
      const zodErrors = err.errors?.map((x) => `${x.path.join('.') || '(root)'}: ${x.message}`) ?? [err.message];
      return { ok: false, errors: zodErrors };
    }
  }

  saveDraft(input: { packId: string; id: string; yaml: string; status?: DraftStatus; actorRef: string; note?: string }): DraftRecord {
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(input.packId)) throw new Error('invalid-pack-id');
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(input.id)) throw new Error('invalid-agent-id');
    const draftsDir = `${PACKS_DIR}/${input.packId}/drafts`;
    if (!existsSync(`${PACKS_DIR}/${input.packId}`)) throw new Error('unknown-pack');
    mkdirSync(draftsDir, { recursive: true });
    // Reject id collisions against published agents
    const publishedPath = `${PACKS_DIR}/${input.packId}/agents/${input.id}.yaml`;
    if (existsSync(publishedPath)) throw new Error(`agent-already-published: ${input.id}`);
    const isNew = !existsSync(`${draftsDir}/${input.id}.yaml`);
    const header = [
      `# status: ${input.status ?? 'draft'}`,
      `# author: ${input.actorRef}`,
      `# updatedAt: ${new Date().toISOString()}`,
    ].join('\n') + '\n';
    // Strip prior header comments
    const body = input.yaml.replace(/^(#\s*(status|author|updatedAt):.*\n)+/m, '');
    const finalYaml = header + body;
    writeFileSync(`${draftsDir}/${input.id}.yaml`, finalYaml);
    this.appendAudit({
      actorRef: input.actorRef,
      action: isNew ? 'create-draft' : (input.status === 'in-review' ? 'submit-review' : 'update-draft'),
      packId: input.packId,
      agentId: input.id,
      contentSha256: createHash('sha256').update(finalYaml).digest('hex'),
      timestamp: new Date().toISOString(),
      ...(input.note !== undefined ? { note: input.note } : {}),
    });
    return this.getDraft(input.packId, input.id)!;
  }

  publish(input: { packId: string; id: string; actorRef: string; note?: string }): { published: true; path: string; contentSha256: string } {
    const draft = this.getDraft(input.packId, input.id);
    if (!draft) throw new Error('draft-not-found');
    if (!draft.validation.ok) throw new Error(`draft-invalid: ${draft.validation.errors.join('; ')}`);
    // Duplicate id check across all packs
    for (const pack of readdirSync(PACKS_DIR)) {
      const p = `${PACKS_DIR}/${pack}/agents/${input.id}.yaml`;
      if (existsSync(p)) throw new Error(`agent-id-collision: ${input.id} already exists in ${pack}`);
    }
    const agentsDir = `${PACKS_DIR}/${input.packId}/agents`;
    mkdirSync(agentsDir, { recursive: true });
    // Strip authoring headers before publishing to keep published YAML clean
    const publishedYaml = draft.yaml.replace(/^(#\s*(status|author|updatedAt):.*\n)+/m, '');
    const publishedPath = `${agentsDir}/${input.id}.yaml`;
    writeFileSync(publishedPath, publishedYaml);
    // Remove draft
    renameSync(draft.path, `${draft.path}.published`);
    const sha = createHash('sha256').update(publishedYaml).digest('hex');
    this.appendAudit({
      actorRef: input.actorRef,
      action: 'publish',
      packId: input.packId,
      agentId: input.id,
      contentSha256: sha,
      timestamp: new Date().toISOString(),
      ...(input.note !== undefined ? { note: input.note } : {}),
    });
    return { published: true, path: publishedPath, contentSha256: sha };
  }

  reject(input: { packId: string; id: string; actorRef: string; note: string }): void {
    const draft = this.getDraft(input.packId, input.id);
    if (!draft) throw new Error('draft-not-found');
    // Downgrade status back to draft; keep the file
    const updated = draft.yaml.replace(/^#\s*status:\s*.*$/m, '# status: draft');
    writeFileSync(draft.path, updated);
    this.appendAudit({
      actorRef: input.actorRef,
      action: 'reject',
      packId: input.packId,
      agentId: input.id,
      contentSha256: createHash('sha256').update(updated).digest('hex'),
      timestamp: new Date().toISOString(),
      note: input.note,
    });
  }

  auditLog(): PublishAuditEntry[] {
    if (!existsSync(AUDIT_LOG)) return [];
    return readFileSync(AUDIT_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as PublishAuditEntry);
  }

  private appendAudit(entry: PublishAuditEntry): void {
    mkdirSync(PACKS_DIR, { recursive: true });
    writeFileSync(AUDIT_LOG, JSON.stringify(entry) + '\n', { flag: 'a' });
  }

  // Convenience: scaffold a minimal AgentSpec YAML from a form payload
  scaffoldYaml(input: {
    id: string;
    packId: string;
    displayName: string;
    description?: string;
    trigger: { kind: 'event' | 'schedule' | 'manual'; eventType?: string; cron?: string };
    steps: Array<{ id: string; skill: string }>;
    labels?: Record<string, string>;
    baseFeeUsd?: number;
    budgetCapMonthlyUsd?: number;
  }): string {
    const lines: string[] = [];
    lines.push(`id: ${input.id}`);
    lines.push(`version: 1.0.0`);
    lines.push(`packId: ${input.packId}`);
    lines.push(`displayName: ${JSON.stringify(input.displayName)}`);
    if (input.description) lines.push(`description: ${JSON.stringify(input.description)}`);
    lines.push(`scope: facility`);
    lines.push(`trigger:`);
    lines.push(`  kind: ${input.trigger.kind}`);
    if (input.trigger.kind === 'event' && input.trigger.eventType) lines.push(`  eventType: ${input.trigger.eventType}`);
    if (input.trigger.kind === 'schedule' && input.trigger.cron) lines.push(`  cron: ${JSON.stringify(input.trigger.cron)}`);
    lines.push(`inputs: {}`);
    lines.push(`outputs: {}`);
    lines.push(`plan:`);
    lines.push(`  type: sequence`);
    lines.push(`  children:`);
    for (const s of input.steps) {
      lines.push(`    - type: step`);
      lines.push(`      step:`);
      lines.push(`        id: ${s.id}`);
      lines.push(`        skill: ${s.skill}`);
      lines.push(`        inputs: {}`);
    }
    if (input.labels && Object.keys(input.labels).length > 0) {
      lines.push(`labels:`);
      for (const [k, v] of Object.entries(input.labels)) lines.push(`  ${k}: ${v}`);
    }
    lines.push(`governance:`);
    lines.push(`  phiHandling: none`);
    lines.push(`  purposeOfUse: [operations]`);
    lines.push(`  clearanceRequired: internal`);
    lines.push(`billing:`);
    lines.push(`  baseFeeUsd: ${input.baseFeeUsd ?? 0}`);
    if (input.budgetCapMonthlyUsd !== undefined) lines.push(`  budgetCapMonthlyUsd: ${input.budgetCapMonthlyUsd}`);
    return lines.join('\n') + '\n';
  }
}
