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

import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { chdir } from 'node:process';
import { AgentAuthoringService } from '../src/server/agent-authoring.js';

const ORIGINAL_CWD = process.cwd();
const SANDBOX = '/tmp/hh-authoring-test';

function seedPack(): void {
  rmSync(SANDBOX, { recursive: true, force: true });
  mkdirSync(`${SANDBOX}/packs/test-pack/agents`, { recursive: true });
  chdir(SANDBOX);
}

function goodYaml(id: string, packId = 'test-pack'): string {
  return [
    `id: ${id}`,
    `version: 1.0.0`,
    `packId: ${packId}`,
    `displayName: "Test agent"`,
    `scope: facility`,
    `trigger:`,
    `  kind: manual`,
    `inputs: {}`,
    `outputs: {}`,
    `plan:`,
    `  type: sequence`,
    `  children:`,
    `    - type: step`,
    `      step:`,
    `        id: s1`,
    `        skill: noop`,
    `        inputs: {}`,
    `governance:`,
    `  phiHandling: none`,
    `  purposeOfUse: [operations]`,
    `  clearanceRequired: internal`,
    `billing:`,
    `  baseFeeUsd: 0`,
    ``,
  ].join('\n');
}

describe('AgentAuthoringService (M7)', () => {
  beforeEach(() => { seedPack(); });
  afterAll(() => { chdir(ORIGINAL_CWD); rmSync(SANDBOX, { recursive: true, force: true }); });

  it('validates a well-formed YAML spec', () => {
    const svc = new AgentAuthoringService();
    const r = svc.validateYaml(goodYaml('foo-1'));
    expect(r.ok).toBe(true);
    expect(r.spec?.id).toBe('foo-1');
  });

  it('reports parse + zod errors on malformed YAML', () => {
    const svc = new AgentAuthoringService();
    expect(svc.validateYaml('this: is: not: valid: yaml: [').ok).toBe(false);
    const bad = svc.validateYaml('id: x\nversion: 1.0.0\npackId: test-pack\n');
    expect(bad.ok).toBe(false);
    expect(bad.errors.length).toBeGreaterThan(0);
  });

  it('saves a draft, lists it, and stamps status + author', () => {
    const svc = new AgentAuthoringService();
    const d = svc.saveDraft({ packId: 'test-pack', id: 'foo-1', yaml: goodYaml('foo-1'), actorRef: 'user:alice' });
    expect(d.status).toBe('draft');
    expect(d.authorRef).toBe('user:alice');
    expect(d.validation.ok).toBe(true);
    expect(svc.listDrafts().length).toBe(1);
  });

  it('rejects invalid pack + agent ids', () => {
    const svc = new AgentAuthoringService();
    expect(() => svc.saveDraft({ packId: 'Not Valid', id: 'x', yaml: goodYaml('x'), actorRef: 'u' })).toThrow(/invalid-pack-id/);
    expect(() => svc.saveDraft({ packId: 'test-pack', id: 'X BAD', yaml: goodYaml('X BAD'), actorRef: 'u' })).toThrow(/invalid-agent-id/);
    expect(() => svc.saveDraft({ packId: 'no-such-pack', id: 'ok', yaml: goodYaml('ok'), actorRef: 'u' })).toThrow(/unknown-pack/);
  });

  it('publishes a valid draft, writes to agents/, and appends audit', () => {
    const svc = new AgentAuthoringService();
    svc.saveDraft({ packId: 'test-pack', id: 'foo-1', yaml: goodYaml('foo-1'), actorRef: 'user:alice', status: 'in-review' });
    const result = svc.publish({ packId: 'test-pack', id: 'foo-1', actorRef: 'user:reviewer', note: 'looks good' });
    expect(result.published).toBe(true);
    expect(existsSync('packs/test-pack/agents/foo-1.yaml')).toBe(true);
    const audit = svc.auditLog();
    expect(audit.length).toBeGreaterThanOrEqual(2);
    expect(audit.some((e) => e.action === 'publish')).toBe(true);
  });

  it('rejects publish when draft is invalid', () => {
    const svc = new AgentAuthoringService();
    // Manually write an invalid draft (bypassing saveDraft, which validates via header)
    mkdirSync('packs/test-pack/drafts', { recursive: true });
    writeFileSync('packs/test-pack/drafts/bad-1.yaml', '# status: in-review\nid: bad-1\nversion: 1.0.0\npackId: test-pack\n');
    expect(() => svc.publish({ packId: 'test-pack', id: 'bad-1', actorRef: 'u' })).toThrow(/draft-invalid/);
  });

  it('rejects duplicate ids across packs at publish time', () => {
    const svc = new AgentAuthoringService();
    mkdirSync('packs/other-pack/agents', { recursive: true });
    writeFileSync('packs/other-pack/agents/foo-1.yaml', goodYaml('foo-1', 'other-pack'));
    svc.saveDraft({ packId: 'test-pack', id: 'foo-1', yaml: goodYaml('foo-1'), actorRef: 'u' });
    expect(() => svc.publish({ packId: 'test-pack', id: 'foo-1', actorRef: 'u' })).toThrow(/agent-id-collision/);
  });

  it('reject() flips status back to draft and audits', () => {
    const svc = new AgentAuthoringService();
    svc.saveDraft({ packId: 'test-pack', id: 'foo-1', yaml: goodYaml('foo-1'), actorRef: 'u', status: 'in-review' });
    svc.reject({ packId: 'test-pack', id: 'foo-1', actorRef: 'reviewer', note: 'add billing' });
    expect(svc.getDraft('test-pack', 'foo-1')?.status).toBe('draft');
    expect(svc.auditLog().some((e) => e.action === 'reject')).toBe(true);
  });

  it('scaffoldYaml produces a valid spec from form input', () => {
    const svc = new AgentAuthoringService();
    const yaml = svc.scaffoldYaml({
      id: 'form-agent',
      packId: 'test-pack',
      displayName: 'Form-built agent',
      description: 'Created via UI form',
      trigger: { kind: 'event', eventType: 'lab.result-arrived' },
      steps: [{ id: 's1', skill: 'lookup-labs' }, { id: 's2', skill: 'notify-provider' }],
      labels: { setting: 'primary-care', lifecycleStage: 'active-care' },
      baseFeeUsd: 0.05,
      budgetCapMonthlyUsd: 500,
    });
    expect(svc.validateYaml(yaml).ok).toBe(true);
  });
});
