/******************************************************************************
 * Generic platform contract layer (port plan Phase A/B).
 *
 * The docs' "generic platform" owns organization graphs, identity/roles,
 * integrations, topic plans, releases, DLQ and the two experience UIs — with
 * solution packs / lenses supplying domain specifics. These routes expose that
 * generic surface over the existing durable services (the swarm workspace, the
 * persistent outcome coordinator, the bridge/outbox and the SQL store). They do
 * NOT create a second store; they compose existing state into product journeys.
 *
 *   GET  /admin/platform/bootstrap            — onboarding state + next gate
 *   PUT  /admin/platform/onboarding           — resumable onboarding rail
 *   GET  /admin/platform/organization         — provider/payer/hybrid hierarchy
 *   PUT  /admin/platform/organization         — upsert hierarchy (durable)
 *   GET  /admin/platform/topics               — versioned topic/partition/DLQ plan
 *   PUT  /admin/platform/topics               — upsert topic plan (durable)
 *   GET  /admin/platform/integrations         — kafka/fhir/cms/identity summary
 *   POST /admin/platform/integrations/kafka/test — contract-verified broker test
 *   GET  /admin/platform/releases             — releases + active
 *   POST /admin/platform/releases             — create draft release
 *   POST /admin/platform/releases/:id/{validate,request-approval,activate,rollback}
 *   GET  /admin/platform/dlq                  — broker DLQ + bridge incidents + outbox
 *
 * Public experience APIs (session-aware, not gated by the /admin/* guard):
 *   GET  /api/context                         — role/scope/pack/lens/nav/capabilities
 *   GET  /api/work                            — role-scoped My Work queue
 *   GET  /api/work/:id                        — universal detail
 *   POST /api/work/:id/actions                — typed idempotent intent
 *   GET  /api/graph                           — typed scoped hypergraph projection
 *   GET/POST /api/canvases (+/:id)            — saved shared-intelligence canvases
 ******************************************************************************/

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { LocalUser, LocalUserStore } from './auth/users.js';
import type { SessionManager } from './auth/session.js';
import { SESSION_COOKIE, readCookieValue } from './auth/session.js';
import { consolesForRole, type ConsoleId } from './console-gate.js';
// The cohort reference builder/parser live in the cohort module so the queue and
// every drawer cannot spell the same key two different ways.
import { cohortWorkId, parseCohortRef } from './cohort-routes.js';
import { getSwarmWorkspace, getSwarmCoordinator, swarmWhatIf, projectTopology, type ProjectedEdge, type ProjectedNode } from './swarm-routes.js';
import type { SwarmWorkspaceStore, WorkspaceDoc, PlatformOrganization, PlatformTopicPlan, PlatformCanvas, ConfigRelease, EvidenceReview, DlqRemediation } from '../swarm/workspace.js';
import type { PersistentOutcomeCoordinator } from '../swarm/durable-coordinator.js';
import type { OutcomeEpisode } from '../swarm/outcome-episode.js';
import { episodeDstReadout, compareDstQueue } from '../swarm/work-dst.js';
import type { ApprovalClass } from '../swarm/types.js';
import type { LiveRealmSource } from '../swarm/live.js';
import type { EventBroker } from './event-broker.js';
import { getSqlStore } from './sql/index.js';
import { seedCMSSources } from '../healthcare-core/cms-source-registry.js';
import type { CanonicalEvent } from '../healthcare-core/events.js';
import type { IdentityRole } from '../identity/types.js';
import type { DomainPack } from '../control-plane/pack-registry.js';

export interface PlatformRouteOptions {
  /** Live realm snapshots (for scope/aggregate badges on context + work). */
  realms?: () => LiveRealmSource[];
  /** Live broker (for DLQ depth). */
  broker?: EventBroker;
  /** Durable outbox (for outbox dead/pending counts on the DLQ view). */
  eventOutbox?: import('./event-outbox.js').EventOutbox;
  /** Console identity — resolves the hh_session cookie to a role for the public
   *  experience APIs. Absent → experience APIs are unauthenticated. */
  users?: LocalUserStore;
  sessions?: SessionManager;
  /** Installed solution packs (from the PackRegistry) — the real Pack Studio
   *  catalog. Activating one durably drives `/api/context` pack.id + lens. */
  packs?: readonly DomainPack[];
  /** F2 renal patient source — lets cohort suggestions appear in the work queue
   *  instead of a second inbox. Defaults to every patient in RealmRegistry. */
  patients?: (() => import('../swarm/renal-cohort.js').RenalPatientInput[]) | undefined;
}

/** Capabilities granted per console (server-authoritative). A work item carries
 *  a capability; a role can act when its console grants it. */
export const CAPABILITIES: Record<ConsoleId, string[]> = {
  exec: ['work.review', 'work.approve', 'release.approve', 'episode.decide', 'episode.escalate', 'evidence.review', 'cohort.review'],
  ops: ['onboarding.run', 'org.configure', 'integration.operate', 'topic.configure', 'dlq.remediate', 'release.validate', 'catalog.admin', 'cohort.review'],
};

/* ---------- onboarding model (12-step product rail, gated) ---------- */

const ONBOARDING_STEPS: Array<{ id: string; label: string; gate: string }> = [
  { id: 'organization', label: 'Organization graph', gate: 'Provider, payer or hybrid hierarchy is configured' },
  { id: 'identity', label: 'Identity and decision rights', gate: 'Users, roles and scopes exist' },
  { id: 'integrations', label: 'Event and clinical data plane', gate: 'Kafka / FHIR / CMS connections are configured' },
  { id: 'topics', label: 'Kafka routing and topic plan', gate: 'Topics, partitions, keys and DLQ are planned' },
  { id: 'packs', label: 'Install solution packs', gate: 'A solution pack and its agents are installed' },
  { id: 'agents', label: 'Configure agents and workflows', gate: 'Bounded agents are configured with outputs and DLQ' },
  { id: 'release', label: 'Red/green release gates', gate: 'A release validates with no blocking findings' },
  { id: 'activate', label: 'Activate and hand off', gate: 'A release is active and users can start on My Work' },
];

/** Deterministic gate checks derived from real state (never client claims). */
async function onboardingGates(ws: SwarmWorkspaceStore, users?: LocalUserStore): Promise<Record<string, boolean>> {
  let releases: ConfigRelease[] = [];
  let agentCount = 0;
  try { await ws.seedCatalogs(); } catch { /* catalogs unavailable */ }
  try { releases = await ws.listReleases(); } catch { /* no releases */ }
  try { agentCount = (await ws.list<WorkspaceDoc>('agent-manifest')).length; } catch { /* no agents */ }
  return {
    organization: Boolean(await ws.getPlatformOrganization()),
    identity: (users?.list().length ?? 0) > 0,
    // The admin-kafka doc self-seeds as 'not-configured'; the gate only unlocks
    // once an operator runs the contract-only broker test.
    integrations: (await ws.getAdminKafka()).status === 'contract-verified',
    topics: Boolean(await ws.getPlatformTopicPlan()),
    packs: agentCount > 0,
    agents: agentCount > 0,
    release: releases.some((r) => ['validated', 'approved', 'active'].includes(r.status)),
    activate: releases.some((r) => r.status === 'active'),
  };
}

/** Build the onboarding state: steps with derived status + the next gate. */
async function onboardingState(ws: SwarmWorkspaceStore, users?: LocalUserStore): Promise<{
  operatingModel: PlatformOrganization['operatingModel'] | null;
  currentStep: string;
  completedSteps: string[];
  steps: Array<{ id: string; label: string; status: 'pending' | 'active' | 'complete'; gate: string }>;
  gates: Record<string, boolean>;
  readyForRehearsal: boolean;
}> {
  const [gates, doc] = await Promise.all([onboardingGates(ws, users), ws.getPlatformOnboarding()]);
  const completed = new Set<string>();
  for (const [id, ok] of Object.entries(gates)) if (ok) completed.add(id);
  const currentStep = doc?.currentStep && !gates[doc.currentStep] ? doc.currentStep : (ONBOARDING_STEPS.find((s) => !gates[s.id])?.id ?? 'activate');
  const steps = ONBOARDING_STEPS.map((s) => ({
    id: s.id,
    label: s.label,
    gate: s.gate,
    status: gates[s.id] ? ('complete' as const) : s.id === currentStep ? ('active' as const) : ('pending' as const),
  }));
  // "Ready for rehearsal" = everything through red/green release, before activation.
  const readyForRehearsal = ['organization', 'identity', 'integrations', 'topics', 'packs', 'agents', 'release'].every((id) => gates[id]);
  return { operatingModel: (await ws.getPlatformOrganization())?.operatingModel ?? null, currentStep, completedSteps: ONBOARDING_STEPS.filter((s) => gates[s.id]).map((s) => s.id), steps, gates, readyForRehearsal };
}

