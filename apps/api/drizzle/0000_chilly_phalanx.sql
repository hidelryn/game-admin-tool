CREATE TABLE `admin_permission_overrides` (
	`admin_id` bigint unsigned NOT NULL,
	`permission_id` int unsigned NOT NULL,
	`effect` varchar(10) NOT NULL,
	`created_at` datetime NOT NULL DEFAULT (now()),
	CONSTRAINT `admin_permission_overrides_admin_id_permission_id_pk` PRIMARY KEY(`admin_id`,`permission_id`)
);
--> statement-breakpoint
CREATE TABLE `admins` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`email` varchar(191) NOT NULL,
	`password_hash` varchar(255) NOT NULL,
	`name` varchar(50) NOT NULL,
	`role_id` int unsigned NOT NULL,
	`status` varchar(20) NOT NULL DEFAULT 'ACTIVE',
	`perm_version` int unsigned NOT NULL DEFAULT 1,
	`must_change_password` boolean NOT NULL DEFAULT false,
	`failed_login_count` int unsigned NOT NULL DEFAULT 0,
	`locked_until` datetime,
	`last_login_at` datetime,
	`created_at` datetime NOT NULL DEFAULT (now()),
	`updated_at` datetime NOT NULL DEFAULT (now()),
	CONSTRAINT `admins_id` PRIMARY KEY(`id`),
	CONSTRAINT `admins_email_unique` UNIQUE(`email`)
);
--> statement-breakpoint
CREATE TABLE `api_tokens` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`admin_id` bigint unsigned NOT NULL,
	`name` varchar(50) NOT NULL,
	`prefix` varchar(16) NOT NULL,
	`secret_hash` char(64) NOT NULL,
	`permissions` json NOT NULL,
	`expires_at` datetime NOT NULL,
	`last_used_at` datetime,
	`last_used_ip` varchar(45),
	`revoked_at` datetime,
	`created_at` datetime NOT NULL DEFAULT (now()),
	CONSTRAINT `api_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `api_tokens_prefix_unique` UNIQUE(`prefix`)
);
--> statement-breakpoint
CREATE TABLE `permissions` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`code` varchar(50) NOT NULL,
	`description` varchar(200) NOT NULL,
	CONSTRAINT `permissions_id` PRIMARY KEY(`id`),
	CONSTRAINT `permissions_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `refresh_tokens` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`admin_id` bigint unsigned NOT NULL,
	`token_hash` char(64) NOT NULL,
	`family_id` char(36) NOT NULL,
	`expires_at` datetime NOT NULL,
	`used_at` datetime,
	`revoked_at` datetime,
	`ip` varchar(45),
	`user_agent` varchar(255),
	`created_at` datetime NOT NULL DEFAULT (now()),
	CONSTRAINT `refresh_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `refresh_tokens_token_hash_unique` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `role_permissions` (
	`role_id` int unsigned NOT NULL,
	`permission_id` int unsigned NOT NULL,
	CONSTRAINT `role_permissions_role_id_permission_id_pk` PRIMARY KEY(`role_id`,`permission_id`)
);
--> statement-breakpoint
CREATE TABLE `roles` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`code` varchar(30) NOT NULL,
	`name` varchar(50) NOT NULL,
	`created_at` datetime NOT NULL DEFAULT (now()),
	CONSTRAINT `roles_id` PRIMARY KEY(`id`),
	CONSTRAINT `roles_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `user_activity_logs` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`type` varchar(30) NOT NULL,
	`payload` json,
	`occurred_at` datetime NOT NULL,
	CONSTRAINT `user_activity_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `user_suspensions` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`reason` varchar(200) NOT NULL,
	`starts_at` datetime NOT NULL,
	`ends_at` datetime,
	`suspended_by` bigint unsigned,
	`released_at` datetime,
	`released_by` bigint unsigned,
	`release_reason` varchar(200),
	`created_at` datetime NOT NULL DEFAULT (now()),
	CONSTRAINT `user_suspensions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` varchar(20) NOT NULL,
	`nickname` varchar(30) NOT NULL,
	`email` varchar(191) NOT NULL,
	`level` int unsigned NOT NULL DEFAULT 1,
	`status` varchar(20) NOT NULL DEFAULT 'ACTIVE',
	`registered_at` datetime NOT NULL,
	`last_login_at` datetime,
	`created_at` datetime NOT NULL DEFAULT (now()),
	`updated_at` datetime NOT NULL DEFAULT (now()),
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_public_id_unique` UNIQUE(`public_id`)
);
--> statement-breakpoint
CREATE TABLE `currencies` (
	`id` int unsigned NOT NULL,
	`code` varchar(20) NOT NULL,
	`name` varchar(30) NOT NULL,
	`is_paid` boolean NOT NULL,
	`max_balance` bigint NOT NULL,
	`grant_limit_per_request` bigint NOT NULL,
	CONSTRAINT `currencies_id` PRIMARY KEY(`id`),
	CONSTRAINT `currencies_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `currency_transactions` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`currency_id` int unsigned NOT NULL,
	`delta` bigint NOT NULL,
	`balance_before` bigint NOT NULL,
	`balance_after` bigint NOT NULL,
	`source` varchar(10) NOT NULL,
	`reason` varchar(200),
	`admin_id` bigint unsigned,
	`channel` varchar(10),
	`mail_id` bigint unsigned,
	`request_id` varchar(64),
	`created_at` datetime NOT NULL DEFAULT (now()),
	CONSTRAINT `currency_transactions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `items` (
	`id` int unsigned NOT NULL,
	`code` varchar(40) NOT NULL,
	`name` varchar(50) NOT NULL,
	`stackable` boolean NOT NULL DEFAULT true,
	CONSTRAINT `items_id` PRIMARY KEY(`id`),
	CONSTRAINT `items_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `user_currencies` (
	`user_id` bigint unsigned NOT NULL,
	`currency_id` int unsigned NOT NULL,
	`balance` bigint NOT NULL DEFAULT 0,
	`version` int unsigned NOT NULL DEFAULT 0,
	`updated_at` datetime NOT NULL DEFAULT (now()),
	CONSTRAINT `user_currencies_user_id_currency_id_pk` PRIMARY KEY(`user_id`,`currency_id`)
);
--> statement-breakpoint
CREATE TABLE `user_items` (
	`user_id` bigint unsigned NOT NULL,
	`item_id` int unsigned NOT NULL,
	`quantity` bigint unsigned NOT NULL DEFAULT 0,
	`updated_at` datetime NOT NULL DEFAULT (now()),
	CONSTRAINT `user_items_user_id_item_id_pk` PRIMARY KEY(`user_id`,`item_id`)
);
--> statement-breakpoint
CREATE TABLE `global_mail_claims` (
	`mail_id` bigint unsigned NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`claimed_at` datetime NOT NULL,
	CONSTRAINT `global_mail_claims_mail_id_user_id_pk` PRIMARY KEY(`mail_id`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `mail_recipients` (
	`mail_id` bigint unsigned NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`read_at` datetime,
	`claimed_at` datetime,
	CONSTRAINT `mail_recipients_mail_id_user_id_pk` PRIMARY KEY(`mail_id`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `mail_rewards` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`mail_id` bigint unsigned NOT NULL,
	`reward_type` varchar(10) NOT NULL,
	`ref_id` int unsigned NOT NULL,
	`quantity` bigint NOT NULL,
	CONSTRAINT `mail_rewards_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `mails` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`type` varchar(10) NOT NULL,
	`title` varchar(50) NOT NULL,
	`body` varchar(500) NOT NULL,
	`status` varchar(20) NOT NULL,
	`scheduled_at` datetime,
	`sent_at` datetime,
	`expires_at` datetime NOT NULL,
	`target_filter` json,
	`created_by` bigint unsigned NOT NULL,
	`reason` varchar(200) NOT NULL,
	`canceled_at` datetime,
	`created_at` datetime NOT NULL DEFAULT (now()),
	CONSTRAINT `mails_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `ranking_scores` (
	`season_id` int unsigned NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`score` bigint NOT NULL,
	`achieved_at` datetime NOT NULL,
	CONSTRAINT `ranking_scores_season_id_user_id_pk` PRIMARY KEY(`season_id`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `ranking_seasons` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`name` varchar(50) NOT NULL,
	`status` varchar(10) NOT NULL,
	`starts_at` datetime NOT NULL,
	`ends_at` datetime,
	`reset_count` int unsigned NOT NULL DEFAULT 0,
	`created_at` datetime NOT NULL DEFAULT (now()),
	CONSTRAINT `ranking_seasons_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `ranking_snapshots` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`season_id` int unsigned NOT NULL,
	`snapshot_id` char(36) NOT NULL,
	`rank_no` int unsigned NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`score` bigint NOT NULL,
	`reason` varchar(200) NOT NULL,
	`created_at` datetime NOT NULL DEFAULT (now()),
	CONSTRAINT `ranking_snapshots_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `approval_requests` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`action` varchar(50) NOT NULL,
	`payload` json NOT NULL,
	`payload_hash` char(64) NOT NULL,
	`status` varchar(20) NOT NULL,
	`requested_by` bigint unsigned NOT NULL,
	`reviewed_by` bigint unsigned,
	`review_comment` varchar(200),
	`reviewed_at` datetime,
	`executed_at` datetime,
	`result_data` json,
	`error_code` varchar(50),
	`expires_at` datetime NOT NULL,
	`created_at` datetime NOT NULL DEFAULT (now()),
	`updated_at` datetime NOT NULL DEFAULT (now()),
	CONSTRAINT `approval_requests_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`admin_id` bigint unsigned,
	`api_token_id` bigint unsigned,
	`channel` varchar(10) NOT NULL,
	`action` varchar(50) NOT NULL,
	`target_type` varchar(30),
	`target_id` varchar(64),
	`reason` varchar(200),
	`before_data` json,
	`after_data` json,
	`result` varchar(10) NOT NULL,
	`error_code` varchar(50),
	`request_id` varchar(64),
	`ip` varchar(45),
	`created_at` datetime NOT NULL DEFAULT (now()),
	CONSTRAINT `audit_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `daily_currency_stats` (
	`stat_date` date NOT NULL,
	`currency_id` int unsigned NOT NULL,
	`issued` bigint NOT NULL DEFAULT 0,
	`consumed` bigint NOT NULL DEFAULT 0,
	CONSTRAINT `daily_currency_stats_stat_date_currency_id_pk` PRIMARY KEY(`stat_date`,`currency_id`)
);
--> statement-breakpoint
CREATE TABLE `daily_kpis` (
	`stat_date` date NOT NULL,
	`dau` int unsigned NOT NULL DEFAULT 0,
	`nru` int unsigned NOT NULL DEFAULT 0,
	`suspended_total` int unsigned NOT NULL DEFAULT 0,
	`updated_at` datetime NOT NULL DEFAULT (now()),
	CONSTRAINT `daily_kpis_stat_date` PRIMARY KEY(`stat_date`)
);
--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`admin_id` bigint unsigned NOT NULL,
	`idem_key` varchar(64) NOT NULL,
	`request_hash` char(64) NOT NULL,
	`response_status` int NOT NULL,
	`response_body` json,
	`created_at` datetime NOT NULL DEFAULT (now()),
	CONSTRAINT `idempotency_keys_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_idem_admin_key` UNIQUE(`admin_id`,`idem_key`)
);
--> statement-breakpoint
ALTER TABLE `admin_permission_overrides` ADD CONSTRAINT `admin_permission_overrides_admin_id_admins_id_fk` FOREIGN KEY (`admin_id`) REFERENCES `admins`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `admin_permission_overrides` ADD CONSTRAINT `admin_permission_overrides_permission_id_permissions_id_fk` FOREIGN KEY (`permission_id`) REFERENCES `permissions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `admins` ADD CONSTRAINT `admins_role_id_roles_id_fk` FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `api_tokens` ADD CONSTRAINT `api_tokens_admin_id_admins_id_fk` FOREIGN KEY (`admin_id`) REFERENCES `admins`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `refresh_tokens` ADD CONSTRAINT `refresh_tokens_admin_id_admins_id_fk` FOREIGN KEY (`admin_id`) REFERENCES `admins`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `role_permissions` ADD CONSTRAINT `role_permissions_role_id_roles_id_fk` FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `role_permissions` ADD CONSTRAINT `role_permissions_permission_id_permissions_id_fk` FOREIGN KEY (`permission_id`) REFERENCES `permissions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_suspensions` ADD CONSTRAINT `user_suspensions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_currencies` ADD CONSTRAINT `user_currencies_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_currencies` ADD CONSTRAINT `user_currencies_currency_id_currencies_id_fk` FOREIGN KEY (`currency_id`) REFERENCES `currencies`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_items` ADD CONSTRAINT `user_items_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_items` ADD CONSTRAINT `user_items_item_id_items_id_fk` FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `global_mail_claims` ADD CONSTRAINT `global_mail_claims_mail_id_mails_id_fk` FOREIGN KEY (`mail_id`) REFERENCES `mails`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `global_mail_claims` ADD CONSTRAINT `global_mail_claims_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mail_recipients` ADD CONSTRAINT `mail_recipients_mail_id_mails_id_fk` FOREIGN KEY (`mail_id`) REFERENCES `mails`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mail_recipients` ADD CONSTRAINT `mail_recipients_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mail_rewards` ADD CONSTRAINT `mail_rewards_mail_id_mails_id_fk` FOREIGN KEY (`mail_id`) REFERENCES `mails`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ranking_scores` ADD CONSTRAINT `ranking_scores_season_id_ranking_seasons_id_fk` FOREIGN KEY (`season_id`) REFERENCES `ranking_seasons`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_admins_role` ON `admins` (`role_id`);--> statement-breakpoint
CREATE INDEX `idx_api_tokens_admin` ON `api_tokens` (`admin_id`);--> statement-breakpoint
CREATE INDEX `idx_refresh_family` ON `refresh_tokens` (`family_id`);--> statement-breakpoint
CREATE INDEX `idx_refresh_admin` ON `refresh_tokens` (`admin_id`);--> statement-breakpoint
CREATE INDEX `idx_activity_user` ON `user_activity_logs` (`user_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_activity_type` ON `user_activity_logs` (`type`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_suspensions_user` ON `user_suspensions` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_suspensions_expiry` ON `user_suspensions` (`released_at`,`ends_at`);--> statement-breakpoint
CREATE INDEX `idx_users_nickname` ON `users` (`nickname`);--> statement-breakpoint
CREATE INDEX `idx_users_status_registered` ON `users` (`status`,`registered_at`);--> statement-breakpoint
CREATE INDEX `idx_users_last_login` ON `users` (`last_login_at`);--> statement-breakpoint
CREATE INDEX `idx_ctx_user` ON `currency_transactions` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_ctx_admin` ON `currency_transactions` (`admin_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_ctx_created_currency` ON `currency_transactions` (`created_at`,`currency_id`);--> statement-breakpoint
CREATE INDEX `idx_mail_recipients_user` ON `mail_recipients` (`user_id`,`claimed_at`);--> statement-breakpoint
CREATE INDEX `idx_mail_rewards_mail` ON `mail_rewards` (`mail_id`);--> statement-breakpoint
CREATE INDEX `idx_mails_type_created` ON `mails` (`type`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_mails_status_scheduled` ON `mails` (`status`,`scheduled_at`);--> statement-breakpoint
CREATE INDEX `idx_scores_order` ON `ranking_scores` (`season_id`,`score`,`achieved_at`);--> statement-breakpoint
CREATE INDEX `idx_snapshots` ON `ranking_snapshots` (`season_id`,`snapshot_id`,`rank_no`);--> statement-breakpoint
CREATE INDEX `idx_approval_status` ON `approval_requests` (`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_approval_requester` ON `approval_requests` (`requested_by`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_admin` ON `audit_logs` (`admin_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_target` ON `audit_logs` (`target_type`,`target_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_action` ON `audit_logs` (`action`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_created` ON `audit_logs` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_idem_created` ON `idempotency_keys` (`created_at`);