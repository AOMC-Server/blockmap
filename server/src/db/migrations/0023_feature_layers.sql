CREATE TABLE `feature_layers` (
	`feature_id` integer NOT NULL,
	`layer_id` integer NOT NULL,
	PRIMARY KEY(`feature_id`, `layer_id`),
	FOREIGN KEY (`feature_id`) REFERENCES `features`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`layer_id`) REFERENCES `layers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `feature_layers_layer` ON `feature_layers` (`layer_id`);--> statement-breakpoint
ALTER TABLE `feature_revisions` ADD `also_in` text DEFAULT '[]' NOT NULL;