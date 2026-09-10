// Living-cohort routes.
//
//   GET    /admin/cohorts                       — the configured catalog (data)
//   POST   /admin/cohorts                       — create a cohort (operator-authored)
//   GET    /admin/cohorts/metrics               — the closed metric vocabulary
//   GET    /admin/cohorts/:id                   — one definition
//   PUT    /admin/cohorts/:id                   — edit a cohort
//   DELETE /admin/cohorts/:id                   — retire a cohort
//   POST   /admin/cohorts/evaluate              — run every cohort over the live cohort of patients
//   GET    /admin/cohorts/state                 — cohort-level state (members, churn, coverage)
//   GET    /admin/cohorts/suggestions           — the nurse-facing suggested queue
//   GET    /admin/cohorts/patients/:patientId   — why IS this patient in cohorts?
//
// Cohorts are operator-editable data. A definition may only reference metrics from
// the closed vocabulary, and every metric resolves from an existing pack output —
// so authoring a cohort is configuration, never new clinical logic.
//
// Nothing here acts. Membership is a statement about state; acting goes through the
// existing proposal → approval → outcome-episode path.

import type { FastifyInstance, FastifyReply } from 'fastify';
import { RealmRegistry } from '../realm/registry.js';
import { renalPatientFacts, renalPatientInputs, type RenalPatientInput } from '../swarm/renal-cohort.js';
import { RENAL_PROTOCOLS, evaluateProtocolForPatient } from '../protocols/registry.js';
import { getSwarmWorkspace } from './swarm-routes.js';
import type { CohortDefinitionDoc, CohortMembershipDoc, SwarmWorkspaceStore } from '../swarm/workspace.js';
import {
  COHORT_METRICS, SEED_COHORT_DEFINITIONS, canonicalLabCode, cohortMetric, cohortStateOf,
  evaluatePatient, shouldExit,
  type CohortCriterion, type CohortDefinition, type CohortEvaluation, type LabPoint,
} from '../swarm/cohort.js';

export interface CohortRouteOptions {
  /** override the live patient source (tests) */
  patients?: (() => RenalPatientInput[]) | undefined;
  /** override the ledger lab-series provider (tests) */
  series?: ((patientId: string, code: string) => readonly LabPoint[]) | undefined;
}

const error = (reply: FastifyReply, code: number, message: string) => reply.code(code).send({ error: message });
const NOW = (): string => new Date().toISOString();

/** Lab codes a cohort criterion may trend. Kept small and explicit. */
const TREND_CODES = ['HGB', 'POTASSIUM', 'PHOS', 'FERRITIN', 'TSAT', 'CRP', 'ALBUMIN', 'KTV', 'URR'] as const;

/**
 * Build the ledger-backed lab series provider.
 *
 * Lab results are attributed to a patient through their ORDER id, exactly as the
 * protocol routes do it, because a `result-lab` effect carries no patientId.
 */
export function ledgerLabSeries(
  events: readonly { payload?: Record<string, unknown>; realmAt?: string; emittedAt?: string }[],
  knownPatientIds: readonly string[],
): (patientId: string, code: string) => readonly LabPoint[] {
  const byKey = new Map<string, LabPoint[]>();
  const known = [...knownPatientIds].sort((a, b) => b.length - a.length);
  for (const event of events) {
    const payload = event.payload ?? {};
    if (typeof payload.code !== 'string' || typeof payload.value !== 'number') continue;
    const orderId = typeof payload.orderId === 'string' ? payload.orderId : undefined;
    const direct = typeof payload.patientId === 'string' ? payload.patientId : undefined;
    const patientId = direct ?? (orderId ? known.find((id) => orderId.startsWith(`${id}-`)) : undefined);
    if (!patientId) continue;
    const at = event.realmAt ?? event.emittedAt;
    if (!at) continue;
    // index by CANONICAL code so `series(patient, 'POTASSIUM')` finds a ledger `K`
    const key = `${patientId}\u0001${canonicalLabCode(String(payload.code))}`;
    const bucket = byKey.get(key);
    const point = { at, value: payload.value };
    if (bucket) bucket.push(point);
    else byKey.set(key, [point]);
  }
  return (patientId, code) => byKey.get(`${patientId}\u0001${canonicalLabCode(code)}`) ?? [];
}

