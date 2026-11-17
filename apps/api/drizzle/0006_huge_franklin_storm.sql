CREATE TABLE `maintenances` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`title` varchar(50) NOT NULL,
	`message` varchar(500) NOT NULL,
	`starts_at` datetime NOT NULL,
	`ends_at` datetime NOT NULL,
	`started_at` datetime,
	`ended_at` datetime,
	`canceled_at` datetime,
	`allow_public_ids` json NOT NULL,
	`session_epoch` int unsigned,
	`notice_id` bigint unsigned,
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_by` bigint unsigned NOT NULL,
	`updated_by` bigint unsigned NOT NULL,
	`created_at` datetime NOT NULL DEFAULT (now()),
	`updated_at` datetime NOT NULL DEFAULT (now()),
	CONSTRAINT `maintenances_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `notices` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`category` varchar(12) NOT NULL,
	`title` varchar(60) NOT NULL,
	`body` varchar(5000) NOT NULL,
	`starts_at` datetime NOT NULL,
	`ends_at` datetime,
	`pinned` boolean NOT NULL DEFAULT false,
	`ticker_enabled` boolean NOT NULL DEFAULT false,
	`ticker_text` varchar(80),
	`hidden_at` datetime,
	`maintenance_id` bigint unsigned,
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_by` bigint unsigned NOT NULL,
	`updated_by` bigint unsigned NOT NULL,
	`created_at` datetime NOT NULL DEFAULT (now()),
	`updated_at` datetime NOT NULL DEFAULT (now()),
	CONSTRAINT `notices_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_maintenances_period` ON `maintenances` (`starts_at`,`ends_at`);--> statement-breakpoint
CREATE INDEX `idx_notices_period` ON `notices` (`starts_at`,`ends_at`);--> statement-breakpoint
CREATE INDEX `idx_notices_maintenance` ON `notices` (`maintenance_id`);