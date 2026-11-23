import {
	cleanStyle,
	type FeatureInput,
	type FeatureStyle,
	type FeatureType,
	type Player,
} from "@blockmap/shared";
import { and, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "./db/client";
import {
	featureLayers,
	featureRevisions,
	features,
	layers,
	revisions,
} from "./db/schema";
import { playersById, resolvePlayerRefs, syncFeaturePlayers } from "./players";
import { SEQS_PER_MS } from "./tiles/history";

export type FeatureView = {
	id: number;
	/** The feature's home layer: it decides its colour and style, and who may edit it. */
	layerId: number;
	/** The other layers it is shown in. */
	alsoIn: number[];
	revisionId: number;
	type: FeatureType;
	name: string;
	popup: string;
	color: string | null;
	/** How a line or an area is drawn; null: the defaults. */
	style: FeatureStyle | null;
	geometry: unknown;
	/** Id of the player who owns it; `owner` is that player. */
	ownerId: number | null;
	builderIds: number[];
	owner: Player | null;
	builders: Player[];
	authorId: string;
	updatedAt: number;
};

type RevisionRow = typeof featureRevisions.$inferSelect;

/** The players a revision mentions, for building its view. */
export const playerIdsOf = (r: Pick<RevisionRow, "ownerId" | "builderIds">) =>
	r.ownerId === null ? r.builderIds : [r.ownerId, ...r.builderIds];

/** The owner and builders of a revision, as players; ids that are gone are left out. */
export function attributionOf(
	r: Pick<RevisionRow, "ownerId" | "builderIds">,
	players: Map<number, Player>,
) {
	return {
		owner: r.ownerId === null ? null : (players.get(r.ownerId) ?? null),
		builders: r.builderIds.flatMap((id) => players.get(id) ?? []),
	};
}

export function toView(
	feature: { id: number },
	r: RevisionRow,
	players: Map<number, Player>,
): FeatureView {
	return {
		id: feature.id,
		layerId: r.layerId,
		alsoIn: r.alsoIn,
		revisionId: r.id,
		type: r.type,
		name: r.name,
		popup: r.popup,
		color: r.color,
		style: r.style,
		geometry: r.geometry,
		ownerId: r.ownerId,
		builderIds: r.builderIds,
		...attributionOf(r, players),
		authorId: r.authorId,
		updatedAt: r.createdAt,
	};
}

/** toView for a single revision, looking up its players. */
export const viewOf = (
	db: Pick<Db, "select">,
	feature: { id: number },
	r: RevisionRow,
) => toView(feature, r, playersById(db, playerIdsOf(r)));

/**
 * Current (or as-of `at`, a unix ms timestamp) non-deleted features of the given layers.
 * A feature's state is its latest revision at that time, which says which layer is its home and
 * which others it is shown in. A feature is listed in each of the given layers it is in, the
 * ones that have it as home first; it is left out when its home layer does not exist (at `at`).
 */
export function featuresOfLayers(
	db: Pick<Db, "select">,
	layerIds: number[],
	at: number | null = null,
): Map<number, FeatureView[]> {
	const byLayer = new Map<number, FeatureView[]>(
		layerIds.map((id) => [id, []]),
	);
	if (layerIds.length === 0) return byLayer;

	const idList = sql.join(
		layerIds.map((id) => sql`${id}`),
		sql`, `,
	);
	const latest = db
		.select({ id: sql<number>`max(${featureRevisions.id})` })
		.from(featureRevisions)
		.where(
			and(
				inArray(
					featureRevisions.featureId,
					db
						.select({ id: featureRevisions.featureId })
						.from(featureRevisions)
						.where(
							or(
								inArray(featureRevisions.layerId, layerIds),
								sql`EXISTS (SELECT 1 FROM json_each(${featureRevisions.alsoIn}) WHERE value IN (${idList}))`,
							),
						),
				),
				at === null ? undefined : lte(featureRevisions.createdAt, at),
			),
		)
		.groupBy(featureRevisions.featureId);

	const rows = db
		.select({ feature: features, revision: featureRevisions })
		.from(featureRevisions)
		.innerJoin(features, eq(features.id, featureRevisions.featureId))
		.where(
			and(
				inArray(featureRevisions.id, latest),
				eq(featureRevisions.deleted, false),
				or(
					inArray(featureRevisions.layerId, layerIds),
					sql`EXISTS (SELECT 1 FROM json_each(${featureRevisions.alsoIn}) WHERE value IN (${idList}))`,
				),
			),
		)
		.orderBy(features.sortOrder, features.id)
		.all();

	// A feature whose home layer is gone goes with it, even where it is also shown.
	const requested = new Set(layerIds);
	const homes = [...new Set(rows.map((r) => r.revision.layerId))].filter(
		(id) => !requested.has(id),
	);
	const liveHomes = new Set<number>(requested);
	if (homes.length > 0)
		for (const l of db
			.select({ id: layers.id })
			.from(layers)
			.where(and(inArray(layers.id, homes), layerLiveAt(at)))
			.all())
			liveHomes.add(l.id);

	const players = playersById(
		db,
		rows.flatMap(({ revision }) => playerIdsOf(revision)),
	);
	const linked = new Map<number, FeatureView[]>();
	for (const { feature, revision } of rows) {
		if (!liveHomes.has(revision.layerId)) continue;
		const view = toView(feature, revision, players);
		byLayer.get(revision.layerId)?.push(view);
		for (const id of revision.alsoIn) {
			if (!requested.has(id)) continue;
			const list = linked.get(id) ?? [];
			list.push(view);
			linked.set(id, list);
		}
	}
	// Features shown in a layer without being its own come after its own, oldest first.
	for (const [id, list] of linked)
		byLayer.get(id)?.push(...list.sort((a, b) => a.id - b.id));
	return byLayer;
}

/** The `sortOrder` for a feature added to the end of a layer. */
export function nextFeatureOrder(db: Pick<Db, "select">, layerId: number) {
	const row = db
		.select({ max: sql<number | null>`max(${features.sortOrder})` })
		.from(features)
		.where(eq(features.layerId, layerId))
		.get();
	return (row?.max ?? 0) + 1;
}

/** Latest revision of a feature, including deleted state. */
export function latestRevision(db: Pick<Db, "select">, featureId: number) {
	return db
		.select()
		.from(featureRevisions)
		.where(eq(featureRevisions.featureId, featureId))
		.orderBy(desc(featureRevisions.id))
		.limit(1)
		.get();
}

/** How many features are in a layer, as their home or as one of their other layers, and not deleted. */
export function liveFeatureCount(db: Pick<Db, "all">, layerId: number) {
	const [row] = db.all<{ n: number }>(sql`
		SELECT COUNT(*) AS n FROM (
			SELECT f.id FROM features f WHERE f.layer_id = ${layerId}
			UNION
			SELECT fl.feature_id FROM feature_layers fl
				JOIN features f ON f.id = fl.feature_id
				JOIN layers h ON h.id = f.layer_id AND h.deleted_at IS NULL
				WHERE fl.layer_id = ${layerId}
		) x WHERE NOT COALESCE(
			(SELECT r.deleted FROM feature_revisions r WHERE r.feature_id = x.id ORDER BY r.id DESC LIMIT 1), 1)`);
	return row?.n ?? 0;
}

/** What a revision holds, with the owner and builders as player ids. */
type OmitEach<T, K extends PropertyKey> = T extends unknown
	? Omit<T, K>
	: never;
export type RevisionContent = OmitEach<FeatureInput, "owner" | "builders"> & {
	ownerId: number | null;
	builderIds: number[];
	deleted?: boolean;
};

type ContentFields = Pick<
	FeatureView,
	| "type"
	| "name"
	| "popup"
	| "color"
	| "style"
	| "geometry"
	| "ownerId"
	| "builderIds"
	| "alsoIn"
>;

/** The editable fields of a revision, ready to be stored again. */
export const contentOf = (r: ContentFields): RevisionContent =>
	({
		type: r.type,
		name: r.name,
		popup: r.popup,
		color: r.color,
		// Only lines and areas have a style.
		...(r.type === "pin" ? {} : { style: r.style }),
		geometry: r.geometry,
		alsoIn: r.alsoIn,
		ownerId: r.ownerId,
		builderIds: r.builderIds,
	}) as RevisionContent;

/**
 * FeatureInput with its owner and builders turned into player ids (adding players given by
 * `{uuid, name}` that the map does not know), or the first player id that does not exist.
 */
export function resolveContent(
	db: Pick<Db, "select" | "insert">,
	input: FeatureInput,
	userId: string | null,
): RevisionContent | { unknownPlayer: number } {
	const { owner, builders, ...rest } = input;
	const ownerIds = resolvePlayerRefs(db, owner === null ? [] : [owner], userId);
	if ("unknown" in ownerIds) return { unknownPlayer: ownerIds.unknown };
	const builderIds = resolvePlayerRefs(db, builders, userId);
	if ("unknown" in builderIds) return { unknownPlayer: builderIds.unknown };
	return {
		...rest,
		ownerId: ownerIds.ids[0] ?? null,
		builderIds: builderIds.ids,
	};
}

/** The editable fields of a revision as FeatureInput, with players as `{uuid, name}` so they can be imported elsewhere. */
export function portableContentOf(
	r: ContentFields,
	players: Map<number, Player>,
): FeatureInput {
	// Layer ids mean nothing in another map.
	const { ownerId, builderIds, alsoIn: _, ...rest } = contentOf(r);
	const ref = (p: Player) => ({ uuid: p.uuid, name: p.name });
	const owner = ownerId === null ? undefined : players.get(ownerId);
	return {
		...rest,
		owner: owner ? ref(owner) : null,
		builders: builderIds.flatMap((id) => {
			const p = players.get(id);
			return p ? [ref(p)] : [];
		}),
	} as FeatureInput;
}

/** Makes feature_layers match the layers a feature is shown in besides its home. */
function syncFeatureLayers(
	db: Pick<Db, "insert" | "delete">,
	featureId: number,
	alsoIn: number[],
) {
	db.delete(featureLayers).where(eq(featureLayers.featureId, featureId)).run();
	if (alsoIn.length > 0)
		db.insert(featureLayers)
			.values(alsoIn.map((layerId) => ({ featureId, layerId })))
			.run();
}

/** Adds a revision; `feature.layerId` is the layer the feature is in as of it. */
export function insertRevision(
	db: Pick<Db, "insert" | "delete">,
	feature: { id: number; layerId: number },
	authorId: string,
	content: RevisionContent,
) {
	// The home layer is not one of the others.
	const alsoIn = [...new Set(content.alsoIn)].filter(
		(id) => id !== feature.layerId,
	);
	const row = db
		.insert(featureRevisions)
		.values({
			featureId: feature.id,
			layerId: feature.layerId,
			authorId,
			deleted: content.deleted ?? false,
			type: content.type,
			name: content.name,
			popup: content.popup,
			color: content.color,
			// Only lines and areas have a style, and an empty one is none.
			style:
				content.type === "pin"
					? null
					: cleanStyle("style" in content ? content.style : null),
			geometry: content.geometry,
			alsoIn,
			ownerId: content.ownerId,
			builderIds: content.builderIds,
		})
		.returning()
		.get();
	syncFeaturePlayers(db, feature.id, row);
	syncFeatureLayers(db, feature.id, alsoIn);
	return row;
}

/** Adds a feature at `sortOrder` with its first revision. */
export function insertFeature(
	db: Pick<Db, "insert" | "delete" | "select">,
	layerId: number,
	sortOrder: number,
	authorId: string,
	content: RevisionContent,
) {
	const feature = db
		.insert(features)
		.values({ layerId, sortOrder })
		.returning()
		.get();
	return viewOf(db, feature, insertRevision(db, feature, authorId, content));
}

/** Puts a feature at the end of another layer. The caller adds the revision that records it. */
export function moveFeature(
	db: Pick<Db, "select" | "update">,
	featureId: number,
	toLayerId: number,
) {
	db.update(features)
		.set({ layerId: toLayerId, sortOrder: nextFeatureOrder(db, toLayerId) })
		.where(eq(features.id, featureId))
		.run();
}

/**
 * Unix ms export time of a revision, for "as of revision" reads. null means "now"; undefined means
 * there is no such revision (for example the upload was deleted).
 */
export function timeOfRev(db: Db, headRev: number, at: number | null) {
	if (at === null || at >= headRev) return null;
	if (at <= 0) return 0;
	const row = db
		.select({ seq: revisions.seq })
		.from(revisions)
		.where(eq(revisions.rev, at))
		.get();
	return row?.seq == null ? undefined : Math.floor(row.seq / SEQS_PER_MS);
}

/** The layers that existed at `at` (unix ms), or the live ones for null. */
export function layerLiveAt(at: number | null) {
	return at === null
		? isNull(layers.deletedAt)
		: and(
				lte(layers.createdAt, at),
				or(isNull(layers.deletedAt), gt(layers.deletedAt, at)),
			);
}
