CREATE TABLE `email_campaigns` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`target_type` varchar(10) NOT NULL,
	`target_public_ids` json,
	`target_address` varchar(191),
	`subject` varchar(150) NOT NULL,
	`body` text NOT NULL,
	`is_ad` boolean NOT NULL DEFAULT false,
	`status` varchar(10) NOT NULL,
	`scheduled_at` datetime NOT NULL,
	`started_at` datetime,
	`finished_at` datetime,
	`canceled_at` datetime,
	`canceled_by` bigint unsigned,
	`demo` boolean NOT NULL DEFAULT false,
	`total_count` int unsigned NOT NULL DEFAULT 0,
	`sent_count` int unsigned NOT NULL DEFAULT 0,
	`virtual_count` int unsigned NOT NULL DEFAULT 0,
	`skipped_count` int unsigned NOT NULL DEFAULT 0,
	`failed_count` int unsigned NOT NULL DEFAULT 0,
	`reason` varchar(200) NOT NULL,
	`created_by` bigint unsigned,
	`channel` varchar(10) NOT NULL,
	`created_at` datetime NOT NULL DEFAULT (now()),
	CONSTRAINT `email_campaigns_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `email_deliveries` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`campaign_id` bigint unsigned NOT NULL,
	`user_id` bigint unsigned,
	`address` varchar(191) NOT NULL,
	`status` varchar(20) NOT NULL,
	`error` varchar(300),
	`message_id` varchar(200),
	`processed_at` datetime NOT NULL,
	CONSTRAINT `email_deliveries_id` PRIMARY KEY(`id`),
	CONSTRAINT `uk_email_deliveries_user` UNIQUE(`campaign_id`,`user_id`)
);
--> statement-breakpoint
ALTER TABLE `users` ADD `ad_email_opt_in` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `night_opt_in` boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_email_campaigns_due` ON `email_campaigns` (`status`,`scheduled_at`);--> statement-breakpoint
CREATE INDEX `idx_email_campaigns_created` ON `email_campaigns` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_email_deliveries_campaign` ON `email_deliveries` (`campaign_id`,`status`);