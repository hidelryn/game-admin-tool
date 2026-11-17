CREATE TABLE `assets` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`storage_key` varchar(64) NOT NULL,
	`mime` varchar(20) NOT NULL,
	`size` int unsigned NOT NULL,
	`width` int unsigned NOT NULL,
	`height` int unsigned NOT NULL,
	`sha256` varchar(64) NOT NULL,
	`original_name` varchar(200) NOT NULL,
	`created_by` bigint unsigned NOT NULL,
	`created_at` datetime NOT NULL DEFAULT (now()),
	CONSTRAINT `assets_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_assets_key` UNIQUE(`storage_key`)
);
--> statement-breakpoint
CREATE TABLE `schedules` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`kind` varchar(16) NOT NULL,
	`title` varchar(50) NOT NULL,
	`description` varchar(1000) NOT NULL DEFAULT '',
	`starts_at` datetime NOT NULL,
	`ends_at` datetime NOT NULL,
	`ranking_season_id` int unsigned,
	`popup_enabled` boolean NOT NULL DEFAULT false,
	`popup_frequency` varchar(12) NOT NULL DEFAULT 'DAILY',
	`banner_enabled` boolean NOT NULL DEFAULT false,
	`priority` int unsigned NOT NULL DEFAULT 0,
	`image_asset_id` bigint unsigned,
	`link` varchar(300),
	`canceled_at` datetime,
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_by` bigint unsigned NOT NULL,
	`updated_by` bigint unsigned NOT NULL,
	`created_at` datetime NOT NULL DEFAULT (now()),
	`updated_at` datetime NOT NULL DEFAULT (now()),
	CONSTRAINT `schedules_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_schedules_season` UNIQUE(`ranking_season_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_assets_sha` ON `assets` (`sha256`);--> statement-breakpoint
CREATE INDEX `idx_schedules_period` ON `schedules` (`starts_at`,`ends_at`);