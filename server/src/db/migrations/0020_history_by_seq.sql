UPDATE `revisions` SET `status` = 'done' WHERE `status` = 'processing' AND `rev` IS NOT NULL;--> statement-breakpoint
ALTER TABLE `revisions` ADD `seq` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `revisions_seq_unique` ON `revisions` (`seq`);--> statement-breakpoint
UPDATE `revisions` SET `seq` = (
	SELECT r.`at` * 1024 + r.`n` FROM (
		SELECT `id`, coalesce(`exported_at`, `created_at`) AS `at`,
			row_number() OVER (PARTITION BY coalesce(`exported_at`, `created_at`) ORDER BY `rev`) - 1 AS `n`
		FROM `revisions` WHERE `status` = 'done' AND `rev` IS NOT NULL
	) r WHERE r.`id` = `revisions`.`id`
) WHERE `status` = 'done' AND `rev` IS NOT NULL;--> statement-breakpoint
DELETE FROM `tile_versions_rebuild`;--> statement-breakpoint
ALTER TABLE `tile_versions_rebuild` RENAME COLUMN `rev` TO `seq`;--> statement-breakpoint
DELETE FROM `tile_versions` WHERE `rev` NOT IN (SELECT `rev` FROM `revisions` WHERE `seq` IS NOT NULL);--> statement-breakpoint
ALTER TABLE `tile_versions` RENAME COLUMN `rev` TO `seq`;--> statement-breakpoint
UPDATE `tile_versions` SET `seq` = -`seq`;--> statement-breakpoint
UPDATE `tile_versions` SET `seq` = (SELECT r.`seq` FROM `revisions` r WHERE r.`rev` = -`tile_versions`.`seq`);--> statement-breakpoint
UPDATE `map_info` SET `recompute_pending` = 1 WHERE EXISTS (
	SELECT 1 FROM `revisions` a JOIN `revisions` b ON a.`dimension_id` = b.`dimension_id` AND a.`rev` < b.`rev` AND a.`seq` > b.`seq`
	WHERE a.`seq` IS NOT NULL AND b.`seq` IS NOT NULL
);--> statement-breakpoint
DELETE FROM `jobs` WHERE `type` = 'recompute_history';--> statement-breakpoint
UPDATE `short_links` SET `query` = substr(`query`, 1, instr(`query`, '&rev=')) || 'seq=' || coalesce(
	(SELECT `seq` FROM `revisions` WHERE `rev` = CAST(substr(`query`, instr(`query`, '&rev=') + 5) AS INTEGER) AND `seq` IS NOT NULL),
	CASE WHEN CAST(substr(`query`, instr(`query`, '&rev=') + 5) AS INTEGER) = 0 THEN -9007199254740991
		ELSE coalesce((SELECT max(`seq`) FROM `revisions`), -9007199254740991) END
) || substr(substr(`query`, instr(`query`, '&rev=') + 5), length(CAST(substr(`query`, instr(`query`, '&rev=') + 5) AS INTEGER)) + 1)
WHERE instr(`query`, '&rev=') > 0;--> statement-breakpoint
UPDATE `revisions` SET `rev` = -`rev` WHERE `rev` IS NOT NULL;--> statement-breakpoint
UPDATE `revisions` SET `rev` = (SELECT count(*) FROM `revisions` r WHERE r.`seq` <= `revisions`.`seq`) WHERE `seq` IS NOT NULL;--> statement-breakpoint
UPDATE `revisions` SET `rev` = NULL WHERE `seq` IS NULL;--> statement-breakpoint
UPDATE `map_info` SET `head_rev` = (SELECT count(*) FROM `revisions` WHERE `seq` IS NOT NULL);
