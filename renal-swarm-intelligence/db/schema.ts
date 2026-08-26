import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const auditEvents = sqliteTable("audit_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  eventId: text("event_id").notNull().unique(),
  category: text("category", { enum: ["human-action", "policy-decision", "data-quality", "security"] }).notNull(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  decision: text("decision", { enum: ["requested", "approved", "rejected", "blocked", "completed"] }).notNull(),
  evidenceHash: text("evidence_hash").notNull(),
  detail: text("detail").notNull().default(""),
  configurationVersion: text("configuration_version").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const evaluationRuns = sqliteTable("evaluation_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: text("run_id").notNull().unique(),
  suite: text("suite", { enum: ["green", "red", "contract", "gold-set"] }).notNull(),
  targetType: text("target_type").notNull(),
  targetVersion: text("target_version").notNull(),
  scenarioId: text("scenario_id"),
  status: text("status", { enum: ["queued", "running", "passed", "failed", "blocked"] }).notNull(),
  scoreBasisPoints: integer("score_basis_points").notNull(),
  evidenceHash: text("evidence_hash").notNull(),
  configurationVersion: text("configuration_version").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const configurationReleases = sqliteTable("configuration_releases", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  version: text("version").notNull().unique(),
  status: text("status", { enum: ["draft", "validated", "approved", "active", "rolled-back"] }).notNull(),
  changeSetId: text("change_set_id").notNull(),
  createdBy: text("created_by").notNull(),
  approvedBy: text("approved_by"),
  effectiveFrom: text("effective_from"),
  rollbackVersion: text("rollback_version"),
  dossierHash: text("dossier_hash").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const authoritySnapshots = sqliteTable("authority_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sourceId: text("source_id").notNull(),
  authority: text("authority").notNull(),
  status: text("status").notNull(),
  effectiveFrom: text("effective_from").notNull(),
  sourceUrl: text("source_url").notNull(),
  contentHash: text("content_hash").notNull(),
  retrievedAt: text("retrieved_at").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("authority_snapshot_source_effective_idx").on(table.sourceId, table.effectiveFrom)]);

export const eventEnvelopes = sqliteTable("event_envelopes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  eventId: text("event_id").notNull().unique(),
  eventType: text("event_type").notNull(),
  schemaVersion: text("schema_version").notNull(),
  tenantId: text("tenant_id").notNull(),
  subjectType: text("subject_type").notNull(),
  subjectId: text("subject_id").notNull(),
  purpose: text("purpose").notNull(),
  validTime: text("valid_time").notNull(),
  recordedTime: text("recorded_time").notNull(),
  correlationId: text("correlation_id"),
  causationId: text("causation_id"),
  sourceSystem: text("source_system").notNull(),
  sourceResource: text("source_resource").notNull(),
  contentHash: text("content_hash").notNull(),
  payloadJson: text("payload_json").notNull(),
  status: text("status", { enum: ["accepted", "quarantined", "replayed"] }).notNull(),
  partitionKey: text("partition_key").notNull(),
  traceId: text("trace_id").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("event_envelopes_tenant_time_idx").on(table.tenantId, table.recordedTime),
  index("event_envelopes_subject_idx").on(table.tenantId, table.subjectType, table.subjectId),
  index("event_envelopes_type_idx").on(table.eventType),
]);

export const evidenceObjects = sqliteTable("evidence_objects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  evidenceId: text("evidence_id").notNull().unique(),
  tenantId: text("tenant_id").notNull(),
  subjectType: text("subject_type").notNull(),
  subjectId: text("subject_id").notNull(),
  evidenceType: text("evidence_type").notNull(),
  sourceEventId: text("source_event_id").notNull(),
  exactText: text("exact_text"),
  structuredJson: text("structured_json").notNull(),
  confidenceBasisPoints: integer("confidence_basis_points").notNull(),
  validFrom: text("valid_from").notNull(),
  validTo: text("valid_to"),
  recordedAt: text("recorded_at").notNull(),
  purpose: text("purpose").notNull(),
  contentHash: text("content_hash").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("evidence_subject_idx").on(table.tenantId, table.subjectId, table.validFrom)]);

export const evidenceReviews = sqliteTable("evidence_reviews", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  reviewId: text("review_id").notNull().unique(),
  tenantId: text("tenant_id").notNull(),
  evidenceId: text("evidence_id").notNull(),
  decision: text("decision", { enum: ["confirmed", "rejected"] }).notNull(),
  reviewer: text("reviewer").notNull(),
  reviewerRole: text("reviewer_role").notNull(),
  citedText: text("cited_text"),
  contentHash: text("content_hash").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("evidence_reviews_evidence_idx").on(table.tenantId, table.evidenceId, table.createdAt)]);

