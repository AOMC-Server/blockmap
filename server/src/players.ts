import type { Player, PlayerRef } from "@blockmap/shared";
import { asc, eq, inArray, lt } from "drizzle-orm";
import type { Db } from "./db/client";
import { featurePlayers, players } from "./db/schema";
import {
	headFromSkin,
	type Mojang,
	type MojangProfile,
	MojangUnavailable,
} from "./mojang";

type PlayerRow = typeof players.$inferSelect;

/** How long a player's name and skin are trusted before the refresher checks them again. */
export const PLAYER_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
const REFRESH_EVERY_MS = 10 * 60 * 1000;
const REFRESH_BATCH = 20;

export const toPlayer = (
	r: Pick<PlayerRow, "id" | "uuid" | "name">,
): Player => ({
	id: r.id,
	uuid: r.uuid,
	name: r.name,
});

const playerColumns = {
	id: players.id,
	uuid: players.uuid,
	name: players.name,
};

/** The players with the given ids, by id. */
export function playersById(
	db: Pick<Db, "select">,
	ids: Iterable<number>,
): Map<number, Player> {
	const list = [...new Set(ids)];
	if (list.length === 0) return new Map();
	const rows = db
		.select(playerColumns)
		.from(players)
		.where(inArray(players.id, list))
		.all();
	return new Map(rows.map((r) => [r.id, toPlayer(r)]));
}

/**
 * Player ids for the references of a feature. A `{uuid, name}` the map does not know yet adds
 * the player, to be checked with Mojang by the refresher. Returns the first unknown id instead
 * when there is one.
 */
export function resolvePlayerRefs(
	db: Pick<Db, "select" | "insert">,
	refs: PlayerRef[],
	userId: string | null,
): { ids: number[] } | { unknown: number } {
	const ids: number[] = [];
	const known = playersById(
		db,
		refs.filter((r): r is number => typeof r === "number"),
	);
	for (const ref of refs) {
		if (typeof ref === "number") {
			if (!known.has(ref)) return { unknown: ref };
			ids.push(ref);
			continue;
		}
		const existing = db
			.select({ id: players.id })
			.from(players)
			.where(eq(players.uuid, ref.uuid))
			.get();
		if (existing) {
			ids.push(existing.id);
			continue;
		}
		const row = db
			.insert(players)
			.values({ uuid: ref.uuid, name: ref.name, createdBy: userId })
			.returning({ id: players.id })
			.get();
		ids.push(row.id);
	}
	// The same player given once by id and once by UUID counts once.
	return { ids: [...new Set(ids)] };
}

/** Makes feature_players match a feature's latest revision. */
export function syncFeaturePlayers(
	db: Pick<Db, "insert" | "delete">,
	featureId: number,
	r: { deleted: boolean; ownerId: number | null; builderIds: number[] },
) {
	db.delete(featurePlayers)
		.where(eq(featurePlayers.featureId, featureId))
		.run();
	if (r.deleted) return;
	const rows = [
		...(r.ownerId === null
			? []
			: [{ featureId, playerId: r.ownerId, role: "owner" as const }]),
		...r.builderIds.map((playerId) => ({
			featureId,
			playerId,
			role: "builder" as const,
		})),
	];
	if (rows.length > 0)
		db.insert(featurePlayers).values(rows).onConflictDoNothing().run();
}

/** Brings a player's name and head up to date with a profile from Mojang. */
async function applyProfile(
	db: Db,
	mojang: Mojang,
	row: Pick<PlayerRow, "id" | "skinUrl" | "head">,
	profile: MojangProfile,
) {
	const set: Partial<PlayerRow> = { name: profile.name, checkedAt: Date.now() };
	if (profile.skinUrl !== row.skinUrl || row.head === null) {
		if (profile.skinUrl === null) {
			set.head = null;
			set.skinUrl = null;
		} else {
			try {
				set.head = await headFromSkin(await mojang.skin(profile.skinUrl));
				set.skinUrl = profile.skinUrl;
			} catch (err) {
				// Keep the old head; the next refresh tries again.
				if (!(err instanceof MojangUnavailable)) console.error(err);
				set.checkedAt = row.head === null ? 0 : Date.now();
			}
		}
	}
	db.update(players).set(set).where(eq(players.id, row.id)).run();
}

/**
 * The player for an account Mojang knows, added if the map does not have it yet, with its name
 * and head brought up to date. `created` says whether it was added.
 */
export async function addPlayer(
	db: Db,
	mojang: Mojang,
	profile: MojangProfile,
	userId: string | null,
): Promise<{ player: Player; created: boolean }> {
	const inserted = db
		.insert(players)
		.values({ uuid: profile.uuid, name: profile.name, createdBy: userId })
		.onConflictDoNothing()
		.returning()
		.get();
	const row =
		inserted ??
		(db
			.select()
			.from(players)
			.where(eq(players.uuid, profile.uuid))
			.get() as PlayerRow);
	await applyProfile(db, mojang, row, profile);
	return {
		player: { ...toPlayer(row), name: profile.name },
		created: inserted !== undefined,
	};
}

/**
 * Checks a player with Mojang again. An account that no longer exists keeps its last name and
 * head. Throws MojangUnavailable when Mojang cannot be asked.
 */
export async function refreshPlayer(db: Db, mojang: Mojang, row: PlayerRow) {
	const profile = await mojang.byUuid(row.uuid, true);
	if (!profile) {
		db.update(players)
			.set({ checkedAt: Date.now() })
			.where(eq(players.id, row.id))
			.run();
		return;
	}
	await applyProfile(db, mojang, row, profile);
}

/** Every few minutes, checks the players that were checked longest ago, a few at a time. */
export function createPlayerRefresher(db: Db, mojang: Mojang) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let running = false;

	async function tick() {
		if (running) return;
		running = true;
		try {
			const due = db
				.select()
				.from(players)
				.where(lt(players.checkedAt, Date.now() - PLAYER_REFRESH_MS))
				.orderBy(asc(players.checkedAt))
				.limit(REFRESH_BATCH)
				.all();
			for (const row of due) await refreshPlayer(db, mojang, row);
		} catch (err) {
			if (!(err instanceof MojangUnavailable)) console.error(err);
		} finally {
			running = false;
		}
	}

	return {
		tick,
		start() {
			timer ??= setInterval(tick, REFRESH_EVERY_MS);
			void tick();
		},
		stop() {
			clearInterval(timer);
			timer = undefined;
		},
	};
}
