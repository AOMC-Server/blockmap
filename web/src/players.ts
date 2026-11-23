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

/** How many recently picked players are kept. */
export const MAX_RECENT_PLAYERS = 8;

/** The recently picked players, from stored JSON; anything that is not a player is skipped. */
export function parseRecentPlayers(raw: string | null): Player[] {
	if (!raw) return [];
	try {
		const data = JSON.parse(raw) as unknown;
		if (!Array.isArray(data)) return [];
		const seen = new Set<number>();
		const out: Player[] = [];
		for (const p of data) {
			if (
				typeof p?.id === "number" &&
				Number.isInteger(p.id) &&
				p.id > 0 &&
				typeof p.uuid === "string" &&
				typeof p.name === "string" &&
				!seen.has(p.id)
			) {
				seen.add(p.id);
				out.push({ id: p.id, uuid: p.uuid, name: p.name });
			}
		}
		return out.slice(0, MAX_RECENT_PLAYERS);
	} catch {
		return [];
	}
}

/** The list with `player` moved (or added) to the front; the oldest fall off the end. */
export function withRecentPlayer(recent: readonly Player[], player: Player) {
	return [player, ...recent.filter((p) => p.id !== player.id)].slice(
		0,
		MAX_RECENT_PLAYERS,
	);
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
