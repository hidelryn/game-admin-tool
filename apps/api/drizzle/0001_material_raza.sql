DROP INDEX `idx_scores_order` ON `ranking_scores`;--> statement-breakpoint
ALTER TABLE `ranking_scores` ADD `achieved_seq` bigint unsigned DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `ranking_seasons` ADD `score_seq` bigint unsigned DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_scores_rank` ON `ranking_scores` (`season_id`,`score`,`achieved_seq`);