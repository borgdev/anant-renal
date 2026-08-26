ALTER TABLE `event_outbox` ADD `locked_by` text;--> statement-breakpoint
ALTER TABLE `event_outbox` ADD `locked_until` text;