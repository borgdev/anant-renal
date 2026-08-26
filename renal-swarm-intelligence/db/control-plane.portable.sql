-- Renal Swarm Intelligence control-plane schema.
-- This file intentionally uses the SQL subset shared by SQLite and PostgreSQL:
-- text business keys, explicit ISO-8601 timestamps, integer basis points/flags,
-- JSON serialized as validated text, and no engine-specific auto-increment.

CREATE TABLE IF NOT EXISTS tenant (
  tenant_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS identity_subject (
  subject_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  external_subject TEXT NOT NULL,
  email TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, external_subject),
  FOREIGN KEY (tenant_id) REFERENCES tenant (tenant_id)
);

CREATE TABLE IF NOT EXISTS role_grant (
  grant_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  scope_level TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  configuration_version TEXT NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenant (tenant_id),
  FOREIGN KEY (subject_id) REFERENCES identity_subject (subject_id)
);

CREATE TABLE IF NOT EXISTS configuration_release (
  release_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'validated', 'approved', 'active', 'rolled-back')),
  content_hash TEXT NOT NULL,
  created_by TEXT NOT NULL,
  approved_by TEXT,
  effective_from TEXT,
  rollback_release_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, version),
  FOREIGN KEY (tenant_id) REFERENCES tenant (tenant_id)
);

CREATE TABLE IF NOT EXISTS authority_version (
  authority_version_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  authority TEXT NOT NULL,
  publication_status TEXT NOT NULL,
  source_url TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  retrieved_at TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  configuration_version TEXT NOT NULL,
  UNIQUE (tenant_id, source_id, effective_from),
  FOREIGN KEY (tenant_id) REFERENCES tenant (tenant_id)
);

CREATE TABLE IF NOT EXISTS agent_definition (
  agent_definition_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  version TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('ai-agent', 'deterministic', 'optimization', 'hybrid')),
  mode TEXT NOT NULL,
  owner_roles_json TEXT NOT NULL,
  input_contracts_json TEXT NOT NULL,
  output_contracts_json TEXT NOT NULL,
  allowed_actions_json TEXT NOT NULL,
  data_permissions_json TEXT NOT NULL,
  tool_permissions_json TEXT NOT NULL,
  approval_class TEXT NOT NULL CHECK (approval_class IN ('A', 'B', 'C', 'D')),
  evaluation_gate_basis_points INTEGER NOT NULL,
  timeout_ms INTEGER NOT NULL,
  maximum_cost_microunits INTEGER NOT NULL,
  fallback_policy TEXT NOT NULL,
  kill_switch_enabled INTEGER NOT NULL CHECK (kill_switch_enabled IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('candidate', 'approved', 'canary', 'active', 'blocked', 'retired')),
  configuration_version TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  recorded_at TEXT NOT NULL,
  UNIQUE (tenant_id, agent_id, version),
  FOREIGN KEY (tenant_id) REFERENCES tenant (tenant_id)
);

CREATE TABLE IF NOT EXISTS canonical_event (
  event_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  valid_time TEXT NOT NULL,
  recorded_time TEXT NOT NULL,
  correlation_id TEXT,
  causation_id TEXT,
  source_system TEXT NOT NULL,
  source_resource TEXT NOT NULL,
  partition_key TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  classification_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted', 'quarantined', 'replayed')),
  FOREIGN KEY (tenant_id) REFERENCES tenant (tenant_id)
);

CREATE TABLE IF NOT EXISTS evidence_object (
  evidence_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  evidence_type TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  exact_text TEXT,
  structured_json TEXT NOT NULL,
  confidence_basis_points INTEGER NOT NULL,
  purpose TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  recorded_at TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenant (tenant_id),
  FOREIGN KEY (source_event_id) REFERENCES canonical_event (event_id)
);

CREATE TABLE IF NOT EXISTS outcome_episode (
  episode_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  outcome_type TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  subject_id TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('observed', 'understood', 'proposed', 'awaiting-approval', 'coordinating', 'verifying', 'resolved', 'blocked')),
  urgency TEXT NOT NULL CHECK (urgency IN ('critical', 'high', 'watch')),
  confidence_basis_points INTEGER NOT NULL,
  owner_role TEXT NOT NULL,
  action_class TEXT NOT NULL CHECK (action_class IN ('A', 'B', 'C', 'D')),
  current_recommendation TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  resolved_at TEXT,
  state_version INTEGER NOT NULL,
  configuration_version TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenant (tenant_id)
);

CREATE TABLE IF NOT EXISTS agent_run (
  run_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  agent_definition_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  episode_id TEXT,
  trace_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('eligible', 'running', 'completed', 'abstained', 'failed', 'blocked')),
  input_hash TEXT NOT NULL,
  output_hash TEXT,
  confidence_basis_points INTEGER,
  latency_ms INTEGER NOT NULL,
  cost_microunits INTEGER NOT NULL,
  abstention_reason TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (tenant_id) REFERENCES tenant (tenant_id),
  FOREIGN KEY (agent_definition_id) REFERENCES agent_definition (agent_definition_id),
  FOREIGN KEY (event_id) REFERENCES canonical_event (event_id),
  FOREIGN KEY (episode_id) REFERENCES outcome_episode (episode_id)
);

