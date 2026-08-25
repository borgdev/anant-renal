import { describe, expect, it } from 'vitest';
import { SwarmWorkspaceStore, sqlWorkspacePersistence, projectRealmEvents, type WorkspacePersistence } from '../src/swarm/workspace.js';

const NOW = () => '2026-08-23T09:00:00.000Z';

/** In-memory WorkspacePersistence for durability tests. */
function memPersistence(): WorkspacePersistence & { rows: Map<string, { kind: string; id: string; entityJson: string; createdAt: string; updatedAt: string }> } {
  const rows = new Map<string, { kind: string; id: string; entityJson: string; createdAt: string; updatedAt: string }>();
  return {
    rows,
    async list(kind) {
      return [...rows.values()].filter((r) => r.kind === kind).map((r) => ({ id: r.id, entityJson: r.entityJson, createdAt: r.createdAt, updatedAt: r.updatedAt }));
    },
    async save(kind, id, entityJson, createdAt, updatedAt) {
      const at = updatedAt ?? NOW();
      const ct = createdAt ?? at;
      rows.set(`${kind}:${id}`, { kind, id, entityJson, createdAt: ct, updatedAt: at });
    },
    async remove(kind, id) {
      rows.delete(`${kind}:${id}`);
    },
  };
}

function ws(persistence?: WorkspacePersistence): SwarmWorkspaceStore {
  return new SwarmWorkspaceStore(persistence, NOW);
}