/* ---------- work queue (My Work) ---------- */

export interface PlatformWorkItem {
  id: string;
  kind: 'episode' | 'review' | 'release' | 'dlq' | 'cohort';
  title: string;
  summary: string;
  state: string;
  urgency: 'high' | 'medium' | 'low';
  scope: string;
  owner: string;
  sla: string;
  console: ConsoleId;
  capability: string;
  actions: string[];
  at: string;
  /** DST-Q — Dempster–Shafer belief readout (present on evidence-driven episode items). */
  belief?: number;
  plausibility?: number;
  conflictMass?: number;
  evidenceStatus?: 'corroborated' | 'weak' | 'contested';
  /** DST-Q — belief-aware decision priority in [0,1]; orders items within an urgency tier. */
  dstPriority?: number;
}

const OPEN_EPISODE_STATES = new Set(['AwaitingApproval', 'Proposed', 'Coordinating', 'Verifying', 'Escalated']);

function episodeApprovalClass(e: OutcomeEpisode): ApprovalClass {
  return (e.proposal as { approvalClass?: ApprovalClass } | undefined)?.approvalClass ?? (e.approval?.approvalClass ?? 'B');
}

/** Derive the role-scoped My Work queue from real state. */
async function buildWorkQueue(ws: SwarmWorkspaceStore, coord: PersistentOutcomeCoordinator, opts: PlatformRouteOptions, role?: IdentityRole): Promise<PlatformWorkItem[]> {
  const roleConsoles = role ? consolesForRole(role) : (['exec', 'ops'] as ConsoleId[]);
  const can = (consoleId: ConsoleId, capability: string): boolean => roleConsoles.includes(consoleId) && CAPABILITIES[consoleId].includes(capability);

  const items: PlatformWorkItem[] = [];

  // 1. Outcome episodes needing a human decision.
  for (const e of coord.list()) {
    if (!OPEN_EPISODE_STATES.has(e.state)) continue;
    const cls = episodeApprovalClass(e);
    const consoleId: ConsoleId = 'exec';
    const actions: string[] = [];
    if (e.state === 'AwaitingApproval' || e.state === 'Proposed') {
      if (can(consoleId, 'episode.decide')) actions.push('approve', 'reject');
    }
    if (e.state !== 'Escalated' && can(consoleId, 'episode.escalate')) actions.push('escalate');
    if (actions.length === 0) continue;
    const item: PlatformWorkItem = {
      id: `episode:${e.episodeId}`,
      kind: 'episode',
      title: `${e.kind.replace(/[-.]/g, ' ')} · ${e.subject}`,
      summary: `Outcome episode in ${e.state} · approval class ${cls} · ${e.evidence.length} evidence ref(s)`,
      state: e.state,
      urgency: e.state === 'Escalated' ? 'high' : e.state === 'AwaitingApproval' ? 'medium' : 'low',
      scope: e.scopeType,
      owner: e.approval?.approver ?? 'Outcome Command',
      sla: e.state === 'AwaitingApproval' ? 'Today' : 'Ongoing',
      console: consoleId,
      capability: 'episode.decide',
      actions,
      at: e.openedAt,
    };
    // DST-Q — belief readout + priority from the episode's real evidence fusion.
    const dst = episodeDstReadout(e);
    if (dst) {
      item.belief = dst.belief;
      item.plausibility = dst.plausibility;
      item.conflictMass = dst.conflictMass;
      if (dst.evidenceStatus !== undefined) item.evidenceStatus = dst.evidenceStatus;
      item.dstPriority = dst.score;
    }
    items.push(item);
  }

  // 2. Pending evidence reviews (clinical/executive).
  let reviews: EvidenceReview[] = [];
  try { reviews = await ws.listReviews(); } catch { /* none */ }
  for (const r of reviews.filter((x) => x.status === 'pending')) {
    const consoleId: ConsoleId = 'exec';
    if (!can(consoleId, 'evidence.review')) continue;
    items.push({
      id: `review:${r.id}`,
      kind: 'review',
      title: `Evidence review · ${r.entityType}`,
      summary: r.reason,
      state: 'pending',
      urgency: 'medium',
      scope: r.entityId,
      owner: 'Clinical Safety Officer',
      sla: 'Today',
      console: consoleId,
      capability: 'evidence.review',
      actions: ['approve', 'reject'],
      at: r.createdAt,
    });
  }

  // 3. Releases awaiting approval (exec) or validation (ops).
  let releases: ConfigRelease[] = [];
  try { releases = await ws.listReleases(); } catch { /* none */ }
  for (const rel of releases) {
    if (rel.status === 'validated' && can('exec', 'release.approve')) {
      items.push({
        id: `release:${rel.id}`, kind: 'release', title: `Release approval · ${rel.version}`,
        summary: rel.changeSummary, state: 'validated', urgency: 'medium', scope: 'configuration',
        owner: 'Configuration Release Approver', sla: 'This sprint', console: 'exec', capability: 'release.approve',
        actions: ['approve', 'reject'], at: rel.validatedAt ?? rel.updatedAt,
      });
    } else if (rel.status === 'approved' && can('exec', 'release.approve')) {
      items.push({
        id: `release:${rel.id}`, kind: 'release', title: `Release activation · ${rel.version}`,
        summary: 'Approved release ready to activate (canary scopes)', state: 'approved', urgency: 'high',
        scope: 'configuration', owner: 'Configuration Release Approver', sla: 'Today', console: 'exec', capability: 'release.approve',
        actions: ['activate', 'rollback'], at: rel.updatedAt,
      });
    } else if (rel.status === 'canary' && can('exec', 'release.approve')) {
      items.push({
        id: `release:${rel.id}`, kind: 'release', title: `Canary promote · ${rel.version}`,
        summary: `Canary scopes ${(rel.canaryScopes ?? []).join(', ') || '—'} — promote to full active or fail the release`, state: 'canary', urgency: 'high',
        scope: 'configuration', owner: 'Configuration Release Approver', sla: 'ASAP', console: 'exec', capability: 'release.approve',
        actions: ['promote', 'fail'], at: rel.canaryStartedAt ?? rel.updatedAt,
      });
    } else if (rel.status === 'failed' && can('ops', 'release.validate')) {
      items.push({
        id: `release:${rel.id}`, kind: 'release', title: `Release gate failed · ${rel.version}`,
        summary: 'Validation gates did not pass — close blocking findings and re-validate', state: 'failed', urgency: 'high',
        scope: 'configuration', owner: 'Configuration Release Approver', sla: 'ASAP', console: 'ops', capability: 'release.validate',
        actions: ['validate'], at: rel.updatedAt,
      });
    } else if (rel.status === 'draft' && can('ops', 'release.validate')) {
      items.push({
        id: `release:${rel.id}`, kind: 'release', title: `Release validation · ${rel.version}`,
        summary: rel.changeSummary, state: 'draft', urgency: 'low', scope: 'configuration',
        owner: 'Configuration Release Approver', sla: 'This sprint', console: 'ops', capability: 'release.validate',
        actions: ['validate'], at: rel.updatedAt,
      });
    }
  }

  // 4. DLQ incidents needing an owner (operations).
  if (can('ops', 'dlq.remediate')) {
    try {
      for (const rcpt of await openBridgeIncidents(ws, 50)) {
        items.push({
          id: `dlq:${rcpt.outboxId}`, kind: 'dlq', title: `Bridge incident · ${rcpt.topic ?? 'unknown topic'}`,
          summary: rcpt.incident ?? 'Delivery failed after retries', state: 'incident', urgency: 'high',
          scope: 'event plane', owner: 'Integration/Kafka Administrator', sla: 'ASAP', console: 'ops', capability: 'dlq.remediate',
          actions: ['acknowledge'], at: rcpt.publishedAt,
        });
      }
    } catch { /* store unavailable — DLQ omitted */ }
  }

  // 5. Living-cohort suggestions awaiting a clinical decision.
  //
  // These are SUGGESTIONS, not actions: a patient satisfying a cohort is a
  // statement about state, and the decision belongs to a human. They land HERE,
  // in the one queue, rather than in a second cohort inbox — a cohort that
  // opened its own alert stream would be exactly the failure mode the cohort
  // design exists to avoid.
  const cohortCapability = can('ops', 'cohort.review') ? 'ops' : can('exec', 'cohort.review') ? 'exec' : null;
  if (cohortCapability && opts.patients) {
    try {
      const docs = await ws.listCohortDefinitions();
      if (docs.length > 0) {
        const { evaluateCohorts, toCohortDefinition } = await import('./cohort-routes.js');
        const { cachedLedgerSeries, declinedSuppression } = await import('./cohort-routes.js');
        const live = opts.patients();
        const series = cachedLedgerSeries(live);
        const { rows } = evaluateCohorts(docs.filter((d) => d.enabled).map(toCohortDefinition), live, { series, at: new Date().toISOString(), intervalDays: 2 });
        // A suggestion a human already declined is not re-presented until its
        // criteria change — otherwise declining it looks like it did nothing.
        const suppressed = await declinedSuppression(ws);
        for (const row of rows) {
          if (row.state !== 'member' || row.kind !== 'suggested') continue;
          if (suppressed(row.cohortId, row.realmId, row.patientId, row.criterionVersion) !== null) continue;
          items.push({
            id: cohortWorkId(row.realmId, row.cohortId, row.patientId),
            kind: 'cohort',
            title: `${row.label} · ${row.patientId}`,
            // the reason is the product: why is this patient in this cohort
            summary: `${row.reason} → ${row.suggestedAction}`,
            state: 'suggested',
            urgency: row.opportunity >= 1.2 ? 'high' : row.opportunity >= 0.6 ? 'medium' : 'low',
            scope: row.protocol,
            owner: row.approvalClass === 'C' ? 'Nephrologist' : 'Renal nurse',
            sla: 'Next session',
            console: cohortCapability,
            capability: 'cohort.review',
            actions: ['review', 'decline'],
            at: new Date().toISOString(),
          });
        }
      }
    } catch (err) {
      // Cohort suggestions are additive: a failure here must not take down the
      // work queue. But silence is how a whole cohort layer goes missing without
      // anyone noticing, so the reason is always recorded.
      console.warn('[work-queue] cohort suggestions unavailable:', err instanceof Error ? err.message : String(err));
    }
  }

  // DST-Q — sort: urgency tier first, then belief-aware priority (scored items
  // before unscored; within scored, highest D-S priority first), recency last.
  return items.sort(compareDstQueue);
}