function defaultSeries(patients: readonly RenalPatientInput[]): (patientId: string, code: string) => readonly LabPoint[] {
  const known = patients.map((p) => p.id);
  const events: Array<{ payload?: Record<string, unknown>; realmAt?: string; emittedAt?: string }> = [];
  for (const realm of RealmRegistry.list()) {
    for (const entry of realm.ledger.listAll()) {
      const effect = entry.effect as Record<string, unknown> | undefined;
      if (!effect || effect.kind !== 'result-lab') continue;
      events.push({
        payload: effect,
        ...(entry.realmAt ? { realmAt: entry.realmAt } : {}),
        emittedAt: entry.emittedAt,
      });
    }
  }
  return ledgerLabSeries(events, known);
}

/**
 * Scanning every realm ledger is far too expensive to repeat on a work-queue poll,
 * so the derived series is cached for a short window. The data is append-only lab
 * history, so a stale read costs at most one new result in a trend of many.
 */
let cachedSeries: { at: number; provider: (patientId: string, code: string) => readonly LabPoint[] } | undefined;
const SERIES_TTL_MS = 30_000;

export function cachedLedgerSeries(patients: readonly RenalPatientInput[]): (patientId: string, code: string) => readonly LabPoint[] {
  const now = Date.now();
  if (cachedSeries && now - cachedSeries.at < SERIES_TTL_MS) return cachedSeries.provider;
  const provider = defaultSeries(patients);
  cachedSeries = { at: now, provider };
  return provider;
}

/** Definition doc → the engine's pure shape. */
export function toCohortDefinition(doc: CohortDefinitionDoc): CohortDefinition {
  return {
    id: doc.definitionId,
    label: doc.label,
    kind: doc.kind,
    protocol: doc.protocol as CohortDefinition['protocol'],
    rationale: doc.rationale,
    entry: doc.entry as CohortCriterion[],
    exit: doc.exit as CohortCriterion[],
    ...(doc.entryMode ? { entryMode: doc.entryMode } : {}),
    suggestedAction: doc.suggestedAction,
    approvalClass: doc.approvalClass as CohortDefinition['approvalClass'],
    mayNever: doc.mayNever,
    guard: doc.guard,
    minN: doc.minN,
    criterionVersion: doc.criterionVersion,
    owner: doc.owner,
    enabled: doc.enabled,
  };
}