describe('swarm workspace store', () => {
  it('seeds the 8 exec-console red-team scenarios and persists runs', async () => {
    const store = ws();
    const scenarios = await store.seedRedTeamScenarios();
    expect(scenarios).toHaveLength(8);
    expect(scenarios.map((s) => s.id)).toEqual(['rt-001', 'rt-002', 'rt-003', 'rt-004', 'rt-005', 'rt-006', 'rt-007', 'rt-008']);
    const run = await store.replayRedTeamScenario('rt-001', { ranBy: 'operator', policy: { defaultDecision: 'block', externalWritesEnabled: false } });
    expect(run.passed).toBe(true);
    expect(run.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
    const runs = await store.listRedTeamRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.scenarioId).toBe('rt-001');
  });

  it('red-team replay reflects the CURRENT admin policy (allow → default-deny fails)', async () => {
    const store = ws();
    await store.seedRedTeamScenarios();
    const pass = await store.replayRedTeamScenario('rt-002', { policy: { defaultDecision: 'block', externalWritesEnabled: false } });
    expect(pass.passed).toBe(true);
    const fail = await store.replayRedTeamScenario('rt-002', { policy: { defaultDecision: 'allow', externalWritesEnabled: false } });
    expect(fail.passed).toBe(false);
    expect(fail.checks.some((c) => !c.passed && /deny/i.test(c.name))).toBe(true);
  });

  it('admin can author/update/delete red-team scenarios', async () => {
    const store = ws();
    const created = await store.createRedTeamScenario({ name: 'Scheduler prompt injection', threatModel: 'prompt-injection', createdBy: 'admin' });
    expect(created.status).toBe('active');
    const updated = await store.updateRedTeamScenario(created.id, { status: 'archived' });
    expect(updated?.status).toBe('archived');
    const deleted = await store.deleteRedTeamScenario(created.id);
    expect(deleted).toBe(true);
    expect(await store.get('red-team-scenario', created.id)).toBeUndefined();
  });

  it('submission packages validate as dry-runs with manifest hashes', async () => {
    const store = ws();
    const pkg = await store.createSubmissionPackage({ measureId: 'ecqm:M21Basic/1.0.0', realmId: 'realm:c2', realms: { total: 4 }, createdBy: 'admin' });
    expect(pkg.status).toBe('validated');
    expect(pkg.resultsIncluded).toBe(4);
    expect(pkg.liveTransmission).toBe(false);
    expect(pkg.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    const again = await store.validateSubmissionPackage(pkg.id);
    expect(again?.status).toBe('validated');
    await store.deleteSubmissionPackage(pkg.id);
    expect(await store.get('submission-package', pkg.id)).toBeUndefined();
  });

  it('config release lifecycle draft → validated → approved → active with single active', async () => {
    const store = ws();
    const draft = await store.createReleaseDraft({ version: 'sandbox-2026.08.23', changeSummary: 'Packaged baseline catalog', createdBy: 'admin' });
    expect(draft.status).toBe('draft');
    const validated = await store.validateRelease(draft.id);
    expect(validated?.status).toBe('validated');
    expect(validated?.checks?.length).toBeGreaterThanOrEqual(4);
    const approved = await store.approveRelease(draft.id);
    expect(approved?.status).toBe('approved');
    const active = await store.activateRelease(draft.id);
    expect(active?.status).toBe('active');
    expect(active?.activatedAt).toBeTruthy();
    // activating a second release retires the first
    const second = await store.createReleaseDraft({ version: 'sandbox-2026.08.24' });
    await store.validateRelease(second.id);
    await store.approveRelease(second.id);
    await store.activateRelease(second.id);
    const all = await store.listReleases();
    expect(all.filter((r) => r.status === 'active')).toHaveLength(1);
    expect((await store.activeRelease())?.id).toBe(second.id);
  });

  it('evidence reviews flow request → confirm / reject with reviewer', async () => {
    const store = ws();
    const review = await store.requestReview({ entityId: 'ep-1042', entityType: 'outcome-episode', requestedBy: 'fa', reason: 'Before execution' });
    expect(review.status).toBe('pending');
    const confirmed = await store.reviewEvidence(review.id, { decision: 'confirmed', reviewer: 'rod', note: 'Plan sound' });
    expect(confirmed?.status).toBe('confirmed');
    expect(confirmed?.reviewer).toBe('rod');
    expect(confirmed?.note).toBe('Plan sound');
    const rejected = await store.reviewEvidence(review.id, { decision: 'rejected', reviewer: 'rod' });
    expect(rejected?.status).toBe('rejected');
  });

  it('facility simulations derive feasibility from real realm counts', async () => {
    const store = ws();
    const feasible = await store.simulateFacility({ realmId: 'realm:c2', realm: { units: 3, patients: 2, presences: 1, effects: 1 } });
    expect(feasible.feasible).toBe(true);
    expect(feasible.checks).toHaveLength(4);
    expect(feasible.runtimeEffect).toBe(false);
    const blocked = await store.simulateFacility({ realmId: 'realm:empty', realm: { units: 0, patients: 0, presences: 0, effects: 0 } });
    expect(blocked.feasible).toBe(false);
    expect(blocked.checks[0]?.detail).toContain('No unit capacity');
    expect((await store.listSimulations())).toHaveLength(2);
  });

  it('knowledge notes support create, comment, list-by-node and delete', async () => {
    const store = ws();
    const note = await store.createNote({ nodeId: 'treatment-continuity', title: 'Transport gap', content: 'Patient cannot drive Tuesdays.', createdBy: 'admin' });
    expect(note.version).toBe(1);
    const commented = await store.addComment('treatment-continuity', note.id, { body: 'Escalate to coordinator', by: 'fa' });
    expect(commented?.version).toBe(2);
    expect(commented?.comments).toHaveLength(1);
    expect((await store.listNotes('treatment-continuity'))).toHaveLength(1);
    expect((await store.listNotes('other-node'))).toHaveLength(0);
    expect(await store.deleteNote(note.id)).toBe(true);
    expect((await store.listNotes())).toHaveLength(0);
  });

  it('platform admin seeds tenant/kafka/policy and persists edits; kafka test verifies contract', async () => {
    const store = ws();
    const tenant = await store.getAdminTenant();
    expect(tenant.displayName).toBe('Riverbend Dialysis');
    const saved = await store.saveAdminTenant({ displayName: 'Acme Renal', status: 'active' });
    expect(saved.displayName).toBe('Acme Renal');
    expect(saved.status).toBe('active');
    expect((await store.getAdminTenant()).persisted).toBe(true);

    const kafka = await store.getAdminKafka();
    expect(kafka.status).toBe('not-configured');
    const draft = await store.saveAdminKafka({ bridgeUrl: 'https://bridge.acme.example' });
    expect(draft.status).toBe('draft');
    const verified = await store.testAdminKafka();
    expect(verified.status).toBe('contract-verified');
    expect(verified.lastTestedAt).toBe(NOW());

    const policy = await store.getAdminPolicy();
    expect(policy.defaultDecision).toBe('block');
    const changed = await store.saveAdminPolicy({ externalWritesEnabled: true });
    expect(changed.externalWritesEnabled).toBe(true);
  });

  it('is durable across store instances via the persistence seam', async () => {
    const persistence = memPersistence();
    const a = ws(persistence);
    await a.seedRedTeamScenarios();
    await a.createSubmissionPackage({ measureId: 'ecqm:M21Basic/1.0.0', realms: { total: 2 } });
    expect(persistence.rows.size).toBeGreaterThan(0);
    // Fresh store hydrated from the same persistence sees the data.
    const b = ws(persistence);
    const scenarios = await b.seedRedTeamScenarios();
    expect(scenarios).toHaveLength(8);
    expect((await b.list('submission-package'))).toHaveLength(1);
  });

  it('sqlWorkspacePersistence adapts a SqlStore-like object', async () => {
    const rows = new Map<string, { kind: string; id: string; entityJson: string; createdAt: string; updatedAt: string }>();
    const fake = {
      async listWorkspace(kind?: string) {
        return [...rows.values()].filter((r) => !kind || r.kind === kind).map((r) => r);
      },
      async saveWorkspace(row: { kind: string; id: string; entityJson: string; createdAt?: string; updatedAt?: string }) {
        rows.set(`${row.kind}:${row.id}`, { kind: row.kind, id: row.id, entityJson: row.entityJson, createdAt: row.createdAt ?? NOW(), updatedAt: row.updatedAt ?? NOW() });
      },
      async deleteWorkspace(kind: string, id: string) {
        rows.delete(`${kind}:${id}`);
      },
    };
    const adapter = sqlWorkspacePersistence(fake);
    await adapter.save('knowledge-note', 'note-1', '{"title":"x"}', NOW(), NOW());
    const listed = await adapter.list('knowledge-note');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe('note-1');
    await adapter.remove('knowledge-note', 'note-1');
    expect(await adapter.list('knowledge-note')).toHaveLength(0);
  });

  it('seeds the full executive substrate (events/evidence/traces/models/drift/authority/audits/topology)', async () => {
    const store = ws();
    expect(await store.listEvents()).toHaveLength(3);
    expect(await store.listEvidence()).toHaveLength(2);
    expect(await store.listTraces()).toHaveLength(6);
    expect(await store.listModels()).toHaveLength(1);
    expect(await store.listDrift()).toHaveLength(1);
    expect(await store.listAuthoritySources()).toHaveLength(2);
    expect(await store.listSwarmAudits()).toHaveLength(2);
    const topo = await store.listTopology();
    expect(topo.nodes).toHaveLength(20);
    expect(topo.edges).toHaveLength(25);
    // Seeds are idempotent.
    expect(await store.listEvents()).toHaveLength(3);
  });

  it('supports substrate CRUD for events/evidence/traces/models/drift/authority/audits/topology', async () => {
    const store = ws();
    const ev = await store.recordEvent({ eventId: 'ev:real-1', eventType: 'vital.observed', subjectId: 'realm:c2' });
    expect(ev.status).toBe('accepted');
    expect((await store.listEvents()).length).toBe(4);
    expect(await store.remove('swarm-event', ev.id)).toBe(true);

    const evi = await store.addEvidence({ exactText: 'Patient prefers afternoon sessions.', questionId: 'schedule-goal', humanConfirmed: true });
    expect(evi.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await store.listEvidence()).length).toBe(3);

    const tr = await store.addTrace({ name: 'New span', system: 'swarm runtime', durationMs: 10 });
    expect(tr.spanId).toBeTruthy();
    expect((await store.listTraces()).length).toBe(7);

    const model = await store.addModel({ modelId: 'esrd-risk-projection', evaluationScoreBasisPoints: 9100 });
    expect(model.killSwitch).toBe(true);
    expect((await store.listModels()).length).toBe(2);

    const drift = await store.addDrift({ targetId: model.modelId, metric: 'calibration', valueBasisPoints: 5000, thresholdBasisPoints: 9000 });
    expect(drift.status).toBe('drifted');
    expect((await store.listDrift()).length).toBe(2);

    const src = await store.addAuthoritySource({ sourceId: 'hcc-risk-2026', authority: 'CMS' });
    expect(src.effectiveFrom).toBeTruthy();
    expect((await store.listAuthoritySources()).length).toBe(3);

    const audit = await store.addSwarmAudit({ actor: 'rod', action: 'escalate', decision: 'escalated' });
    expect(audit.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await store.listSwarmAudits()).length).toBe(3);

    const node = await store.addTopologyNode({ label: 'New clinic', type: 'facility' });
    expect(node.id).toBe('new-clinic');
    const edge = await store.addTopologyEdge({ source: 'new-clinic', target: 'region', relation: 'contains' });
    expect(edge.confidence).toBe(1);
    const topo = await store.listTopology();
    expect(topo.nodes).toHaveLength(21);
    expect(topo.edges).toHaveLength(26);
  });

  it('projects real realm ledger entries into the exec event contract', () => {
    const projected = projectRealmEvents([
      { realmId: 'realm:c2', eventId: 'uuid-1', kind: 'record-assessment', status: 'bound', emittedAt: NOW(), payload: { questionId: 'q1' } },
      { realmId: 'realm:c2', eventId: 'uuid-2', kind: 'discharge-patient', status: 'rejected', emittedAt: NOW(), payload: {} },
      { realmId: 'realm:b3', eventId: 'uuid-3', kind: 'submit-claim', status: 'bound', emittedAt: NOW(), payload: { amount: 12800 } },
    ]);
    expect(projected).toHaveLength(3);
    expect(projected[0]?.eventType).toBe('assessment.response.v1');
    expect(projected[0]?.status).toBe('accepted');
    expect(projected[1]?.eventType).toBe('adt.discharge.v2');
    expect(projected[1]?.status).toBe('rejected');
    expect(projected[2]?.eventType).toBe('claim.submitted');
    expect(projected[2]?.sourceSystem).toBe('realm-ledger');
    expect(projected[0]?.subjectId).toBe('realm:c2');
  });

  it('seeds every catalog the exec console once imported from src/data', async () => {
    const store = ws();
    const c = await store.catalogs();
    // JSON-backed catalogs (from repo fixtures — cwd is the repo root in tests).
    expect(Array.isArray(c['agent-manifest'])).toBe(true);
    expect((c['agent-manifest'] as unknown[]).length).toBeGreaterThan(0);
    expect((c['measure-pack'] as unknown[]).length).toBeGreaterThan(0);
    expect((c['public-source'] as unknown[]).length).toBeGreaterThan(0);
    const operating = c['operating-model'] as { organization?: string; roles?: unknown[]; domains?: unknown[]; scopePath?: unknown[] };
    expect(operating?.organization).toBe('Riverbend Kidney Care');
    expect(operating?.roles?.length).toBeGreaterThan(0);
    const domain = c['domain-pack'] as { version?: string; packs?: unknown[] };
    expect(domain?.version).toBeTruthy();
    expect(domain?.packs?.length).toBeGreaterThan(0);
    // Literal-seeded catalogs.
    expect((c['federal-fact'] as unknown[]).length).toBe(4);
    expect((c['green-team-check'] as unknown[]).length).toBe(6);
    expect((c['source-mapping'] as unknown[]).length).toBe(5);
    expect((c['facility-station'] as unknown[]).length).toBe(12);
    expect((c['assessment-response'] as unknown[]).length).toBe(3);
    expect((c['outcome-episode-story'] as unknown[]).length).toBe(3);
    expect((c['patient-timeline'] as unknown[]).length).toBe(6);
    const bench = c['public-benchmark'] as { benchmarks?: unknown[]; period?: string };
    expect(Array.isArray(bench?.benchmarks)).toBe(true);
    const eco = c['ecosystem'] as { metricsByLevel?: Record<string, unknown>; domainPulse?: unknown[] };
    expect(eco?.metricsByLevel).toBeTruthy();
    expect(Array.isArray(eco?.domainPulse)).toBe(true);
  });
});