/* ---------- aggregates (safe, scoped badges) ---------- */

async function contextAggregates(ws: SwarmWorkspaceStore, coord: PersistentOutcomeCoordinator, opts: PlatformRouteOptions): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const realms = opts.realms?.() ?? [];
  out.realms = realms.length;
  out.patients = realms.reduce((n, r) => n + (r.counts.patient ?? 0), 0);
  out.units = realms.reduce((n, r) => n + (r.counts.unit ?? 0), 0);
  out.facilities = realms.reduce((n, r) => n + (r.counts.facility ?? 0), 0);
  out.openEpisodes = coord.list().filter((e) => OPEN_EPISODE_STATES.has(e.state)).length;
  try {
    out.dlq = opts.broker ? (await opts.broker.deadLetterSize()) : 0;
  } catch { out.dlq = 0; }
  try {
    const store = await getSqlStore();
    out.facilitiesMaster = (await store.listFacilities()).length;
    out.patientsMaster = (await store.listPatients()).length;
  } catch { /* master data unavailable */ }
  return out;
}

/* ---------- navigation + capability model ---------- */

function navigationFor(consoles: ConsoleId[]): Array<{ id: string; label: string; console: ConsoleId; href: string }> {
  const all: Array<{ id: string; label: string; console: ConsoleId; href: string }> = [
    { id: 'my-work', label: 'My Work', console: 'exec', href: '/api/work' },
    { id: 'outcome-command', label: 'Outcome Command', console: 'exec', href: '/exec/' },
    { id: 'person-intelligence', label: 'Person Intelligence', console: 'exec', href: '/exec/' },
    { id: 'shared-intelligence', label: 'Shared Intelligence', console: 'exec', href: '/exec/' },
    { id: 'operator-console', label: 'Operator Console', console: 'ops', href: '/admin/ui/' },
    { id: 'event-operations', label: 'Event Operations', console: 'ops', href: '/admin/ui/' },
    { id: 'release-center', label: 'Release Center', console: 'ops', href: '/admin/platform/releases' },
  ];
  return all.filter((n) => consoles.includes(n.console));
}

function capabilitiesFor(consoles: ConsoleId[]): string[] {
  return [...new Set(consoles.flatMap((c) => CAPABILITIES[c]))];
}

/* ---------- idempotent action cache ---------- */

const ACTION_LEDGER = new Map<string, unknown>();
function actionCacheKey(action: string, idempotencyKey?: string): string | undefined {
  if (!idempotencyKey) return undefined;
  return `${action}:${idempotencyKey}`;
}

/* ---------- route registration ---------- */

