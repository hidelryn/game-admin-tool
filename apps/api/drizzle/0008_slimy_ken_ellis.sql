CREATE TABLE `products` (
	`id` int unsigned NOT NULL,
	`code` varchar(40) NOT NULL,
	`name` varchar(50) NOT NULL,
	`price_krw` int unsigned NOT NULL,
	`gem_amount` int unsigned NOT NULL,
	`sort_order` int unsigned NOT NULL DEFAULT 0,
	CONSTRAINT `products_id` PRIMARY KEY(`id`),
	CONSTRAINT `products_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `purchases` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`product_id` int unsigned NOT NULL,
	`price_krw` int unsigned NOT NULL,
	`gem_amount` int unsigned NOT NULL,
	`stage` int unsigned NOT NULL,
	`purchased_at` datetime NOT NULL,
	`created_at` datetime NOT NULL DEFAULT (now()),
	CONSTRAINT `purchases_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `users` ADD `max_stage` int unsigned DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_purchases_at` ON `purchases` (`purchased_at`);--> statement-breakpoint
CREATE INDEX `idx_purchases_user` ON `purchases` (`user_id`,`purchased_at`);