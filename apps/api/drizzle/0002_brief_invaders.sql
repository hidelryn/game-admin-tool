CREATE INDEX `idx_scores_seq` ON `ranking_scores` (`season_id`,`achieved_seq`);--> statement-breakpoint
ALTER TABLE `ranking_seasons` DROP COLUMN `score_seq`;