/** Validate an operator-authored definition before it is stored. */
export function validateCohortInput(body: unknown): { ok: true; doc: Omit<CohortDefinitionDoc, 'id' | 'createdAt' | 'updatedAt'> } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body-required' };
  const b = body as Record<string, unknown>;
  const str = (k: string): string => (typeof b[k] === 'string' ? (b[k] as string).trim() : '');
  const definitionId = str('id') || str('definitionId');
  const label = str('label');
  if (!definitionId) return { ok: false, error: 'id-required' };
  if (!/^[a-z0-9][a-z0-9-]*$/.test(definitionId)) return { ok: false, error: `invalid-id: ${definitionId}` };
  if (!label) return { ok: false, error: 'label-required' };

  const criteria = (key: 'entry' | 'exit'): CohortCriterion[] | string => {
    const raw = b[key];
    if (!Array.isArray(raw) || raw.length === 0) return `${key}-must-have-at-least-one-criterion`;
    const out: CohortCriterion[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') return `${key}-criterion-must-be-an-object`;
      const c = item as Record<string, unknown>;
      const metric = typeof c.metric === 'string' ? c.metric : '';
      if (!metric) return `${key}-criterion-missing-metric`;
      // the closed vocabulary is what keeps a user-authored cohort honest
      if (!cohortMetric(metric)) return `unknown-metric: ${metric}`;
      const comparator = typeof c.comparator === 'string' ? c.comparator : '';
      const allowed = ['gte', 'gt', 'lte', 'lt', 'eq', 'neq', 'present', 'absent', 'outside'];
      if (!allowed.includes(comparator)) return `invalid-comparator: ${comparator}`;
      const spec = cohortMetric(metric);
      if (spec?.valueType === 'number' && comparator !== 'present' && comparator !== 'absent' && comparator !== 'outside') {
        if (typeof c.value !== 'number') return `${key}:${metric}-needs-a-numeric-value`;
      }
      if (comparator === 'outside' && typeof c.min !== 'number' && typeof c.max !== 'number') {
        return `${key}:${metric}-outside-needs-min-or-max`;
      }
      out.push({
        metric,
        comparator: comparator as CohortCriterion['comparator'],
        ...(c.value !== undefined ? { value: c.value as number | string | boolean } : {}),
        ...(typeof c.min === 'number' ? { min: c.min } : {}),
        ...(typeof c.max === 'number' ? { max: c.max } : {}),
        ...(typeof c.note === 'string' ? { note: c.note } : {}),
      });
    }
    return out;
  };

  const entry = criteria('entry');
  if (typeof entry === 'string') return { ok: false, error: entry };
  const exit = criteria('exit');
  if (typeof exit === 'string') return { ok: false, error: exit };

  const mayNever = Array.isArray(b.mayNever) ? (b.mayNever as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  if (mayNever.length === 0) return { ok: false, error: 'mayNever-required: state the boundary this cohort cannot cross' };
  const guard = Array.isArray(b.guard) ? (b.guard as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  if (guard.length === 0) return { ok: false, error: 'guard-required: name the guards that apply before acting' };

  const kind = b.kind === 'monitoring' ? 'monitoring' : 'suggested';
  const protocol = str('protocol') || 'cross';
  if (protocol !== 'cross' && !RENAL_PROTOCOLS.some((p) => p.id === protocol)) return { ok: false, error: `unknown-protocol: ${protocol}` };

  return {
    ok: true,
    doc: {
      definitionId,
      label,
      kind,
      protocol,
      rationale: str('rationale') || 'operator-authored cohort',
      entry,
      exit,
      ...(b.entryMode === 'any' ? { entryMode: 'any' as const } : {}),
      suggestedAction: str('suggestedAction') || 'clinical review',
      approvalClass: ['A', 'B', 'C', 'D'].includes(str('approvalClass')) ? str('approvalClass') : 'C',
      mayNever,
      guard,
      minN: typeof b.minN === 'number' && b.minN > 0 ? Math.floor(b.minN) : 3,
      criterionVersion: str('criterionVersion') || '1.0.0',
      owner: str('owner') || 'clinical',
      enabled: b.enabled === undefined ? true : Boolean(b.enabled),
    },
  };
}

export interface CohortEvaluationRow extends CohortEvaluation {
  realmId: string;
  risk: number;
  suggestedAction: string;
  approvalClass: string;
  mayNever: string[];
  guard: string[];
  kind: CohortDefinition['kind'];
  protocol: string;
  criterionVersion: string;
  label: string;
  /** risk-weighted opportunity, used to order the suggestion queue */
  opportunity: number;
}

/**
 * Run every enabled cohort over the live patient cohort.
 *
 * Protocol statuses are computed ONCE per patient and shared across all cohorts —
 * a cohort is a composition over pack outputs, so recomputing them per cohort
 * would be both slower and a chance to disagree.
 */
export function evaluateCohorts(
  defs: readonly CohortDefinition[],
  patients: readonly RenalPatientInput[],
  opts: { series?: ((patientId: string, code: string) => readonly LabPoint[]) | undefined; at: string; intervalDays?: number },
): { rows: CohortEvaluationRow[]; states: ReturnType<typeof cohortStateOf>[] } {
  const facts = patients.map((p) => renalPatientFacts(p));
  const stateOf = new Map(patients.map((p) => [p.id, p.state] as const));

  const statusesByPatient = new Map<string, Map<string, { status: string; severity: number }>>();
  const severityTotals = new Map<string, number>();
  for (const f of facts) {
    const statuses = new Map<string, { status: string; severity: number }>();
    let total = 0;
    for (const descriptor of RENAL_PROTOCOLS) {
      const s = evaluateProtocolForPatient(descriptor.id, f);
      statuses.set(descriptor.id as string, { status: s.status as string, severity: s.severity });
      total += s.severity;
    }
    statusesByPatient.set(f.patientId, statuses);
    severityTotals.set(f.patientId, total);
  }

  const rows: CohortEvaluationRow[] = [];
  const states: ReturnType<typeof cohortStateOf>[] = [];

  for (const def of defs) {
    if (!def.enabled) continue;
    const evaluations: CohortEvaluation[] = [];
    for (const f of facts) {
      const ctx = {
        ...(opts.series ? { series: opts.series } : {}),
        at: opts.at,
        ...(opts.intervalDays !== undefined ? { intervalDays: opts.intervalDays } : {}),
        ...(stateOf.get(f.patientId) ? { state: stateOf.get(f.patientId) as Record<string, unknown> } : {}),
      };
      const evaluation = evaluatePatient(def, f, ctx, statusesByPatient.get(f.patientId));
      evaluations.push(evaluation);
      const risk = Math.round((severityTotals.get(f.patientId) ?? 0) * 1000) / 1000;
      rows.push({
        ...evaluation,
        realmId: f.realmId,
        risk,
        suggestedAction: def.suggestedAction,
        approvalClass: def.approvalClass,
        mayNever: def.mayNever,
        guard: def.guard,
        kind: def.kind,
        protocol: def.protocol as string,
        criterionVersion: def.criterionVersion,
        label: def.label,
        // the suggestion queue orders by opportunity, not raw risk (§9)
        opportunity: Math.round(risk * evaluation.confidence * 1000) / 1000,
      });
    }
    const actionable = new Set(evaluations.filter((e) => e.state === 'member').map((e) => e.patientId));
    states.push(cohortStateOf(def, evaluations, actionable));
  }

  return { rows, states };
}

export async function registerCohortRoutes(app: FastifyInstance, opts: CohortRouteOptions = {}): Promise<void> {
  const patients = opts.patients ?? (() => renalPatientInputs(RealmRegistry.list()));
  const series = opts.series ?? ((patientId: string, code: string) => cachedLedgerSeries(patients())(patientId, code));

  const ws = (): SwarmWorkspaceStore => {
    const w = getSwarmWorkspace();
    if (!w) throw new Error('swarm-workspace-not-ready');
    return w;
  };

  /** Seed the shipped catalog once; operator edits are never overwritten. */
  async function ensureDefinitions(store: SwarmWorkspaceStore): Promise<CohortDefinitionDoc[]> {
    await store.seedCohortDefinitions(SEED_COHORT_DEFINITIONS.map((d) => ({ ...d, definitionId: d.id })));
    return store.listCohortDefinitions();
  }

  async function runEvaluation(store: SwarmWorkspaceStore, persist: boolean): Promise<{
    at: string;
    rows: CohortEvaluationRow[];
    states: ReturnType<typeof cohortStateOf>[];
    persisted: number;
  }> {
    const docs = await ensureDefinitions(store);
    const defs = docs.map(toCohortDefinition);
    const at = NOW();
    const live = patients();
    const { rows, states } = evaluateCohorts(defs, live, { series, at, intervalDays: 2 });

    let persisted = 0;
    if (persist) {
      const defsById = new Map(defs.map((d) => [d.id, d]));
      for (const row of rows) {
        const def = defsById.get(row.cohortId);
        if (!def) continue;
        const isMember = row.state === 'member';
        const currentlyMember = isMember || (row.state === 'not-member' && !shouldExit(row) ? false : false);
        await store.recordCohortMembership({
          cohortId: row.cohortId,
          patientId: row.patientId,
          realmId: row.realmId,
          member: currentlyMember,
          reason: row.reason,
          confidence: row.confidence,
          criterionVersion: row.criterionVersion,
          risk: row.risk,
          suggestedAction: row.suggestedAction,
          protocol: row.protocol,
          unresolved: row.unresolved,
        });
        persisted += 1;
      }
    }
    return { at, rows, states, persisted };
  }

  /* ---------- configuration (operator-editable data) ---------- */

  app.get('/admin/cohorts/metrics', async () => ({
    generatedAt: NOW(),
    metrics: COHORT_METRICS,
    comparators: ['gte', 'gt', 'lte', 'lt', 'eq', 'neq', 'present', 'absent', 'outside'],
    note: 'A cohort criterion may only reference a metric from this vocabulary, so an authored cohort composes existing pack outputs rather than defining new clinical logic.',
    trendCodes: TREND_CODES,
  }));

  app.get('/admin/cohorts', async () => {
    const store = ws();
    const docs = await ensureDefinitions(store);
    return {
      generatedAt: NOW(),
      count: docs.length,
      cohorts: docs.map((d) => ({
        ...d,
        suggested: d.kind === 'suggested',
        entryText: d.entry.map((c) => `${c.metric} ${c.comparator} ${c.value ?? ''}`.trim()),
        exitText: d.exit.map((c) => `${c.metric} ${c.comparator} ${c.value ?? ''}`.trim()),
      })),
    };
  });

  app.post<{ Body: unknown }>('/admin/cohorts', async (request, reply) => {
    const parsed = validateCohortInput(request.body);
    if (!parsed.ok) return error(reply, 400, parsed.error);
    const store = ws();
    await ensureDefinitions(store);
    const existing = await store.getCohortDefinition(parsed.doc.definitionId);
    if (existing) return error(reply, 409, `cohort-exists: ${parsed.doc.definitionId}`);
    const created = await store.saveCohortDefinition(parsed.doc);
    return { generatedAt: NOW(), cohort: created };
  });

  app.get<{ Params: { id: string } }>('/admin/cohorts/:id', async (request, reply) => {
    const store = ws();
    await ensureDefinitions(store);
    const doc = await store.getCohortDefinition(request.params.id);
    if (!doc) return error(reply, 404, `cohort-not-found: ${request.params.id}`);
    return { generatedAt: NOW(), cohort: doc, definition: toCohortDefinition(doc) };
  });

  app.put<{ Params: { id: string }; Body: unknown }>('/admin/cohorts/:id', async (request, reply) => {
    const parsed = validateCohortInput({ ...(request.body as Record<string, unknown>), id: request.params.id });
    if (!parsed.ok) return error(reply, 400, parsed.error);
    const store = ws();
    await ensureDefinitions(store);
    const existing = await store.getCohortDefinition(request.params.id);
    if (!existing) return error(reply, 404, `cohort-not-found: ${request.params.id}`);
    const saved = await store.saveCohortDefinition({ ...parsed.doc, definitionId: request.params.id });
    return { generatedAt: NOW(), cohort: saved, note: 'criterion changes take effect on the next evaluation and are attributed by criterionVersion' };
  });

  app.delete<{ Params: { id: string } }>('/admin/cohorts/:id', async (request, reply) => {
    const store = ws();
    const removed = await store.removeCohortDefinition(request.params.id);
    if (!removed) return error(reply, 404, `cohort-not-found: ${request.params.id}`);
    return { generatedAt: NOW(), removed: request.params.id };
  });

  /* ---------- evaluation ---------- */

  app.post<{ Body: { persist?: boolean } }>('/admin/cohorts/evaluate', async (request) => {
    const store = ws();
    const result = await runEvaluation(store, request.body?.persist !== false);
    return {
      generatedAt: result.at,
      persisted: result.persisted,
      cohorts: result.states,
      memberships: result.rows.filter((r) => r.state === 'member').length,
      unresolved: result.rows.filter((r) => r.state === 'unresolved').length,
      note: 'unresolved is reported as a coverage number: a missing measurement is never treated as a healthy patient.',
    };
  });

  app.get('/admin/cohorts/state', async () => {
    const store = ws();
    const result = await runEvaluation(store, false);
    const memberships = await store.listCohortMemberships();
    return {
      generatedAt: result.at,
      cohorts: result.states,
      history: {
        tracked: memberships.length,
        members: memberships.filter((m) => m.member).length,
        entries: memberships.reduce((a, m) => a + m.history.filter((h) => h.event === 'entered').length, 0),
        exits: memberships.reduce((a, m) => a + m.history.filter((h) => h.event === 'exited').length, 0),
      },
    };
  });

  /* ---------- the nurse-facing suggested queue ---------- */

  app.get<{ Querystring: { limit?: string; kind?: string } }>('/admin/cohorts/suggestions', async (request) => {
    const store = ws();
    const result = await runEvaluation(store, true);
    const limitRaw = Number(request.query?.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(500, Math.floor(limitRaw)) : 100;
    const kind = request.query?.kind;
    const queue = result.rows
      .filter((r) => r.state === 'member' && r.kind === 'suggested')
      .filter((r) => (kind ? r.protocol === kind : true))
      .sort((a, b) => b.opportunity - a.opportunity || a.patientId.localeCompare(b.patientId))
      .slice(0, limit)
      .map((r) => ({
        id: `cohort:${r.cohortId}:${r.patientId}`,
        cohortId: r.cohortId,
        cohortLabel: r.label,
        patientId: r.patientId,
        realmId: r.realmId,
        protocol: r.protocol,
        approvalClass: r.approvalClass,
        risk: r.risk,
        confidence: r.confidence,
        opportunity: r.opportunity,
        // the whole point: why is this patient here, in the clinician's words
        reason: r.reason,
        suggestedAction: r.suggestedAction,
        mayNever: r.mayNever,
        guard: r.guard,
        criterionVersion: r.criterionVersion,
        evidence: r.entry.filter((c) => c.outcome === 'met').map((c) => ({ metric: c.metric, measured: c.observed, expected: c.expected })),
        unresolved: r.unresolved,
      }));
    return {
      generatedAt: result.at,
      count: queue.length,
      queue,
      states: result.states,
      note: 'Every entry is a SUGGESTION awaiting a human decision. Nothing in this queue has been acted on.',
    };
  });

  /* ---------- explainability: why is this patient in a cohort? ---------- */

  app.get<{ Params: { patientId: string } }>('/admin/cohorts/patients/:patientId', async (request, reply) => {
    const store = ws();
    const result = await runEvaluation(store, false);
    const rows = result.rows.filter((r) => r.patientId === request.params.patientId);
    if (rows.length === 0) return error(reply, 404, `patient-not-in-cohort-scope: ${request.params.patientId}`);
    const memberships = (await store.listCohortMemberships()).filter((m) => m.patientId === request.params.patientId);
    const byCohort = new Map(memberships.map((m) => [m.cohortId, m]));
    return {
      generatedAt: result.at,
      patientId: request.params.patientId,
      inCohorts: rows.filter((r) => r.state === 'member').map((r) => ({
        cohortId: r.cohortId,
        label: r.label,
        protocol: r.protocol,
        reason: r.reason,
        confidence: r.confidence,
        risk: r.risk,
        opportunity: r.opportunity,
        suggestedAction: r.suggestedAction,
        approvalClass: r.approvalClass,
        mayNever: r.mayNever,
        entry: r.entry,
        enteredAt: byCohort.get(r.cohortId)?.enteredAt ?? null,
        history: byCohort.get(r.cohortId)?.history ?? [],
      })),
      notMember: rows.filter((r) => r.state !== 'member').map((r) => ({ cohortId: r.cohortId, state: r.state, reason: r.reason })),
    };
  });
}