export async function registerPlatformRoutes(app: FastifyInstance, opts: PlatformRouteOptions = {}): Promise<void> {
  const ws = (): SwarmWorkspaceStore => {
    const w = getSwarmWorkspace();
    if (!w) throw new Error('swarm-workspace-not-ready');
    return w;
  };
  const coord = (): PersistentOutcomeCoordinator => {
    const c = getSwarmCoordinator();
    if (!c) throw new Error('swarm-coordinator-not-ready');
    return c;
  };

  /* ================= platform administration (ops console) ================= */

  app.get('/admin/platform/bootstrap', async () => {
    const w = ws();
    const [state, tenant, kafka, policy, active, org] = await Promise.all([
      onboardingState(w, opts.users),
      w.getAdminTenant(),
      w.getAdminKafka(),
      w.getAdminPolicy(),
      w.activeRelease(),
      w.getPlatformOrganization(),
    ]);
    return {
      status: state.gates.activate ? 'active' : state.readyForRehearsal ? 'ready-for-rehearsal' : 'onboarding',
      onboarding: state,
      tenant: tenant ?? null,
      kafka: kafka ?? null,
      policy: policy ?? null,
      organization: org ?? null,
      activeRelease: active ?? null,
    };
  });

  app.put<{ Body: { operatingModel?: string; currentStep?: string; completedSteps?: string[]; tenantId?: string; environmentId?: string } }>(
    '/admin/platform/onboarding',
    async (req, reply) => {
      const body = req.body ?? {};
      const w = ws();
      const existing = await w.getPlatformOnboarding();
      const completed = existing?.completedSteps ?? [];
      for (const s of body.completedSteps ?? []) if (!completed.includes(s)) completed.push(s);
      const doc = await w.savePlatformOnboarding({
        operatingModel: (body.operatingModel as PlatformOrganization['operatingModel'] | undefined) ?? existing?.operatingModel ?? 'provider',
        currentStep: body.currentStep?.trim() || existing?.currentStep || 'organization',
        completedSteps: completed,
        steps: existing?.steps ?? [],
        readyForRehearsal: existing?.readyForRehearsal ?? false,
        ...(body.tenantId ? { tenantId: body.tenantId } : existing?.tenantId ? { tenantId: existing.tenantId } : {}),
        ...(body.environmentId ? { environmentId: body.environmentId } : existing?.environmentId ? { environmentId: existing.environmentId } : {}),
      });
      return { onboarding: doc, state: await onboardingState(w, opts.users) };
    },
  );

  app.get('/admin/platform/organization', async () => {
    const w = ws();
    const org = await w.getPlatformOrganization();
    let realized: Array<{ id: string; label: string; facilities: number; patients: number }> = [];
    try {
      const store = await getSqlStore();
      const facilities = await store.listFacilities();
      const patients = await store.listPatients();
      const patientsByFacility = new Map<string, number>();
      for (const p of patients) patientsByFacility.set(p.facilityId, (patientsByFacility.get(p.facilityId) ?? 0) + 1);
      realized = (org?.scopePath ?? []).map((l) => ({
        id: l.id,
        label: l.label,
        facilities: facilities.filter((f) => f.id === l.id).length || (l.facilities ?? 0),
        patients: [...patientsByFacility.values()].reduce((a, b) => a + b, 0),
      }));
    } catch { /* master data unavailable */ }
    return { organization: org ?? null, realized };
  });

  app.put<{ Body: Partial<Omit<PlatformOrganization, 'id' | 'createdAt' | 'updatedAt'>> }>(
    '/admin/platform/organization',
    async (req, reply) => {
      const body = req.body ?? {};
      const w = ws();
      const existing = await w.getPlatformOrganization();
      if (body.operatingModel && !['provider', 'payer', 'hybrid'].includes(body.operatingModel)) {
        return reply.code(400).send({ error: 'invalid-operating-model', allowed: ['provider', 'payer', 'hybrid'] });
      }
      const org = await w.savePlatformOrganization({
        operatingModel: body.operatingModel ?? existing?.operatingModel ?? 'provider',
        displayName: body.displayName?.trim() || existing?.displayName || 'Unnamed organization',
        region: body.region?.trim() || existing?.region || 'us-east',
        timezone: body.timezone?.trim() || existing?.timezone || 'America/Chicago',
        retentionDays: body.retentionDays ?? existing?.retentionDays ?? 365,
        scopePath: body.scopePath ?? existing?.scopePath ?? [],
        synthetic: body.synthetic ?? existing?.synthetic ?? false,
        // Deployment posture — same document as the rest of the profile, so the
        // operator console reads and writes one organization record, not two.
        environmentName: body.environmentName?.trim() || existing?.environmentName || 'reference',
        deploymentMode: body.deploymentMode ?? existing?.deploymentMode ?? 'reference',
        dataRegion: body.dataRegion?.trim() || existing?.dataRegion || 'United States',
      });
      return { organization: org };
    },
  );

  app.get('/admin/platform/topics', async () => {
    const w = ws();
    return { topics: (await w.getPlatformTopicPlan()) ?? null, defaults: DEFAULT_TOPIC_PLAN };
  });

  app.put<{ Body: Partial<Omit<PlatformTopicPlan, 'id' | 'createdAt' | 'updatedAt'>> }>(
    '/admin/platform/topics',
    async (req, reply) => {
      const body = req.body ?? {};
      const w = ws();
      const existing = await w.getPlatformTopicPlan();
      const plan = await w.savePlatformTopicPlan({
        defaultOutputTopic: body.defaultOutputTopic?.trim() || existing?.defaultOutputTopic || DEFAULT_TOPIC_PLAN.defaultOutputTopic,
        agentDlqTopic: body.agentDlqTopic?.trim() || existing?.agentDlqTopic || DEFAULT_TOPIC_PLAN.agentDlqTopic,
        actionCommandTopic: body.actionCommandTopic?.trim() || existing?.actionCommandTopic || DEFAULT_TOPIC_PLAN.actionCommandTopic,
        actionAckTopic: body.actionAckTopic?.trim() || existing?.actionAckTopic || DEFAULT_TOPIC_PLAN.actionAckTopic,
        outcomeStateTopic: body.outcomeStateTopic?.trim() || existing?.outcomeStateTopic || DEFAULT_TOPIC_PLAN.outcomeStateTopic,
        assuranceEventTopic: body.assuranceEventTopic?.trim() || existing?.assuranceEventTopic || DEFAULT_TOPIC_PLAN.assuranceEventTopic,
        entries: body.entries ?? existing?.entries ?? [],
      });
      return { topics: plan };
    },
  );

  app.get('/admin/platform/integrations', async () => {
    const w = ws();
    const kafka = await w.getAdminKafka();
    let fhirResources = 0;
    try { fhirResources = (await (await getSqlStore()).listFhirResources()).length; } catch { /* no fhir store */ }
    const roles: IdentityRole[] = [...new Set((opts.users?.list() ?? []).map((u) => u.role))];
    return {
      kafka: kafka ?? null,
      fhir: { resources: fhirResources },
      identity: { users: opts.users?.list().length ?? 0, roles },
      cms: { sources: seedCMSSources.length },
      lastTestedAt: kafka?.lastTestedAt ?? null,
    };
  });

  app.post('/admin/platform/integrations/kafka/test', async () => ({ kafka: await ws().testAdminKafka() }));

  /* ---------- release center ---------- */

  app.get('/admin/platform/releases', async () => {
    const w = ws();
    return { releases: await w.listReleases(), active: await w.activeRelease() };
  });

  app.post<{ Body: { version?: string; changeSummary?: string; objectCount?: number; createdBy?: string } }>(
    '/admin/platform/releases',
    async (req, reply) => {
      try {
        return { release: await ws().createReleaseDraft(req.body ?? {}) };
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  const releaseLifecycle = (fn: (id: string) => Promise<ConfigRelease | undefined>) => async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const release = await fn(req.params.id);
    if (!release) return reply.code(404).send({ error: 'config-release-not-found' });
    return { release };
  };

  app.post<{ Params: { id: string } }>('/admin/platform/releases/:id/validate', releaseLifecycle((id) => ws().validateRelease(id)));
  app.post<{ Params: { id: string } }>('/admin/platform/releases/:id/request-approval', releaseLifecycle((id) => ws().approveRelease(id)));
  app.post<{ Params: { id: string } }>('/admin/platform/releases/:id/activate', releaseLifecycle((id) => ws().activateRelease(id)));
  app.post<{ Params: { id: string } }>('/admin/platform/releases/:id/rollback', releaseLifecycle((id) => ws().rollbackRelease(id)));

  // Canary activation (spec §23): Approved → Canary → Active | RolledBack.
  app.post<{ Params: { id: string }; Body: { scopes?: string[]; by?: string } }>(
    '/admin/platform/releases/:id/canary',
    async (req, reply) => {
      const release = await ws().startCanary(req.params.id, { ...(req.body?.scopes?.length ? { scopes: req.body.scopes } : {}), ...(req.body?.by ? { by: req.body.by } : {}) });
      if (!release) return reply.code(404).send({ error: 'config-release-not-found' });
      return { release };
    },
  );
  app.post<{ Params: { id: string }; Body: { by?: string; health?: boolean } }>(
    '/admin/platform/releases/:id/canary/promote',
    async (req, reply) => {
      const release = await ws().promoteCanary(req.params.id, { ...(req.body?.by ? { by: req.body.by } : {}), health: req.body?.health !== false });
      if (!release) return reply.code(404).send({ error: 'config-release-not-found' });
      return { release };
    },
  );
  app.post<{ Params: { id: string }; Body: { by?: string; reason?: string } }>(
    '/admin/platform/releases/:id/canary/fail',
    async (req, reply) => {
      const release = await ws().failCanary(req.params.id, { ...(req.body?.by ? { by: req.body.by } : {}), ...(req.body?.reason ? { reason: req.body.reason } : {}) });
      if (!release) return reply.code(404).send({ error: 'config-release-not-found' });
      return { release };
    },
  );

  /* ---------- DLQ inspection ---------- */

  app.get('/admin/platform/dlq', async () => {
    const w = ws();
    let brokerDepth = 0;
    try { brokerDepth = opts.broker ? await opts.broker.deadLetterSize() : 0; } catch { /* broker unavailable */ }
    let outbox: { pending: number; delivered: number; dead: number } | null = null;
    try { outbox = opts.eventOutbox ? await opts.eventOutbox.counts() : null; } catch { /* outbox unavailable */ }
    let incidents: Array<Record<string, unknown>> = [];
    try {
      incidents = (await openBridgeIncidents(w, 100)).map((r) => ({
        outboxId: r.outboxId, topic: r.topic, partitionKey: r.partitionKey, idempotencyKey: r.idempotencyKey, publishedAt: r.publishedAt, state: r.state, incident: r.incident ?? null,
      }));
    } catch { /* store unavailable */ }
    return {
      brokerDepth,
      outbox: outbox ?? { pending: 0, delivered: 0, dead: 0 },
      incidents,
      items: incidents.map((i) => ({ id: `dlq:${i.outboxId}`, ...i })),
    };
  });

  /* ---------- first-class DLQ journey (Journey L — evidence, owner, replay) ---------- */

  async function dlqIncident(id: string): Promise<Record<string, unknown> | undefined> {
    // Accept both `dlq:<outboxId>` (list / My Work id) and the raw outboxId.
    const outboxId = id.replace(/^dlq:/, '');
    const store = await getSqlStore();
    const receipts = await store.listBridgeReceipts(200);
    const rcpt = receipts.find((r) => r.outboxId === outboxId);
    const row = await store.getOutboxRow(outboxId);
    const remediations = await ws().list<DlqRemediation>('dlq-remediation');
    return {
      outboxId,
      topic: rcpt?.topic ?? row?.topic ?? null,
      partitionKey: rcpt?.partitionKey ?? null,
      idempotencyKey: rcpt?.idempotencyKey ?? (row ? `row:${outboxId}` : null),
      publishedAt: rcpt?.publishedAt ?? row?.createdAt ?? null,
      state: rcpt?.state ?? row?.status ?? null,
      incident: rcpt?.incident ?? row?.lastError ?? null,
      attempts: row?.attempts ?? null,
      createdAt: row?.createdAt ?? null,
      remediations: remediations.filter((r) => r.outboxId === outboxId),
    };
  }

  app.get<{ Params: { id: string } }>('/admin/platform/dlq/:id', async (req, reply) => {
    const item = await dlqIncident(req.params.id);
    if (!item || !item.topic) return reply.code(404).send({ error: 'dlq-item-not-found' });
    return { item };
  });

  app.post<{ Params: { id: string }; Body: { owner?: string; reason?: string } }>(
    '/admin/platform/dlq/:id/acknowledge',
    async (req, reply) => {
      const item = await dlqIncident(req.params.id);
      if (!item || !item.topic) return reply.code(404).send({ error: 'dlq-item-not-found' });
      const outboxId = String(item.outboxId);
      const w = ws();
      const remediation = await w.create<DlqRemediation>('dlq-remediation', `dlq-${outboxId}-${Date.now()}`, {
        outboxId,
        owner: req.body?.owner?.trim() || 'operator',
        status: 'acknowledged',
        reason: req.body?.reason?.trim() || 'owned for remediation',
      });
      return { item: { outboxId, owner: remediation.owner, status: remediation.status } };
    },
  );

  app.post<{ Params: { id: string }; Body: { owner?: string; reason?: string } }>(
    '/admin/platform/dlq/:id/replay',
    async (req, reply) => {
      const item = await dlqIncident(req.params.id);
      if (!item || !item.topic) return reply.code(404).send({ error: 'dlq-item-not-found' });
      if (!opts.broker) return reply.code(503).send({ error: 'broker-unavailable' });
      const outboxId = String(item.outboxId);
      const store = await getSqlStore();
      const row = await store.getOutboxRow(outboxId);
      if (!row || !row.eventJson) return reply.code(404).send({ error: 'outbox-event-not-found' });
      const event = JSON.parse(row.eventJson) as CanonicalEvent;
      const replayId = `replay-${outboxId}-${Date.now()}`;
      const partitionKey = typeof item.partitionKey === 'string' ? item.partitionKey : row.scopeId;
      // Idempotent replay: a NEW delivery id, but the ORIGINAL business key so a
      // downstream consumer cannot create a duplicate effect.
      await opts.broker.publish(
        { topic: row.topic, event, headers: { 'x-idempotency-key': `row:${row.id}` } },
        { partitionKey },
      );
      await store.recordBridgeReceipt({ outboxId: row.id, topic: row.topic, partitionKey, idempotencyKey: `row:${row.id}`, publishedAt: new Date().toISOString(), state: 'delivered' });
      const w = ws();
      await w.create<DlqRemediation>('dlq-remediation', `dlq-${outboxId}-${Date.now()}`, {
        outboxId,
        owner: req.body?.owner?.trim() || 'operator',
        status: 'replayed',
        reason: req.body?.reason?.trim() || 'idempotent replay from DLQ',
        replayId,
      });
      return { ok: true, replayId, item: { outboxId, status: 'replayed', replayId } };
    },
  );

  /* ---------- Chaos drill fixture (gated) ----------
   * Seeds ONE synthetic bridge incident (outbox row + incident receipt) so the
   * chaos drill can exercise the real DLQ journey — acknowledge → idempotent
   * replay → verify the incident is cleared. Disabled outside dev/demo/test
   * (or without HH_ENABLE_DRILLS=1) so a governed deployment can never be
   * polluted with fabricated incidents. */
  const chaosDrillsEnabled = (): boolean => {
    if (process.env.HH_ENABLE_DRILLS === '1') return true;
    const env = (process.env.ANANT_ENV ?? '').toLowerCase();
    if (env === 'production' || env.startsWith('prod')) return false;
    if (process.env.NODE_ENV === 'production') return false;
    // dev/demo/test/local, or unset (local dev servers don't set ANANT_ENV).
    return env.startsWith('dev') || env === 'demo' || env === 'test' || env === 'local' || env === '';
  };

  app.post<{ Body?: { topic?: string; reason?: string; partitionKey?: string } }>(
    '/admin/platform/dlq/_drill/seed',
    async (req, reply) => {
      if (!chaosDrillsEnabled()) return reply.code(403).send({ error: 'chaos-drills-disabled' });
      const store = await getSqlStore();
      if (!opts.eventOutbox) return reply.code(503).send({ error: 'outbox-unavailable' });
      const topic = req.body?.topic?.trim() || 'anant.agent.output.v1';
      const reason = req.body?.reason?.trim() || 'poison message after retries (chaos drill)';
      const id = `drill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const now = new Date().toISOString();
      const event: CanonicalEvent = {
        id, type: 'treatment.missed', occurredAt: now, scopeId: 'scope:drill', subjectId: 'patient:drill', facilityId: 'facility:drill',
        payload: { reason, drill: true },
        provenance: { sourceId: 'chaos-drill', observedAt: now, ingestedAt: now },
        classification: 'internal',
      };
      await opts.eventOutbox.enqueue(event, { topic, scopeId: 'scope:drill' });
      await store.recordBridgeReceipt({
        outboxId: id, topic, partitionKey: req.body?.partitionKey?.trim() || 'scope:drill',
        idempotencyKey: `row:${id}`, publishedAt: now, state: 'incident', incident: `chaos-drill: ${reason}`,
      });
      return { ok: true, outboxId: id, topic };
    },
  );

  /* ================= public experience APIs (session-aware) ================= */

  const sessionUser = (req: FastifyRequest): LocalUser | undefined => {
    if (!opts.users || !opts.sessions) return undefined;
    const raw = req.headers['cookie'];
    const h = Array.isArray(raw) ? raw[0] : raw;
    const token = readCookieValue(h, SESSION_COOKIE);
    if (!token) return undefined;
    const session = opts.sessions.get(token);
    if (!session) return undefined;
    return opts.users.get(session.username);
  };

  const sessionRole = (req: FastifyRequest): IdentityRole | undefined => sessionUser(req)?.role;

  app.get('/api/context', async (req) => {
    const w = ws();
    const user = sessionUser(req);
    const role = user?.role;
    // An unauthenticated caller has NO consoles. Advertising both was a role claim
    // that no session backs — the console switcher reads this list, so it must be
    // empty until there is a real principal.
    const consoles = role ? consolesForRole(role) : ([] as ConsoleId[]);
    let pack: { id: string; lens: string } = { id: 'healthcare.renal-enterprise', lens: 'provider' };
    let aggregates: Record<string, number> = {};
    try {
      // Pack Studio activation wins over the operating-model default: activating
      // a domain pack durably flips pack.id + lens (`POST /admin/platform/packs/:id/activate`).
      const active = await w.activePack();
      if (active && opts.packs?.some((p) => p.id === active.packId)) {
        const resolved = opts.packs.find((p) => p.id === active.packId)!;
        pack = { id: resolved.id, lens: lensForPack(resolved) };
      } else {
        const org = await w.getPlatformOrganization();
        if (org) pack = { id: `healthcare.${org.operatingModel === 'payer' ? 'payer' : org.operatingModel === 'hybrid' ? 'hybrid' : 'provider'}`, lens: org.operatingModel };
      }
      aggregates = await contextAggregates(w, coord(), opts);
    } catch { /* context must degrade gracefully */ }
    return {
      authenticated: Boolean(user),
      user: user ? { username: user.username, displayName: user.displayName, role: user.role, clearance: user.clearance, purposeOfUse: user.purposeOfUse, scopeIds: user.scopeIds } : null,
      role: role ?? null,
      consoles,
      pack,
      navigation: navigationFor(consoles),
      capabilities: capabilitiesFor(consoles),
      aggregates,
      configuration: { activeVersion: (await w.activeRelease())?.version ?? null },
    };
  });

  app.get('/api/work', async (req, reply) => {
    // The queue is ROLE-SCOPED, so it is meaningless without a session — and while
    // it was readable anonymously it returned every patient-scoped suggestion
    // (patient ids, the clinical reason, the owner role) to anyone who asked.
    if (!sessionUser(req)) return reply.code(401).send({ error: 'not-authenticated' });
    const w = ws();
    try {
      const items = await buildWorkQueue(w, coord(), opts, sessionRole(req));
      return { items, total: items.length };
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get<{ Params: { id: string } }>('/api/work/:id', async (req, reply) => {
    // the detail explains a specific patient's membership, so it is session-gated too
    if (!sessionUser(req)) return reply.code(401).send({ error: 'not-authenticated' });
    const w = ws();
    const id = req.params.id;
    const [kind, rest] = splitWorkId(id);
    if (!kind || !rest) return reply.code(404).send({ error: 'work-item-not-found' });
    if (kind === 'episode') {
      const e = coord().get(rest);
      if (!e) return reply.code(404).send({ error: 'episode-not-found' });
      return { detail: episodeDetail(e) };
    }
    if (kind === 'review') {
      const r = await w.get<EvidenceReview>('evidence-review', rest);
      if (!r) return reply.code(404).send({ error: 'evidence-review-not-found' });
      return { detail: reviewDetail(r) };
    }
    if (kind === 'release') {
      const r = await w.get<ConfigRelease>('config-release', rest);
      if (!r) return reply.code(404).send({ error: 'config-release-not-found' });
      return { detail: releaseDetail(r) };
    }
    if (kind === 'dlq') {
      return { detail: dlqDetail(rest) };
    }
    if (kind === 'cohort') {
      const detail = await cohortDetail(ws(), rest, opts.patients);
      if (!detail) return reply.code(404).send({ error: 'cohort-suggestion-not-found' });
      return { detail };
    }
    return reply.code(404).send({ error: 'work-item-not-found' });
  });

  app.post<{ Params: { id: string }; Body: { action?: string; reason?: string; approver?: string; idempotencyKey?: string } }>(
    '/api/work/:id/actions',
    async (req, reply) => {
      // A decision is attributed to a person; there is no anonymous decider.
      if (!sessionUser(req)) return reply.code(401).send({ error: 'not-authenticated' });
      const id = req.params.id;
      const action = req.body?.action;
      const idempotencyKey = req.body?.idempotencyKey;
      const cacheKey = actionCacheKey(action ?? '', idempotencyKey);
      if (cacheKey && ACTION_LEDGER.has(cacheKey)) return { ...(ACTION_LEDGER.get(cacheKey) as Record<string, unknown>), duplicate: true };
      const [kind, rest] = splitWorkId(id);
      if (!kind || !rest || !action) return reply.code(400).send({ error: 'invalid-work-action' });

      let result: Record<string, unknown>;
      if (kind === 'episode') {
        try {
          const e = coord().get(rest);
          if (!e) return reply.code(404).send({ error: 'episode-not-found' });
          const cls = episodeApprovalClass(e);
          if (action === 'approve' || action === 'reject') {
            const after = coord().decide(rest, action === 'approve' ? 'approved' : 'rejected', req.body?.approver?.trim() || 'operator', cls);
            result = { accepted: true, state: after.state, action };
          } else if (action === 'escalate') {
            const after = coord().escalate(rest, req.body?.reason?.trim() || 'escalated by operator');
            result = { accepted: true, state: after.state, action };
          } else {
            return reply.code(400).send({ error: 'unsupported-episode-action', allowed: ['approve', 'reject', 'escalate'] });
          }
        } catch (err) {
          // Invalid state transition — fail closed and explain the next step.
          return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
        }
      } else if (kind === 'review') {
        if (action !== 'approve' && action !== 'reject') return reply.code(400).send({ error: 'unsupported-review-action', allowed: ['approve', 'reject'] });
        const reviewed = await ws().reviewEvidence(rest, { decision: action === 'approve' ? 'confirmed' : 'rejected', ...(req.body?.approver ? { reviewer: req.body.approver } : {}), ...(req.body?.reason ? { note: req.body.reason } : {}) });
        if (!reviewed) return reply.code(404).send({ error: 'evidence-review-not-found' });
        result = { accepted: true, state: reviewed.status, action };
      } else if (kind === 'release') {
        const release = await (action === 'validate'
          ? ws().validateRelease(rest)
          : action === 'approve' || action === 'request-approval'
            ? ws().approveRelease(rest)
            : action === 'activate'
              ? ws().activateRelease(rest)
              : action === 'canary'
                ? ws().startCanary(rest, { by: req.body?.approver?.trim() || 'operator' })
                : action === 'promote'
                  ? ws().promoteCanary(rest, { by: req.body?.approver?.trim() || 'operator', health: req.body?.reason !== 'fail' })
                  : action === 'fail'
                    ? ws().failCanary(rest, { reason: req.body?.reason?.trim() || 'canary failed by operator', by: req.body?.approver?.trim() || 'operator' })
                    : action === 'rollback'
                      ? ws().rollbackRelease(rest)
                      : undefined);
        if (!release) return reply.code(404).send({ error: 'config-release-not-found' });
        result = { accepted: true, state: release.status, action, version: release.version };
      } else if (kind === 'dlq') {
        // Durable remediation (repair/replay) is performed via the kafka-bridge
        // and outbox; this endpoint records the operator acknowledgement.
        if (action !== 'acknowledge') return reply.code(400).send({ error: 'unsupported-dlq-action', allowed: ['acknowledge'] });
        result = { accepted: true, action, note: 'acknowledged — durable remediation is wired through /admin/swarm/bridge and the outbox' };
      } else if (kind === 'cohort') {
        // A cohort suggestion is a statement about state; the human decides
        // whether it was worth raising. A decline is REQUIRED to carry a reason
        // because it is the only feedback that can tune a criterion.
        if (action !== 'review' && action !== 'decline') {
          return reply.code(400).send({ error: 'unsupported-cohort-action', allowed: ['review', 'decline'] });
        }
        const suggestion = await cohortSuggestion(ws(), rest, opts.patients);
        if (!suggestion) return reply.code(404).send({ error: 'cohort-suggestion-not-found' });
        if (action === 'decline' && !req.body?.reason?.trim()) {
          return reply.code(400).send({ error: 'decline-requires-reason' });
        }
        const decision = await ws().recordCohortDecision({
          cohortId: suggestion.cohortId,
          patientId: suggestion.patientId,
          realmId: suggestion.realmId,
          action,
          reason: req.body?.reason?.trim() || 'reviewed and accepted',
          actor: req.body?.approver?.trim() || sessionRole(req) || 'operator',
          criterionVersion: suggestion.criterionVersion,
          suggestionReason: suggestion.reason,
          confidence: suggestion.confidence,
          risk: suggestion.risk,
        });
        result = {
          accepted: true, action, state: `${suggestion.cohortId}:${action}`,
          decisionId: decision.id, criterionVersion: decision.criterionVersion,
          note: action === 'decline'
            ? 'declined — retained against the criterion version so the definition can be tuned'
            : 'reviewed by a human; acting remains a separate proposal',
        };
      } else {
        return reply.code(404).send({ error: 'work-item-not-found' });
      }

      if (cacheKey) ACTION_LEDGER.set(cacheKey, result);
      return result;
    },
  );

  app.get('/api/graph', async () => {
    const { nodes, edges } = await projectTopology(ws());
    return { nodes: nodes as ProjectedNode[], edges: edges as ProjectedEdge[] };
  });

  app.get('/api/canvases', async () => ({ canvases: await ws().listCanvases() }));
  app.get<{ Params: { id: string } }>('/api/canvases/:id', async (req, reply) => {
    const canvas = await ws().getCanvas(req.params.id);
    if (!canvas) return reply.code(404).send({ error: 'canvas-not-found' });
    return { canvas };
  });
  app.post<{ Body: { name: string; scopeId?: string; nodes?: PlatformCanvas['nodes']; edges?: PlatformCanvas['edges']; notes?: PlatformCanvas['notes']; createdBy?: string } }>(
    '/api/canvases',
    async (req, reply) => {
      try {
        const body = req.body ?? { name: 'Untitled canvas' };
        const canvas = await ws().createCanvas({
          name: body.name?.trim() || 'Untitled canvas',
          scopeId: body.scopeId ?? 'scope:enterprise',
          nodes: body.nodes ?? [],
          edges: body.edges ?? [],
          notes: body.notes ?? [],
          createdBy: body.createdBy?.trim() || 'operator',
          updatedBy: body.createdBy?.trim() || 'operator',
        });
        return { canvas };
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );
  app.put<{ Params: { id: string }; Body: Partial<Omit<PlatformCanvas, 'id' | 'createdAt' | 'updatedAt' | 'version'>> }>(
    '/api/canvases/:id',
    async (req, reply) => {
      const canvas = await ws().updateCanvas(req.params.id, { ...(req.body ?? {}) });
      if (!canvas) return reply.code(404).send({ error: 'canvas-not-found' });
      return { canvas };
    },
  );
  app.delete<{ Params: { id: string } }>('/api/canvases/:id', async (req, reply) => {
    const ok = await ws().deleteCanvas(req.params.id);
    if (!ok) return reply.code(404).send({ error: 'canvas-not-found' });
    return { ok: true };
  });

  // Journey O — append a scoped note (with optional citation) to a canvas.
  app.post<{ Params: { id: string }; Body: { body: string; by?: string; citation?: string } }>(
    '/api/canvases/:id/notes',
    async (req, reply) => {
      const body = req.body?.body?.trim();
      if (!body) return reply.code(400).send({ error: 'note-body-required' });
      const canvas = await ws().addCanvasNote(req.params.id, {
        body,
        by: req.body?.by?.trim() || 'operator',
        ...(req.body?.citation?.trim() ? { citation: req.body.citation.trim() } : {}),
      });
      if (!canvas) return reply.code(404).send({ error: 'canvas-not-found' });
      return { canvas, note: canvas.notes[canvas.notes.length - 1] };
    },
  );

  // Journey O — what-if entry: replay the swarm boundary at a different
  // consensus threshold in isolation, then record the cited simulation as a
  // versioned canvas note (graph insight → cited work/release decision).
  app.post<{ Params: { id: string }; Body: { threshold?: number; by?: string } }>(
    '/api/canvases/:id/simulate',
    async (req, reply) => {
      const w = ws();
      const canvas = await w.getCanvas(req.params.id);
      if (!canvas) return reply.code(404).send({ error: 'canvas-not-found' });
      const threshold = req.body?.threshold;
      if (threshold === undefined || typeof threshold !== 'number' || threshold < 0 || threshold > 1) {
        return reply.code(400).send({ error: 'threshold must be a number in [0,1]' });
      }
      try {
        const by = req.body?.by?.trim() || 'operator';
        const sim = await swarmWhatIf(threshold);
        const body = `What-if at consensus ${Math.round(threshold * 100)}% (isolated, no runtime change): ${sim.episodesSurfaced} episode(s) would surface · ${sim.reviewsRequired} review(s) required · ~$${Number(sim.estimatedValue).toLocaleString()} estimated value · ${sim.treatmentsProtected} treatment(s) protected.`;
        const updated = await w.addCanvasNote(req.params.id, { body, by, citation: `what-if:threshold=${threshold}` });
        if (!updated) return reply.code(404).send({ error: 'canvas-not-found' });
        return { canvas: updated, simulation: sim, note: updated.notes[updated.notes.length - 1] };
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  /* ---------- Pack Studio — real installed packs + durable lens switch ---------- */

  // GET /admin/platform/packs — the REAL PackRegistry catalog (the packs passed
  // into buildApp), each with its durable active flag. This is what the Config
  // Studio "Pack registry" renders — no more cosmetic/empty catalog.
  app.get('/admin/platform/packs', async () => {
    const w = ws();
    const active = await w.activePack();
    return {
      activePack: active?.packId ?? null,
      packs: (opts.packs ?? []).map((p) => ({
        id: p.id,
        version: p.version,
        extends: p.extends?.map((e) => e.id) ?? [],
        appliesTo: p.appliesTo,
        capabilities: p.capabilities,
        cmsUniverse: p.cmsUniverse,
        requiredControls: p.requiredControls,
        lens: lensForPack(p),
        active: active?.packId === p.id,
      })),
    };
  });

  // POST /admin/platform/packs/:id/activate — durable activation: the exec lens
  // (`/api/context` pack.id/lens) switches to this pack until deactivated.
  app.post<{ Params: { id: string }; Body: { by?: string } }>(
    '/admin/platform/packs/:id/activate',
    async (req, reply) => {
      const w = ws();
      const id = req.params.id;
      const pack = (opts.packs ?? []).find((p) => p.id === id);
      if (!pack) return reply.code(404).send({ error: 'pack-not-installed', known: (opts.packs ?? []).map((p) => p.id) });
      const activation = await w.activatePack({ packId: id, by: req.body?.by?.trim() || 'platform-admin' });
      return { ok: true, pack: { id: pack.id, version: pack.version, lens: lensForPack(pack) }, activation };
    },
  );

  // POST /admin/platform/packs/deactivate — restore the operating-model default.
  app.post<{ Body: { by?: string } }>('/admin/platform/packs/deactivate', async () => {
    await ws().deactivatePack();
    return { ok: true };
  });
}

/* ---------- helpers ---------- */

/** Open bridge incidents — incidents already remediated through the DLQ journey
 *  (acknowledged or replayed, recorded as a durable `dlq-remediation` doc) are
 *  no longer open. Receipt history stays immutable; the view reflects recovery. */
async function openBridgeIncidents(ws: SwarmWorkspaceStore, limit = 100) {
  const store = await getSqlStore();
  const [receipts, remediations] = await Promise.all([
    store.listBridgeReceipts(limit),
    ws.list<DlqRemediation>('dlq-remediation'),
  ]);
  const handled = new Set(remediations.map((r) => r.outboxId));
  return receipts.filter((r) => r.state === 'incident' && !handled.has(r.outboxId));
}

/** Map a DomainPack's organization kinds to the exec lens enum
 *  (provider | payer | hybrid) — the same tri-state the operating model uses. */
function lensForPack(pack: DomainPack): 'provider' | 'payer' | 'hybrid' {
  const kinds = pack.appliesTo?.organizationKinds ?? [];
  const isPayer = kinds.includes('payer');
  const isProvider = kinds.includes('provider') || kinds.includes('health-system') || kinds.includes('provider-org');
  if (isPayer && isProvider) return 'hybrid';
  if (isPayer) return 'payer';
  return 'provider';
}

function splitWorkId(id: string): [string, string] {
  const i = id.indexOf(':');
  if (i < 0) return ['', ''];
  return [id.slice(0, i), id.slice(i + 1)];
}

interface CohortSuggestion {
  cohortId: string;
  patientId: string;
  realmId: string;
  label: string;
  protocol: string;
  approvalClass: string;
  suggestedAction: string;
  mayNever: string[];
  guard: string[];
  criterionVersion: string;
  rationale: string;
  reason: string;
  confidence: number;
  risk: number;
  opportunity: number;
  unresolved: string[];
  entry: readonly import('../swarm/cohort.js').CriterionResult[];
  exit: readonly import('../swarm/cohort.js').CriterionResult[];
}

/**
 * Re-evaluate ONE cohort for ONE patient.
 *
 * The queue and the item detail must agree: both go through this function, so a
 * drawer can never explain a suggestion differently from the row that raised it.
 * A patient who no longer qualifies returns null — the suggestion is gone rather
 * than stale, which is what makes a cohort self-clearing.
 */
async function cohortSuggestion(
  ws: SwarmWorkspaceStore,
  rest: string,
  patients?: (() => import('../swarm/renal-cohort.js').RenalPatientInput[]) | undefined,
): Promise<CohortSuggestion | null> {
  const ref = parseCohortRef(rest);
  if (!ref || !patients) return null;
  const { realmId, cohortId, patientId } = ref;
  const doc = await ws.getCohortDefinition(cohortId);
  if (!doc) return null;
  const { evaluateCohorts, toCohortDefinition, cachedLedgerSeries } = await import('./cohort-routes.js');
  const live = patients();
  const { rows } = evaluateCohorts([toCohortDefinition(doc)], live, {
    series: cachedLedgerSeries(live), at: new Date().toISOString(), intervalDays: 2,
  });
  // match the REALM as well: the same identifier exists in other facilities, and
  // resolving the wrong one would explain a suggestion the clinician never saw
  const row = rows.find((r) => r.patientId === patientId && r.realmId === realmId && r.state === 'member');
  if (!row) return null;
  return {
    cohortId, patientId,
    realmId: row.realmId,
    label: row.label,
    protocol: row.protocol,
    approvalClass: row.approvalClass,
    suggestedAction: row.suggestedAction,
    mayNever: row.mayNever,
    guard: row.guard,
    criterionVersion: row.criterionVersion,
    rationale: String(doc.rationale ?? ''),
    reason: row.reason,
    confidence: row.confidence,
    risk: row.risk,
    opportunity: row.opportunity,
    unresolved: row.unresolved,
    entry: row.entry,
    exit: row.exit,
  };
}

/**
 * A cohort work item, in the same shape as every other drawer.
 *
 * `decision.allowed` is the whole contract for a suggestion: a human reviews or
 * declines it. Acting on the patient remains a separate proposal → approval →
 * outcome episode, so nothing here can move a patient by itself.
 */
async function cohortDetail(
  ws: SwarmWorkspaceStore,
  rest: string,
  patients?: (() => import('../swarm/renal-cohort.js').RenalPatientInput[]) | undefined,
): Promise<Record<string, unknown> | null> {
  const s = await cohortSuggestion(ws, rest, patients);
  if (!s) return null;
  const membership = await ws.get<import('../swarm/workspace.js').CohortMembershipDoc>('cohort-membership', `${s.cohortId}::${s.realmId}::${s.patientId}`);
  const decisions = await ws.cohortDecisions(s.cohortId, s.patientId, s.realmId);
  const activity = [
    ...(membership?.history ?? []).map((h) => ({ at: h.at, from: '—', to: h.event, by: 'cohort engine', note: `${h.reason} (criteria ${h.criterionVersion})` })),
    ...decisions.map((d) => ({ at: d.at, from: 'suggested', to: d.action === 'decline' ? 'declined' : 'reviewed', by: d.actor, note: d.reason })),
  ].sort((a, b) => String(a.at).localeCompare(String(b.at)));

  const criteriaOf = (rows: readonly import('../swarm/cohort.js').CriterionResult[]): Array<Record<string, unknown>> =>
    rows.map((c) => ({ metric: c.metric, comparator: c.comparator, expected: c.expected, observed: c.observed ?? null, outcome: c.outcome, note: c.note ?? null }));

  return {
    // The canonical work id, the SAME value the queue emits. It used to be
    // `cohort:${cohortId}:${patientId}` here, which dropped the realm and used
    // the wrong separator: the detail advertised an id, and a replay URL built
    // from it, that both answered `cohort-suggestion-not-found` (404). A drawer
    // that cannot be acted on by the id it reports about itself is a dead end,
    // and the realm is not optional — the same patient id exists in many realms.
    id: cohortWorkId(s.realmId, s.cohortId, s.patientId),
    kind: 'cohort',
    title: `${s.label} · ${s.patientId}`,
    state: 'suggested',
    scope: s.realmId,
    owner: s.approvalClass === 'C' ? 'Nephrologist' : 'Renal nurse',
    // `why` is the product: the reason is the suggestion's entire justification
    why: s.reason,
    overview: {
      cohortId: s.cohortId, patientId: s.patientId, protocol: s.protocol,
      rationale: s.rationale, confidence: s.confidence, risk: s.risk,
      opportunity: s.opportunity, criterionVersion: s.criterionVersion,
      suggestedAction: s.suggestedAction,
      // the engine's own words for what held and what did not
      entryCriteria: criteriaOf(s.entry),
      exitCriteria: criteriaOf(s.exit),
      unresolved: s.unresolved,
    },
    evidence: criteriaOf(s.entry).map((c) => ({ sourceId: String(c.metric), contentType: 'criterion', hash: null, span: { expected: c.expected, observed: c.observed } })),
    contributions: [],
    policy: {
      approvalClass: s.approvalClass,
      mayNever: s.mayNever,
      guard: s.guard,
      // a cohort is a statement about state, never an action
      actsOnPatient: false,
    },
    activity,
    decision: {
      allowed: ['review', 'decline'],
      reasonRequiredFor: ['decline'],
    },
    execution: null,
    outcome: {
      // the only way anything changes: a separate proposal, approved, then verified
      verification: 'proposal → approval → outcome episode',
      actingOnSuggestion: false,
    },
    assurance: {
      criterionVersion: s.criterionVersion,
      replay: `/api/work/${cohortWorkId(s.realmId, s.cohortId, s.patientId)}`,
      whyPatientIsHere: `/admin/cohorts/patients/${s.patientId}`,
    },
  };
}

const DEFAULT_TOPIC_PLAN: Omit<PlatformTopicPlan, 'id' | 'createdAt' | 'updatedAt'> = {
  defaultOutputTopic: 'anant.agent.output.v1',
  agentDlqTopic: 'anant.agent.output.dlq.v1',
  actionCommandTopic: 'anant.action.command.v1',
  actionAckTopic: 'anant.action.ack.v1',
  outcomeStateTopic: 'anant.outcome.state.v1',
  assuranceEventTopic: 'anant.assurance.event.v1',
  entries: [],
};

/** Universal detail for an outcome episode (the closed-loop unit of work). */
function episodeDetail(e: OutcomeEpisode): Record<string, unknown> {
  return {
    id: `episode:${e.episodeId}`,
    kind: 'episode',
    title: `${e.kind.replace(/-/g, ' ')} · ${e.subject}`,
    state: e.state,
    scope: e.scopeType,
    owner: e.approval?.approver ?? 'Outcome Command',
    why: 'This episode exists because observed signals crossed the configured policy threshold and require authorized coordination to close.',
    overview: { kind: e.kind, subject: e.subject, openedAt: e.openedAt, approvalClass: episodeApprovalClass(e), evidenceCount: e.evidence.length },
    evidence: e.evidence.map((ev) => ({ sourceId: ev.sourceId, contentType: ev.contentType, hash: ev.hash ?? null, span: ev.span ?? null })),
    contributions: e.proposal ? [{ cellId: (e.proposal as { cellId?: string }).cellId ?? null, option: (e.proposal as { option?: string }).option ?? null, confidenceBasisPoints: (e.proposal as { confidenceBasisPoints?: number }).confidenceBasisPoints ?? null }] : [],
    policy: { approvalClass: episodeApprovalClass(e), approved: e.approval?.decision ?? null, approver: e.approval?.approver ?? null },
    activity: e.transitions.map((t) => ({ from: t.from, to: t.to, at: t.at, by: t.by, note: t.note ?? null })),
    decision: { allowed: ['approve', 'reject', 'escalate'], reasonRequiredFor: ['reject', 'escalate'] },
    execution: e.command ? { commandId: e.command.commandId, action: e.command.action, idempotencyKey: e.command.idempotencyKey } : null,
    outcome: e.measureResult ? { measureId: e.measureResult.measureId, met: e.measureResult.met, at: e.measureResult.at } : { verified: e.state === 'Resolved' },
    assurance: { dossierHash: e.dossierHash, evidenceStatus: e.evidenceStatus ?? null, replay: `/api/work/${e.episodeId}` },
  };
}

function reviewDetail(r: EvidenceReview): Record<string, unknown> {
  return {
    id: `review:${r.id}`,
    kind: 'review',
    title: `Evidence review · ${r.entityType}`,
    state: r.status,
    scope: r.entityId,
    owner: 'Clinical Safety Officer',
    why: r.reason,
    overview: { entityId: r.entityId, entityType: r.entityType, requestedBy: r.requestedBy, requestedAt: r.createdAt },
    evidence: [],
    contributions: [],
    policy: { approvalClass: 'C', approved: r.decision ?? null, approver: r.reviewer ?? null },
    activity: [{ from: 'pending', to: r.status, at: r.reviewedAt ?? r.createdAt, by: r.reviewer ?? r.requestedBy, note: r.note ?? null }],
    decision: { allowed: ['approve', 'reject'], reasonRequiredFor: ['reject'] },
    execution: null,
    outcome: { reviewed: r.status !== 'pending' },
    assurance: { replay: `/api/work/review:${r.id}` },
  };
}

function releaseDetail(r: ConfigRelease): Record<string, unknown> {
  const gates = r.checks ?? [];
  const failedGates = gates.filter((c) => !c.passed);
  const allowed: string[] = [];
  if (r.status === 'draft' || r.status === 'failed') allowed.push('validate');
  if (r.status === 'validated') allowed.push('approve');
  if (r.status === 'approved') allowed.push('canary', 'activate', 'rollback');
  if (r.status === 'canary') allowed.push('promote', 'fail');
  if (r.status === 'active' || r.status === 'approved' || r.status === 'validated') allowed.push('rollback');
  return {
    id: `release:${r.id}`,
    kind: 'release',
    title: `Release · ${r.version}`,
    state: r.status,
    scope: 'configuration',
    owner: 'Configuration Release Approver',
    why: r.changeSummary,
    overview: {
      version: r.version,
      contentHash: r.contentHash,
      objectCount: r.objectCount,
      createdBy: r.createdBy,
      canaryScopes: r.canaryScopes ?? [],
      ...(r.canaryResult ? { canaryResult: r.canaryResult } : {}),
    },
    evidence: (r.checks?.map((c) => ({ id: c.name, sourceId: 'release-gate', contentType: 'gate', validFrom: r.validatedAt ?? null, passed: c.passed, observed: c.observed })) ?? []),
    contributions: [],
    policy: { approvalClass: 'D', approved: r.status === 'approved' || r.status === 'active' || r.status === 'canary', approver: r.createdBy },
    activity: [
      { from: 'draft', to: r.status, at: r.updatedAt, by: r.createdBy, note: null },
      ...(r.activatedAt ? [{ from: 'approved', to: 'active', at: r.activatedAt, by: r.createdBy, note: 'dossier written' }] : []),
      ...(r.rolledBackAt ? [{ from: r.status, to: 'rolled-back', at: r.rolledBackAt, by: 'rollback-operator', note: null }] : []),
    ],
    decision: { allowed, reasonRequiredFor: ['rollback', 'fail'] },
    execution: null,
    outcome: { active: r.status === 'active', canary: r.status === 'canary', gateFailed: r.status === 'failed' },
    assurance: {
      contentHash: r.contentHash,
      replay: `/api/work/release:${r.id}`,
      gates: r.checks ?? [],
      blockingFindings: failedGates.length,
      dossier: r.dossier ?? null,
    },
  };
}

function dlqDetail(outboxId: string): Record<string, unknown> {
  return {
    id: `dlq:${outboxId}`,
    kind: 'dlq',
    title: `DLQ item · ${outboxId}`,
    state: 'incident',
    scope: 'event plane',
    owner: 'Integration/Kafka Administrator',
    why: 'A message exhausted its retry budget and was parked in the dead-letter queue pending operator remediation.',
    overview: { outboxId },
    evidence: [],
    contributions: [],
    policy: { approvalClass: 'B', approved: null, approver: null },
    activity: [{ from: 'retrying', to: 'incident', at: new Date().toISOString(), by: 'kafka-bridge', note: null }],
    decision: { allowed: ['acknowledge'], reasonRequiredFor: [] },
    execution: null,
    outcome: { remediated: false },
    assurance: { replay: `/api/work/dlq:${outboxId}` },
  };
}
