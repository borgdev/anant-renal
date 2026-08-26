#!/usr/bin/env node
/**
 * Phase F — the one scripted demo that proves the entire closed loop and
 * produces an audit/replay package (port plan Phase F exit), as a live CLI
 * artifact (not just a unit test).
 *
 * Drives the RUNNING server over HTTP only (no internal imports):
 *
 *   admin login → green team → red team (contained) → release (validate →
 *   approve → activate, immutable dossier) → payer demo (episodes) → My Work
 *   (cockpit) → approve care-gap → Coordinating → audit/replay package written
 *   to ./audit-replay/phase-f-audit.json (deterministic content hash).
 *
 * Usage:
 *   node scripts/full-journey.mjs                  # against http://127.0.0.1:3000
 *   BASE_URL=http://localhost:8080 node scripts/full-journey.mjs
 *   node scripts/full-journey.mjs --fresh          # also run a red-team suite under
 *                                                  # the allow policy to prove findings block
 */
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const fresh = process.argv.includes('--fresh');
const results = [];
const step = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? '  ✓' : '  ✗'} ${name} — ${detail}`); };

let cookie = '';
async function api(method, path, body) {
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: hasBody ? (body === undefined ? '{}' : JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  const json = text ? (() => { try { return JSON.parse(text); } catch { return { raw: text }; } })() : {};
  if (method === 'POST' && path === '/auth/login') {
    const sc = res.headers.get('set-cookie') ?? '';
    const m = /hh_session=([^;]+)/.exec(sc);
    if (m) cookie = `hh_session=${m[1]}`;
  }
  return { status: res.status, json };
}

const J = async (method, path, body) => {
  const r = await api(method, path, body);
  if (r.status >= 400) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
  return r.json;
};

async function main() {
  console.log(`Phase F full journey → ${BASE}\n`);

  // 0. Login
  const login = await api('POST', '/auth/login', { username: process.env.ADMIN_USER ?? 'admin', password: process.env.ADMIN_PASS ?? 'admin123' });
  step('admin login', login.status === 200 && Boolean(cookie), `session ${cookie ? 'acquired' : 'MISSING'}`);
  if (!cookie) { console.log('\nPhase F: ABORTED (no session)'); process.exit(1); }

  // Optional: prove findings block an unsafe release (--fresh only)
  if (fresh) {
    await J('PUT', '/admin/swarm/admin/policy', { defaultDecision: 'allow' });
    const bad = await J('POST', '/admin/platform/red-team/run-suite', { ranBy: 'full-journey' });
    step('unsafe policy → findings', bad.findings.length > 0, `${bad.findings.length} blocking finding(s)`);
    // Remediate + retest + independent review → close (Journey M) so the release can validate.
    const findings = (await J('GET', '/admin/platform/findings')).findings ?? [];
    let closed = 0;
    for (const f of findings.filter((x) => x.status !== 'closed')) {
      await J('POST', `/admin/platform/findings/${f.id}/assign`, { owner: 'security-owner' });
      await J('POST', `/admin/platform/findings/${f.id}/remediate`, { remediation: 'Policy restored to default-deny', by: 'security-owner' });
      await J('POST', `/admin/platform/findings/${f.id}/retest`, {});
      const rv = await J('POST', `/admin/platform/findings/${f.id}/review`, { reviewer: 'independent-reviewer', acceptClosure: true });
      if (rv.finding?.status === 'closed') closed += 1;
    }
    step('findings remediated + closed', closed > 0, `${closed} closed via §20.2 workflow`);
    await J('PUT', '/admin/swarm/admin/policy', { defaultDecision: 'block' });
  }

  // 1. Assurance
  const green = await J('POST', '/admin/platform/green-team/run', { ranBy: 'full-journey' });
  step('green team', green.run.passed, `${green.run.checks.length} gates`);
  const red = await J('POST', '/admin/platform/red-team/run-suite', { ranBy: 'full-journey' });
  step('red team (block policy)', red.passed, `${red.runs.length} scenarios, ${red.findings.length} findings`);

  // 2. Release lifecycle → active with dossier
  const rel = await J('POST', '/admin/platform/releases', { version: `journey-${Date.now() % 100000}`, changeSummary: 'Phase F full journey', createdBy: 'admin' });
  const v = await J('POST', `/admin/platform/releases/${rel.release.id}/validate`);
  step('release validated', v.release.status === 'validated', `${(v.release.checks ?? []).filter((c) => c.passed).length}/${(v.release.checks ?? []).length} gates`);
  await J('POST', `/admin/platform/releases/${rel.release.id}/request-approval`);
  const active = await J('POST', `/admin/platform/releases/${rel.release.id}/activate`);
  step('release activated', active.release.status === 'active', `dossier hash ${active.release.dossier?.contentHash?.slice(0, 12) ?? 'MISSING'}`);

  // 3. Payer demo → outcome episodes on the shared coordinator (idempotent:
  //    re-seeding returns [] when the episodes already exist — verified next).
  const demo = await J('POST', '/admin/swarm/payer/demo');
  step('payer demo seeded', Array.isArray(demo.opened), `${(demo.opened ?? []).length} opened this run`);

  // 4. My Work (user cockpit) surfaces the episodes
  const work = await J('GET', '/api/work');
  const careGap = work.items.find((i) => i.title.startsWith('care gap closure'));
  const authz = work.items.find((i) => i.title.startsWith('authorization review'));
  step('My Work surfaces episodes', Boolean(careGap) && Boolean(authz), `care gap closure (${careGap?.state}) + authorization review (${authz?.state})`);

  // 5. Approve → command path (skip if a prior run already advanced it)
  let decided = { state: careGap.state };
  if (careGap.state === 'AwaitingApproval' || careGap.state === 'Proposed') {
    decided = await J('POST', `/api/work/${encodeURIComponent(careGap.id)}/actions`, { action: 'approve', approver: 'Facility Administrator', idempotencyKey: `journey-${Date.now()}` });
  }
  step('approve → Coordinating', decided.state === 'Coordinating', `state ${decided.state}${careGap.state === 'AwaitingApproval' ? '' : ' (already in flight from a prior run)'}`);

  // 6. Assemble the audit/replay package
  const assurance = await J('GET', '/admin/platform/assurance');
  const ctx = await J('GET', '/api/context');
  const payload = {
    generatedAt: new Date().toISOString(),
    base: BASE,
    release: { version: active.release.version, status: active.release.status, contentHash: active.release.dossier?.contentHash },
    gates: active.release.dossier?.gates?.map((g) => ({ name: g.name, passed: g.passed })),
    findingsBlocking: assurance.findings.blocking,
    configuration: { activeVersion: ctx.configuration.activeVersion },
    workProcessed: [{ id: careGap.id, from: careGap.state, to: decided.state }],
    episodes: work.items.filter((i) => i.kind === 'episode').map((i) => ({ title: i.title, state: i.state })),
  };
  const content = { release: payload.release, episodes: payload.episodes, workProcessed: payload.workProcessed };
  const auditPackage = { ...payload, packageHash: createHash('sha256').update(JSON.stringify(content)).digest('hex') };
  const outDir = resolve(root, 'audit-replay');
  mkdirSync(outDir, { recursive: true });
  const outFile = resolve(outDir, 'phase-f-audit.json');
  writeFileSync(outFile, JSON.stringify(auditPackage, null, 2));
  step('audit/replay package written', Boolean(auditPackage.packageHash), `${outFile} · sha256 ${auditPackage.packageHash.slice(0, 12)}`);

  // 7. Summary
  const passed = results.every((r) => r.ok);
  console.log(`\nPhase F full journey: ${results.filter((r) => r.ok).length}/${results.length} steps passed`);
  process.exit(passed ? 0 : 1);
}

main().catch((e) => { console.error(`\nPhase F journey FAILED: ${e.message}`); process.exit(1); });
