import {
	createPlayerSchema,
	isUuid,
	type LineGeometry,
	linePaths,
	normalizeUuid,
	type Point,
	playerLookupQuerySchema,
	playerSearchQuerySchema,
} from "@blockmap/shared";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { requireUser, userOf } from "../auth/session";
import type { Db } from "../db/client";
import {
	dimensions,
	featurePlayers,
	featureRevisions,
	features,
	layerMembers,
	layers,
	players,
	users,
} from "../db/schema";
import { latestRevision, playerIdsOf } from "../features";
import {
	defaultHead,
	headFromSkin,
	type Mojang,
	MojangUnavailable,
} from "../mojang";
import { doc } from "../openapi";
import {
	type Actor,
	canEdit,
	canModerate,
	canViewLayer,
	effectiveLayerRole,
} from "../permissions";
import { addPlayer, playersById, refreshPlayer, toPlayer } from "../players";
import type { AppEnv } from "../types";
import { validate } from "../validate";
import { parseId } from "./util";

type Role = AppEnv["Variables"]["role"];

/** The features that are in one of `layerIds`, as their home or as one of their other layers, and whose home layer still exists. */
const inVisibleLayers = (layerIds: number[]) =>
	and(
		or(
			inArray(features.layerId, layerIds),
			sql`EXISTS (SELECT 1 FROM feature_layers fl WHERE fl.feature_id = ${features.id} AND fl.layer_id IN (${sql.join(
				layerIds.map((id) => sql`${id}`),
				sql`, `,
			)}))`,
		),
		sql`EXISTS (SELECT 1 FROM layers h WHERE h.id = ${features.layerId} AND h.deleted_at IS NULL)`,
	);

/** Ids of the live layers the actor may see. */
function visibleLayerIds(db: Db, actor: Actor, role: Role): number[] {
	const rows = db.select().from(layers).where(isNull(layers.deletedAt)).all();
	const memberships = actor
		? new Map(
				db
					.select({ layerId: layerMembers.layerId, role: layerMembers.role })
					.from(layerMembers)
					.where(eq(layerMembers.userId, actor.id))
					.all()
					.map((m) => [m.layerId, m.role]),
			)
		: new Map();
	return rows
		.filter((l) =>
			canViewLayer(
				role,
				l,
				effectiveLayerRole(actor, l, memberships.get(l.id) ?? null),
			),
		)
		.map((l) => l.id);
}

/** Owned and built counts of each player, over the features the actor may see. */
function attributionCounts(db: Db, layerIds: number[], playerIds?: number[]) {
	const counts = new Map<number, { owned: number; built: number }>();
	if (layerIds.length === 0) return counts;
	const rows = db
		.select({
			playerId: featurePlayers.playerId,
			role: featurePlayers.role,
			n: sql<number>`count(*)`,
		})
		.from(featurePlayers)
		.innerJoin(features, eq(features.id, featurePlayers.featureId))
		.where(
			and(
				inVisibleLayers(layerIds),
				playerIds ? inArray(featurePlayers.playerId, playerIds) : undefined,
			),
		)
		.groupBy(featurePlayers.playerId, featurePlayers.role)
		.all();
	for (const r of rows) {
		const c = counts.get(r.playerId) ?? { owned: 0, built: 0 };
		if (r.role === "owner") c.owned = r.n;
		else c.built = r.n;
		counts.set(r.playerId, c);
	}
	return counts;
}

/** Where to look at a feature: a pin's point, or the middle of a line's or an area's box. */
function centerOf(type: string, geometry: unknown): Point {
	const points: Point[] =
		type === "pin"
			? [geometry as Point]
			: type === "line"
				? linePaths(geometry as LineGeometry).flat()
				: (geometry as Point[]);
	const xs = points.map((p) => p[0]);
	const zs = points.map((p) => p[1]);
	return [
		Math.round((Math.min(...xs) + Math.max(...xs)) / 2),
		Math.round((Math.min(...zs) + Math.max(...zs)) / 2),
	];
}

