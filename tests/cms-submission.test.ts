/******************************************************************************
 * CMS/EQRS submission lifecycle — Journey K / Epic 8 — tests.
 *
 * Proves: draft → validated → dual Class-D approval (distinct approvers) →
 * reference-mode transmission gate (stops before live transmission + says why)
 * → submitted → receipt accepted (reconciled) | rejected → correct → resubmit.
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

type Pkg = { id: string; status: string; approvals?: Array<{ approver: string; class: string }>; receipt?: { status: string; referenceId: string }; transmissionBlocked?: { reason: string }; evidenceWindow?: { start: string; end: string; frozenBy?: string }; pinnedVersions?: Record<string, string>; dossier?: { contentHash: string }; reconciledAt?: string; correctionReason?: string; manifestHash?: string; checks?: Array<{ name: string; passed: boolean }> };

describe('CMS/EQRS submission lifecycle (Journey K / Epic 8)', () => {
  let app: App;
  let admin: string;
  beforeAll(async () => {
    app = await build();
    admin = await login(app, 'admin', 'admin123');
  });
  afterAll(async () => { await app.close(); });

  it('blocks unauthenticated /admin/platform/submissions calls (401)', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/platform/submissions' });
    expect(res.statusCode).toBe(401);
  });

  it('creates a package (draft when no results, validated when results present)', async () => {
    const empty = await app.inject({ method: 'POST', url: '/admin/platform/submissions', headers: { cookie: cookie(admin) }, payload: { measureId: 'ecqm:M21Basic/1.0.0', realmId: 'realm:c2', resultsIncluded: 0 } });
    expect(empty.json().package.status).toBe('draft');
    expect(empty.json().package.resultsIncluded).toBe(0);

    const full = await app.inject({ method: 'POST', url: '/admin/platform/submissions', headers: { cookie: cookie(admin) }, payload: { measureId: 'ecqm:M21Basic/1.0.0', realmId: 'realm:c2', resultsIncluded: 214, createdBy: 'regulatory-admin' } });
    expect(full.json().package.status).toBe('validated');
    expect(full.json().package.resultsIncluded).toBe(214);
    expect(full.json().package.liveTransmission).toBe(false);
  });

  it('freezes the evidence window and pins measure/source/config versions', async () => {
    // A release must exist for the config version pin to resolve.
    await app.inject({ method: 'POST', url: '/admin/platform/releases', headers: { cookie: cookie(admin) }, payload: { version: 'sub-pin', createdBy: 'admin' } });
    const full = await app.inject({ method: 'POST', url: '/admin/platform/submissions', headers: { cookie: cookie(admin) }, payload: { measureId: 'ecqm:M21Basic/1.0.0', resultsIncluded: 214 } });
    const id = full.json().package.id;
    const frozen = await app.inject({ method: 'POST', url: `/admin/platform/submissions/${id}/freeze`, headers: { cookie: cookie(admin) }, payload: { start: '2026-01-01', end: '2026-12-31', by: 'regulatory-admin' } });
    const pkg = frozen.json().package as Pkg;
    expect(pkg.evidenceWindow?.start).toBe('2026-01-01');
    expect(pkg.evidenceWindow?.frozenBy).toBe('regulatory-admin');
    expect(pkg.pinnedVersions?.source).toBe('cms-cy2026-final');
    expect(typeof pkg.pinnedVersions?.config).toBe('string');
  });

  it('validate requires the frozen evidence window gate', async () => {
    const full = await app.inject({ method: 'POST', url: '/admin/platform/submissions', headers: { cookie: cookie(admin) }, payload: { measureId: 'ecqm:M21Basic/1.0.0', resultsIncluded: 100 } });
    const id = full.json().package.id;
    // Validate WITHOUT freezing → stays draft (evidence-window gate fails).
    const v1 = await app.inject({ method: 'POST', url: `/admin/platform/submissions/${id}/validate`, headers: { cookie: cookie(admin) } });
    expect(v1.json().package.status).toBe('draft');
    // Freeze then validate → validated.
    await app.inject({ method: 'POST', url: `/admin/platform/submissions/${id}/freeze`, headers: { cookie: cookie(admin) }, payload: { start: '2026-01-01', end: '2026-12-31' } });
    const v2 = await app.inject({ method: 'POST', url: `/admin/platform/submissions/${id}/validate`, headers: { cookie: cookie(admin) } });
    expect(v2.json().package.status).toBe('validated');
    expect(v2.json().package.checks.some((c: { name: string; passed: boolean }) => c.name === 'Evidence window' && c.passed)).toBe(true);
  });

  it('dual Class-D approval requires two DISTINCT approvers and writes a dossier', async () => {
    const pkg = await makeValidatedPackage();
    const id = pkg.id;
    const a1 = await app.inject({ method: 'POST', url: `/admin/platform/submissions/${id}/approve`, headers: { cookie: cookie(admin) }, payload: { approver: 'regulatory-admin' } });
    expect(a1.json().package.status).toBe('validated');
    expect(a1.json().approvals).toBe(1);
    // Same approver again → rejected (distinct required).
    const dup = await app.inject({ method: 'POST', url: `/admin/platform/submissions/${id}/approve`, headers: { cookie: cookie(admin) }, payload: { approver: 'regulatory-admin' } });
    expect(dup.statusCode).toBe(400);
    expect(dup.json().error).toBe('dual-approval-requires-distinct-approvers');
    // Second distinct approver → approved + dossier.
    const a2 = await app.inject({ method: 'POST', url: `/admin/platform/submissions/${id}/approve`, headers: { cookie: cookie(admin) }, payload: { approver: 'quality-officer' } });
    expect(a2.json().package.status).toBe('approved');
    expect(a2.json().approvals).toBe(2);
    const p2 = a2.json().package as Pkg;
    expect(p2.approvals?.every((a) => a.class === 'D')).toBe(true);
    expect(p2.dossier?.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reference-mode transmission stops before live transmission and says why', async () => {
    const pkg = await makeApprovedPackage();
    // No certified connector (kafka not contract-verified) + no credentials.
    const res = await app.inject({ method: 'POST', url: `/admin/platform/submissions/${pkg.id}/submit`, headers: { cookie: cookie(admin) }, payload: { by: 'regulatory-admin' } });
    expect(res.json().stopped).toBe(true);
    expect(res.json().reason).toContain('no certified connector');
    expect(res.json().package.status).toBe('approved');
    expect((res.json().package as Pkg).transmissionBlocked?.reason).toContain('reference-mode');
  });

  it('transmits only with a certified connector + credentials → submitted', async () => {
    // Certify the connector via the contract test.
    await app.inject({ method: 'POST', url: '/admin/platform/integrations/kafka/test', headers: { cookie: cookie(admin) } });
    const pkg = await makeApprovedPackage();
    const res = await app.inject({ method: 'POST', url: `/admin/platform/submissions/${pkg.id}/submit`, headers: { cookie: cookie(admin) }, payload: { by: 'regulatory-admin', credentialsPresent: true } });
    expect(res.json().transmitted).toBe(true);
    expect(res.json().package.status).toBe('submitted');
    expect(res.json().package.transmissionMode).toBe('certified');
  });

  it('receipt accepted → reconciled with evidence retained', async () => {
    const pkg = await makeSubmittedPackage();
    const res = await app.inject({ method: 'POST', url: `/admin/platform/submissions/${pkg.id}/receipt`, headers: { cookie: cookie(admin) }, payload: { status: 'accepted', referenceId: 'EQRS-2026-000123', message: 'accepted' } });
    const p = res.json().package as Pkg;
    expect(p.status).toBe('reconciled');
    expect(p.receipt?.status).toBe('accepted');
    expect(p.receipt?.referenceId).toBe('EQRS-2026-000123');
    expect(p.reconciledAt).toBeTruthy();
  });

  it('receipt rejected → correct → resubmit → accepted (full correction loop)', async () => {
    const pkg = await makeSubmittedPackage();
    const reject = await app.inject({ method: 'POST', url: `/admin/platform/submissions/${pkg.id}/receipt`, headers: { cookie: cookie(admin) }, payload: { status: 'rejected', referenceId: 'EQRS-2026-000456', message: 'denominator mismatch on line 4' } });
    expect(reject.json().package.status).toBe('rejected');
    expect(reject.json().package.rejectionReason).toContain('denominator mismatch');

    // Correct → back to draft; receipt evidence cleared.
    const correct = await app.inject({ method: 'POST', url: `/admin/platform/submissions/${pkg.id}/correct`, headers: { cookie: cookie(admin) }, payload: { reason: 'Fixed exclusion mapping', by: 'quality-officer' } });
    const c = correct.json().package as Pkg;
    expect(c.status).toBe('draft');
    expect(c.correctionReason).toContain('Fixed exclusion');
    expect(c.receipt).toBeUndefined();

    // Re-validate → re-approve (dual) → re-submit → accepted → reconciled.
    await app.inject({ method: 'POST', url: `/admin/platform/submissions/${pkg.id}/validate`, headers: { cookie: cookie(admin) } });
    await app.inject({ method: 'POST', url: `/admin/platform/submissions/${pkg.id}/approve`, headers: { cookie: cookie(admin) }, payload: { approver: 'regulatory-admin' } });
    await app.inject({ method: 'POST', url: `/admin/platform/submissions/${pkg.id}/approve`, headers: { cookie: cookie(admin) }, payload: { approver: 'quality-officer' } });
    const resubmit = await app.inject({ method: 'POST', url: `/admin/platform/submissions/${pkg.id}/submit`, headers: { cookie: cookie(admin) }, payload: { by: 'regulatory-admin', credentialsPresent: true } });
    expect(resubmit.json().package.status).toBe('submitted');
    const final = await app.inject({ method: 'POST', url: `/admin/platform/submissions/${pkg.id}/receipt`, headers: { cookie: cookie(admin) }, payload: { status: 'accepted', referenceId: 'EQRS-2026-000789' } });
    expect(final.json().package.status).toBe('reconciled');
  });

  it('detail returns the evidence snapshot + approvals + receipt', async () => {
    const pkg = await makeSubmittedPackage();
    const detail = await app.inject({ method: 'GET', url: `/admin/platform/submissions/${pkg.id}`, headers: { cookie: cookie(admin) } });
    expect(detail.statusCode).toBe(200);
    const p = detail.json().package as Pkg;
    expect(p.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Array.isArray(p.approvals)).toBe(true);
    expect(p.approvals?.length).toBe(2);
  });

  /* ---------- helpers (each builds a fresh package through the lifecycle) ---------- */

  async function makeValidatedPackage(): Promise<Pkg> {
    const full = await app.inject({ method: 'POST', url: '/admin/platform/submissions', headers: { cookie: cookie(admin) }, payload: { measureId: 'ecqm:M21Basic/1.0.0', resultsIncluded: 214 } });
    const id = full.json().package.id;
    await app.inject({ method: 'POST', url: `/admin/platform/submissions/${id}/freeze`, headers: { cookie: cookie(admin) }, payload: { start: '2026-01-01', end: '2026-12-31' } });
    await app.inject({ method: 'POST', url: `/admin/platform/submissions/${id}/validate`, headers: { cookie: cookie(admin) } });
    return { id, status: 'validated' };
  }
  async function makeApprovedPackage(): Promise<Pkg> {
    const p = await makeValidatedPackage();
    await app.inject({ method: 'POST', url: `/admin/platform/submissions/${p.id}/approve`, headers: { cookie: cookie(admin) }, payload: { approver: 'regulatory-admin' } });
    await app.inject({ method: 'POST', url: `/admin/platform/submissions/${p.id}/approve`, headers: { cookie: cookie(admin) }, payload: { approver: 'quality-officer' } });
    return { id: p.id, status: 'approved' };
  }
  async function makeSubmittedPackage(): Promise<Pkg> {
    await app.inject({ method: 'POST', url: '/admin/platform/integrations/kafka/test', headers: { cookie: cookie(admin) } });
    const p = await makeApprovedPackage();
    const res = await app.inject({ method: 'POST', url: `/admin/platform/submissions/${p.id}/submit`, headers: { cookie: cookie(admin) }, payload: { by: 'regulatory-admin', credentialsPresent: true } });
    expect(res.json().transmitted).toBe(true);
    return { id: p.id, status: 'submitted' };
  }
});