export const temporalStates = sqliteTable("temporal_states", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  stateId: text("state_id").notNull().unique(),
  tenantId: text("tenant_id").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  stateType: text("state_type").notNull(),
  stateJson: text("state_json").notNull(),
  validFrom: text("valid_from").notNull(),
  validTo: text("valid_to"),
  recordedFrom: text("recorded_from").notNull(),
  recordedTo: text("recorded_to"),
  sourceEventId: text("source_event_id").notNull(),
}, (table) => [index("temporal_state_entity_idx").on(table.tenantId, table.entityType, table.entityId, table.validFrom)]);

export const topologyNodes = sqliteTable("topology_nodes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  nodeId: text("node_id").notNull().unique(),
  tenantId: text("tenant_id").notNull(),
  nodeType: text("node_type").notNull(),
  label: text("label").notNull(),
  scopeId: text("scope_id").notNull(),
  attributesJson: text("attributes_json").notNull(),
  xBasisPoints: integer("x_basis_points").notNull(),
  yBasisPoints: integer("y_basis_points").notNull(),
  zBasisPoints: integer("z_basis_points").notNull(),
  validFrom: text("valid_from").notNull(),
  validTo: text("valid_to"),
  sourceEventId: text("source_event_id").notNull(),
}, (table) => [index("topology_nodes_scope_idx").on(table.tenantId, table.scopeId, table.nodeType)]);

export const topologyEdges = sqliteTable("topology_edges", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  edgeId: text("edge_id").notNull().unique(),
  tenantId: text("tenant_id").notNull(),
  sourceNodeId: text("source_node_id").notNull(),
  targetNodeId: text("target_node_id").notNull(),
  relation: text("relation").notNull(),
  confidenceBasisPoints: integer("confidence_basis_points").notNull(),
  provenanceJson: text("provenance_json").notNull(),
  validFrom: text("valid_from").notNull(),
  validTo: text("valid_to"),
  sourceEventId: text("source_event_id").notNull(),
}, (table) => [
  index("topology_edges_source_idx").on(table.tenantId, table.sourceNodeId),
  index("topology_edges_target_idx").on(table.tenantId, table.targetNodeId),
]);

export const outcomeEpisodes = sqliteTable("outcome_episodes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  episodeId: text("episode_id").notNull().unique(),
  tenantId: text("tenant_id").notNull(),
  outcomeType: text("outcome_type").notNull(),
  scopeType: text("scope_type").notNull(),
  scopeId: text("scope_id").notNull(),
  subjectId: text("subject_id"),
  title: text("title").notNull(),
  status: text("status", { enum: ["observed", "understood", "proposed", "awaiting-approval", "coordinating", "verifying", "resolved", "blocked"] }).notNull(),
  urgency: text("urgency", { enum: ["critical", "high", "watch"] }).notNull(),
  confidenceBasisPoints: integer("confidence_basis_points").notNull(),
  ownerRole: text("owner_role").notNull(),
  actionClass: text("action_class", { enum: ["A", "B", "C", "D"] }).notNull(),
  evidenceCount: integer("evidence_count").notNull(),
  currentRecommendation: text("current_recommendation").notNull(),
  openedAt: text("opened_at").notNull(),
  resolvedAt: text("resolved_at"),
  version: integer("version").notNull().default(1),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("outcome_episode_scope_idx").on(table.tenantId, table.scopeId, table.status)]);

