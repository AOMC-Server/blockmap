import {
	DAY,
	FEATURE_TYPES,
	type FeatureType,
	MINUTE,
	type StatsRange,
	statsQuerySchema,
} from "@blockmap/shared";
import { inArray, type SQL, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { Db } from "../db/client";
import { users } from "../db/schema";
import { doc } from "../openapi";
import type { AppEnv } from "../types";
import { validate } from "../validate";

/** How long the figures that are the same for everyone are reused. */
const CACHE_MS = MINUTE;
const RANGE_DAYS: Record<StatsRange, number | null> = {
	all: null,
	"30d": 30,
	"7d": 7,
	"3d": 3,
	"1d": 1,
};

export type UserStats = {
	uploads: number;
	/** Of which sent by the in-game mod; with the volume and the distinct ground it uploaded. */
	modUploads: number;
	modUploadedBlocks: number;
	modAreaTiles: number;
	modAreaBlocks: number;
	tiles: number;
	/** Every tile uploaded, repeats included, as blocks². */
	uploadedBlocks: number;
	areaTiles: number;
	areaBlocks: number;
	featuresCreated: number;
	featuresByType: Record<FeatureType, number>;
	featureEdits: number;
	layersCreated: number;
};

const emptyStats = (): UserStats => ({
	uploads: 0,
	modUploads: 0,
	modUploadedBlocks: 0,
	modAreaTiles: 0,
	modAreaBlocks: 0,
	tiles: 0,
	uploadedBlocks: 0,
	areaTiles: 0,
	areaBlocks: 0,
	featuresCreated: 0,
	featuresByType: { pin: 0, line: 0, polygon: 0 },
	featureEdits: 0,
	layersCreated: 0,
});

type Scope = {
	since: number;
	tileSize: number;
	/** Only this user's activity. */
	userId?: string;
	/** Leave out features and layers that are private or deleted. */
	publicOnly: boolean;
};

/** Finished uploads (revision `r`) that still count. */
const DONE_UPLOAD = sql.raw("r.kind = 'upload' AND r.status = 'done'");

/** The uploads of `DONE_UPLOAD` that completed since `since`. */
const uploadedSince = (since: number) =>
	sql`${DONE_UPLOAD} AND COALESCE(r.completed_at, r.created_at) >= ${since}`;

const FIRST_REVISION = sql.raw(
	"(SELECT MIN(id) FROM feature_revisions WHERE feature_id = fr.feature_id)",
);

/** Joins a feature revision `fr` to its layer, keeping only live public layers. */
const publicFeature = (s: Scope) =>
	s.publicOnly
		? sql.raw(
				"JOIN features f ON f.id = fr.feature_id JOIN layers l ON l.id = f.layer_id AND l.visibility = 'public' AND l.deleted_at IS NULL",
			)
		: sql``;

const byUser = (column: string, s: Scope): SQL =>
	s.userId ? sql`AND ${sql.raw(column)} = ${s.userId}` : sql``;

/** Every user's stats over the scope, by user id. Users with no activity are absent. */
function collect(db: Db, s: Scope): Map<string, UserStats> {
	const out = new Map<string, UserStats>();
	const get = (id: string) => {
		const row = out.get(id) ?? emptyStats();
		out.set(id, row);
		return row;
	};

	const uploads = db.all<{
		userId: string;
		uploads: number;
		modUploads: number;
		modTiles: number;
		modArea: number;
		tiles: number;
		area: number;
	}>(sql`
		SELECT r.author_id AS userId, COUNT(DISTINCT r.id) AS uploads,
			COUNT(DISTINCT CASE WHEN r.via_mod = 1 THEN r.id END) AS modUploads,
			COUNT(CASE WHEN r.via_mod = 1 THEN p.revision_id END) AS modTiles,
			COUNT(DISTINCT CASE WHEN r.via_mod = 1 THEN r.dimension_id || ':' || p.tile_x || ':' || p.tile_y END) AS modArea,
			COUNT(p.revision_id) AS tiles,
			COUNT(DISTINCT r.dimension_id || ':' || p.tile_x || ':' || p.tile_y) AS area
		FROM revisions r LEFT JOIN upload_patches p ON p.revision_id = r.id
		WHERE ${uploadedSince(s.since)} ${byUser("r.author_id", s)}
		GROUP BY r.author_id`);
	for (const r of uploads) {
		const row = get(r.userId);
		row.uploads = r.uploads;
		row.modUploads = r.modUploads;
		row.modUploadedBlocks = r.modTiles * s.tileSize * s.tileSize;
		row.modAreaTiles = r.modArea;
		row.modAreaBlocks = r.modArea * s.tileSize * s.tileSize;
		row.tiles = r.tiles;
		row.uploadedBlocks = r.tiles * s.tileSize * s.tileSize;
		row.areaTiles = r.area;
		row.areaBlocks = r.area * s.tileSize * s.tileSize;
	}

	const created = db.all<{ userId: string; type: FeatureType; n: number }>(sql`
		SELECT fr.author_id AS userId, fr.type AS type, COUNT(*) AS n
		FROM feature_revisions fr ${publicFeature(s)}
		WHERE fr.id = ${FIRST_REVISION} AND fr.created_at >= ${s.since} ${byUser("fr.author_id", s)}
		GROUP BY fr.author_id, fr.type`);
	for (const r of created) {
		const row = get(r.userId);
		row.featuresByType[r.type] = r.n;
		row.featuresCreated += r.n;
	}

	const edits = db.all<{ userId: string; n: number }>(sql`
		SELECT fr.author_id AS userId, COUNT(*) AS n
		FROM feature_revisions fr ${publicFeature(s)}
		WHERE fr.id <> ${FIRST_REVISION} AND fr.created_at >= ${s.since} ${byUser("fr.author_id", s)}
		GROUP BY fr.author_id`);
	for (const r of edits) get(r.userId).featureEdits = r.n;

	const layerRows = db.all<{ userId: string; n: number }>(sql`
		SELECT created_by AS userId, COUNT(*) AS n FROM layers
		WHERE deleted_at IS NULL AND created_at >= ${s.since}
			${s.publicOnly ? sql.raw("AND visibility = 'public'") : sql``} ${byUser("created_by", s)}
		GROUP BY created_by`);
	for (const r of layerRows) get(r.userId).layersCreated = r.n;

	return out;
}

/** Map-wide totals; the area counts a tile once however many users uploaded it. */
function totalsOf(db: Db, s: Scope, rows: UserStats[]): UserStats {
	const total = emptyStats();
	for (const r of rows) {
		total.uploads += r.uploads;
		total.modUploads += r.modUploads;
		total.modUploadedBlocks += r.modUploadedBlocks;
		total.tiles += r.tiles;
		total.uploadedBlocks += r.uploadedBlocks;
		total.featuresCreated += r.featuresCreated;
		for (const t of FEATURE_TYPES)
			total.featuresByType[t] += r.featuresByType[t];
		total.featureEdits += r.featureEdits;
		total.layersCreated += r.layersCreated;
	}
	const [area] = db.all<{ area: number; modArea: number }>(sql`
		SELECT COUNT(*) AS area, COALESCE(SUM(viaMod), 0) AS modArea FROM (
			SELECT r.dimension_id, p.tile_x, p.tile_y, MAX(r.via_mod) AS viaMod
			FROM revisions r JOIN upload_patches p ON p.revision_id = r.id
			WHERE ${uploadedSince(s.since)}
			GROUP BY r.dimension_id, p.tile_x, p.tile_y
		)`);
	total.areaTiles = area?.area ?? 0;
	total.areaBlocks = total.areaTiles * s.tileSize * s.tileSize;
	total.modAreaTiles = area?.modArea ?? 0;
	total.modAreaBlocks = total.modAreaTiles * s.tileSize * s.tileSize;
	return total;
}

type FirstUploads = { t: number; n: number }[];

/**
 * How many tiles were first mapped in each period (by `bucket` ms), optionally by one user. A tile
 * is dated by when its data was exported, or by its upload when that is unknown.
 */
function firstUploads(db: Db, bucket: number, userId?: string): FirstUploads {
	return db.all<{ t: number; n: number }>(sql`
		SELECT (first / ${bucket}) * ${bucket} AS t, COUNT(*) AS n FROM (
			SELECT MIN(COALESCE(r.exported_at, r.created_at)) AS first
			FROM revisions r JOIN upload_patches p ON p.revision_id = r.id
			WHERE ${DONE_UPLOAD} ${userId ? sql`AND r.author_id = ${userId}` : sql``}
			GROUP BY r.dimension_id, p.tile_x, p.tile_y
		) GROUP BY 1 ORDER BY 1`);
}

/**
 * Running totals of things counted per period (`rows`, each series by period start), on one time
 * grid that starts where the first series does (or when the range began). Each series starts from
 * what was already there when the range began. Null when the first series is empty.
 */
function growth(
	rows: FirstUploads[],
	since: number,
	now: number,
	bucket: number,
) {
	const first = rows[0]?.[0];
	if (!first) return null;
	const start = since > 0 ? Math.floor(since / bucket) * bucket : first.t;

	const grid: number[] = [];
	for (let t = start; t <= now; t += bucket) grid.push(t);
	const cumulative = (series: FirstUploads) => {
		const added = new Map(series.map((r) => [r.t, r.n]));
		let sum = series.filter((r) => r.t < start).reduce((n, r) => n + r.n, 0);
		return [sum, ...grid.map((t) => (sum += added.get(t) ?? 0))];
	};
	return {
		ts: [Math.max(start, since), ...grid.map((t) => Math.min(t + bucket, now))],
		values: rows.map(cumulative),
	};
}

/**
 * The mapped area as it grew: distinct tiles, counted from the earliest export that covered them.
 * Starts from what was already mapped when the range began.
 */
function areaHistory(
	total: FirstUploads,
	mine: FirstUploads | null,
	since: number,
	now: number,
	bucket: number,
	tileSize: number,
) {
	const g = growth(mine ? [total, mine] : [total], since, now, bucket);
	if (!g) return [];
	const blocks = (tiles: number) => tiles * tileSize * tileSize;
	return g.ts.map((t, i) => ({
		t,
		totalBlocks: blocks(g.values[0]?.[i] as number),
		myBlocks: g.values[1] ? blocks(g.values[1][i] as number) : null,
	}));
}

type FeatureRow = { t: number; type: FeatureType; n: number };

/**
 * The first revisions of the features that exist now: their layer is live and their latest
 * revision is not a deletion. `publicOnly` leaves out private layers.
 */
const liveFeatures = (publicOnly: boolean, userId?: string) => sql`
	FROM feature_revisions fr
	JOIN features f ON f.id = fr.feature_id
	JOIN layers l ON l.id = f.layer_id AND l.deleted_at IS NULL
		${publicOnly ? sql.raw("AND l.visibility = 'public'") : sql``}
	WHERE fr.id = ${FIRST_REVISION}
		AND (SELECT deleted FROM feature_revisions WHERE feature_id = fr.feature_id ORDER BY id DESC LIMIT 1) = 0
		${userId ? sql`AND fr.author_id = ${userId}` : sql``}`;

/** Those features by the period their first revision was made in. */
function featureRows(
	db: Db,
	bucket: number,
	publicOnly: boolean,
	userId?: string,
): FeatureRow[] {
	return db.all<FeatureRow>(sql`
		SELECT (fr.created_at / ${bucket}) * ${bucket} AS t, fr.type AS type, COUNT(*) AS n
		${liveFeatures(publicOnly, userId)}
		GROUP BY 1, fr.type ORDER BY 1`);
}

/** The rows of one feature type, or of all of them added together. */
function countsOf(rows: FeatureRow[], type?: FeatureType): FirstUploads {
	const byTime = new Map<number, number>();
	for (const r of rows)
		if (!type || r.type === type) byTime.set(r.t, (byTime.get(r.t) ?? 0) + r.n);
	return [...byTime].map(([t, n]) => ({ t, n })).sort((a, b) => a.t - b.t);
}

/**
 * How many features there were over time: all of them, yours, and each type. Dated by creation, so
 * a feature that was later deleted is not counted at all.
 */
function featureHistory(
	rows: FeatureRow[],
	mine: FeatureRow[] | null,
	since: number,
	now: number,
	bucket: number,
) {
	const g = growth(
		[
			countsOf(rows),
			...FEATURE_TYPES.map((t) => countsOf(rows, t)),
			...(mine ? [countsOf(mine)] : []),
		],
		since,
		now,
		bucket,
	);
	if (!g) return [];
	const at = (k: number, i: number) => g.values[k]?.[i] as number;
	return g.ts.map((t, i) => ({
		t,
		total: at(0, i),
		pin: at(1 + FEATURE_TYPES.indexOf("pin"), i),
		line: at(1 + FEATURE_TYPES.indexOf("line"), i),
		polygon: at(1 + FEATURE_TYPES.indexOf("polygon"), i),
		mine: mine ? at(1 + FEATURE_TYPES.length, i) : null,
	}));
}

/** What is the same for every visitor; reused for `CACHE_MS`. */
type Everyone = {
	at: number;
	since: number | null;
	leaderboard: (UserStats & {
		userId: string;
		username: string;
		avatarUrl: string | null;
	})[];
	totals: UserStats;
	/** Length of a step of the area and of the feature history, in ms. */
	areaBucket: number;
	featureBucket: number;
	firstUploads: FirstUploads;
	features: FeatureRow[];
};

const caches = new WeakMap<Db, Map<string, Everyone>>();

/** Forgets the reused figures (for tests). */
export const resetStatsCache = (db: Db) => caches.delete(db);

function everyone(
	db: Db,
	range: StatsRange,
	tileSize: number,
	now: number,
): Everyone {
	const cache = caches.get(db) ?? new Map<string, Everyone>();
	caches.set(db, cache);
	const key = `${range}|${tileSize}`;
	const hit = cache.get(key);
	if (hit && now - hit.at < CACHE_MS) return hit;

	const days = RANGE_DAYS[range];
	const since = days === null ? null : now - days * DAY;
	const scope = { since: since ?? 0, tileSize, publicOnly: true };
	const all = collect(db, scope);
	const ids = [...all.keys()];
	const people = ids.length
		? db
				.select({
					id: users.id,
					username: users.username,
					avatarUrl: users.avatarUrl,
				})
				.from(users)
				.where(inArray(users.id, ids))
				.all()
		: [];
	// Each history is cut into steps by its own time span: the features are far younger than the tiles.
	const areaBucket = bucketOf(since, now, () => {
		const [first] = db.all<{ t: number | null }>(sql`
			SELECT MIN(COALESCE(r.exported_at, r.created_at)) AS t FROM revisions r WHERE ${DONE_UPLOAD}`);
		return first?.t ?? null;
	});
	const featureBucket = bucketOf(since, now, () => {
		const [first] = db.all<{ t: number | null }>(sql`
			SELECT MIN(fr.created_at) AS t ${liveFeatures(true)}`);
		return first?.t ?? null;
	});
	const fresh: Everyone = {
		at: now,
		since,
		leaderboard: people.map((p) => ({
			userId: p.id,
			username: p.username,
			avatarUrl: p.avatarUrl,
			...(all.get(p.id) as UserStats),
		})),
		totals: totalsOf(db, scope, [...all.values()]),
		areaBucket,
		featureBucket,
		firstUploads: firstUploads(db, areaBucket),
		features: featureRows(db, featureBucket, true),
	};
	cache.set(key, fresh);
	return fresh;
}

/** About how many steps the history charts have, whatever the time they cover. */
const HISTORY_STEPS = 250;

/**
 * The length of a step: the time shown over `HISTORY_STEPS`, in whole minutes. The time is the
 * range, or for all time everything since `earliest` (when the first item of the history was made).
 */
function bucketOf(
	since: number | null,
	now: number,
	earliest: () => number | null,
) {
	const from = since ?? earliest() ?? now;
	return Math.max(1, Math.ceil((now - from) / HISTORY_STEPS / MINUTE)) * MINUTE;
}

export const statsRoutes = new Hono<AppEnv>().get(
	"/",
	doc({
		tag: "Stats",
		summary: "Contribution statistics and leaderboard",
		description:
			"Public. `me` is your own activity (null when not logged in) and includes private layers; `leaderboard` and `totals` (everyone combined) only count public layers and are reused for a minute. `modUploads`, `modUploadedBlocks` (volume, repeats counted) and `modAreaTiles`/`modAreaBlocks` (distinct ground) are the part sent by the in-game mod (AOMC Webmapper, or whatever `MOD_USER_AGENTS` lists); it is also counted in the other numbers. `areaHistory` is the mapped area over time, for the whole map and for you, by the date the uploaded data was exported. `featureHistory` is how many features there were over time (`total` on public layers, `mine` including your private ones, and `pin`/`line`/`polygon` of the total), by when they were created; features that were deleted since, or whose layer was, are not counted. Both histories have about 250 steps whatever the range (the time each covers divided into whole minutes, so the features, being newer, get finer steps than the area). `range` is `all` (default), `30d`, `7d`, `3d` or `1d`.",
		fails: [400],
	}),
	validate("query", statsQuerySchema),
	(c) => {
		const { db, user, map } = c.var;
		const { range } = c.req.valid("query");
		const now = Date.now();
		const shared = everyone(db, range, map.tileSize, now);
		const since = shared.since ?? 0;

		const me = user
			? (collect(db, {
					since,
					tileSize: map.tileSize,
					publicOnly: false,
					userId: user.id,
				}).get(user.id) ?? emptyStats())
			: null;

		return c.json({
			range,
			since: shared.since,
			me,
			leaderboard: shared.leaderboard,
			totals: shared.totals,
			areaHistory: areaHistory(
				shared.firstUploads,
				user ? firstUploads(db, shared.areaBucket, user.id) : null,
				since,
				now,
				shared.areaBucket,
				map.tileSize,
			),
			featureHistory: featureHistory(
				shared.features,
				user ? featureRows(db, shared.featureBucket, false, user.id) : null,
				since,
				now,
				shared.featureBucket,
			),
		});
	},
);
