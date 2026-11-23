import { MAX_FEATURES_PER_LAYER, type Role } from "@blockmap/shared";
import { and, inArray, isNull } from "drizzle-orm";
import type { Db } from "./db/client";
import { layers } from "./db/schema";
import { liveFeatureCount } from "./features";
import { type Actor, canEditLayer, loadLayerAccess } from "./permissions";

/** The ids among `ids` of layers that are not deleted. */
export function liveLayerIds(db: Pick<Db, "select">, ids: number[]): number[] {
	if (ids.length === 0) return [];
	const live = new Set(
		db
			.select({ id: layers.id })
			.from(layers)
			.where(and(inArray(layers.id, ids), isNull(layers.deletedAt)))
			.all()
			.map((l) => l.id),
	);
	return ids.filter((id) => live.has(id));
}

export type LinkFailure = { status: 400 | 403 | 404; error: string };

/**
 * Whether the actor may change the layers a feature is shown in from `before` to `after`:
 * they must be able to edit each layer that is added or taken away (a layer that no longer
 * exists can always be dropped), and a layer must be in the feature's dimension. The home layer,
 * and `moveTo` when the feature is being moved there, are not counted as others. Null: allowed.
 */
export async function checkLinkChange(
	db: Db,
	actor: Actor,
	role: Role,
	dimensionId: number,
	before: number[],
	after: number[],
	skip: number[],
): Promise<LinkFailure | null> {
	const added = after.filter(
		(id) => !before.includes(id) && !skip.includes(id),
	);
	const removed = before.filter(
		(id) => !after.includes(id) && !skip.includes(id),
	);
	for (const id of added) {
		const target = await loadLayerAccess(db, actor, role, id);
		if (!target) return { status: 404, error: "layer not found" };
		if (!canEditLayer(role, target.layer, target.layerRole))
			return { status: 403, error: "forbidden" };
		if (target.layer.dimensionId !== dimensionId)
			return {
				status: 400,
				error: "a feature can only be shown in layers of its own dimension",
			};
	}
	for (const id of removed) {
		if (liveLayerIds(db, [id]).length === 0) continue;
		const target = await loadLayerAccess(db, actor, role, id);
		if (!target || !canEditLayer(role, target.layer, target.layerRole))
			return { status: 403, error: "forbidden" };
	}
	return null;
}

/** The first layer in `ids` that has no room for another feature, or null. */
export function firstFullLayer(db: Pick<Db, "all">, ids: number[]) {
	return (
		ids.find((id) => liveFeatureCount(db, id) >= MAX_FEATURES_PER_LAYER) ?? null
	);
}
