CREATE TABLE `acknowledgements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`acknowledgement_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`command_id` text NOT NULL,
	`acknowledgement_type` text NOT NULL,
	`source` text NOT NULL,
	`payload_json` text NOT NULL,
	`received_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `acknowledgements_acknowledgement_id_unique` ON `acknowledgements` (`acknowledgement_id`);--> statement-breakpoint
CREATE TABLE `agent_executions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`execution_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`agent_version` text NOT NULL,
	`event_id` text NOT NULL,
	`episode_id` text,
	`trace_id` text NOT NULL,
	`status` text NOT NULL,
	`input_hash` text NOT NULL,
	`output_hash` text,
	`confidence_basis_points` integer,
	`latency_ms` integer NOT NULL,
	`abstention_reason` text,
	`cost_microunits` integer DEFAULT 0 NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_executions_execution_id_unique` ON `agent_executions` (`execution_id`);--> statement-breakpoint
CREATE INDEX `agent_execution_trace_idx` ON `agent_executions` (`trace_id`,`agent_id`);--> statement-breakpoint
CREATE TABLE `agent_proposals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`proposal_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`execution_id` text NOT NULL,
	`episode_id` text,
	`agent_id` text NOT NULL,
	`proposal_type` text NOT NULL,
	`proposal_json` text NOT NULL,
	`confidence_basis_points` integer NOT NULL,
	`conflict_group` text,
	`status` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_proposals_proposal_id_unique` ON `agent_proposals` (`proposal_id`);--> statement-breakpoint
CREATE INDEX `agent_proposal_episode_idx` ON `agent_proposals` (`tenant_id`,`episode_id`,`status`);--> statement-breakpoint
CREATE TABLE `commands` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`command_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`action_id` text NOT NULL,
	`command_type` text NOT NULL,
	`destination` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`payload_json` text NOT NULL,
	`status` text NOT NULL,
	`emitted_at` text,
	`acknowledged_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `commands_command_id_unique` ON `commands` (`command_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `commands_idempotency_key_unique` ON `commands` (`idempotency_key`);--> statement-breakpoint
CREATE TABLE `drift_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`drift_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`target_id` text NOT NULL,
	`metric` text NOT NULL,
	`value_basis_points` integer NOT NULL,
	`threshold_basis_points` integer NOT NULL,
	`status` text NOT NULL,
	`measured_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `drift_snapshots_drift_id_unique` ON `drift_snapshots` (`drift_id`);--> statement-breakpoint
CREATE TABLE `event_envelopes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` text NOT NULL,
	`event_type` text NOT NULL,
	`schema_version` text NOT NULL,
	`tenant_id` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`purpose` text NOT NULL,
	`valid_time` text NOT NULL,
	`recorded_time` text NOT NULL,
	`correlation_id` text,
	`causation_id` text,
	`source_system` text NOT NULL,
	`source_resource` text NOT NULL,
	`content_hash` text NOT NULL,
	`payload_json` text NOT NULL,
	`status` text NOT NULL,
	`partition_key` text NOT NULL,
	`trace_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_envelopes_event_id_unique` ON `event_envelopes` (`event_id`);--> statement-breakpoint
CREATE INDEX `event_envelopes_tenant_time_idx` ON `event_envelopes` (`tenant_id`,`recorded_time`);--> statement-breakpoint
CREATE INDEX `event_envelopes_subject_idx` ON `event_envelopes` (`tenant_id`,`subject_type`,`subject_id`);--> statement-breakpoint
CREATE INDEX `event_envelopes_type_idx` ON `event_envelopes` (`event_type`);--> statement-breakpoint
CREATE TABLE `event_outbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`outbox_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`topic` text NOT NULL,
	`message_key` text NOT NULL,
	`envelope_json` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text,
	`published_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_outbox_outbox_id_unique` ON `event_outbox` (`outbox_id`);--> statement-breakpoint
CREATE INDEX `event_outbox_status_idx` ON `event_outbox` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `evidence_objects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`evidence_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`evidence_type` text NOT NULL,
	`source_event_id` text NOT NULL,
	`exact_text` text,
	`structured_json` text NOT NULL,
	`confidence_basis_points` integer NOT NULL,
	`valid_from` text NOT NULL,
	`valid_to` text,
	`recorded_at` text NOT NULL,
	`purpose` text NOT NULL,
	`content_hash` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `evidence_objects_evidence_id_unique` ON `evidence_objects` (`evidence_id`);--> statement-breakpoint
CREATE INDEX `evidence_subject_idx` ON `evidence_objects` (`tenant_id`,`subject_id`,`valid_from`);--> statement-breakpoint
CREATE TABLE `incidents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`incident_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`severity` integer NOT NULL,
	`status` text NOT NULL,
	`source` text NOT NULL,
	`summary` text NOT NULL,
	`owner_role` text NOT NULL,
	`opened_at` text NOT NULL,
	`resolved_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `incidents_incident_id_unique` ON `incidents` (`incident_id`);--> statement-breakpoint