const lookupError = (err: unknown) => {
	if (err instanceof MojangUnavailable)
		return { error: "Mojang could not be reached, try again" } as const;
	throw err;
};

export function playerRoutes(mojang: Mojang) {
	return new Hono<AppEnv>()
		.get(
			"/",
			doc({
				tag: "Players",
				summary: "List players",
				description:
					"Players whose name contains `q`, with how many of the features you can see they own and helped build. `total` is how many players match, which can be more than `limit`.",
				fails: [400],
			}),
			validate("query", playerSearchQuerySchema),
			(c) => {
				const { db, user, role } = c.var;
				const { q, limit, sort } = c.req.valid("query");
				const escaped = q.replaceAll(/[\\%_]/g, (m) => `\\${m}`);
				const pattern = `%${escaped}%`;
				const where =
					q === ""
						? undefined
						: or(
								sql`${players.name} LIKE ${pattern} ESCAPE '\\'`,
								isUuid(q) ? eq(players.uuid, normalizeUuid(q)) : undefined,
							);
				const query = db
					.select({ id: players.id, uuid: players.uuid, name: players.name })
					.from(players)
					.where(where)
					// Names that start with what was typed first.
					.orderBy(
						sql`${players.name} NOT LIKE ${`${escaped}%`} ESCAPE '\\'`,
						asc(sql`lower(${players.name})`),
					);
				const total =
					db
						.select({ n: sql<number>`count(*)` })
						.from(players)
						.where(where)
						.get()?.n ?? 0;
				const layerIds = visibleLayerIds(db, user, role);
				let rows: { id: number; uuid: string; name: string }[];
				let counts: ReturnType<typeof attributionCounts>;
				if (sort === "name") {
					rows = query.limit(limit).all();
					counts = attributionCounts(
						db,
						layerIds,
						rows.map((r) => r.id),
					);
				} else {
					// The counts of everyone, to take the top of the whole list and not of one page of names.
					counts = attributionCounts(db, layerIds);
					const of = (id: number) => counts.get(id) ?? { owned: 0, built: 0 };
					const [first, second] =
						sort === "owned"
							? (["owned", "built"] as const)
							: (["built", "owned"] as const);
					rows = query
						.all()
						.map((r, i) => ({ r, i }))
						.sort(
							(a, b) =>
								of(b.r.id)[first] - of(a.r.id)[first] ||
								of(b.r.id)[second] - of(a.r.id)[second] ||
								a.i - b.i,
						)
						.slice(0, limit)
						.map(({ r }) => r);
				}
				return c.json({
					players: rows.map((r) => ({
						...toPlayer(r),
						owned: counts.get(r.id)?.owned ?? 0,
						built: counts.get(r.id)?.built ?? 0,
					})),
					total,
				});
			},
		)
		.get(
			"/lookup",
			doc({
				tag: "Players",
				summary: "Look up a Minecraft account",
				description:
					"Asks Mojang for the account with a name or UUID, without adding it. `existing` is the player the map already has with that UUID (possibly under an old name), or null. 404 if there is no such account, 502 if Mojang could not be reached.",
				fails: [400, 404, 502],
				login: true,
			}),
			requireUser,
			validate("query", playerLookupQuerySchema),
			async (c) => {
				const { db } = c.var;
				const { q } = c.req.valid("query");
				if (!isUuid(q) && !/^[A-Za-z0-9_]{1,16}$/.test(q))
					return c.json({ error: "not a Minecraft name or UUID" }, 400);
				let profile: Awaited<ReturnType<Mojang["byUuid"]>>;
				try {
					profile = isUuid(q) ? await mojang.byUuid(q) : await mojang.byName(q);
				} catch (err) {
					return c.json(lookupError(err), 502);
				}
				if (!profile)
					return c.json(
						{
							error: isUuid(q)
								? "no Minecraft account has this UUID"
								: `no Minecraft account named ${q}`,
						},
						404,
					);
				const existing = db
					.select({ id: players.id, uuid: players.uuid, name: players.name })
					.from(players)
					.where(eq(players.uuid, profile.uuid))
					.get();
				const counts = existing
					? attributionCounts(db, visibleLayerIds(db, c.var.user, c.var.role), [
							existing.id,
						]).get(existing.id)
					: undefined;
				return c.json({
					uuid: profile.uuid,
					name: profile.name,
					existing: existing
						? {
								...toPlayer(existing),
								owned: counts?.owned ?? 0,
								built: counts?.built ?? 0,
							}
						: null,
				});
			},
		)
		.get(
			"/lookup/head.png",
			doc({
				tag: "Players",
				summary: "Head of an account that is not added yet",
				description:
					"The 8x8 face (with the hat layer) of the account with UUID `uuid`, for previews; a default face if it has no skin. 404 if there is no such account, 502 if Mojang could not be reached.",
				query: { uuid: "Minecraft UUID, with or without dashes" },
				fails: [400, 404, 502],
				login: true,
			}),
			requireUser,
			async (c) => {
				const uuid = c.req.query("uuid") ?? "";
				if (!isUuid(uuid)) return c.json({ error: "not a UUID" }, 400);
				try {
					const profile = await mojang.byUuid(uuid);
					if (!profile) return c.json({ error: "no such account" }, 404);
					const png = profile.skinUrl
						? await headFromSkin(await mojang.skin(profile.skinUrl))
						: await defaultHead();
					return c.body(new Uint8Array(png), 200, {
						"Content-Type": "image/png",
						"Cache-Control": "private, max-age=300",
					});
				} catch (err) {
					return c.json(lookupError(err), 502);
				}
			},
		)
		.post(
			"/",
			doc({
				tag: "Players",
				summary: "Add a player",
				description:
					"Anyone who may edit. Adds a player by UUID, with the name and skin Mojang has. If the map already has the player, returns it (200) with its name updated. 404 if there is no such account, 502 if Mojang could not be reached.",
				ok: { 200: "Already on the map", 201: "Added" },
				fails: [400, 403, 404, 429, 502],
				login: true,
			}),
			requireUser,
			validate("json", createPlayerSchema),
			async (c) => {
				const { db, role } = c.var;
				const user = userOf(c);
				if (!canEdit(role)) return c.json({ error: "forbidden" }, 403);
				const { uuid } = c.req.valid("json");
				let profile: Awaited<ReturnType<Mojang["byUuid"]>>;
				try {
					profile = await mojang.byUuid(uuid, true);
				} catch (err) {
					return c.json(lookupError(err), 502);
				}
				if (!profile)
					return c.json({ error: "no Minecraft account has this UUID" }, 404);
				const { player, created } = await addPlayer(
					db,
					mojang,
					profile,
					user.id,
				);
				return c.json({ player }, created ? 201 : 200);
			},
		)
		.get(
			"/:id",
			doc({
				tag: "Players",
				summary: "Get a player and their features",
				description:
					"`owned` and `built` are the features you can see that they own and helped build now, each with its layer (its home, or a layer it is also shown in when you cannot see the home), its owner and builders; `ownership` lists the changes of owner that involved them, newest first. `players` has every player these mention.",
				params: { id: "Player id or UUID" },
				fails: [404],
			}),
			(c) => {
				const { db, user, role } = c.var;
				const key = c.req.param("id");
				const row = db
					.select({
						id: players.id,
						uuid: players.uuid,
						name: players.name,
						createdAt: players.createdAt,
						checkedAt: players.checkedAt,
					})
					.from(players)
					.where(
						isUuid(key)
							? eq(players.uuid, normalizeUuid(key))
							: eq(players.id, parseId(key)),
					)
					.get();
				if (!row) return c.json({ error: "not found" }, 404);

				const layerIds = visibleLayerIds(db, user, role);
				const visible = new Set(layerIds);
				const current =
					layerIds.length === 0
						? []
						: db
								.select({
									role: featurePlayers.role,
									featureId: features.id,
								})
								.from(featurePlayers)
								.innerJoin(features, eq(features.id, featurePlayers.featureId))
								.where(
									and(
										eq(featurePlayers.playerId, row.id),
										inVisibleLayers(layerIds),
									),
								)
								.all();
				const latest = new Map(
					[...new Set(current.map((r) => r.featureId))].flatMap((id) => {
						const rev = latestRevision(db, id);
						return rev ? [[id, rev] as const] : [];
					}),
				);
				const layerRows = new Map(
					latest.size === 0
						? []
						: db
								.select({
									id: layers.id,
									name: layers.name,
									color: layers.color,
									dimension: dimensions.slug,
								})
								.from(layers)
								.innerJoin(dimensions, eq(dimensions.id, layers.dimensionId))
								.where(
									inArray(
										layers.id,
										[...latest.values()]
											.flatMap((r) => [r.layerId, ...r.alsoIn])
											.filter((id) => visible.has(id)),
									),
								)
								.all()
								.map((l) => [l.id, l]),
				);
				const summarize = (r: (typeof current)[number]) => {
					const rev = latest.get(r.featureId);
					if (!rev) return [];
					// Listed under its home layer, or under one it is also shown in when the home is hidden from you.
					const layer = [rev.layerId, ...rev.alsoIn]
						.map((id) => layerRows.get(id))
						.find((l) => l !== undefined);
					if (!layer) return [];
					return [
						{
							id: r.featureId,
							layerId: layer.id,
							layerName: layer.name,
							/** The layer's colour, which the feature has unless it sets its own. */
							layerColor: layer.color,
							dimension: layer.dimension,
							type: rev.type,
							name: rev.name,
							color: rev.color,
							center: centerOf(rev.type, rev.geometry),
							ownerId: rev.ownerId,
							builderIds: rev.builderIds,
						},
					];
				};
				const byName = (a: { name: string }, b: { name: string }) =>
					a.name.localeCompare(b.name);

				// Every revision of the features this player has ever owned, to find the changes of owner.
				const revs = db
					.select({
						featureId: featureRevisions.featureId,
						revisionId: featureRevisions.id,
						ownerId: featureRevisions.ownerId,
						layerId: featureRevisions.layerId,
						name: featureRevisions.name,
						deleted: featureRevisions.deleted,
						createdAt: featureRevisions.createdAt,
						authorName: users.username,
					})
					.from(featureRevisions)
					.innerJoin(users, eq(users.id, featureRevisions.authorId))
					.where(
						inArray(
							featureRevisions.featureId,
							db
								.selectDistinct({ id: featureRevisions.featureId })
								.from(featureRevisions)
								.where(eq(featureRevisions.ownerId, row.id)),
						),
					)
					.orderBy(asc(featureRevisions.featureId), asc(featureRevisions.id))
					.all();
				const ownership: {
					featureId: number;
					featureName: string;
					revisionId: number;
					from: number | null;
					to: number | null;
					at: number;
					by: string;
				}[] = [];
				let prev: (typeof revs)[number] | undefined;
				for (const r of revs) {
					const before = prev?.featureId === r.featureId ? prev.ownerId : null;
					if (
						visible.has(r.layerId) &&
						before !== r.ownerId &&
						(before === row.id || r.ownerId === row.id)
					)
						ownership.push({
							featureId: r.featureId,
							featureName: r.name,
							revisionId: r.revisionId,
							from: before,
							to: r.ownerId,
							at: r.createdAt,
							by: r.authorName,
						});
					prev = r;
				}
				ownership.sort((a, b) => b.revisionId - a.revisionId);
				const others = playersById(db, [
					...ownership.flatMap((o) =>
						[o.from, o.to].filter((id): id is number => id !== null),
					),
					...[...latest.values()].flatMap(playerIdsOf),
				]);

				return c.json({
					player: toPlayer(row),
					addedAt: row.createdAt,
					checkedAt: row.checkedAt,
					owned: current
						.filter((r) => r.role === "owner")
						.flatMap(summarize)
						.sort(byName),
					built: current
						.filter((r) => r.role === "builder")
						.flatMap(summarize)
						.sort(byName),
					ownership,
					/** The players `ownership` and the features' owners and builders mention, by id. */
					players: Object.fromEntries(others),
				});
			},
		)
		.get(
			"/:id/head.png",
			doc({
				tag: "Players",
				summary: "Get a player's head",
				description:
					"The 8x8 face of the player's skin with the hat layer, as a PNG; a default face until the skin is known. Scale it up without smoothing.",
				params: { id: "Player id" },
				ok: { 200: "PNG image" },
				fails: [404],
			}),
			async (c) => {
				const row = c.var.db
					.select({ head: players.head, skinUrl: players.skinUrl })
					.from(players)
					.where(eq(players.id, parseId(c.req.param("id"))))
					.get();
				if (!row) return c.json({ error: "not found" }, 404);
				const etag = `"${Bun.hash(row.skinUrl ?? "default").toString(36)}"`;
				if (c.req.header("If-None-Match") === etag)
					return c.body(null, 304, { ETag: etag });
				const png = row.head ?? (await defaultHead());
				return c.body(new Uint8Array(png), 200, {
					"Content-Type": "image/png",
					"Cache-Control": "public, max-age=3600",
					ETag: etag,
				});
			},
		)
		.post(
			"/:id/refresh",
			doc({
				tag: "Players",
				summary: "Refresh a player from Mojang",
				description:
					"Moderators. Fetches the player's name and skin now instead of waiting for the weekly check. 502 if Mojang could not be reached.",
				params: { id: "Player id" },
				fails: [403, 404, 429, 502],
				login: true,
			}),
			requireUser,
			async (c) => {
				const { db, role } = c.var;
				if (!canModerate(role)) return c.json({ error: "forbidden" }, 403);
				const row = db
					.select()
					.from(players)
					.where(eq(players.id, parseId(c.req.param("id"))))
					.get();
				if (!row) return c.json({ error: "not found" }, 404);
				try {
					await refreshPlayer(db, mojang, row);
				} catch (err) {
					return c.json(lookupError(err), 502);
				}
				const fresh = db
					.select({ id: players.id, uuid: players.uuid, name: players.name })
					.from(players)
					.where(eq(players.id, row.id))
					.get();
				return c.json({ player: fresh && toPlayer(fresh) });
			},
		)
		.delete(
			"/:id",
			doc({
				tag: "Players",
				summary: "Delete a player",
				description:
					"Moderators, and only for a player that no version of any feature was ever attributed to (409 otherwise).",
				params: { id: "Player id" },
				fails: [403, 404, 409, 429],
				login: true,
			}),
			requireUser,
			(c) => {
				const { db, role } = c.var;
				if (!canModerate(role)) return c.json({ error: "forbidden" }, 403);
				const id = parseId(c.req.param("id"));
				const row = db
					.select({ id: players.id })
					.from(players)
					.where(eq(players.id, id))
					.get();
				if (!row) return c.json({ error: "not found" }, 404);
				const used = db
					.select({ id: featureRevisions.id })
					.from(featureRevisions)
					.where(
						or(
							eq(featureRevisions.ownerId, id),
							sql`EXISTS (SELECT 1 FROM json_each(${featureRevisions.builderIds}) WHERE value = ${id})`,
						),
					)
					.limit(1)
					.get();
				if (used)
					return c.json(
						{ error: "features have been attributed to this player" },
						409,
					);
				db.delete(players).where(eq(players.id, id)).run();
				return c.json({ ok: true });
			},
		);
}
