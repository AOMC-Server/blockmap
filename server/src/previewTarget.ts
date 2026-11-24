import { MAX_FILTER_LENGTH } from "@blockmap/shared/featureFilter";
import { blockCoord } from "@blockmap/shared/schemas";
import { MIN_ZOOM } from "@blockmap/shared/view";
import { z } from "zod";
import type { Db } from "./db/client";
import { defaultDimension, dimensionBySlug } from "./dimensionLookup";
import type { Env } from "./env";
import { timeOfRev } from "./features";
import type { PreviewParams } from "./preview";
import { displayName } from "./siteName";
import type { MapRow } from "./types";

const coord = z.coerce.number().pipe(blockCoord);

/** The view parameters shared by /api/preview.png and the page's share tags. */
export const viewQuerySchema = z.object({
	dim: z
		.string()
		.max(40)
		.optional()
		.describe(
			"Dimension slug (default: the first dimension that is not archived)",
		),
	x: coord.optional().describe("Block X coordinate of the centre (default: 0)"),
	z: coord.optional().describe("Block Z coordinate of the centre (default: 0)"),
	zoom: z.coerce
		.number()
		.finite()
		.optional()
		.describe(
			"Zoom level, clamped to what the map supports (default: 2); fractions are allowed",
		),
	rev: z.coerce
		.number()
		.int()
		.min(0)
		.optional()
		.describe(
			"Show the map as of this revision (default and maximum: the latest)",
		),
	/** Layer ids, comma separated, like the viewer's `layers`; empty shows none, absent the defaults. */
	layers: z
		.string()
		.max(400)
		.optional()
		.describe(
			"Ids of the layers to show, comma-separated; empty shows none (default: each layer's default)",
		),
	/** Feature filter text, as the viewer's `filter`; text that does not parse is ignored. */
	filter: z
		.string()
		.max(MAX_FILTER_LENGTH)
		.optional()
		.describe(
			"Feature filter text: only the features it matches are drawn (default: all features)",
		),
});
export type ViewQuery = z.infer<typeof viewQuerySchema>;

export type PreviewTarget = {
	mapName: string;
	dimensionName: string;
	dimensionSlug: string;
	params: PreviewParams;
};

/** "1,2,3" to [1, 2, 3], skipping what is no layer id; null (each layer's default) when the query has no layers. */
export function parseLayerIds(value: string | undefined): number[] | null {
	if (value === undefined) return null;
	return value
		.split(",")
		.map((part) => Number(part.trim()))
		.filter((n) => Number.isInteger(n) && n > 0)
		.sort((a, b) => a - b);
}

/**
 * Resolves a view query to a concrete dimension, position and revision.
 * Returns null when the dimension does not exist (callers answer 404).
 */
export async function resolvePreviewTarget(
	db: Db,
	env: Env,
	map: MapRow,
	q: ViewQuery,
): Promise<PreviewTarget | null> {
	const dim = q.dim ? dimensionBySlug(db, q.dim) : defaultDimension(db);
	if (!dim) return null;

	const rev = Math.min(q.rev ?? map.headRev, map.headRev);
	const zoom =
		Math.round(Math.min(Math.max(q.zoom ?? 2, MIN_ZOOM), env.MAX_ZOOM) * 100) /
		100;
	return {
		mapName: displayName(map.name),
		dimensionName: dim.name,
		dimensionSlug: dim.slug,
		params: {
			dimensionId: dim.id,
			tileSize: map.tileSize,
			maxZoom: env.MAX_ZOOM,
			x: q.x ?? 0,
			z: q.z ?? 0,
			zoom,
			rev,
			featuresAt: timeOfRev(db, map.headRev, rev) ?? null,
			layers: parseLayerIds(q.layers),
			filter: q.filter ?? null,
			epoch: map.epoch,
		},
	};
}
