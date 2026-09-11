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

// SqlStore — durable persistence for the harness's product state (realms, billing,
// counterfactuals, nudge ledger) over ANY `SqlDb` dialect. The store only writes portable SQL;
// swapping SQLite → Postgres is constructing a different `SqlDb`, nothing else changes.

import type { SqlDb } from './sql-db.js';
import { MIGRATIONS, WIDEN_TO_BIGINT } from './schema.js';
import type { LocalUser } from '../auth/users.js';

/**
 * A BIGINT/BIGINT-shaped column, as a number.
 *
 * The pg driver returns INT8 as a STRING because it cannot know a value fits a JS
 * number; SQLite returns a number. A column declared `number` in TypeScript is
 * therefore a string at runtime on Postgres — which is how a restored session's
 * `expiresAt` reached `new Date(...)` as "1789…" and threw
 * `Invalid time value`, 500-ing `GET /auth/me` and quietly defeating the durable
 * session restore it exists to provide. Epoch-millisecond values are well inside
 * the safe integer range, so the coercion is lossless here.
 */
function bigintToNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

/** `nudge_ledger.expires_at` is BIGINT — coerce it wherever the row is read. */
function coerceNudge<T extends { expiresAt?: number | string | undefined | null }>(row: T): T {
  const coerced = bigintToNumber(row.expiresAt);
  return { ...row, ...(coerced !== undefined ? { expiresAt: coerced } : {}) };
}

/** Row shape for `local_users` (JSON array columns arrive as TEXT). */
interface LocalUserRow {
  username: string;
  displayName: string;
  passwordHash: string;
  role: string;
  clearance: string;
  purposeOfUse: string;
  orgId: string;
  scopeIds: string;
  createdAt: string;
  lastLoginAt: string | null;
}

/**
 * Parse a JSON array column without letting one malformed row abort a list read.
 * A missing/unparseable value becomes `[]`, which is the documented meaning of an
 * empty list rather than an error.
 */
