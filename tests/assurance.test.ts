/******************************************************************************
 * AI Assurance + release control (port plan Phase E, spec §20) — tests.
 *
 * Proves: green-team suite runs, red-team suite creates findings when the
 * runtime policy is unsafe, an intentionally unsafe release cannot validate or
 * activate, the finding lifecycle (§20.2) closes only via remediation + retest +
 * independent review, findings are immutable (no delete), and canary activation
 * writes an immutable dossier (Approved → Canary → Active | RolledBack).
 ******************************************************************************/

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { Telemetry, InMemorySink } from '../src/server/telemetry.js';
import { healthcareCorePack } from '../packs/healthcare-core/index.js';
import type { PostgresEventStore } from '../src/server/postgres-event-store.js';
import type { CanonicalEvent } from '../src/healthcare-core/events.js';
import type { LedgerEntry } from '../src/hypergraph/ledger.js';
import type { ActorContext } from '../src/server/scoped-persistence.js';

function inMemoryStore() {
  const events: CanonicalEvent[] = [];
  const ledger: LedgerEntry[] = [];
  const audit: unknown[] = [];
  const store = {
    async applyMigrations() { /* noop */ },
    async appendEvent(_scope: { scopeId: string; actorRef: string }, ev: CanonicalEvent) { events.push(ev); },
    async queryEvents() { return events; },
    async ledgerAppend(_scope: { scopeId: string; actorRef: string }, e: LedgerEntry) { ledger.push(e); },
    async ledgerQuery() { return ledger; },
    async appendAudit(_scope: { scopeId: string; actorRef: string }, row: unknown) { audit.push(row); },
    async queryAudit() { return audit; },
    async recordFhirResource(_scope: { scopeId: string; actorRef: string }, r: unknown) { /* noop */ },
    async listFhirResources() { return []; },
  } as unknown as PostgresEventStore;
  return store;
}

const actor: ActorContext = { actorRef: 'user:test', scopeIds: ['scope:*'], clearance: 'restricted-phi', purposeOfUse: 'operations' } as ActorContext;

type App = Awaited<ReturnType<typeof build>>;
async function build() {
  return buildApp({
    store: inMemoryStore(),
    telemetry: new Telemetry('test', new InMemorySink()),
    packs: [healthcareCorePack],
    authenticate: async () => actor,
    checkHealth: async () => ({ db: true, redis: true }),
    adminApiAuth: true,
  });
}

async function login(app: App, username: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { username, password } });
  const raw = Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'].join(';') : String(res.headers['set-cookie'] ?? '');
  const token = /hh_session=([^;]+)/.exec(raw)?.[1];
  if (!token) throw new Error(`no session cookie: ${res.statusCode} ${res.body}`);
  return token;
}
const cookie = (token: string) => `hh_session=${token}`;

type Finding = { id: string; severity: string; status: string; releaseId?: string };

