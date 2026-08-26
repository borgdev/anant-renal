CREATE TABLE `evidence_reviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`review_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`evidence_id` text NOT NULL,
	`decision` text NOT NULL,
	`reviewer` text NOT NULL,
	`reviewer_role` text NOT NULL,
	`cited_text` text,
	`content_hash` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `evidence_reviews_review_id_unique` ON `evidence_reviews` (`review_id`);--> statement-breakpoint
CREATE INDEX `evidence_reviews_evidence_idx` ON `evidence_reviews` (`tenant_id`,`evidence_id`,`created_at`);