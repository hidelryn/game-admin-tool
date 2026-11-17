CREATE TABLE `ranking_boards` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`code` varchar(20) NOT NULL,
	`name` varchar(50) NOT NULL,
	`sort_order` int unsigned NOT NULL DEFAULT 0,
	`created_at` datetime NOT NULL DEFAULT (now()),
	CONSTRAINT `ranking_boards_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_ranking_boards_code` UNIQUE(`code`)
);
--> statement-breakpoint
ALTER TABLE `ranking_seasons` ADD `board_id` int unsigned DEFAULT 1 NOT NULL;