describe('AI assurance + release control (Phase E)', () => {
  let app: App;
  let admin: string;

  beforeAll(async () => {
    app = await build();
    admin = await login(app, 'admin', 'admin123');
  });
  afterAll(async () => { await app.close(); });

  it('blocks unauthenticated /admin/platform/* assurance calls (401)', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/platform/findings' });
    expect(res.statusCode).toBe(401);
  });

  it('green-team suite runs and records durable gates', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/platform/green-team/run', headers: { cookie: cookie(admin) }, payload: { ranBy: 'test-operator' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().run.passed).toBe(true);
    expect(res.json().run.checks.length).toBeGreaterThanOrEqual(8);
    expect(res.json().run.checks.every((c: { passed: boolean }) => c.passed)).toBe(true);
  });

  it('red-team suite passes under the default block policy (no findings)', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/platform/red-team/run-suite', headers: { cookie: cookie(admin) }, payload: { ranBy: 'test-operator' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.passed).toBe(true);
    expect(body.findings).toHaveLength(0);
    expect(body.runs.length).toBeGreaterThanOrEqual(8);
  });

  it('assurance dashboard reports findings, green/red and the release gate', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/platform/assurance', headers: { cookie: cookie(admin) } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.findings.total).toBe('number');
    expect(body.findings.blocking).toBe(0);
    expect(body.releaseGate.verdict).toBe('pass');
    expect(body.greenTeam.runs).toBeGreaterThanOrEqual(1);
    expect(body.redTeam.runs).toBeGreaterThanOrEqual(8);
  });

  it('an unsafe runtime policy makes the red-team suite fail and create findings', async () => {
    await app.inject({ method: 'PUT', url: '/admin/swarm/admin/policy', headers: { cookie: cookie(admin) }, payload: { defaultDecision: 'allow' } });
    const res = await app.inject({ method: 'POST', url: '/admin/platform/red-team/run-suite', headers: { cookie: cookie(admin) }, payload: { ranBy: 'test-operator' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.passed).toBe(false);
    expect(body.findings.length).toBeGreaterThanOrEqual(5);
    expect(body.findings.every((f: Finding) => f.severity === 'critical' || f.severity === 'high')).toBe(true);
    expect(body.findings.every((f: Finding) => f.status === 'open')).toBe(true);
  });

  it('provider and payer adversarial journeys are part of the required suite', async () => {
    // The suite now carries provider (rt-009/010) and payer (rt-011/012) scenarios.
    const res = await app.inject({ method: 'POST', url: '/admin/platform/red-team/run-suite', headers: { cookie: cookie(admin) }, payload: { ranBy: 'test-operator' } });
    const body = res.json();
    const byId = (id: string) => body.runs.find((r: { scenarioId: string }) => r.scenarioId === id);
    expect(byId('rt-009')).toBeTruthy(); // provider unsafe order escalation
    expect(byId('rt-010')).toBeTruthy(); // provider supply substitution
    expect(byId('rt-011')).toBeTruthy(); // payer cross-plan benefit leakage
    expect(byId('rt-012')).toBeTruthy(); // payer claim-before-authorization
    // Under the (currently allow) policy they must fail and be flagged.
    const crossPlan = body.findings.filter((f: { threatModel: string }) => f.threatModel === 'cross-tenant-leakage');
    expect(crossPlan.length).toBeGreaterThanOrEqual(1);
    // NOTE: policy stays `allow` here — the following "unsafe release" test
    // depends on it; the finding-lifecycle test restores `block`.
  });

  it('an intentionally unsafe release cannot validate or activate (Journey M)', async () => {
    const create = await app.inject({ method: 'POST', url: '/admin/platform/releases', headers: { cookie: cookie(admin) }, payload: { version: 'unsafe-v1', changeSummary: 'allows external writes' } });
    const release = create.json().release;

    const validate = await app.inject({ method: 'POST', url: `/admin/platform/releases/${release.id}/validate`, headers: { cookie: cookie(admin) } });
    expect(validate.json().release.status).toBe('failed');
    const failedGates = validate.json().release.checks.filter((c: { passed: boolean }) => !c.passed).map((c: { name: string }) => c.name);
    expect(failedGates).toContain('Red team');
    expect(failedGates).toContain('Promotion');
    // Findings were auto-created and linked to this release.
    const findings = await (await app.inject({ method: 'GET', url: '/admin/platform/findings', headers: { cookie: cookie(admin) } })).json();
    const linked = findings.findings.filter((f: Finding) => f.releaseId === release.id);
    expect(linked.length).toBeGreaterThanOrEqual(5);

    // Cannot approve (blocked) and therefore cannot activate.
    const approve = await app.inject({ method: 'POST', url: `/admin/platform/releases/${release.id}/request-approval`, headers: { cookie: cookie(admin) } });
    expect(approve.json().release.status).toBe('failed');
    const activate = await app.inject({ method: 'POST', url: `/admin/platform/releases/${release.id}/activate`, headers: { cookie: cookie(admin) } });
    expect(activate.json().release.status).toBe('failed');
  });

  it('finding lifecycle: assign → remediate → retest-passed → independently-reviewed → closed', async () => {
    const findings = await (await app.inject({ method: 'GET', url: '/admin/platform/findings', headers: { cookie: cookie(admin) } })).json();
    const f = findings.findings.find((x: Finding) => x.status === 'open') as Finding;
    expect(f).toBeTruthy();

    const assign = await app.inject({ method: 'POST', url: `/admin/platform/findings/${f.id}/assign`, headers: { cookie: cookie(admin) }, payload: { owner: 'security-owner' } });
    expect(assign.json().finding.status).toBe('assigned');

    const remediate = await app.inject({ method: 'POST', url: `/admin/platform/findings/${f.id}/remediate`, headers: { cookie: cookie(admin) }, payload: { remediation: 'Restore default-deny policy; added allowlist guard', by: 'security-owner' } });
    expect(remediate.json().finding.status).toBe('remediating');
    expect(remediate.json().finding.remediation).toContain('default-deny');

    // Invalid transition guard — closing from 'remediating' without a review path is rejected.
    const badClose = await app.inject({ method: 'POST', url: `/admin/platform/findings/${f.id}/close`, headers: { cookie: cookie(admin) }, payload: { reviewer: 'reviewer' } });
    expect(badClose.statusCode).toBe(400);

    // Retest — rerun the finding's exact scenario against the (still allow) policy → fails.
    const retestFail = await app.inject({ method: 'POST', url: `/admin/platform/findings/${f.id}/retest`, headers: { cookie: cookie(admin) }, payload: {} });
    expect(retestFail.statusCode).toBe(200);
    expect(retestFail.json().finding.status).toBe('retest-failed');
    expect(retestFail.json().run).toBeTruthy();

    // Remediate again, then retest passes once the policy is safe.
    await app.inject({ method: 'PUT', url: '/admin/swarm/admin/policy', headers: { cookie: cookie(admin) }, payload: { defaultDecision: 'block' } });
    await app.inject({ method: 'POST', url: `/admin/platform/findings/${f.id}/remediate`, headers: { cookie: cookie(admin) }, payload: { remediation: 'Policy restored to block; retest clean', by: 'security-owner' } });
    const retest = await app.inject({ method: 'POST', url: `/admin/platform/findings/${f.id}/retest`, headers: { cookie: cookie(admin) }, payload: {} });
    expect(retest.json().finding.status).toBe('retest-passed');

    const review = await app.inject({ method: 'POST', url: `/admin/platform/findings/${f.id}/review`, headers: { cookie: cookie(admin) }, payload: { reviewer: 'independent-reviewer', note: 'accepted', acceptClosure: true } });
    expect(review.json().finding.status).toBe('closed');
    expect(review.json().finding.reviewedBy).toBe('independent-reviewer');
  });

  it('findings cannot be deleted (immutable evidence)', async () => {
    const findings = await (await app.inject({ method: 'GET', url: '/admin/platform/findings', headers: { cookie: cookie(admin) } })).json();
    const f = findings.findings[0] as Finding;
    const del = await app.inject({ method: 'DELETE', url: `/admin/platform/findings/${f.id}`, headers: { cookie: cookie(admin) } });
    expect(del.statusCode).toBe(404);
  });

  it('a release activates only when all blocking findings are closed — canary → active with dossier', async () => {
    // Close every remaining open blocking finding linked to the unsafe release.
    const findings = await (await app.inject({ method: 'GET', url: '/admin/platform/findings', headers: { cookie: cookie(admin) } })).json();
    for (const f of findings.findings.filter((x: Finding) => x.status !== 'closed' && (x.severity === 'critical' || x.severity === 'high'))) {
      await app.inject({ method: 'POST', url: `/admin/platform/findings/${f.id}/assign`, headers: { cookie: cookie(admin) }, payload: { owner: 'security-owner' } });
      await app.inject({ method: 'POST', url: `/admin/platform/findings/${f.id}/remediate`, headers: { cookie: cookie(admin) }, payload: { remediation: 'Control restored', by: 'security-owner' } });
      const r = await app.inject({ method: 'POST', url: `/admin/platform/findings/${f.id}/retest`, headers: { cookie: cookie(admin) }, payload: {} });
      expect(r.json().finding.status).toBe('retest-passed');
      await app.inject({ method: 'POST', url: `/admin/platform/findings/${f.id}/review`, headers: { cookie: cookie(admin) }, payload: { reviewer: 'independent-reviewer', acceptClosure: true } });
    }

    // New release on a clean policy → full lifecycle with staged canary.
    const create = await app.inject({ method: 'POST', url: '/admin/platform/releases', headers: { cookie: cookie(admin) }, payload: { version: 'safe-v2', changeSummary: 'green path release' } });
    const release = create.json().release;

    const validate = await app.inject({ method: 'POST', url: `/admin/platform/releases/${release.id}/validate`, headers: { cookie: cookie(admin) } });
    expect(validate.json().release.status).toBe('validated');

    const approve = await app.inject({ method: 'POST', url: `/admin/platform/releases/${release.id}/request-approval`, headers: { cookie: cookie(admin) } });
    expect(approve.json().release.status).toBe('approved');

    const canary = await app.inject({ method: 'POST', url: `/admin/platform/releases/${release.id}/canary`, headers: { cookie: cookie(admin) }, payload: { scopes: ['5% of network-access cohort'], by: 'release-approver' } });
    expect(canary.json().release.status).toBe('canary');
    expect(canary.json().release.canaryScopes).toContain('5% of network-access cohort');

    const promote = await app.inject({ method: 'POST', url: `/admin/platform/releases/${release.id}/canary/promote`, headers: { cookie: cookie(admin) }, payload: { by: 'release-approver', health: true } });
    expect(promote.json().release.status).toBe('active');
    const dossier = promote.json().release.dossier;
    expect(dossier.contentHash).toBe(release.contentHash);
    expect(dossier.canary.result).toBe('pass');
    expect(dossier.gates.length).toBeGreaterThanOrEqual(5);
    expect(dossier.findingsBlocking).toBe(0);
    expect(dossier.approvers).toContain('release-approver');

    const list = await app.inject({ method: 'GET', url: '/admin/platform/releases', headers: { cookie: cookie(admin) } });
    expect(list.json().active.id).toBe(release.id);
  });

  it('canary failure rolls the release back with the failed evidence retained', async () => {
    const create = await app.inject({ method: 'POST', url: '/admin/platform/releases', headers: { cookie: cookie(admin) }, payload: { version: 'canary-fail-v3' } });
    const release = create.json().release;
    await app.inject({ method: 'POST', url: `/admin/platform/releases/${release.id}/validate`, headers: { cookie: cookie(admin) } });
    await app.inject({ method: 'POST', url: `/admin/platform/releases/${release.id}/request-approval`, headers: { cookie: cookie(admin) } });
    const canary = await app.inject({ method: 'POST', url: `/admin/platform/releases/${release.id}/canary`, headers: { cookie: cookie(admin) } });
    expect(canary.json().release.status).toBe('canary');

    const fail = await app.inject({ method: 'POST', url: `/admin/platform/releases/${release.id}/canary/fail`, headers: { cookie: cookie(admin) }, payload: { reason: 'error-rate spike in canary scopes', by: 'release-approver' } });
    expect(fail.json().release.status).toBe('rolled-back');
    expect(fail.json().release.dossier.canary.result).toBe('fail');
    expect(fail.json().release.dossier.runtimeHealth.ok).toBe(false);

    // The previously active release is untouched — rollback does not erase it.
    const list = await app.inject({ method: 'GET', url: '/admin/platform/releases', headers: { cookie: cookie(admin) } });
    expect(list.json().active.version).toBe('safe-v2.draft');
  });
});
