import type { FeatureType, Point } from "@blockmap/shared/features";
import type { Player } from "@blockmap/shared/players";
import { TYPE_LABEL } from "./featureInfo";

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

/** A feature on a player's page, as the server lists it. */
export type PlayerFeature = {
	id: number;
	layerId: number;
	layerName: string;
	layerColor: string;
	dimension: string;
	type: FeatureType;
	name: string;
	color: string | null;
	center: Point;
	ownerId: number | null;
	builderIds: number[];
};

/** Someone else attributed with a feature of a player's page. */
export type Collaborator = { player: Player; role: "owner" | "builder" };

export type PlayerFeatureRow = PlayerFeature & {
	/** Whether the page's player owns it, and whether they helped build it. */
	owns: boolean;
	built: boolean;
	/** The owner (when it is someone else), then the other builders. */
	others: Collaborator[];
};

export type PlayerLayerGroup = {
	layerId: number;
	layerName: string;
	layerColor: string;
	dimension: string;
	/** How many of the layer's features the player owns, and helped build; whatever the search. */
	owned: number;
	built: number;
	features: PlayerFeatureRow[];
};

export type PlayerFeatureSort = "owned" | "built" | "name";

const byName = (a: string, b: string) =>
	a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });

/**
 * The features a player owns or built, one row each, in groups by layer. A layer whose name (or
 * dimension's name) matches `query` is listed whole; otherwise only the features whose name, type
 * or other players match are. `sort` orders the layers, and the features in each: "owned" puts
 * the ones the player owns most of first, "built" the ones they built most of, "name" goes by name.
 */
export function groupPlayerFeatures(opts: {
	playerId: number;
	owned: readonly PlayerFeature[];
	built: readonly PlayerFeature[];
	players: ReadonlyMap<number, Player>;
	query?: string;
	sort?: PlayerFeatureSort;
	dimensionName?: (slug: string) => string;
}): PlayerLayerGroup[] {
	const { playerId, players } = opts;
	const sort = opts.sort ?? "owned";
	const q = (opts.query ?? "").trim().toLowerCase();
	const dimensionName = opts.dimensionName ?? ((slug: string) => slug);

	const rows = new Map<number, PlayerFeatureRow>();
	for (const [list, role] of [
		[opts.owned, "owns"],
		[opts.built, "built"],
	] as const)
		for (const f of list) {
			const row = rows.get(f.id) ?? {
				...f,
				owns: false,
				built: false,
				others: [],
			};
			row[role] = true;
			rows.set(f.id, row);
		}
	for (const row of rows.values()) {
		const owner =
			row.ownerId !== null && row.ownerId !== playerId
				? players.get(row.ownerId)
				: undefined;
		row.others = [
			...(owner ? [{ player: owner, role: "owner" as const }] : []),
			...row.builderIds
				.filter((id) => id !== playerId && id !== row.ownerId)
				.flatMap((id) => {
					const p = players.get(id);
					return p ? [{ player: p, role: "builder" as const }] : [];
				}),
		];
	}

	const groups = new Map<number, PlayerLayerGroup>();
	for (const row of rows.values()) {
		const g = groups.get(row.layerId) ?? {
			layerId: row.layerId,
			layerName: row.layerName,
			layerColor: row.layerColor,
			dimension: row.dimension,
			owned: 0,
			built: 0,
			features: [],
		};
		if (row.owns) g.owned++;
		if (row.built) g.built++;
		g.features.push(row);
		groups.set(row.layerId, g);
	}

	const matches = (row: PlayerFeatureRow) =>
		[
			row.name,
			TYPE_LABEL[row.type],
			...row.others.map((o) => o.player.name),
		].some((text) => text.toLowerCase().includes(q));
	const out: PlayerLayerGroup[] = [];
	for (const g of groups.values()) {
		const whole =
			!q ||
			g.layerName.toLowerCase().includes(q) ||
			dimensionName(g.dimension).toLowerCase().includes(q);
		const features = whole ? g.features : g.features.filter(matches);
		if (features.length > 0) out.push({ ...g, features });
	}

	const rank = (owned: number, built: number) =>
		sort === "owned" ? [owned, built] : sort === "built" ? [built, owned] : [];
	const compare = (a: number[], b: number[]) => {
		for (let i = 0; i < a.length; i++) {
			const d = (b[i] ?? 0) - (a[i] ?? 0);
			if (d) return d;
		}
		return 0;
	};
	for (const g of out)
		g.features.sort(
			(a, b) =>
				compare(
					rank(Number(a.owns), Number(a.built)),
					rank(Number(b.owns), Number(b.built)),
				) ||
				Number(!a.name) - Number(!b.name) ||
				byName(a.name, b.name) ||
				a.id - b.id,
		);
	return out.sort(
		(a, b) =>
			compare(rank(a.owned, a.built), rank(b.owned, b.built)) ||
			byName(a.layerName, b.layerName) ||
			byName(dimensionName(a.dimension), dimensionName(b.dimension)) ||
			a.layerId - b.layerId,
	);
}
