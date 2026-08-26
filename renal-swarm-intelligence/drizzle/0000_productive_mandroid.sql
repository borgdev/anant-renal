CREATE TABLE `audit_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` text NOT NULL,
	`category` text NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`decision` text NOT NULL,
	`evidence_hash` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`configuration_version` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_events_event_id_unique` ON `audit_events` (`event_id`);--> statement-breakpoint
CREATE TABLE `authority_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` text NOT NULL,
	`authority` text NOT NULL,
	`status` text NOT NULL,
	`effective_from` text NOT NULL,
	`source_url` text NOT NULL,
	`content_hash` text NOT NULL,
	`retrieved_at` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `configuration_releases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`version` text NOT NULL,
	`status` text NOT NULL,
	`change_set_id` text NOT NULL,
	`created_by` text NOT NULL,
	`approved_by` text,
	`effective_from` text,
	`rollback_version` text,
	`dossier_hash` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `configuration_releases_version_unique` ON `configuration_releases` (`version`);--> statement-breakpoint
CREATE TABLE `evaluation_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`suite` text NOT NULL,
	`target_type` text NOT NULL,
	`target_version` text NOT NULL,
	`scenario_id` text,
	`status` text NOT NULL,
	`score_basis_points` integer NOT NULL,
	`evidence_hash` text NOT NULL,
	`configuration_version` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `evaluation_runs_run_id_unique` ON `evaluation_runs` (`run_id`);