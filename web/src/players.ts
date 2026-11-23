import type { Point } from "@blockmap/shared/features";
import type { Player } from "@blockmap/shared/players";

export const playerHeadUrl = (id: number) => `/api/players/${id}/head.png`;

/** The head of an account the map does not have yet. */
export const lookupHeadUrl = (uuid: string) =>
	`/api/players/lookup/head.png?uuid=${encodeURIComponent(uuid)}`;

export const playerPageUrl = (player: { id: number }) =>
	`/players/${player.id}`;

/** The map at a feature of a player's page; the map fits the view to it and opens its popup. */
export function featureMapUrl(f: {
	id: number;
	dimension: string;
	center: Point;
}): string {
	const q = new URLSearchParams({
		dim: f.dimension,
		x: String(f.center[0]),
		z: String(f.center[1]),
		feature: String(f.id),
	});
	return `/?${q}`;
}

/** Who a version of a feature is attributed to. */
export type Attribution = {
	ownerId: number | null;
	owner: Player | null;
	builderIds: number[];
	builders: Player[];
};

export type AttributionChange = {
	owner: { from: Player | null; to: Player | null } | null;
	added: Player[];
	removed: Player[];
};

/** What changed from `older` (null for a feature that did not exist yet) to `newer`; null if nothing did. */
export function attributionChange(
	older: Attribution | null,
	newer: Attribution,
): AttributionChange | null {
	const before = older?.builderIds ?? [];
	const owner =
		(older?.ownerId ?? null) === newer.ownerId
			? null
			: { from: older?.owner ?? null, to: newer.owner };
	const added = newer.builders.filter((b) => !before.includes(b.id));
	const removed = (older?.builders ?? []).filter(
		(b) => !newer.builderIds.includes(b.id),
	);
	if (!owner && added.length === 0 && removed.length === 0) return null;
	return { owner, added, removed };
}