export const agentExecutions = sqliteTable("agent_executions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  executionId: text("execution_id").notNull().unique(),
  tenantId: text("tenant_id").notNull(),
  agentId: text("agent_id").notNull(),
  agentVersion: text("agent_version").notNull(),
  eventId: text("event_id").notNull(),
  episodeId: text("episode_id"),
  traceId: text("trace_id").notNull(),
  status: text("status", { enum: ["eligible", "running", "completed", "abstained", "failed", "blocked"] }).notNull(),
  inputHash: text("input_hash").notNull(),
  outputHash: text("output_hash"),
  confidenceBasisPoints: integer("confidence_basis_points"),
  latencyMs: integer("latency_ms").notNull(),
  abstentionReason: text("abstention_reason"),
  costMicrounits: integer("cost_microunits").notNull().default(0),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
}, (table) => [index("agent_execution_trace_idx").on(table.traceId, table.agentId)]);

export const agentProposals = sqliteTable("agent_proposals", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  proposalId: text("proposal_id").notNull().unique(),
  tenantId: text("tenant_id").notNull(),
  executionId: text("execution_id").notNull(),
  episodeId: text("episode_id"),
  agentId: text("agent_id").notNull(),
  proposalType: text("proposal_type").notNull(),
  proposalJson: text("proposal_json").notNull(),
  confidenceBasisPoints: integer("confidence_basis_points").notNull(),
  conflictGroup: text("conflict_group"),
  status: text("status", { enum: ["proposed", "accepted", "conflicted", "superseded", "blocked"] }).notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("agent_proposal_episode_idx").on(table.tenantId, table.episodeId, table.status)]);

