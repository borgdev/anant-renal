CREATE TABLE `configuration_objects` (
	`object_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`release_id` text NOT NULL,
	`object_type` text NOT NULL,
	`object_key` text NOT NULL,
	`schema_version` text NOT NULL,
	`payload_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `configuration_object_release_key_idx` ON `configuration_objects` (`release_id`,`object_type`,`object_key`);--> statement-breakpoint
CREATE INDEX `configuration_object_effective_idx` ON `configuration_objects` (`tenant_id`,`environment_id`,`object_type`,`object_key`);--> statement-breakpoint
CREATE TABLE `configuration_validations` (
	`validation_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`release_id` text NOT NULL,
	`suite` text NOT NULL,
	`status` text NOT NULL,
	`score_basis_points` integer NOT NULL,
	`checks_json` text NOT NULL,
	`evidence_hash` text NOT NULL,
	`run_by` text NOT NULL,
	`run_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `configuration_validation_release_idx` ON `configuration_validations` (`release_id`,`run_at`);--> statement-breakpoint
CREATE TABLE `integration_connections` (
	`connection_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`kind` text NOT NULL,
	`display_name` text NOT NULL,
	`endpoint_url` text NOT NULL,
	`cluster_alias` text NOT NULL,
	`security_protocol` text NOT NULL,
	`secret_ref` text NOT NULL,
	`consumer_group` text NOT NULL,
	`topic_mappings_json` text NOT NULL,
	`status` text NOT NULL,
	`last_tested_at` text,
	`last_test_result_json` text,
	`configuration_version` text NOT NULL,
	`updated_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `integration_environment_kind_idx` ON `integration_connections` (`tenant_id`,`environment_id`,`kind`);--> statement-breakpoint
CREATE TABLE `onboarding_states` (
	`onboarding_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`current_step` text NOT NULL,
	`steps_json` text NOT NULL,
	`status` text NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `onboarding_tenant_environment_idx` ON `onboarding_states` (`tenant_id`,`environment_id`);--> statement-breakpoint
CREATE TABLE `tenant_configuration_releases` (
	`release_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`version` text NOT NULL,
	`status` text NOT NULL,
	`base_version` text,
	`rollback_version` text,
	`change_summary` text NOT NULL,
	`content_hash` text NOT NULL,
	`created_by` text NOT NULL,
	`validated_by` text,
	`activated_by` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`validated_at` text,
	`activated_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tenant_configuration_version_idx` ON `tenant_configuration_releases` (`tenant_id`,`environment_id`,`version`);--> statement-breakpoint
CREATE INDEX `tenant_configuration_status_idx` ON `tenant_configuration_releases` (`tenant_id`,`environment_id`,`status`);--> statement-breakpoint
CREATE TABLE `tenant_environments` (
	`environment_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`display_name` text NOT NULL,
	`environment_name` text NOT NULL,
	`deployment_mode` text NOT NULL,
	`status` text NOT NULL,
	`time_zone` text NOT NULL,
	`data_region` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tenant_environment_name_idx` ON `tenant_environments` (`tenant_id`,`environment_name`);