function parseJsonArray(value: unknown): unknown[] {
  if (typeof value !== 'string' || value.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export interface RealmSnapshotRow {
  realmId: string;
  mode: string;
  createdAt: string;
  updatedAt: string;
  snapshotJson: string;
}
export interface WorkspaceRow {
  kind: string;
  id: string;
  entityJson: string;
  createdAt: string;
  updatedAt: string;
}
export interface RealmSpecRow {
  realmId: string;
  mode: string;
  trajectoryEngine?: string | null;
  specJson: string;
  createdAt: string;
  updatedAt: string;
}
export interface SimulatorFleetRow {
  id: string;
  scenarioId: string;
  status: string;
  startedAt: string | null;
  tickCount: number;
  eventCount: number;
  fleetJson: string;
  createdAt: string;
  updatedAt: string;
}
export interface BillingRow {
  id: string;
  realmId: string;
  period: string;
  plan: string;
  reportJson: string;
  createdAt: string;
}
export interface FhirResourceRow {
  id: string;
  realmId: string;
  resourceType: string;
  kind: string;
  entityId?: string | null;
  resourceJson: string;
  direction: 'in' | 'out';
  ingestedAt: string;
}
// Phase 4 — enterprise platform rows (idempotency, audit, webhooks, alerts, retention).
export interface IdempotencyKeyRow {
  id: string;
  scopeId: string;
  method: string;
  path: string;
  requestHash: string;
  responseJson?: string | null;
  createdAt: string;
}
export interface AuditEventRow {
  id: string;
  scopeId: string;
  actorRef: string;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  classification: string;
  occurredAt: string;
  payloadJson?: string | null;
}
export interface WebhookEndpointRow {
  id: string;
  realmId?: string | null;
  url: string;
  secret: string;
  eventTypesJson: string;
  active: number;
  createdAt: string;
  updatedAt: string;
}
export interface WebhookDeliveryRow {
  id: string;
  webhookId: string;
  eventId: string;
  eventJson: string;
  status: string;
  attempts: number;
  nextAttemptAt?: string | null;
  lastError?: string | null;
  signature?: string | null;
  createdAt: string;
  deliveredAt?: string | null;
}
export interface AlertRuleRow {
  id: string;
  metric: string;
  op: string;
  threshold: number;
  severity: string;
  enabled: number;
  label?: string | null;
}
export interface AlertEventRow {
  id: string;
  ruleId: string;
  metric: string;
  value: number;
  severity: string;
  message?: string | null;
  status: string;
  firedAt: string;
  resolvedAt?: string | null;
}
export interface RetentionPolicyRow {
  id: string;
  entity: string;
  scopeId?: string | null;
  maxAgeMs: number;
  enabled: number;
}
export interface NudgeRow {
  id: string;
  realmId: string;
  patientId: string;
  channel: string;
  nudgeKind: string;
  expectedEffectJson: string;
  rehearsalId?: string | null;
  variantId?: string | null;
  expiresAt?: string | null;
  status: string;
  sentAt: string;
  observedAt?: string | null;
  observedOutcomeJson?: string | null;
}
export interface CounterfactualRunRow {
  id: string;
  realmId?: string | null;
  label: string;
  inputJson: string;
  reportJson: string;
  createdAt: string;
}
export interface FacilityRow {
  id: string;
  realmId: string;
  name: string;
  kind?: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface UnitRow {
  id: string;
  facilityId: string;
  realmId: string;
  code: string;
  createdAt: string;
  updatedAt: string;
}
export interface PatientRow {
  id: string;
  facilityId: string;
  unitId: string;
  realmId: string;
  name?: string | null;
  age?: number | null;
  sex?: string | null;
  trajectory?: string | null;
  labsJson?: string | null;
  vitalsJson?: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface AssessmentRow {
  id: string;
  title: string;
  loinc?: string | null;
  domain: string;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}
export interface LifecycleStageRow {
  id: string;
  orderNum: number;
  label: string;
  kind: string;
  createdAt: string;
  updatedAt: string;
}
export interface NudgeTemplateRow {
  id: string;
  nudgeKind: string;
  channel: string;
  description?: string | null;
  expectedEffectJson?: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface OutboxRow {
  id: string;
  topic: string;
  scopeId: string;
  eventJson: string;
  status: string;
  attempts: number;
  nextAttemptAt?: string | null;
  lastError?: string | null;
  createdAt: string;
  deliveredAt?: string | null;
  /** kafka-bridge consecutive publish-failure count (from the lease row). */
  bridgeAttempts?: number;
}
/** A bridge publish receipt or terminal incident (M-S3 kafka-bridge). */
export interface BridgeReceiptRow {
  outboxId: string;
  topic: string;
  partitionKey: string;
  idempotencyKey: string;
  publishedAt: string;
  ackOffset?: number | null;
  state: 'delivered' | 'incident';
  incident?: string | null;
}
export interface BridgeCounts {
  leases: number;
  activeLeases: number;
  receipts: number;
  incidents: number;
}

export class SqlStore {
  constructor(private readonly db: SqlDb) {}

  get dialect(): SqlDb['dialect'] {
    return this.db.dialect;
  }

  async applyMigrations(): Promise<void> {
    for (const stmt of MIGRATIONS) await this.db.exec(stmt);
    // Widen ms/epoch columns on databases created before they were BIGINT. A
    // missing table is not an error — the widening is best-effort by design, and
    // failing the boot over an already-correct column would be worse.
    if (this.db.dialect === 'postgres') {
      for (const stmt of WIDEN_TO_BIGINT) {
        try {
          await this.db.exec(stmt);
        } catch { /* already widened, or table absent */ }
      }
    }
  }

  // ---- Realms ----
  async saveRealmSnapshot(row: Omit<RealmSnapshotRow, 'updatedAt'> & { updatedAt?: string }): Promise<void> {
    const updatedAt = row.updatedAt ?? new Date().toISOString();
    await this.db.run(
      `INSERT INTO realm_snapshots (realm_id, mode, created_at, updated_at, snapshot_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (realm_id) DO UPDATE SET
         mode = excluded.mode, updated_at = excluded.updated_at, snapshot_json = excluded.snapshot_json`,
      [row.realmId, row.mode, row.createdAt, updatedAt, row.snapshotJson],
    );
  }

  async listRealmSnapshots(): Promise<RealmSnapshotRow[]> {
    return this.db.all<RealmSnapshotRow>(
      `SELECT realm_id AS realmId, mode, created_at AS createdAt, updated_at AS updatedAt, snapshot_json AS snapshotJson
       FROM realm_snapshots ORDER BY updated_at DESC`);
  }

  async getRealmSnapshot(realmId: string): Promise<RealmSnapshotRow | undefined> {
    const rows = await this.db.all<RealmSnapshotRow>(
      `SELECT realm_id AS realmId, mode, created_at AS createdAt, updated_at AS updatedAt, snapshot_json AS snapshotJson
       FROM realm_snapshots WHERE realm_id = ?`, [realmId]);
    return rows[0];
  }

  // ---- Swarm workspace (durable JSON document store for executive assets) ----
  async saveWorkspace(row: { kind: string; id: string; entityJson: string; createdAt?: string; updatedAt?: string }): Promise<void> {
    const now = new Date().toISOString();
    const createdAt = row.createdAt ?? now;
    const updatedAt = row.updatedAt ?? now;
    await this.db.run(
      `INSERT INTO swarm_workspace (kind, id, entity_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (kind, id) DO UPDATE SET entity_json = excluded.entity_json, updated_at = excluded.updated_at`,
      [row.kind, row.id, row.entityJson, createdAt, updatedAt],
    );
  }

  async listWorkspace(kind?: string): Promise<WorkspaceRow[]> {
    if (kind) {
      return this.db.all<WorkspaceRow>(
        `SELECT kind, id, entity_json AS entityJson, created_at AS createdAt, updated_at AS updatedAt
         FROM swarm_workspace WHERE kind = ? ORDER BY updated_at DESC`, [kind]);
    }
    return this.db.all<WorkspaceRow>(
      `SELECT kind, id, entity_json AS entityJson, created_at AS createdAt, updated_at AS updatedAt
       FROM swarm_workspace ORDER BY updated_at DESC`);
  }

  async getWorkspace(kind: string, id: string): Promise<WorkspaceRow | undefined> {
    const rows = await this.db.all<WorkspaceRow>(
      `SELECT kind, id, entity_json AS entityJson, created_at AS createdAt, updated_at AS updatedAt
       FROM swarm_workspace WHERE kind = ? AND id = ?`, [kind, id]);
    return rows[0];
  }

  async deleteWorkspace(kind: string, id: string): Promise<void> {
    await this.db.run(`DELETE FROM swarm_workspace WHERE kind = ? AND id = ?`, [kind, id]);
  }

  // ---- Realm creation specs (restore-on-boot) ----
  async saveRealmSpec(row: Omit<RealmSpecRow, 'updatedAt'> & { updatedAt?: string }): Promise<void> {
    const updatedAt = row.updatedAt ?? new Date().toISOString();
    await this.db.run(
      `INSERT INTO realm_specs (realm_id, mode, trajectory_engine, spec_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (realm_id) DO UPDATE SET
         mode = excluded.mode, trajectory_engine = excluded.trajectory_engine,
         spec_json = excluded.spec_json, updated_at = excluded.updated_at`,
      [row.realmId, row.mode, row.trajectoryEngine ?? null, row.specJson, row.createdAt, updatedAt],
    );
  }

  async listRealmSpecs(): Promise<RealmSpecRow[]> {
    return this.db.all<RealmSpecRow>(
      `SELECT realm_id AS realmId, mode, trajectory_engine AS trajectoryEngine, spec_json AS specJson, created_at AS createdAt, updated_at AS updatedAt
       FROM realm_specs ORDER BY created_at ASC`);
  }

  async deleteRealmSpec(realmId: string): Promise<void> {
    await this.db.run(`DELETE FROM realm_specs WHERE realm_id = ?`, [realmId]);
  }

  // ---- Simulator fleet (active demo scenario, resumed on boot) ----
  async saveSimulatorFleet(row: { scenarioId: string; status: string; startedAt: string | null; tickCount: number; eventCount: number; fleetJson: string; createdAt?: string; updatedAt?: string }): Promise<void> {
    const now = new Date().toISOString();
    const createdAt = row.createdAt ?? now;
    const updatedAt = row.updatedAt ?? now;
    await this.db.run(
      `INSERT INTO simulator_fleet (id, scenario_id, status, started_at, tick_count, event_count, fleet_json, created_at, updated_at)
       VALUES ('default', ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         scenario_id = excluded.scenario_id, status = excluded.status, started_at = excluded.started_at,
         tick_count = excluded.tick_count, event_count = excluded.event_count,
         fleet_json = excluded.fleet_json, updated_at = excluded.updated_at`,
      [row.scenarioId, row.status, row.startedAt, row.tickCount, row.eventCount, row.fleetJson, createdAt, updatedAt],
    );
  }

  async getSimulatorFleet(): Promise<SimulatorFleetRow | undefined> {
    const rows = await this.db.all<SimulatorFleetRow>(
      `SELECT id, scenario_id AS scenarioId, status, started_at AS startedAt, tick_count AS tickCount, event_count AS eventCount, fleet_json AS fleetJson, created_at AS createdAt, updated_at AS updatedAt
       FROM simulator_fleet WHERE id = 'default'`);
    return rows[0];
  }

  async clearSimulatorFleet(): Promise<void> {
    await this.db.run(`DELETE FROM simulator_fleet WHERE id = 'default'`);
  }

  // ---- Console sessions (durable login for both consoles) ----
  async saveSession(row: { tokenHash: string; username: string; createdAt: string; expiresAt: number }): Promise<void> {
    await this.db.run(
      `INSERT INTO auth_sessions (token_hash, username, created_at, expires_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (token_hash) DO UPDATE SET
         username = excluded.username, expires_at = excluded.expires_at`,
      [row.tokenHash, row.username, row.createdAt, row.expiresAt],
    );
  }

  async listSessions(): Promise<Array<{ tokenHash: string; username: string; createdAt: string; expiresAt: number }>> {
    const rows = await this.db.all<{ tokenHash: string; username: string; createdAt: string; expiresAt: number | string }>(
      `SELECT token_hash AS tokenHash, username, created_at AS createdAt, expires_at AS expiresAt
       FROM auth_sessions`,
    );
    // Postgres returns BIGINT as a STRING (the pg driver cannot know a value fits a
    // JS number) while SQLite returns a number, so a column declared `number` here
    // is a string at runtime on Postgres. That is how a restored session's
    // `expiresAt` reached `new Date(...)` as "1789…" and threw
    // `Invalid time value` — 500-ing GET /auth/me and silently breaking the durable
    // session restore this exists to provide. Coerce at the boundary.
    return rows.map((r) => ({ ...r, expiresAt: bigintToNumber(r.expiresAt) ?? 0 }));
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.db.run(`DELETE FROM auth_sessions WHERE token_hash = ?`, [tokenHash]);
  }

  /** Drop every session that expired at or before `nowEpochMs`. */
  async pruneSessions(nowEpochMs: number): Promise<void> {
    await this.db.run(`DELETE FROM auth_sessions WHERE expires_at <= ?`, [nowEpochMs]);
  }

  // ---- Console users ----
  async saveLocalUser(user: LocalUser): Promise<void> {
    const updatedAt = new Date().toISOString();
    await this.db.run(
      `INSERT INTO local_users
         (username, display_name, password_hash, role, clearance, purpose_of_use, org_id, scope_ids, created_at, last_login_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (username) DO UPDATE SET
         display_name = excluded.display_name, password_hash = excluded.password_hash,
         role = excluded.role, clearance = excluded.clearance,
         purpose_of_use = excluded.purpose_of_use, org_id = excluded.org_id,
         scope_ids = excluded.scope_ids, last_login_at = excluded.last_login_at,
         updated_at = excluded.updated_at`,
      [
        user.username, user.displayName, user.passwordHash, user.role, user.clearance,
        JSON.stringify(user.purposeOfUse ?? []), user.orgId, JSON.stringify(user.scopeIds ?? []),
        user.createdAt, user.lastLoginAt ?? null, updatedAt,
      ],
    );
  }

  async listLocalUsers(): Promise<LocalUser[]> {
    const rows = await this.db.all<LocalUserRow>(
      `SELECT username, display_name AS displayName, password_hash AS passwordHash,
              role, clearance, purpose_of_use AS purposeOfUse, org_id AS orgId,
              scope_ids AS scopeIds, created_at AS createdAt, last_login_at AS lastLoginAt
       FROM local_users ORDER BY username`);
    return rows.map((r) => {
      const user: LocalUser = {
        username: r.username,
        displayName: r.displayName,
        passwordHash: r.passwordHash,
        role: r.role as LocalUser['role'],
        clearance: r.clearance as LocalUser['clearance'],
        purposeOfUse: parseJsonArray(r.purposeOfUse) as LocalUser['purposeOfUse'],
        orgId: r.orgId,
        scopeIds: parseJsonArray(r.scopeIds) as string[],
        createdAt: r.createdAt,
      };
      if (r.lastLoginAt) user.lastLoginAt = r.lastLoginAt;
      return user;
    });
  }

  async deleteLocalUser(username: string): Promise<void> {
    await this.db.run(`DELETE FROM local_users WHERE username = ?`, [username]);
  }

  // ---- Billing ----
  async saveBilling(row: Omit<BillingRow, 'createdAt'> & { createdAt?: string }): Promise<void> {
    const createdAt = row.createdAt ?? new Date().toISOString();
    await this.db.run(
      `INSERT INTO billing_usage (id, realm_id, period, plan, report_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [row.id, row.realmId, row.period, row.plan, row.reportJson, createdAt],
    );
  }

  async listBilling(realmId?: string): Promise<BillingRow[]> {
    const select = `SELECT id, realm_id AS realmId, period, plan, report_json AS reportJson, created_at AS createdAt
                   FROM billing_usage`;
    if (realmId) {
      return this.db.all<BillingRow>(`${select} WHERE realm_id = ? ORDER BY created_at DESC`, [realmId]);
    }
    return this.db.all<BillingRow>(`${select} ORDER BY created_at DESC`);
  }

  // ---- Nudge ledger ----
  async saveNudge(row: NudgeRow): Promise<void> {
    await this.db.run(
      `INSERT INTO nudge_ledger (id, realm_id, patient_id, channel, nudge_kind, expected_effect_json, rehearsal_id, variant_id, expires_at, status, sent_at, observed_at, observed_outcome_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.realmId, row.patientId, row.channel, row.nudgeKind, row.expectedEffectJson, row.rehearsalId ?? null, row.variantId ?? null, row.expiresAt ?? null, row.status, row.sentAt, row.observedAt ?? null, row.observedOutcomeJson ?? null],
    );
  }

  async listNudges(realmId?: string): Promise<NudgeRow[]> {
    const select = `SELECT id, realm_id AS realmId, patient_id AS patientId, channel, nudge_kind AS nudgeKind,
                           expected_effect_json AS expectedEffectJson, rehearsal_id AS rehearsalId, variant_id AS variantId,
                           expires_at AS expiresAt, status, sent_at AS sentAt, observed_at AS observedAt,
                           observed_outcome_json AS observedOutcomeJson
                    FROM nudge_ledger`;
    const rows = realmId
      ? await this.db.all<NudgeRow & { expiresAt: number | string }>(`${select} WHERE realm_id = ? ORDER BY sent_at DESC`, [realmId])
      : await this.db.all<NudgeRow & { expiresAt: number | string }>(`${select} ORDER BY sent_at DESC`);
    return rows.map(coerceNudge);
  }

  async getNudge(id: string): Promise<NudgeRow | undefined> {
    const rows = await this.db.all<NudgeRow & { expiresAt: number | string }>(
      `SELECT id, realm_id AS realmId, patient_id AS patientId, channel, nudge_kind AS nudgeKind,
              expected_effect_json AS expectedEffectJson, rehearsal_id AS rehearsalId, variant_id AS variantId,
              expires_at AS expiresAt, status, sent_at AS sentAt, observed_at AS observedAt,
              observed_outcome_json AS observedOutcomeJson
       FROM nudge_ledger WHERE id = ?`, [id]);
    return rows[0] ? coerceNudge(rows[0]) : undefined;
  }

  async updateNudgeObserved(id: string, observedAt: string, observedOutcomeJson: string, status = 'observed'): Promise<boolean> {
    const res = await this.db.run(
      `UPDATE nudge_ledger SET status = ?, observed_at = ?, observed_outcome_json = ? WHERE id = ?`,
      [status, observedAt, observedOutcomeJson, id],
    );
    return res.changes > 0;
  }

  // ---- Counterfactual runs ----
  async saveCounterfactual(row: CounterfactualRunRow): Promise<void> {
    await this.db.run(
      `INSERT INTO counterfactual_runs (id, realm_id, label, input_json, report_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [row.id, row.realmId ?? null, row.label, row.inputJson, row.reportJson, row.createdAt],
    );
  }

  async listCounterfactuals(): Promise<CounterfactualRunRow[]> {
    return this.db.all<CounterfactualRunRow>(
      `SELECT id, realm_id AS realmId, label, input_json AS inputJson, report_json AS reportJson, created_at AS createdAt
       FROM counterfactual_runs ORDER BY created_at DESC`);
  }

  async getCounterfactual(id: string): Promise<CounterfactualRunRow | undefined> {
    const rows = await this.db.all<CounterfactualRunRow>(
      `SELECT id, realm_id AS realmId, label, input_json AS inputJson, report_json AS reportJson, created_at AS createdAt
       FROM counterfactual_runs WHERE id = ?`, [id]);
    return rows[0];
  }

  async removeCounterfactual(id: string): Promise<boolean> {
    const res = await this.db.run(`DELETE FROM counterfactual_runs WHERE id = ?`, [id]);
    return res.changes > 0;
  }

  async clearCounterfactuals(): Promise<void> {
    await this.db.run(`DELETE FROM counterfactual_runs`);
  }

  async deleteRealmSnapshot(realmId: string): Promise<boolean> {
    const res = await this.db.run(`DELETE FROM realm_snapshots WHERE realm_id = ?`, [realmId]);
    return res.changes > 0;
  }

  // ---- Master data: facilities / units / patients (Settings admin) ----
  async listFacilities(realmId?: string): Promise<FacilityRow[]> {
    const select = `SELECT id, realm_id AS realmId, name, kind, created_at AS createdAt, updated_at AS updatedAt FROM facilities`;
    if (realmId) return this.db.all<FacilityRow>(`${select} WHERE realm_id = ? ORDER BY name`, [realmId]);
    return this.db.all<FacilityRow>(`${select} ORDER BY name`);
  }
  async getFacility(id: string): Promise<FacilityRow | undefined> {
    const rows = await this.db.all<FacilityRow>(
      `SELECT id, realm_id AS realmId, name, kind, created_at AS createdAt, updated_at AS updatedAt FROM facilities WHERE id = ?`, [id]);
    return rows[0];
  }
  async saveFacility(row: Omit<FacilityRow, 'createdAt' | 'updatedAt'> & { createdAt?: string; updatedAt?: string }): Promise<void> {
    const createdAt = row.createdAt ?? new Date().toISOString();
    const updatedAt = row.updatedAt ?? new Date().toISOString();
    await this.db.run(
      `INSERT INTO facilities (id, realm_id, name, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET realm_id = excluded.realm_id, name = excluded.name, kind = excluded.kind, updated_at = excluded.updated_at`,
      [row.id, row.realmId, row.name, row.kind ?? null, createdAt, updatedAt]);
  }
  async deleteFacility(id: string): Promise<boolean> {
    const res = await this.db.run(`DELETE FROM facilities WHERE id = ?`, [id]);
    return res.changes > 0;
  }

  async listUnits(facilityId?: string): Promise<UnitRow[]> {
    const select = `SELECT id, facility_id AS facilityId, realm_id AS realmId, code, created_at AS createdAt, updated_at AS updatedAt FROM units`;
    if (facilityId) return this.db.all<UnitRow>(`${select} WHERE facility_id = ? ORDER BY code`, [facilityId]);
    return this.db.all<UnitRow>(`${select} ORDER BY code`);
  }
  async getUnit(id: string): Promise<UnitRow | undefined> {
    const rows = await this.db.all<UnitRow>(
      `SELECT id, facility_id AS facilityId, realm_id AS realmId, code, created_at AS createdAt, updated_at AS updatedAt FROM units WHERE id = ?`, [id]);
    return rows[0];
  }
  async saveUnit(row: Omit<UnitRow, 'createdAt' | 'updatedAt'> & { createdAt?: string; updatedAt?: string }): Promise<void> {
    const createdAt = row.createdAt ?? new Date().toISOString();
    const updatedAt = row.updatedAt ?? new Date().toISOString();
    await this.db.run(
      `INSERT INTO units (id, facility_id, realm_id, code, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET facility_id = excluded.facility_id, realm_id = excluded.realm_id, code = excluded.code, updated_at = excluded.updated_at`,
      [row.id, row.facilityId, row.realmId, row.code, createdAt, updatedAt]);
  }
  async deleteUnit(id: string): Promise<boolean> {
    const res = await this.db.run(`DELETE FROM units WHERE id = ?`, [id]);
    return res.changes > 0;
  }

  async listPatients(opts: { facilityId?: string; unitId?: string } = {}): Promise<PatientRow[]> {
    let sql = `SELECT id, facility_id AS facilityId, unit_id AS unitId, realm_id AS realmId, name, age, sex, trajectory, labs_json AS labsJson, vitals_json AS vitalsJson, created_at AS createdAt, updated_at AS updatedAt FROM patients`;
    const where: string[] = []; const params: unknown[] = [];
    if (opts.facilityId) { where.push('facility_id = ?'); params.push(opts.facilityId); }
    if (opts.unitId) { where.push('unit_id = ?'); params.push(opts.unitId); }
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    return this.db.all<PatientRow>(sql + ' ORDER BY id', params);
  }
  async getPatient(id: string): Promise<PatientRow | undefined> {
    const rows = await this.db.all<PatientRow>(
      `SELECT id, facility_id AS facilityId, unit_id AS unitId, realm_id AS realmId, name, age, sex, trajectory, labs_json AS labsJson, vitals_json AS vitalsJson, created_at AS createdAt, updated_at AS updatedAt FROM patients WHERE id = ?`, [id]);
    return rows[0];
  }
  async savePatient(row: Omit<PatientRow, 'createdAt' | 'updatedAt'> & { createdAt?: string; updatedAt?: string }): Promise<void> {
    const createdAt = row.createdAt ?? new Date().toISOString();
    const updatedAt = row.updatedAt ?? new Date().toISOString();
    await this.db.run(
      `INSERT INTO patients (id, facility_id, unit_id, realm_id, name, age, sex, trajectory, labs_json, vitals_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET facility_id = excluded.facility_id, unit_id = excluded.unit_id, realm_id = excluded.realm_id, name = excluded.name, age = excluded.age, sex = excluded.sex, trajectory = excluded.trajectory, labs_json = excluded.labs_json, vitals_json = excluded.vitals_json, updated_at = excluded.updated_at`,
      [row.id, row.facilityId, row.unitId, row.realmId, row.name ?? null, row.age ?? null, row.sex ?? null, row.trajectory ?? null, row.labsJson ?? null, row.vitalsJson ?? null, createdAt, updatedAt]);
  }
  async deletePatient(id: string): Promise<boolean> {
    const res = await this.db.run(`DELETE FROM patients WHERE id = ?`, [id]);
    return res.changes > 0;
  }

  // ---- Master data catalogs: assessments / lifecycle stages / nudge templates ----
  async listAssessments(domain?: string): Promise<AssessmentRow[]> {
    const select = `SELECT id, title, loinc, domain, item_count AS itemCount, created_at AS createdAt, updated_at AS updatedAt FROM assessments`;
    if (domain) return this.db.all<AssessmentRow>(`${select} WHERE domain = ? ORDER BY title`, [domain]);
    return this.db.all<AssessmentRow>(`${select} ORDER BY title`);
  }
  async getAssessment(id: string): Promise<AssessmentRow | undefined> {
    const rows = await this.db.all<AssessmentRow>(
      `SELECT id, title, loinc, domain, item_count AS itemCount, created_at AS createdAt, updated_at AS updatedAt FROM assessments WHERE id = ?`, [id]);
    return rows[0];
  }
  async saveAssessment(row: Omit<AssessmentRow, 'createdAt' | 'updatedAt'> & { createdAt?: string; updatedAt?: string }): Promise<void> {
    const createdAt = row.createdAt ?? new Date().toISOString();
    const updatedAt = row.updatedAt ?? new Date().toISOString();
    await this.db.run(
      `INSERT INTO assessments (id, title, loinc, domain, item_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET title = excluded.title, loinc = excluded.loinc, domain = excluded.domain, item_count = excluded.item_count, updated_at = excluded.updated_at`,
      [row.id, row.title, row.loinc ?? null, row.domain, row.itemCount ?? 0, createdAt, updatedAt]);
  }
  async deleteAssessment(id: string): Promise<boolean> {
    const res = await this.db.run(`DELETE FROM assessments WHERE id = ?`, [id]);
    return res.changes > 0;
  }

  async listLifecycleStages(): Promise<LifecycleStageRow[]> {
    return this.db.all<LifecycleStageRow>(
      `SELECT id, order_num AS orderNum, label, kind, created_at AS createdAt, updated_at AS updatedAt FROM lifecycle_stages ORDER BY order_num, id`);
  }
  async getLifecycleStage(id: string): Promise<LifecycleStageRow | undefined> {
    const rows = await this.db.all<LifecycleStageRow>(
      `SELECT id, order_num AS orderNum, label, kind, created_at AS createdAt, updated_at AS updatedAt FROM lifecycle_stages WHERE id = ?`, [id]);
    return rows[0];
  }
  async saveLifecycleStage(row: Omit<LifecycleStageRow, 'createdAt' | 'updatedAt'> & { createdAt?: string; updatedAt?: string }): Promise<void> {
    const createdAt = row.createdAt ?? new Date().toISOString();
    const updatedAt = row.updatedAt ?? new Date().toISOString();
    await this.db.run(
      `INSERT INTO lifecycle_stages (id, order_num, label, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET order_num = excluded.order_num, label = excluded.label, kind = excluded.kind, updated_at = excluded.updated_at`,
      [row.id, row.orderNum ?? 0, row.label, row.kind, createdAt, updatedAt]);
  }
  async deleteLifecycleStage(id: string): Promise<boolean> {
    const res = await this.db.run(`DELETE FROM lifecycle_stages WHERE id = ?`, [id]);
    return res.changes > 0;
  }

  async listNudgeTemplates(kind?: string): Promise<NudgeTemplateRow[]> {
    const select = `SELECT id, nudge_kind AS nudgeKind, channel, description, expected_effect_json AS expectedEffectJson, created_at AS createdAt, updated_at AS updatedAt FROM nudge_templates`;
    if (kind) return this.db.all<NudgeTemplateRow>(`${select} WHERE nudge_kind = ? ORDER BY channel`, [kind]);
    return this.db.all<NudgeTemplateRow>(`${select} ORDER BY nudge_kind, channel`);
  }
  async getNudgeTemplate(id: string): Promise<NudgeTemplateRow | undefined> {
    const rows = await this.db.all<NudgeTemplateRow>(
      `SELECT id, nudge_kind AS nudgeKind, channel, description, expected_effect_json AS expectedEffectJson, created_at AS createdAt, updated_at AS updatedAt FROM nudge_templates WHERE id = ?`, [id]);
    return rows[0];
  }
  async saveNudgeTemplate(row: Omit<NudgeTemplateRow, 'createdAt' | 'updatedAt'> & { createdAt?: string; updatedAt?: string }): Promise<void> {
    const createdAt = row.createdAt ?? new Date().toISOString();
    const updatedAt = row.updatedAt ?? new Date().toISOString();
    await this.db.run(
      `INSERT INTO nudge_templates (id, nudge_kind, channel, description, expected_effect_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET nudge_kind = excluded.nudge_kind, channel = excluded.channel, description = excluded.description, expected_effect_json = excluded.expected_effect_json, updated_at = excluded.updated_at`,
      [row.id, row.nudgeKind, row.channel, row.description ?? null, row.expectedEffectJson ?? null, createdAt, updatedAt]);
  }
  async deleteNudgeTemplate(id: string): Promise<boolean> {
    const res = await this.db.run(`DELETE FROM nudge_templates WHERE id = ?`, [id]);
    return res.changes > 0;
  }

  // ---- Event outbox (Phase 0 — transactional-outbox publish path) ----
  async enqueueOutboxEvent(row: { id: string; topic: string; scopeId: string; eventJson: string; createdAt?: string }): Promise<void> {
    const createdAt = row.createdAt ?? new Date().toISOString();
    await this.db.run(
      `INSERT INTO event_outbox (id, topic, scope_id, event_json, status, attempts, next_attempt_at, last_error, created_at, delivered_at)
       VALUES (?, ?, ?, ?, 'pending', 0, NULL, NULL, ?, NULL)
       ON CONFLICT (id) DO NOTHING`,
      [row.id, row.topic, row.scopeId, row.eventJson, createdAt],
    );
  }
  async pendingOutboxEvents(limit = 100, now = new Date().toISOString()): Promise<OutboxRow[]> {
    return this.db.all<OutboxRow>(
      `SELECT id, topic, scope_id AS scopeId, event_json AS eventJson, status, attempts,
              next_attempt_at AS nextAttemptAt, last_error AS lastError, created_at AS createdAt, delivered_at AS deliveredAt
       FROM event_outbox
       WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY created_at ASC LIMIT ?`, [now, limit]);
  }
  async markOutboxDelivered(id: string, deliveredAt = new Date().toISOString()): Promise<boolean> {
    const res = await this.db.run(
      `UPDATE event_outbox SET status = 'delivered', delivered_at = ?, attempts = attempts + 1 WHERE id = ? AND status = 'pending'`, [deliveredAt, id]);
    return res.changes > 0;
  }
  async markOutboxFailed(id: string, error: string, maxAttempts: number, nextAttemptAt: string): Promise<'pending' | 'dead'> {
    const rows = await this.db.all<{ attempts: number }>(`SELECT attempts FROM event_outbox WHERE id = ?`, [id]);
    const attempts = (rows[0]?.attempts ?? 0) + 1;
    const status: 'pending' | 'dead' = attempts >= maxAttempts ? 'dead' : 'pending';
    await this.db.run(
      `UPDATE event_outbox SET attempts = ?, last_error = ?, status = ?, next_attempt_at = ? WHERE id = ?`,
      [attempts, error, status, status === 'dead' ? null : nextAttemptAt, id]);
    return status;
  }
  /** Delivered rows after a cursor (delivered_at) — for replay-from-cursor (Phase 3). */
  async deliveredOutboxEventsSince(cursor: string, limit = 200): Promise<OutboxRow[]> {
    return this.db.all<OutboxRow>(
      `SELECT id, topic, scope_id AS scopeId, event_json AS eventJson, status, attempts,
              next_attempt_at AS nextAttemptAt, last_error AS lastError, created_at AS createdAt, delivered_at AS deliveredAt
       FROM event_outbox
       WHERE status = 'delivered' AND (delivered_at IS NOT NULL AND delivered_at > ?)
       ORDER BY delivered_at ASC LIMIT ?`, [cursor, limit]);
  }
  /** Fetch one outbox row by id — used for precise per-item DLQ replay. */
  async getOutboxRow(id: string): Promise<OutboxRow | undefined> {
    const rows = await this.db.all<OutboxRow>(
      `SELECT id, topic, scope_id AS scopeId, event_json AS eventJson, status, attempts,
              next_attempt_at AS nextAttemptAt, last_error AS lastError, created_at AS createdAt, delivered_at AS deliveredAt
       FROM event_outbox WHERE id = ?`, [id]);
    return rows[0];
  }
  async outboxCounts(): Promise<{ pending: number; delivered: number; dead: number }> {
    const rows = await this.db.all<{ status: string; n: number | string }>(`SELECT status, COUNT(*) AS n FROM event_outbox GROUP BY status`);
    const c = { pending: 0, delivered: 0, dead: 0 };
    for (const r of rows) {
      // Postgres returns bigint as a STRING (SQLite returns a number), so an
      // uncoerced count leaks `"30792"` into /health and into any arithmetic.
      const n = Number(r.n);
      if (r.status === 'pending') c.pending = n;
      else if (r.status === 'delivered') c.delivered = n;
      else if (r.status === 'dead') c.dead = n;
    }
    return c;
  }
  async clearOutbox(): Promise<void> {
    await this.db.run(`DELETE FROM event_outbox`);
  }
  /** Delete delivered outbox rows keeping the latest `keep` (by created_at) — bounds the
   *  delivered-history backlog that otherwise grows forever. Returns rows deleted. */
  async pruneOutboxDelivered(keep = 1000): Promise<number> {
    const res = await this.db.run(
      `DELETE FROM event_outbox
       WHERE status = 'delivered' AND id NOT IN (
         SELECT id FROM event_outbox WHERE status = 'delivered' ORDER BY created_at DESC LIMIT ?
       )`, [keep]);
    return res.changes;
  }

  // ---- M-S3 kafka-bridge: outbox leasing + receipts/incidents ----
  async leaseBridgeOutbox(opts: { owner: string; limit?: number; leaseTtlMs?: number; now?: string }): Promise<OutboxRow[]> {
    const limit = opts.limit ?? 20;
    const ttlMs = opts.leaseTtlMs ?? 30_000;
    const now = opts.now ?? new Date().toISOString();
    const until = new Date(Date.parse(now) + ttlMs).toISOString();
    // Candidates: pending rows not actively leased by ANOTHER worker. The owning
    // worker may re-lease its own rows immediately (the retry loop); others wait
    // for the lease TTL to expire.
    const rows = await this.db.all<OutboxRow>(
      `SELECT id, topic, scope_id AS scopeId, event_json AS eventJson, status, attempts,
              next_attempt_at AS nextAttemptAt, last_error AS lastError, created_at AS createdAt, delivered_at AS deliveredAt,
              COALESCE((SELECT bl.attempts FROM bridge_leases bl WHERE bl.outbox_id = event_outbox.id), 0) AS bridgeAttempts
       FROM event_outbox
       WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         AND id NOT IN (SELECT outbox_id FROM bridge_leases WHERE terminal = 0 AND lease_until > ? AND lease_owner != ?)
       ORDER BY created_at ASC LIMIT ?`, [now, now, opts.owner, limit]);
    const leased: OutboxRow[] = [];
    for (const row of rows) {
      // Upsert the lease; the guarded UPDATE means a concurrent worker that won
      // the row first keeps ownership (changes = 0 → we skip it).
      const res = await this.db.run(
        `INSERT INTO bridge_leases (outbox_id, lease_owner, lease_until, attempts, last_error, terminal, updated_at)
         VALUES (?, ?, ?, 0, NULL, 0, ?)
         ON CONFLICT (outbox_id) DO UPDATE SET
           lease_owner = excluded.lease_owner,
           lease_until = excluded.lease_until,
           updated_at = excluded.updated_at
         WHERE bridge_leases.terminal = 0 AND (bridge_leases.lease_owner = excluded.lease_owner OR bridge_leases.lease_until <= ?)`,
        [row.id, opts.owner, until, now, now]);
      if (res.changes > 0) leased.push(row);
    }
    return leased;
  }
  async releaseBridgeLease(outboxId: string, owner: string): Promise<void> {
    await this.db.run(`DELETE FROM bridge_leases WHERE outbox_id = ? AND lease_owner = ?`, [outboxId, owner]);
  }
  async renewBridgeLease(outboxId: string, owner: string, attempts: number, error: string | null, until: string): Promise<void> {
    await this.db.run(
      `UPDATE bridge_leases SET attempts = ?, last_error = ?, lease_until = ?, updated_at = ? WHERE outbox_id = ? AND lease_owner = ?`,
      [attempts, error ?? null, until, new Date().toISOString(), outboxId, owner]);
  }
  async markBridgeTerminal(outboxId: string, owner: string, error: string): Promise<void> {
    await this.db.run(
      `UPDATE bridge_leases SET terminal = 1, last_error = ?, updated_at = ? WHERE outbox_id = ? AND lease_owner = ?`,
      [error, new Date().toISOString(), outboxId, owner]);
  }
  async recordBridgeReceipt(row: {
    outboxId: string; topic: string; partitionKey: string; idempotencyKey: string;
    publishedAt: string; ackOffset?: number; state: 'delivered' | 'incident'; incident?: string;
  }): Promise<void> {
    await this.db.run(
      `INSERT INTO bridge_receipts (outbox_id, topic, partition_key, idempotency_key, published_at, ack_offset, state, incident)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (outbox_id) DO NOTHING`,
      [row.outboxId, row.topic, row.partitionKey, row.idempotencyKey, row.publishedAt, row.ackOffset ?? null, row.state, row.incident ?? null]);
  }
  async listBridgeReceipts(limit = 100): Promise<BridgeReceiptRow[]> {
    const rows = await this.db.all<BridgeReceiptRow & { ackOffset: number | string | null }>(
      `SELECT outbox_id AS outboxId, topic, partition_key AS partitionKey, idempotency_key AS idempotencyKey,
              published_at AS publishedAt, ack_offset AS ackOffset, state, incident
       FROM bridge_receipts ORDER BY published_at DESC LIMIT ?`, [limit]);
    // ack_offset is BIGINT and is part of a receipt's evidence, so it is coerced
    // rather than reported as a quoted string.
    return rows.map((r) => {
      const offset = bigintToNumber(r.ackOffset);
      return { ...r, ...(offset !== undefined ? { ackOffset: offset } : {}) };
    });
  }
  async bridgeCounts(): Promise<BridgeCounts> {
    const leases = await this.db.all<{ active: number; terminal: number }>(
      `SELECT SUM(CASE WHEN terminal = 0 THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN terminal = 1 THEN 1 ELSE 0 END) AS terminal FROM bridge_leases`);
    const receipts = await this.db.all<{ delivered: number; incident: number }>(
      `SELECT SUM(CASE WHEN state = 'delivered' THEN 1 ELSE 0 END) AS delivered,
              SUM(CASE WHEN state = 'incident' THEN 1 ELSE 0 END) AS incident FROM bridge_receipts`);
    const a = leases[0] ?? { active: 0, terminal: 0 };
    const r = receipts[0] ?? { delivered: 0, incident: 0 };
    return {
      leases: Number(a.active ?? 0) + Number(a.terminal ?? 0),
      activeLeases: Number(a.active ?? 0),
      receipts: Number(r.delivered ?? 0),
      incidents: Number(r.incident ?? 0),
    };
  }

  // ---- FHIR resources (Phase 2) ----
  async saveFhirResource(row: Omit<FhirResourceRow, 'ingestedAt'> & { ingestedAt?: string }): Promise<void> {
    const ingestedAt = row.ingestedAt ?? new Date().toISOString();
    await this.db.run(
      `INSERT INTO fhir_resources (id, realm_id, resource_type, kind, entity_id, resource_json, direction, ingested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         resource_json = excluded.resource_json, ingested_at = excluded.ingested_at`,
      [row.id, row.realmId, row.resourceType, row.kind, row.entityId ?? null, row.resourceJson, row.direction, ingestedAt],
    );
  }

  async listFhirResources(opts: { realmId?: string; resourceType?: string; direction?: 'in' | 'out'; limit?: number } = {}): Promise<FhirResourceRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.realmId) { where.push('realm_id = ?'); params.push(opts.realmId); }
    if (opts.resourceType) { where.push('resource_type = ?'); params.push(opts.resourceType); }
    if (opts.direction) { where.push('direction = ?'); params.push(opts.direction); }
    const limit = opts.limit ?? 200;
    return this.db.all<FhirResourceRow>(
      `SELECT id, realm_id AS realmId, resource_type AS resourceType, kind, entity_id AS entityId,
              resource_json AS resourceJson, direction, ingested_at AS ingestedAt
       FROM fhir_resources ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY ingested_at DESC LIMIT ${limit}`,
      params,
    );
  }

  async getFhirResource(id: string): Promise<FhirResourceRow | undefined> {
    const rows = await this.db.all<FhirResourceRow>(
      `SELECT id, realm_id AS realmId, resource_type AS resourceType, kind, entity_id AS entityId,
              resource_json AS resourceJson, direction, ingested_at AS ingestedAt
       FROM fhir_resources WHERE id = ?`, [id]);
    return rows[0];
  }

  async clearFhirResources(realmId?: string): Promise<void> {
    if (realmId) await this.db.run(`DELETE FROM fhir_resources WHERE realm_id = ?`, [realmId]);
    else await this.db.run(`DELETE FROM fhir_resources`);
  }

  // ---- Phase 4 — idempotency keys ----
  async saveIdempotencyKey(row: IdempotencyKeyRow): Promise<void> {
    await this.db.run(
      `INSERT INTO idempotency_keys (id, scope_id, method, path, request_hash, response_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET response_json = excluded.response_json`,
      [row.id, row.scopeId, row.method, row.path, row.requestHash, row.responseJson ?? null, row.createdAt],
    );
  }
  async getIdempotencyKey(scopeId: string, method: string, path: string, requestHash: string): Promise<IdempotencyKeyRow | undefined> {
    const rows = await this.db.all<IdempotencyKeyRow>(
      `SELECT id, scope_id AS scopeId, method, path, request_hash AS requestHash, response_json AS responseJson, created_at AS createdAt
       FROM idempotency_keys WHERE scope_id = ? AND method = ? AND path = ? AND request_hash = ?`,
      [scopeId, method, path, requestHash]);
    return rows[0];
  }
  async getIdempotencyKeyById(id: string): Promise<IdempotencyKeyRow | undefined> {
    const rows = await this.db.all<IdempotencyKeyRow>(
      `SELECT id, scope_id AS scopeId, method, path, request_hash AS requestHash, response_json AS responseJson, created_at AS createdAt
       FROM idempotency_keys WHERE id = ?`, [id]);
    return rows[0];
  }

  // ---- Phase 4 — audit events ----
  async appendAuditEvent(row: AuditEventRow): Promise<void> {
    await this.db.run(
      `INSERT INTO audit_events (id, scope_id, actor_ref, action, resource_type, resource_id, classification, occurred_at, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.scopeId, row.actorRef, row.action, row.resourceType, row.resourceId ?? null, row.classification, row.occurredAt, row.payloadJson ?? null],
    );
  }
  async listAuditEvents(opts: { scopeId?: string; action?: string; limit?: number } = {}): Promise<AuditEventRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.scopeId) { where.push('scope_id = ?'); params.push(opts.scopeId); }
    if (opts.action) { where.push('action = ?'); params.push(opts.action); }
    const limit = opts.limit ?? 100;
    return this.db.all<AuditEventRow>(
      `SELECT id, scope_id AS scopeId, actor_ref AS actorRef, action, resource_type AS resourceType,
              resource_id AS resourceId, classification, occurred_at AS occurredAt, payload_json AS payloadJson
       FROM audit_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY occurred_at DESC LIMIT ${limit}`, params);
  }

  // ---- Phase 4 — webhooks ----
  async saveWebhookEndpoint(row: Omit<WebhookEndpointRow, 'createdAt' | 'updatedAt'> & { createdAt?: string; updatedAt?: string }): Promise<void> {
    const now = new Date().toISOString();
    const createdAt = row.createdAt ?? now;
    const updatedAt = row.updatedAt ?? now;
    await this.db.run(
      `INSERT INTO webhook_endpoints (id, realm_id, url, secret, event_types_json, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET realm_id = excluded.realm_id, url = excluded.url, secret = excluded.secret,
         event_types_json = excluded.event_types_json, active = excluded.active, updated_at = excluded.updated_at`,
      [row.id, row.realmId ?? null, row.url, row.secret, row.eventTypesJson, row.active, createdAt, updatedAt],
    );
  }
  async listWebhookEndpoints(activeOnly = false): Promise<WebhookEndpointRow[]> {
    return this.db.all<WebhookEndpointRow>(
      `SELECT id, realm_id AS realmId, url, secret, event_types_json AS eventTypesJson, active,
              created_at AS createdAt, updated_at AS updatedAt
       FROM webhook_endpoints ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY created_at DESC`);
  }
  async getWebhookEndpoint(id: string): Promise<WebhookEndpointRow | undefined> {
    const rows = await this.db.all<WebhookEndpointRow>(
      `SELECT id, realm_id AS realmId, url, secret, event_types_json AS eventTypesJson, active,
              created_at AS createdAt, updated_at AS updatedAt
       FROM webhook_endpoints WHERE id = ?`, [id]);
    return rows[0];
  }
  async deleteWebhookEndpoint(id: string): Promise<boolean> {
    const res = await this.db.run(`DELETE FROM webhook_endpoints WHERE id = ?`, [id]);
    return res.changes > 0;
  }
  async enqueueWebhookDelivery(row: { id: string; webhookId: string; eventId: string; eventJson: string; createdAt?: string }): Promise<void> {
    const createdAt = row.createdAt ?? new Date().toISOString();
    await this.db.run(
      `INSERT INTO webhook_deliveries (id, webhook_id, event_id, event_json, status, attempts, next_attempt_at, last_error, signature, created_at, delivered_at)
       VALUES (?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, ?, NULL)
       ON CONFLICT (id) DO NOTHING`,
      [row.id, row.webhookId, row.eventId, row.eventJson, createdAt]);
  }
  async pendingWebhookDeliveries(limit = 50, now = new Date().toISOString()): Promise<WebhookDeliveryRow[]> {
    return this.db.all<WebhookDeliveryRow>(
      `SELECT id, webhook_id AS webhookId, event_id AS eventId, event_json AS eventJson, status, attempts,
              next_attempt_at AS nextAttemptAt, last_error AS lastError, signature, created_at AS createdAt, delivered_at AS deliveredAt
       FROM webhook_deliveries
       WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY created_at ASC LIMIT ?`, [now, limit]);
  }
  async markWebhookDelivered(id: string, signature: string, deliveredAt = new Date().toISOString()): Promise<boolean> {
    const res = await this.db.run(
      `UPDATE webhook_deliveries SET status = 'delivered', delivered_at = ?, signature = ?, attempts = attempts + 1 WHERE id = ? AND status = 'pending'`,
      [deliveredAt, signature, id]);
    return res.changes > 0;
  }
  async markWebhookFailed(id: string, error: string, maxAttempts: number, nextAttemptAt: string): Promise<'pending' | 'dead'> {
    const rows = await this.db.all<{ attempts: number }>(`SELECT attempts FROM webhook_deliveries WHERE id = ?`, [id]);
    const attempts = (rows[0]?.attempts ?? 0) + 1;
    const status: 'pending' | 'dead' = attempts >= maxAttempts ? 'dead' : 'pending';
    await this.db.run(
      `UPDATE webhook_deliveries SET attempts = ?, last_error = ?, status = ?, next_attempt_at = ? WHERE id = ?`,
      [attempts, error, status, status === 'dead' ? null : nextAttemptAt, id]);
    return status;
  }
  async webhookDeliveryCounts(): Promise<{ pending: number; delivered: number; dead: number }> {
    const rows = await this.db.all<{ status: string; n: number | string }>(`SELECT status, COUNT(*) AS n FROM webhook_deliveries GROUP BY status`);
    const c = { pending: 0, delivered: 0, dead: 0 };
    for (const r of rows) {
      // See outboxCounts: bigint arrives as a string on Postgres.
      const n = Number(r.n);
      if (r.status === 'pending') c.pending = n;
      else if (r.status === 'delivered') c.delivered = n;
      else if (r.status === 'dead') c.dead = n;
    }
    return c;
  }

  // ---- Phase 4 — alert rules + events ----
  async saveAlertRule(row: AlertRuleRow): Promise<void> {
    await this.db.run(
      `INSERT INTO alert_rules (id, metric, op, threshold, severity, enabled, label) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET metric = excluded.metric, op = excluded.op, threshold = excluded.threshold,
         severity = excluded.severity, enabled = excluded.enabled, label = excluded.label`,
      [row.id, row.metric, row.op, row.threshold, row.severity, row.enabled, row.label ?? null]);
  }
  async listAlertRules(enabledOnly = false): Promise<AlertRuleRow[]> {
    return this.db.all<AlertRuleRow>(
      `SELECT id, metric, op, threshold, severity, enabled, label FROM alert_rules ${enabledOnly ? 'WHERE enabled = 1' : ''} ORDER BY metric`);
  }
  async deleteAlertRule(id: string): Promise<boolean> {
    const res = await this.db.run(`DELETE FROM alert_rules WHERE id = ?`, [id]);
    return res.changes > 0;
  }
  async saveAlertEvent(row: AlertEventRow): Promise<void> {
    await this.db.run(
      `INSERT INTO alert_events (id, rule_id, metric, value, severity, message, status, fired_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.ruleId, row.metric, row.value, row.severity, row.message ?? null, row.status, row.firedAt, row.resolvedAt ?? null]);
  }
  async listAlertEvents(limit = 100): Promise<AlertEventRow[]> {
    return this.db.all<AlertEventRow>(
      `SELECT id, rule_id AS ruleId, metric, value, severity, message, status, fired_at AS firedAt, resolved_at AS resolvedAt
       FROM alert_events ORDER BY fired_at DESC LIMIT ${limit}`);
  }

  // ---- Phase 4 — retention policies + purge ----
  async saveRetentionPolicy(row: RetentionPolicyRow): Promise<void> {
    await this.db.run(
      `INSERT INTO retention_policies (id, entity, scope_id, max_age_ms, enabled) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET entity = excluded.entity, scope_id = excluded.scope_id,
         max_age_ms = excluded.max_age_ms, enabled = excluded.enabled`,
      [row.id, row.entity, row.scopeId ?? null, row.maxAgeMs, row.enabled]);
  }
  async listRetentionPolicies(): Promise<RetentionPolicyRow[]> {
    const rows = await this.db.all<RetentionPolicyRow & { maxAgeMs: number | string }>(
      `SELECT id, entity, scope_id AS scopeId, max_age_ms AS maxAgeMs, enabled FROM retention_policies ORDER BY entity`);
    // max_age_ms is BIGINT: 30 days is 2.592e9, past INT4, so it is a string on
    // Postgres and a number on SQLite — and a purge window computed from a string
    // is a silent zero.
    return rows.map((r) => ({ ...r, maxAgeMs: bigintToNumber(r.maxAgeMs) ?? 0 }));
  }
  async deleteRetentionPolicy(id: string): Promise<boolean> {
    const res = await this.db.run(`DELETE FROM retention_policies WHERE id = ?`, [id]);
    return res.changes > 0;
  }
  /** Purge rows older than `before` for an entity → returns deleted count. */
  async purgeBefore(entity: string, before: string): Promise<number> {
    const map: Record<string, { table: string; dateCol: string }> = {
      'event_outbox': { table: 'event_outbox', dateCol: 'created_at' },
      'audit_events': { table: 'audit_events', dateCol: 'occurred_at' },
      'webhook_deliveries': { table: 'webhook_deliveries', dateCol: 'created_at' },
      'fhir_resources': { table: 'fhir_resources', dateCol: 'ingested_at' },
      'billing_usage': { table: 'billing_usage', dateCol: 'created_at' },
      'alert_events': { table: 'alert_events', dateCol: 'fired_at' },
    };
    const entry = map[entity];
    if (!entry) return 0;
    const res = await this.db.run(`DELETE FROM ${entry.table} WHERE ${entry.dateCol} < ?`, [before]);
    return res.changes;
  }

  /** Best-effort file compaction (SQLite only — no-op on Postgres). Checkpoints +
   *  truncates the WAL first, then VACUUMs so freed pages actually return to disk. */
  async vacuum(): Promise<boolean> {
    if (this.db.dialect !== 'sqlite') return false;
    try {
      await this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      await this.db.exec('VACUUM');
      return true;
    } catch { return false; }
  }
}

