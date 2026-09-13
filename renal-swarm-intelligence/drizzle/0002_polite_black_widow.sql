--*****************************************************************************
--
--  Copyright (c) 2026 AnantHQ Inc.
--  All Rights Reserved.
--
--  This software is licensed, not sold.
--
--  The contents of this file constitute confidential and proprietary
--  information belonging exclusively to AnantHQ Inc.
--
--  This source code incorporates proprietary algorithms, software architecture,
--  business logic, computational methods, optimization techniques,
--  workflows, data structures, APIs, and implementation details that are
--  protected by copyright law, patent law, trade secret law, and
--  international intellectual property treaties.
--
--  Except as expressly permitted by a written license agreement,
--  no person or organization may:
--
--    • Copy or reproduce this software.
--    • Modify or create derivative works.
--    • Reverse engineer, decompile, or disassemble.
--    • Benchmark or publicly disclose performance.
--    • Redistribute, sublicense, lease, rent, or sell.
--    • Use this software for competitive analysis.
--    • Disclose any implementation details.
--
--  Any unauthorized use is strictly prohibited and may result in
--  civil damages, injunctive relief, criminal prosecution,
--  and all other remedies available under applicable law.
--
-- *****************************************************************************/

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