CREATE TABLE IF NOT EXISTS agent_message (
  message_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  run_id TEXT,
  episode_id TEXT,
  message_type TEXT NOT NULL CHECK (message_type IN ('signal', 'execution', 'proposal', 'insight', 'policy')),
  sender_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted', 'completed', 'proposed', 'review', 'blocked')),
  trace_id TEXT,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenant (tenant_id),
  FOREIGN KEY (run_id) REFERENCES agent_run (run_id),
  FOREIGN KEY (episode_id) REFERENCES outcome_episode (episode_id)
);

CREATE TABLE IF NOT EXISTS work_item (
  work_item_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  episode_id TEXT,
  scope_id TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL,
  owner_role TEXT NOT NULL,
  due_at TEXT,
  action_class TEXT NOT NULL CHECK (action_class IN ('A', 'B', 'C', 'D')),
  current_stage TEXT NOT NULL,
  state_version INTEGER NOT NULL,
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  recorded_at TEXT NOT NULL,
  configuration_version TEXT NOT NULL,
  UNIQUE (tenant_id, entity_type, entity_id, state_version),
  FOREIGN KEY (tenant_id) REFERENCES tenant (tenant_id),
  FOREIGN KEY (episode_id) REFERENCES outcome_episode (episode_id)
);

CREATE TABLE IF NOT EXISTS work_item_evidence (
  work_item_evidence_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  use_policy TEXT NOT NULL,
  attached_at TEXT NOT NULL,
  UNIQUE (work_item_id, evidence_id),
  FOREIGN KEY (tenant_id) REFERENCES tenant (tenant_id),
  FOREIGN KEY (work_item_id) REFERENCES work_item (work_item_id),
  FOREIGN KEY (evidence_id) REFERENCES evidence_object (evidence_id)
);

CREATE TABLE IF NOT EXISTS work_item_activity (
  activity_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  activity_type TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('done', 'current', 'pending', 'blocked')),
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  trace_id TEXT,
  FOREIGN KEY (tenant_id) REFERENCES tenant (tenant_id),
  FOREIGN KEY (work_item_id) REFERENCES work_item (work_item_id)
);

CREATE TABLE IF NOT EXISTS work_item_action (
  action_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  action_class TEXT NOT NULL CHECK (action_class IN ('A', 'B', 'C', 'D')),
  required_roles_json TEXT NOT NULL,
  minimum_approvals INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  expected_destination TEXT NOT NULL,
  expected_acknowledgement TEXT NOT NULL,
  timeout_policy_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('available', 'requested', 'approved', 'rejected', 'emitted', 'acknowledged', 'blocked')),
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id) REFERENCES tenant (tenant_id),
  FOREIGN KEY (work_item_id) REFERENCES work_item (work_item_id)
);

CREATE TABLE IF NOT EXISTS action_decision (
  decision_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  actor_subject_id TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  actor_scope_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('requested', 'approved', 'rejected', 'blocked')),
  policy_version TEXT NOT NULL,
  reasons_json TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenant (tenant_id),
  FOREIGN KEY (action_id) REFERENCES work_item_action (action_id),
  FOREIGN KEY (actor_subject_id) REFERENCES identity_subject (subject_id)
);

CREATE TABLE IF NOT EXISTS outbox_message (
  outbox_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  message_key TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'leased', 'published', 'failed')),
  attempts INTEGER NOT NULL,
  next_attempt_at TEXT,
  locked_by TEXT,
  locked_until TEXT,
  published_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenant (tenant_id),
  FOREIGN KEY (action_id) REFERENCES work_item_action (action_id)
);

CREATE TABLE IF NOT EXISTS acknowledgement (
  acknowledgement_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  outbox_id TEXT NOT NULL,
  acknowledgement_type TEXT NOT NULL,
  source_system TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  received_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenant (tenant_id),
  FOREIGN KEY (outbox_id) REFERENCES outbox_message (outbox_id)
);

CREATE TABLE IF NOT EXISTS audit_record (
  audit_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('human-action', 'policy-decision', 'data-quality', 'security', 'agent-execution')),
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  configuration_version TEXT NOT NULL,
  trace_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenant (tenant_id)
);

CREATE TABLE IF NOT EXISTS tenant_environment (
  environment_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  environment_name TEXT NOT NULL,
  deployment_mode TEXT NOT NULL CHECK (deployment_mode IN ('reference', 'non-production', 'production')),
  status TEXT NOT NULL CHECK (status IN ('onboarding', 'ready', 'active', 'blocked')),
  time_zone TEXT NOT NULL,
  data_region TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, environment_name),
  FOREIGN KEY (tenant_id) REFERENCES tenant (tenant_id)
);

