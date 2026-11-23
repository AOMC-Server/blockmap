CREATE TABLE `feature_players` (
	`feature_id` integer NOT NULL,
	`player_id` integer NOT NULL,
	`role` text NOT NULL,
	PRIMARY KEY(`feature_id`, `player_id`, `role`),
	FOREIGN KEY (`feature_id`) REFERENCES `features`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `feature_players_player` ON `feature_players` (`player_id`);--> statement-breakpoint
CREATE TABLE `players` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`uuid` text NOT NULL,
	`name` text NOT NULL,
	`head` blob,
	`skin_url` text,
	`checked_at` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `players_uuid_unique` ON `players` (`uuid`);--> statement-breakpoint
CREATE INDEX `players_name` ON `players` (`name`);--> statement-breakpoint
CREATE INDEX `players_checked` ON `players` (`checked_at`);--> statement-breakpoint
ALTER TABLE `feature_revisions` ADD `owner_player_id` integer REFERENCES players(id);--> statement-breakpoint
ALTER TABLE `feature_revisions` ADD `builder_ids` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
CREATE INDEX `feature_revisions_owner` ON `feature_revisions` (`owner_player_id`);