CREATE TABLE `knowledge_comments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`comment_id` text NOT NULL,
	`note_id` text NOT NULL,
	`body` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_comments_comment_id_unique` ON `knowledge_comments` (`comment_id`);--> statement-breakpoint
CREATE INDEX `knowledge_comments_note_idx` ON `knowledge_comments` (`note_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `knowledge_note_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`version_id` text NOT NULL,
	`note_id` text NOT NULL,
	`version` integer NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`changed_by` text NOT NULL,
	`changed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_note_versions_version_id_unique` ON `knowledge_note_versions` (`version_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_note_version_idx` ON `knowledge_note_versions` (`note_id`,`version`);--> statement-breakpoint
CREATE TABLE `knowledge_notes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`note_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`node_id` text NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`version` integer NOT NULL,
	`visibility` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_notes_note_id_unique` ON `knowledge_notes` (`note_id`);--> statement-breakpoint
CREATE INDEX `knowledge_notes_node_idx` ON `knowledge_notes` (`tenant_id`,`node_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `measure_results` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`result_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`measure_pack_id` text NOT NULL,
	`scope_id` text NOT NULL,
	`period` text NOT NULL,
	`numerator` integer NOT NULL,
	`denominator` integer NOT NULL,
	`value_basis_points` integer NOT NULL,
	`status` text NOT NULL,
	`source_version` text NOT NULL,
	`evidence_hash` text NOT NULL,
	`calculated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `measure_results_result_id_unique` ON `measure_results` (`result_id`);--> statement-breakpoint
CREATE TABLE `model_registry` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`registry_id` text NOT NULL,
	`model_id` text NOT NULL,
	`model_version` text NOT NULL,
	`provider` text NOT NULL,
	`purpose` text NOT NULL,
	`status` text NOT NULL,
	`evaluation_score_basis_points` integer NOT NULL,
	`cost_microunits_per_call` integer NOT NULL,
	`kill_switch` integer NOT NULL,
	`last_evaluated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `model_registry_registry_id_unique` ON `model_registry` (`registry_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `model_registry_model_version_idx` ON `model_registry` (`model_id`,`model_version`);--> statement-breakpoint
CREATE TABLE `next_best_actions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`action_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`episode_id` text,
	`rank` integer NOT NULL,
	`title` text NOT NULL,
	`outcome` text NOT NULL,
	`scope_id` text NOT NULL,
	`owner_role` text NOT NULL,
	`due_at` text NOT NULL,
	`value_label` text NOT NULL,
	`confidence_basis_points` integer NOT NULL,
	`action_class` text NOT NULL,
	`evidence_count` integer NOT NULL,
	`agent_ids_json` text NOT NULL,
	`audience_json` text NOT NULL,
	`status` text NOT NULL,
	`policy_evaluation_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `next_best_actions_action_id_unique` ON `next_best_actions` (`action_id`);--> statement-breakpoint
CREATE INDEX `nba_scope_rank_idx` ON `next_best_actions` (`tenant_id`,`scope_id`,`rank`);--> statement-breakpoint
CREATE TABLE `outcome_episodes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`episode_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`outcome_type` text NOT NULL,
	`scope_type` text NOT NULL,
	`scope_id` text NOT NULL,
	`subject_id` text,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`urgency` text NOT NULL,
	`confidence_basis_points` integer NOT NULL,
	`owner_role` text NOT NULL,
	`action_class` text NOT NULL,
	`evidence_count` integer NOT NULL,
	`current_recommendation` text NOT NULL,
	`opened_at` text NOT NULL,
	`resolved_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outcome_episodes_episode_id_unique` ON `outcome_episodes` (`episode_id`);--> statement-breakpoint
CREATE INDEX `outcome_episode_scope_idx` ON `outcome_episodes` (`tenant_id`,`scope_id`,`status`);--> statement-breakpoint
CREATE TABLE `policy_evaluations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`evaluation_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`policy_version` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`actor_role` text NOT NULL,
	`decision` text NOT NULL,
	`reasons_json` text NOT NULL,
	`threshold_basis_points` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `policy_evaluations_evaluation_id_unique` ON `policy_evaluations` (`evaluation_id`);--> statement-breakpoint
CREATE TABLE `role_assignments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`assignment_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`actor_email` text NOT NULL,
	`role_id` text NOT NULL,
	`scope_level` text NOT NULL,
	`scope_id` text NOT NULL,
	`effective_from` text NOT NULL,
	`effective_to` text,
	`synthetic_delegation` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `role_assignments_assignment_id_unique` ON `role_assignments` (`assignment_id`);--> statement-breakpoint
CREATE INDEX `role_assignment_actor_idx` ON `role_assignments` (`tenant_id`,`actor_email`,`role_id`);--> statement-breakpoint
CREATE TABLE `submission_packages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`package_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`program` text NOT NULL,
	`period` text NOT NULL,
	`measure_pack_version` text NOT NULL,
	`row_count` integer NOT NULL,
	`status` text NOT NULL,
	`manifest_hash` text NOT NULL,
	`created_by` text NOT NULL,
	`approved_by` text,
	`receipt_json` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `submission_packages_package_id_unique` ON `submission_packages` (`package_id`);--> statement-breakpoint
CREATE TABLE `swarm_insights` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`insight_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`episode_id` text,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`scope_id` text NOT NULL,
	`confidence_basis_points` integer NOT NULL,
	`state` text NOT NULL,
	`contributors_json` text NOT NULL,
	`conflicts_json` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `swarm_insights_insight_id_unique` ON `swarm_insights` (`insight_id`);--> statement-breakpoint
CREATE TABLE `temporal_states` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`state_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`state_type` text NOT NULL,
	`state_json` text NOT NULL,
	`valid_from` text NOT NULL,
	`valid_to` text,
	`recorded_from` text NOT NULL,
	`recorded_to` text,
	`source_event_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `temporal_states_state_id_unique` ON `temporal_states` (`state_id`);--> statement-breakpoint
CREATE INDEX `temporal_state_entity_idx` ON `temporal_states` (`tenant_id`,`entity_type`,`entity_id`,`valid_from`);--> statement-breakpoint
CREATE TABLE `topology_edges` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`edge_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`source_node_id` text NOT NULL,
	`target_node_id` text NOT NULL,
	`relation` text NOT NULL,
	`confidence_basis_points` integer NOT NULL,
	`provenance_json` text NOT NULL,
	`valid_from` text NOT NULL,
	`valid_to` text,
	`source_event_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `topology_edges_edge_id_unique` ON `topology_edges` (`edge_id`);--> statement-breakpoint
CREATE INDEX `topology_edges_source_idx` ON `topology_edges` (`tenant_id`,`source_node_id`);--> statement-breakpoint
CREATE INDEX `topology_edges_target_idx` ON `topology_edges` (`tenant_id`,`target_node_id`);--> statement-breakpoint
CREATE TABLE `topology_nodes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`node_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`node_type` text NOT NULL,
	`label` text NOT NULL,
	`scope_id` text NOT NULL,
	`attributes_json` text NOT NULL,
	`x_basis_points` integer NOT NULL,
	`y_basis_points` integer NOT NULL,
	`z_basis_points` integer NOT NULL,
	`valid_from` text NOT NULL,
	`valid_to` text,
	`source_event_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `topology_nodes_node_id_unique` ON `topology_nodes` (`node_id`);--> statement-breakpoint
CREATE INDEX `topology_nodes_scope_idx` ON `topology_nodes` (`tenant_id`,`scope_id`,`node_type`);--> statement-breakpoint
CREATE TABLE `trace_spans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`span_id` text NOT NULL,
	`trace_id` text NOT NULL,
	`parent_span_id` text,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`system` text NOT NULL,
	`status` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`attributes_json` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trace_spans_span_id_unique` ON `trace_spans` (`span_id`);--> statement-breakpoint
CREATE INDEX `trace_spans_trace_idx` ON `trace_spans` (`trace_id`,`created_at`);