export const swarmInsights = sqliteTable("swarm_insights", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  insightId: text("insight_id").notNull().unique(),
  tenantId: text("tenant_id").notNull(),
  episodeId: text("episode_id"),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  scopeId: text("scope_id").notNull(),
  confidenceBasisPoints: integer("confidence_basis_points").notNull(),
  state: text("state").notNull(),
  contributorsJson: text("contributors_json").notNull(),
  conflictsJson: text("conflicts_json").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const policyEvaluations = sqliteTable("policy_evaluations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  evaluationId: text("evaluation_id").notNull().unique(),
  tenantId: text("tenant_id").notNull(),
  policyVersion: text("policy_version").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  actorRole: text("actor_role").notNull(),
  decision: text("decision", { enum: ["allow", "review", "block"] }).notNull(),
  reasonsJson: text("reasons_json").notNull(),
  thresholdBasisPoints: integer("threshold_basis_points").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const nextBestActions = sqliteTable("next_best_actions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  actionId: text("action_id").notNull().unique(),
  tenantId: text("tenant_id").notNull(),
  episodeId: text("episode_id"),
  rank: integer("rank").notNull(),
  title: text("title").notNull(),
  outcome: text("outcome").notNull(),
  scopeId: text("scope_id").notNull(),
  ownerRole: text("owner_role").notNull(),
  dueAt: text("due_at").notNull(),
  valueLabel: text("value_label").notNull(),
  confidenceBasisPoints: integer("confidence_basis_points").notNull(),
  actionClass: text("action_class", { enum: ["A", "B", "C", "D"] }).notNull(),
  evidenceCount: integer("evidence_count").notNull(),
  agentIdsJson: text("agent_ids_json").notNull(),
  audienceJson: text("audience_json").notNull(),
  status: text("status", { enum: ["queued", "review", "approved", "rejected", "emitted", "completed", "blocked"] }).notNull(),
  policyEvaluationId: text("policy_evaluation_id").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("nba_scope_rank_idx").on(table.tenantId, table.scopeId, table.rank)]);

export const commands = sqliteTable("commands", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  commandId: text("command_id").notNull().unique(),
  tenantId: text("tenant_id").notNull(),
  actionId: text("action_id").notNull(),
  commandType: text("command_type").notNull(),
  destination: text("destination").notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  payloadJson: text("payload_json").notNull(),
  status: text("status", { enum: ["pending", "emitted", "acknowledged", "failed", "blocked"] }).notNull(),
  emittedAt: text("emitted_at"),
  acknowledgedAt: text("acknowledged_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const acknowledgements = sqliteTable("acknowledgements", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  acknowledgementId: text("acknowledgement_id").notNull().unique(),
  tenantId: text("tenant_id").notNull(),
  commandId: text("command_id").notNull(),
  acknowledgementType: text("acknowledgement_type").notNull(),
  source: text("source").notNull(),
  payloadJson: text("payload_json").notNull(),
  receivedAt: text("received_at").notNull(),
});

export const eventOutbox = sqliteTable("event_outbox", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  outboxId: text("outbox_id").notNull().unique(),
  tenantId: text("tenant_id").notNull(),
  topic: text("topic").notNull(),
  messageKey: text("message_key").notNull(),
  envelopeJson: text("envelope_json").notNull(),
  status: text("status", { enum: ["pending", "leased", "published", "failed"] }).notNull(),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: text("next_attempt_at"),
  lockedBy: text("locked_by"),
  lockedUntil: text("locked_until"),
  publishedAt: text("published_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("event_outbox_status_idx").on(table.status, table.createdAt)]);

export const traceSpans = sqliteTable("trace_spans", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  spanId: text("span_id").notNull().unique(),
  traceId: text("trace_id").notNull(),
  parentSpanId: text("parent_span_id"),
  tenantId: text("tenant_id").notNull(),
  name: text("name").notNull(),
  system: text("system").notNull(),
  status: text("status", { enum: ["ok", "review", "blocked", "error"] }).notNull(),
  durationMs: integer("duration_ms").notNull(),
  attributesJson: text("attributes_json").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("trace_spans_trace_idx").on(table.traceId, table.createdAt)]);

export const measureResults = sqliteTable("measure_results", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  resultId: text("result_id").notNull().unique(),
  tenantId: text("tenant_id").notNull(),
  measurePackId: text("measure_pack_id").notNull(),
  scopeId: text("scope_id").notNull(),
  period: text("period").notNull(),
  numerator: integer("numerator").notNull(),
  denominator: integer("denominator").notNull(),
  valueBasisPoints: integer("value_basis_points").notNull(),
  status: text("status", { enum: ["calculated", "validated", "ready", "submitted", "reconciled"] }).notNull(),
  sourceVersion: text("source_version").notNull(),
  evidenceHash: text("evidence_hash").notNull(),
  calculatedAt: text("calculated_at").notNull(),
});

export const submissionPackages = sqliteTable("submission_packages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  packageId: text("package_id").notNull().unique(),
  tenantId: text("tenant_id").notNull(),
  program: text("program").notNull(),
  period: text("period").notNull(),
  measurePackVersion: text("measure_pack_version").notNull(),
  rowCount: integer("row_count").notNull(),
  status: text("status", { enum: ["draft", "validated", "approved", "transmitted", "acknowledged", "rejected"] }).notNull(),
  manifestHash: text("manifest_hash").notNull(),
  createdBy: text("created_by").notNull(),
  approvedBy: text("approved_by"),
  receiptJson: text("receipt_json"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const modelRegistry = sqliteTable("model_registry", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  registryId: text("registry_id").notNull().unique(),
  modelId: text("model_id").notNull(),
  modelVersion: text("model_version").notNull(),
  provider: text("provider").notNull(),
  purpose: text("purpose").notNull(),
  status: text("status", { enum: ["candidate", "approved", "canary", "active", "blocked", "retired"] }).notNull(),
  evaluationScoreBasisPoints: integer("evaluation_score_basis_points").notNull(),
  costMicrounitsPerCall: integer("cost_microunits_per_call").notNull(),
  killSwitch: integer("kill_switch", { mode: "boolean" }).notNull(),
  lastEvaluatedAt: text("last_evaluated_at").notNull(),
}, (table) => [uniqueIndex("model_registry_model_version_idx").on(table.modelId, table.modelVersion)]);

export const driftSnapshots = sqliteTable("drift_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  driftId: text("drift_id").notNull().unique(),
  tenantId: text("tenant_id").notNull(),
  targetId: text("target_id").notNull(),
  metric: text("metric").notNull(),
  valueBasisPoints: integer("value_basis_points").notNull(),
  thresholdBasisPoints: integer("threshold_basis_points").notNull(),
  status: text("status", { enum: ["healthy", "watch", "blocked"] }).notNull(),
  measuredAt: text("measured_at").notNull(),
});

export const incidents = sqliteTable("incidents", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  incidentId: text("incident_id").notNull().unique(),
  tenantId: text("tenant_id").notNull(),
  severity: integer("severity").notNull(),
  status: text("status", { enum: ["open", "contained", "resolved"] }).notNull(),
  source: text("source").notNull(),
  summary: text("summary").notNull(),
  ownerRole: text("owner_role").notNull(),
  openedAt: text("opened_at").notNull(),
  resolvedAt: text("resolved_at"),
});

