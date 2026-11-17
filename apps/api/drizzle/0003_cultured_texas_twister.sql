CREATE TABLE `ranking_reward_payouts` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`season_id` int unsigned NOT NULL,
	`snapshot_id` char(36) NOT NULL,
	`tiers` json NOT NULL,
	`mail_ids` json NOT NULL,
	`recipient_count` int unsigned NOT NULL,
	`skipped_count` int unsigned NOT NULL,
	`approval_request_id` bigint unsigned,
	`created_by` bigint unsigned NOT NULL,
	`created_at` datetime NOT NULL DEFAULT (now()),
	CONSTRAINT `ranking_reward_payouts_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_reward_payouts_snapshot` UNIQUE(`snapshot_id`)
);
--> statement-breakpoint
ALTER TABLE `ranking_snapshots` ADD `kind` varchar(10) DEFAULT 'RESET' NOT NULL;