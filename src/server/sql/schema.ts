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

// Portable schema for the durable product-state store (realms, billing, counterfactuals,
// nudge ledger). Every statement is dialect-neutral: TEXT primary keys (no serial/autoincrement
// — all ids are UUIDs/strings), JSON columns as TEXT, timestamps as TEXT (ISO), REAL for
// numbers. Runs identically on SQLite and Postgres.

export const MIGRATIONS: readonly string[] = [  `CREATE TABLE IF NOT EXISTS realm_snapshots (
     realm_id TEXT PRIMARY KEY,
     mode TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     snapshot_json TEXT NOT NULL
   )`,

  // Realm creation specs — persisted so realms can be restored on boot (the
  // in-memory RealmRegistry resets on restart, but the spec lets us rebuild).
  `CREATE TABLE IF NOT EXISTS realm_specs (
     realm_id TEXT PRIMARY KEY,
     mode TEXT NOT NULL,
     trajectory_engine TEXT,
     spec_json TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,

  // Console sessions — the login for BOTH consoles (/admin/ui and /exec) is the
  // same `hh_session` token. Persisted so a process restart does not silently
  // log every console out (the in-memory SessionManager is the read path; this
  // is the write-through + restore source). The raw token is never stored, only
  // its SHA-256 hash.
  `CREATE TABLE IF NOT EXISTS auth_sessions (
     token_hash TEXT PRIMARY KEY,
     username TEXT NOT NULL,
     created_at TEXT NOT NULL,
     -- Epoch MILLISECONDS (~1.8e12) — must be 64-bit. As INTEGER this overflowed
     -- on Postgres and made every login fail with 22003, while SQLite (untyped)
     -- accepted it happily. See WIDEN_TO_BIGINT below.
     expires_at BIGINT NOT NULL
   )`,

  // Console users — durable so an operator-created user, a password reset or a
  // role change is not silently discarded on the next restart while the seeded
  // defaults reappear. purpose_of_use/scope_ids are JSON arrays stored as TEXT.
  `CREATE TABLE IF NOT EXISTS local_users (
     username TEXT PRIMARY KEY,
     display_name TEXT NOT NULL,
     password_hash TEXT NOT NULL,
     role TEXT NOT NULL,
     clearance TEXT NOT NULL,
     purpose_of_use TEXT NOT NULL,
     org_id TEXT NOT NULL,
     scope_ids TEXT NOT NULL,
     created_at TEXT NOT NULL,
     last_login_at TEXT,
     updated_at TEXT NOT NULL
   )`,

  // Simulator fleet — the active demo scenario + its realm ids, so a running
  // fleet (and its controls) survive process restarts / reloads. realmIds are
  // restored via realm_specs/realm_snapshots; this row re-wires the controller.
  `CREATE TABLE IF NOT EXISTS simulator_fleet (
     id TEXT PRIMARY KEY,
     scenario_id TEXT NOT NULL,
     status TEXT NOT NULL,
     started_at TEXT,
     tick_count INTEGER NOT NULL DEFAULT 0,
     event_count INTEGER NOT NULL DEFAULT 0,
     fleet_json TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS billing_usage (
     id TEXT PRIMARY KEY,
     realm_id TEXT NOT NULL,
     period TEXT NOT NULL,
     plan TEXT NOT NULL,
     report_json TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS nudge_ledger (
     id TEXT PRIMARY KEY,
     realm_id TEXT NOT NULL,
     patient_id TEXT NOT NULL,
     channel TEXT NOT NULL,
     nudge_kind TEXT NOT NULL,
     expected_effect_json TEXT NOT NULL,
     rehearsal_id TEXT,
     variant_id TEXT,
     expires_at TEXT,
     status TEXT NOT NULL,
     sent_at TEXT NOT NULL,
     observed_at TEXT,
     observed_outcome_json TEXT
   )`,

  `CREATE TABLE IF NOT EXISTS counterfactual_runs (
     id TEXT PRIMARY KEY,
     realm_id TEXT,
     label TEXT NOT NULL,
     input_json TEXT NOT NULL,
     report_json TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,

  // Master data (Settings admin): facilities → units → patients
  `CREATE TABLE IF NOT EXISTS facilities (
     id TEXT PRIMARY KEY,
     realm_id TEXT NOT NULL,
     name TEXT NOT NULL,
     kind TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS units (
     id TEXT PRIMARY KEY,
     facility_id TEXT NOT NULL,
     realm_id TEXT NOT NULL,
     code TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS patients (
     id TEXT PRIMARY KEY,
     facility_id TEXT NOT NULL,
     unit_id TEXT NOT NULL,
     realm_id TEXT NOT NULL,
     name TEXT,
     age INTEGER,
     sex TEXT,
     trajectory TEXT,
     labs_json TEXT,
     vitals_json TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,

  // Master data catalogs (Settings admin): assessments, lifecycle stages, nudge templates
  `CREATE TABLE IF NOT EXISTS assessments (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     loinc TEXT,
     domain TEXT NOT NULL,
     item_count INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS lifecycle_stages (
     id TEXT PRIMARY KEY,
     order_num INTEGER NOT NULL DEFAULT 0,
     label TEXT NOT NULL,
     kind TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS nudge_templates (
     id TEXT PRIMARY KEY,
     nudge_kind TEXT NOT NULL,
     channel TEXT NOT NULL,
     description TEXT,
     expected_effect_json TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,

  // Event outbox (Phase 0 — transactional-outbox publish path to the EventBroker)
  `CREATE TABLE IF NOT EXISTS event_outbox (
     id TEXT PRIMARY KEY,
     topic TEXT NOT NULL,
     scope_id TEXT NOT NULL,
     event_json TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending',
     attempts INTEGER NOT NULL DEFAULT 0,
     next_attempt_at TEXT,
     last_error TEXT,
     created_at TEXT NOT NULL,
     delivered_at TEXT
   )`,

  // FHIR resources (Phase 2 — durable mirror of hydrated/serialized R4 resources)
  `CREATE TABLE IF NOT EXISTS fhir_resources (
     id TEXT PRIMARY KEY,
     realm_id TEXT NOT NULL,
     resource_type TEXT NOT NULL,
     kind TEXT NOT NULL,
     entity_id TEXT,
     resource_json TEXT NOT NULL,
     direction TEXT NOT NULL DEFAULT 'in',
     ingested_at TEXT NOT NULL
   )`,
  // Phase 4 — idempotency keys (Idempotency-Key on public writes)
  `CREATE TABLE IF NOT EXISTS idempotency_keys (
     id TEXT PRIMARY KEY,
     scope_id TEXT NOT NULL,
     method TEXT NOT NULL,
     path TEXT NOT NULL,
     request_hash TEXT NOT NULL,
     response_json TEXT,
     created_at TEXT NOT NULL,
     UNIQUE (scope_id, method, path, request_hash)
   )`,

  // Phase 4 — portable audit events (FHIR AuditEvent projection of session/ledger events)
  `CREATE TABLE IF NOT EXISTS audit_events (
     id TEXT PRIMARY KEY,
     scope_id TEXT NOT NULL,
     actor_ref TEXT NOT NULL,
     action TEXT NOT NULL,
     resource_type TEXT NOT NULL,
     resource_id TEXT,
     classification TEXT NOT NULL DEFAULT 'internal',
     occurred_at TEXT NOT NULL,
     payload_json TEXT
   )`,

  // Phase 4 — webhook endpoints + durable delivery outbox
  `CREATE TABLE IF NOT EXISTS webhook_endpoints (
     id TEXT PRIMARY KEY,
     realm_id TEXT,
     url TEXT NOT NULL,
     secret TEXT NOT NULL,
     event_types_json TEXT NOT NULL,
     active INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS webhook_deliveries (
     id TEXT PRIMARY KEY,
     webhook_id TEXT NOT NULL,
     event_id TEXT NOT NULL,
     event_json TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending',
     attempts INTEGER NOT NULL DEFAULT 0,
     next_attempt_at TEXT,
     last_error TEXT,
     signature TEXT,
     created_at TEXT NOT NULL,
     delivered_at TEXT
   )`,

  // Phase 4 — alert rules + fired alert events
  `CREATE TABLE IF NOT EXISTS alert_rules (
     id TEXT PRIMARY KEY,
     metric TEXT NOT NULL,
     op TEXT NOT NULL,
     threshold REAL NOT NULL,
     severity TEXT NOT NULL DEFAULT 'warning',
     enabled INTEGER NOT NULL DEFAULT 1,
     label TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS alert_events (
     id TEXT PRIMARY KEY,
     rule_id TEXT NOT NULL,
     metric TEXT NOT NULL,
     value REAL NOT NULL,
     severity TEXT NOT NULL,
     message TEXT,
     status TEXT NOT NULL DEFAULT 'firing',
     fired_at TEXT NOT NULL,
     resolved_at TEXT
   )`,

  // Phase 4 — retention policies + purge cursor
  `CREATE TABLE IF NOT EXISTS retention_policies (
     id TEXT PRIMARY KEY,
     entity TEXT NOT NULL,
     scope_id TEXT,
     -- Retention age in milliseconds: a 30-day policy is 2.592e9, which exceeds
     -- INT4's 2.147e9 ceiling. 64-bit keeps every horizon expressible.
     max_age_ms BIGINT NOT NULL,
     enabled INTEGER NOT NULL DEFAULT 1
   )`,

  // M-S3 — kafka-bridge durable connector: outbox leasing + receipts/incidents.
  // The hosted worker terminates Kafka at authenticated HTTPS; the bridge is the
  // deployable connection to the org's brokers. It leases outbox rows (only one
  // worker owns a row), validates integrity/tenant, publishes with an idempotent
  // producer (key = event id) and records a receipt or a terminal incident.
  `CREATE TABLE IF NOT EXISTS bridge_leases (
     outbox_id TEXT PRIMARY KEY,
     lease_owner TEXT NOT NULL,
     lease_until TEXT NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0,
     last_error TEXT,
     terminal INTEGER NOT NULL DEFAULT 0,
     updated_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS bridge_receipts (
     outbox_id TEXT PRIMARY KEY,
     topic TEXT NOT NULL,
     partition_key TEXT NOT NULL,
     idempotency_key TEXT NOT NULL,
     published_at TEXT NOT NULL,
     ack_offset INTEGER,     state TEXT NOT NULL,
     incident TEXT
   )`,

  `CREATE INDEX IF NOT EXISTS idx_idem_scope ON idempotency_keys (scope_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_scope ON audit_events (scope_id, occurred_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_webhook_active ON webhook_endpoints (active)`,
  `CREATE INDEX IF NOT EXISTS idx_webhook_pending ON webhook_deliveries (status, next_attempt_at)`,
  `CREATE INDEX IF NOT EXISTS idx_alert_events_rule ON alert_events (rule_id, fired_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_retention_entity ON retention_policies (entity)`,
  `CREATE INDEX IF NOT EXISTS idx_fhir_realm_type ON fhir_resources (realm_id, resource_type)`,
  `CREATE INDEX IF NOT EXISTS idx_fhir_kind ON fhir_resources (kind, entity_id)`,
  `CREATE INDEX IF NOT EXISTS idx_fhir_direction ON fhir_resources (direction, ingested_at)`,

  `CREATE INDEX IF NOT EXISTS idx_nudge_realm ON nudge_ledger (realm_id, sent_at)`,
  `CREATE INDEX IF NOT EXISTS idx_billing_realm ON billing_usage (realm_id, period)`,
  `CREATE INDEX IF NOT EXISTS idx_cf_created ON counterfactual_runs (created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_facilities_realm ON facilities (realm_id)`,
  `CREATE INDEX IF NOT EXISTS idx_units_facility ON units (facility_id)`,
  `CREATE INDEX IF NOT EXISTS idx_patients_unit ON patients (unit_id)`,
  `CREATE INDEX IF NOT EXISTS idx_assessments_domain ON assessments (domain)`,
  `CREATE INDEX IF NOT EXISTS idx_lifecycle_order ON lifecycle_stages (order_num)`,
  `CREATE INDEX IF NOT EXISTS idx_nudge_templates_kind ON nudge_templates (nudge_kind)`,
  `CREATE INDEX IF NOT EXISTS idx_event_outbox_pending ON event_outbox (status, next_attempt_at)`,
  `CREATE INDEX IF NOT EXISTS idx_bridge_lease_active ON bridge_leases (terminal, lease_until)`,
  `CREATE INDEX IF NOT EXISTS idx_bridge_receipt_state ON bridge_receipts (state, published_at)`,

  // M-S6 — durable swarm workspace: one JSON document store backing every executive
  // asset (red-team scenarios/runs, submission packages, config releases, evidence
  // reviews, facility simulations, knowledge notes, admin tenant/kafka/policy).
  `CREATE TABLE IF NOT EXISTS swarm_workspace (
     kind TEXT NOT NULL,
     id TEXT NOT NULL,
     entity_json TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (kind, id)
   )`,

  `CREATE INDEX IF NOT EXISTS idx_swarm_workspace_kind ON swarm_workspace (kind, updated_at DESC)`,
];

/**
 * Widen millisecond-valued columns on databases created before they were declared
 * BIGINT.
 *
 * `CREATE TABLE IF NOT EXISTS` cannot change an existing column, so a database
 * that predates this fix would keep INT4 and keep failing with 22003 — the SQLite
 * default hid the problem for the entire life of the project, because SQLite
 * ignores declared types. Widening INT4 → BIGINT is lossless and idempotent in
 * Postgres, so it is safe to run on every boot.
 *
 * Postgres-only: SQLite does not support ALTER COLUMN and does not need it.
 */
export const WIDEN_TO_BIGINT: readonly string[] = [
  `ALTER TABLE retention_policies ALTER COLUMN max_age_ms TYPE BIGINT`,
  `ALTER TABLE auth_sessions ALTER COLUMN expires_at TYPE BIGINT`,
  // Kafka offsets are int64; a topic that ever passes 2.1e9 would otherwise
  // silently break lease bookkeeping.
  `ALTER TABLE bridge_leases ALTER COLUMN ack_offset TYPE BIGINT`,
];