export const roleAssignments = sqliteTable("role_assignments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  assignmentId: text("assignment_id").notNull().unique(),
  tenantId: text("tenant_id").notNull(),
  actorEmail: text("actor_email").notNull(),
  roleId: text("role_id").notNull(),
  scopeLevel: text("scope_level").notNull(),
  scopeId: text("scope_id").notNull(),
  effectiveFrom: text("effective_from").notNull(),
  effectiveTo: text("effective_to"),
  syntheticDelegation: integer("synthetic_delegation", { mode: "boolean" }).notNull().default(false),
}, (table) => [index("role_assignment_actor_idx").on(table.tenantId, table.actorEmail, table.roleId)]);

export const knowledgeNotes = sqliteTable("knowledge_notes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  noteId: text("note_id").notNull().unique(),
  tenantId: text("tenant_id").notNull(),
  nodeId: text("node_id").notNull(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  version: integer("version").notNull(),
  visibility: text("visibility", { enum: ["scope", "role", "private"] }).notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("knowledge_notes_node_idx").on(table.tenantId, table.nodeId, table.updatedAt)]);

export const knowledgeNoteVersions = sqliteTable("knowledge_note_versions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  versionId: text("version_id").notNull().unique(),
  noteId: text("note_id").notNull(),
  version: integer("version").notNull(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  changedBy: text("changed_by").notNull(),
  changedAt: text("changed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("knowledge_note_version_idx").on(table.noteId, table.version)]);

export const knowledgeComments = sqliteTable("knowledge_comments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  commentId: text("comment_id").notNull().unique(),
  noteId: text("note_id").notNull(),
  body: text("body").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("knowledge_comments_note_idx").on(table.noteId, table.createdAt)]);

/**
 * Tenant control-plane tables intentionally use application-assigned text keys
 * and portable scalar types. The logical model can move to PostgreSQL without
 * changing identifiers, payload contracts, lifecycle semantics or timestamps.
 */
export const tenantEnvironments = sqliteTable("tenant_environments", {
  environmentId: text("environment_id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  displayName: text("display_name").notNull(),
  environmentName: text("environment_name").notNull(),
  deploymentMode: text("deployment_mode", { enum: ["reference", "non-production", "production"] }).notNull(),
  status: text("status", { enum: ["onboarding", "ready", "active", "blocked"] }).notNull(),
  timeZone: text("time_zone").notNull(),
  dataRegion: text("data_region").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("tenant_environment_name_idx").on(table.tenantId, table.environmentName),
]);

export const integrationConnections = sqliteTable("integration_connections", {
  connectionId: text("connection_id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  environmentId: text("environment_id").notNull(),
  kind: text("kind", { enum: ["kafka-bridge", "fhir", "cms", "identity"] }).notNull(),
  displayName: text("display_name").notNull(),
  endpointUrl: text("endpoint_url").notNull(),
  clusterAlias: text("cluster_alias").notNull(),
  securityProtocol: text("security_protocol").notNull(),
  secretRef: text("secret_ref").notNull(),
  consumerGroup: text("consumer_group").notNull(),
  topicMappingsJson: text("topic_mappings_json").notNull(),
  status: text("status", { enum: ["draft", "contract-verified", "verified", "active", "error"] }).notNull(),
  lastTestedAt: text("last_tested_at"),
  lastTestResultJson: text("last_test_result_json"),
  configurationVersion: text("configuration_version").notNull(),
  updatedBy: text("updated_by").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("integration_environment_kind_idx").on(table.tenantId, table.environmentId, table.kind),
]);

export const tenantConfigurationReleases = sqliteTable("tenant_configuration_releases", {
  releaseId: text("release_id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  environmentId: text("environment_id").notNull(),
  version: text("version").notNull(),
  status: text("status", { enum: ["draft", "validated", "active", "retired", "blocked"] }).notNull(),
  baseVersion: text("base_version"),
  rollbackVersion: text("rollback_version"),
  changeSummary: text("change_summary").notNull(),
  contentHash: text("content_hash").notNull(),
  createdBy: text("created_by").notNull(),
  validatedBy: text("validated_by"),
  activatedBy: text("activated_by"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  validatedAt: text("validated_at"),
  activatedAt: text("activated_at"),
}, (table) => [
  uniqueIndex("tenant_configuration_version_idx").on(table.tenantId, table.environmentId, table.version),
  index("tenant_configuration_status_idx").on(table.tenantId, table.environmentId, table.status),
]);

export const configurationObjects = sqliteTable("configuration_objects", {
  objectId: text("object_id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  environmentId: text("environment_id").notNull(),
  releaseId: text("release_id").notNull(),
  objectType: text("object_type", { enum: ["agent", "policy", "adapter", "measure-pack", "workflow", "role-map"] }).notNull(),
  objectKey: text("object_key").notNull(),
  schemaVersion: text("schema_version").notNull(),
  payloadJson: text("payload_json").notNull(),
  contentHash: text("content_hash").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("configuration_object_release_key_idx").on(table.releaseId, table.objectType, table.objectKey),
  index("configuration_object_effective_idx").on(table.tenantId, table.environmentId, table.objectType, table.objectKey),
]);

export const configurationValidations = sqliteTable("configuration_validations", {
  validationId: text("validation_id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  environmentId: text("environment_id").notNull(),
  releaseId: text("release_id").notNull(),
  suite: text("suite", { enum: ["schema", "green", "red", "integration", "promotion"] }).notNull(),
  status: text("status", { enum: ["passed", "failed", "blocked"] }).notNull(),
  scoreBasisPoints: integer("score_basis_points").notNull(),
  checksJson: text("checks_json").notNull(),
  evidenceHash: text("evidence_hash").notNull(),
  runBy: text("run_by").notNull(),
  runAt: text("run_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("configuration_validation_release_idx").on(table.releaseId, table.runAt)]);

export const onboardingStates = sqliteTable("onboarding_states", {
  onboardingId: text("onboarding_id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  environmentId: text("environment_id").notNull(),
  currentStep: text("current_step").notNull(),
  stepsJson: text("steps_json").notNull(),
  status: text("status", { enum: ["not-started", "in-progress", "ready", "active", "blocked"] }).notNull(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("onboarding_tenant_environment_idx").on(table.tenantId, table.environmentId)]);