CREATE TABLE IF NOT EXISTS integration_connection (
  connection_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('kafka-bridge', 'fhir', 'cms', 'identity')),
  display_name TEXT NOT NULL,
  endpoint_url TEXT NOT NULL,
  cluster_alias TEXT NOT NULL,
  security_protocol TEXT NOT NULL,
  secret_ref TEXT NOT NULL,
  consumer_group TEXT NOT NULL,
  topic_mappings_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'contract-verified', 'verified', 'active', 'error')),
  last_tested_at TEXT,
  last_test_result_json TEXT,
  configuration_version TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, environment_id, kind),
  FOREIGN KEY (tenant_id) REFERENCES tenant (tenant_id),
  FOREIGN KEY (environment_id) REFERENCES tenant_environment (environment_id)
);

CREATE TABLE IF NOT EXISTS environment_configuration_release (
  release_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'validated', 'active', 'retired', 'blocked')),
  base_version TEXT,
  rollback_version TEXT,
  change_summary TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_by TEXT NOT NULL,
  validated_by TEXT,
  activated_by TEXT,
  created_at TEXT NOT NULL,
  validated_at TEXT,
  activated_at TEXT,
  UNIQUE (tenant_id, environment_id, version),
  FOREIGN KEY (tenant_id) REFERENCES tenant (tenant_id),
  FOREIGN KEY (environment_id) REFERENCES tenant_environment (environment_id)
);

CREATE TABLE IF NOT EXISTS configuration_object (
  object_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  object_type TEXT NOT NULL CHECK (object_type IN ('agent', 'policy', 'adapter', 'measure-pack', 'workflow', 'role-map')),
  object_key TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (release_id, object_type, object_key),
  FOREIGN KEY (tenant_id) REFERENCES tenant (tenant_id),
  FOREIGN KEY (environment_id) REFERENCES tenant_environment (environment_id),
  FOREIGN KEY (release_id) REFERENCES environment_configuration_release (release_id)
);

CREATE TABLE IF NOT EXISTS configuration_validation (
  validation_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  suite TEXT NOT NULL CHECK (suite IN ('schema', 'green', 'red', 'integration', 'promotion')),
  status TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'blocked')),
  score_basis_points INTEGER NOT NULL,
  checks_json TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  run_by TEXT NOT NULL,
  run_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenant (tenant_id),
  FOREIGN KEY (environment_id) REFERENCES tenant_environment (environment_id),
  FOREIGN KEY (release_id) REFERENCES environment_configuration_release (release_id)
);

CREATE TABLE IF NOT EXISTS onboarding_state (
  onboarding_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  current_step TEXT NOT NULL,
  steps_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('not-started', 'in-progress', 'ready', 'active', 'blocked')),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, environment_id),
  FOREIGN KEY (tenant_id) REFERENCES tenant (tenant_id),
  FOREIGN KEY (environment_id) REFERENCES tenant_environment (environment_id)
);

CREATE INDEX IF NOT EXISTS role_grant_subject_scope_idx ON role_grant (tenant_id, subject_id, scope_id);
CREATE INDEX IF NOT EXISTS canonical_event_subject_time_idx ON canonical_event (tenant_id, subject_type, subject_id, recorded_time);
CREATE INDEX IF NOT EXISTS canonical_event_trace_idx ON canonical_event (tenant_id, trace_id);
CREATE INDEX IF NOT EXISTS evidence_subject_time_idx ON evidence_object (tenant_id, subject_id, valid_from);
CREATE INDEX IF NOT EXISTS outcome_episode_scope_status_idx ON outcome_episode (tenant_id, scope_id, status);
CREATE INDEX IF NOT EXISTS agent_run_trace_idx ON agent_run (tenant_id, trace_id, agent_definition_id);
CREATE INDEX IF NOT EXISTS agent_message_episode_time_idx ON agent_message (tenant_id, episode_id, created_at);
CREATE INDEX IF NOT EXISTS work_item_scope_status_idx ON work_item (tenant_id, scope_id, status);
CREATE INDEX IF NOT EXISTS work_item_activity_time_idx ON work_item_activity (tenant_id, work_item_id, occurred_at);
CREATE INDEX IF NOT EXISTS outbox_status_time_idx ON outbox_message (tenant_id, status, created_at);
CREATE INDEX IF NOT EXISTS audit_entity_time_idx ON audit_record (tenant_id, entity_type, entity_id, created_at);
CREATE INDEX IF NOT EXISTS integration_environment_status_idx ON integration_connection (tenant_id, environment_id, status);
CREATE INDEX IF NOT EXISTS environment_configuration_status_idx ON environment_configuration_release (tenant_id, environment_id, status);
CREATE INDEX IF NOT EXISTS configuration_object_effective_idx ON configuration_object (tenant_id, environment_id, object_type, object_key);
CREATE INDEX IF NOT EXISTS configuration_validation_release_idx ON configuration_validation (release_id, run_at);
