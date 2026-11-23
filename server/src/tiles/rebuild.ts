import { floorDiv } from "@blockmap/shared";
import { and, asc, eq, gte } from "drizzle-orm";
import { mapLimit } from "../concurrency";
import type { Db } from "../db/client";
import { tileVersions } from "../db/schema";
import type { BlobStore } from "./blobstore";
import { composeParent, loadTile, overRegion, storeTile } from "./compose";
import { tileHashAt } from "./history";

/** One stored version of a tile: from the upload with this `seq` on it is `hash` (null = empty). */
export type Row = { seq: number; hash: string | null };

/** An upload's patch of one zoom 0 tile, by the `seq` of the upload. */
export type TilePatch = { seq: number; hash: string };

/** The new versions of a tile from some seq on. */
export type Rewrite = { zoom: number; x: number; y: number; rows: Row[] };

/** What is stored already: the tile just before `fromSeq`, and its rows at or after it. */
export type Existing = {
	base(zoom: number, x: number, y: number): Promise<string | null>;
	rows(zoom: number, x: number, y: number): Promise<Row[]>;
};

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export const tileKey = (x: number, y: number) => `${x},${y}`;
export const parseKey = (key: string) =>
	key.split(",").map(Number) as [number, number];

export const sameRows = (a: Row[], b: Row[]) =>
	a.length === b.length &&
	a.every((r, i) => r.seq === b[i]?.seq && r.hash === b[i]?.hash);

export const emptyExisting: Existing = {
	base: async () => null,
	rows: async () => [],
};

/** The stored versions of a dimension, read from tile_versions. */
export const dbExisting = (
	db: Db,
	dimensionId: number,
	fromSeq: number,
): Existing => ({
	base: (zoom, x, y) => tileHashAt(db, dimensionId, zoom, x, y, fromSeq - 1),
	rows: async (zoom, x, y) =>
		(
			await db
				.select({ seq: tileVersions.seq, hash: tileVersions.blobHash })
				.from(tileVersions)
				.where(
					and(
						eq(tileVersions.dimensionId, dimensionId),
						eq(tileVersions.zoom, zoom),
						eq(tileVersions.tileX, x),
						eq(tileVersions.tileY, y),
						gte(tileVersions.seq, fromSeq),
					),
				)
				.orderBy(asc(tileVersions.seq))
		).map((r) => ({ seq: r.seq, hash: r.hash })),
});

/**
 * The versions of zoom 0 tiles from `fromSeq` on. A tile after an upload is the tile before it
 * with the upload's patch over it, so each patch (`patchesOf`: those of the tile at or after
 * `fromSeq`) is laid over the previous result in seq order; a row is stored wherever that
 * changes the tile. Only tiles whose rows differ from the existing ones are returned.
 *
 * `preloaded` holds the images of patches (by hash) that are already in memory, exactly as
 * they were when stored.
 */
export async function rebuildBase(opts: {
	blobs: BlobStore;
	tileSize: number;
	concurrency: number;
	tiles: { x: number; y: number }[];
	patchesOf: (x: number, y: number) => Promise<TilePatch[]>;
	existing: Existing;
	preloaded?: Map<string, Buffer>;
	onProgress?: (done: number, total: number) => void;
}): Promise<Rewrite[]> {
	const { blobs, tileSize: T, existing } = opts;
	let finished = 0;

	const rebuilt = await mapLimit(opts.tiles, opts.concurrency, async (tile) => {
		const { x, y } = tile;
		const patches = (await opts.patchesOf(x, y)).sort((a, b) => a.seq - b.seq);
		let prev = await existing.base(0, x, y);
		// The image of `prev`, decoded when a patch first has to go over it.
		let canvas: Buffer | null = null;
		const rows: Row[] = [];

		for (const p of patches) {
			let hash: string | null;
			if (prev === null) {
				// Over an empty tile the result is the patch itself.
				hash = p.hash;
				canvas = null;
			} else {
				canvas ??= await loadTile(blobs, prev, T);
				const image =
					opts.preloaded?.get(p.hash) ?? (await loadTile(blobs, p.hash, T));
				overRegion(canvas, T, image, T, T, 0, 0);
				hash = await storeTile(blobs, canvas, T);
			}
			if (hash !== prev) {
				rows.push({ seq: p.seq, hash });
				prev = hash;
			}
		}

		opts.onProgress?.(++finished, opts.tiles.length);
		return sameRows(rows, await existing.rows(0, x, y))
			? null
			: ({ zoom: 0, x, y, rows } satisfies Rewrite);
	});
	return rebuilt.filter((r) => r !== null);
}

/**
 * The versions of a zoomed-out tile, from the versions of its four children (in quadrant order:
 * top left, top right, bottom left, bottom right). Before its first row a child is `base`; the
 * parent starts as `base` and gets a row wherever the mix of its children changes it. `mixes`
 * caches composed parents by the hashes of their children and may be shared between calls.
 */
export async function parentRows(opts: {
	blobs: BlobStore;
	tileSize: number;
	kids: { base: string | null; rows: Row[] }[];
	base: string | null;
	mixes: Map<string, string | null>;
}): Promise<Row[]> {
	const { blobs, tileSize: T, kids, mixes } = opts;
	const seqs = [...new Set(kids.flatMap((k) => k.rows.map((r) => r.seq)))].sort(
		(a, b) => a - b,
	);
	let prev = opts.base;
	const rows: Row[] = [];
	// Each child's current image, so it is decoded once per version rather than once per seq.
	const held: { hash: string | null; image: Buffer | null }[] = kids.map(
		() => ({ hash: null, image: null }),
	);
	const image = async (q: number, hash: string | null) => {
		const slot = held[q] as (typeof held)[number];
		if (slot.hash !== hash || (hash !== null && slot.image === null)) {
			slot.image = hash ? await loadTile(blobs, hash, T) : null;
			slot.hash = hash;
		}
		return slot.image;
	};
	// How many of each child's rows are at or before the seq being built (seqs only go up).
	const seen = kids.map(() => 0);
	for (const seq of seqs) {
		const hashes = kids.map((k, q) => {
			let n = seen[q] as number;
			while (n < k.rows.length && (k.rows[n] as Row).seq <= seq) n++;
			seen[q] = n;
			return n > 0 ? (k.rows[n - 1] as Row).hash : k.base;
		});
		const mixKey = hashes.join("|");
		if (!mixes.has(mixKey)) {
			const canvas = composeParent(
				T,
				await Promise.all(hashes.map((hash, q) => image(q, hash))),
			);
			mixes.set(mixKey, canvas ? await storeTile(blobs, canvas, T) : null);
		}
		const hash = mixes.get(mixKey) ?? null;
		if (hash !== prev) {
			rows.push({ seq, hash });
			prev = hash;
		}
	}
	return rows;
}

/**
 * Rebuilds the ancestors (zoom 1 to maxZoom) of rewritten zoom 0 tiles: each parent follows its
 * four children, wherever any of them changes. Children that were not rewritten are read from
 * `existing`. Only parents whose rows differ from the existing ones are returned.
 */
export async function rebuildParents(opts: {
	blobs: BlobStore;
	tileSize: number;
	maxZoom: number;
	concurrency: number;
	changed: Rewrite[];
	existing: Existing;
	onProgress?: (zoom: number, done: number, total: number) => void;
}): Promise<Rewrite[]> {
	const { blobs, tileSize: T, existing } = opts;
	const baseCache = new Map<string, string | null>();
	const base = async (zoom: number, x: number, y: number) => {
		const key = `${zoom}:${tileKey(x, y)}`;
		if (!baseCache.has(key))
			baseCache.set(key, await existing.base(zoom, x, y));
		return baseCache.get(key) ?? null;
	};

	const rewrites: Rewrite[] = [];
	let level = new Map<string, Row[]>(
		opts.changed.map((r) => [tileKey(r.x, r.y), r.rows]),
	);
	for (let zoom = 1; zoom <= opts.maxZoom && level.size > 0; zoom++) {
		const parents = new Set<string>();
		for (const key of level.keys()) {
			const [x, y] = parseKey(key);
			parents.add(tileKey(floorDiv(x, 2), floorDiv(y, 2)));
		}

		const next = new Map<string, Row[]>();
		const mixes = new Map<string, string | null>();
		let built = 0;
		await mapLimit([...parents], opts.concurrency, async (parentKey) => {
			const [px, py] = parseKey(parentKey);
			const kids = await Promise.all(
				[0, 1, 2, 3].map(async (q) => {
					const cx = 2 * px + (q % 2);
					const cy = 2 * py + Math.floor(q / 2);
					return {
						base: await base(zoom - 1, cx, cy),
						rows:
							level.get(tileKey(cx, cy)) ??
							(await existing.rows(zoom - 1, cx, cy)),
					};
				}),
			);
			const rows = await parentRows({
				blobs,
				tileSize: T,
				kids,
				base: await base(zoom, px, py),
				mixes,
			});
			if (!sameRows(rows, await existing.rows(zoom, px, py))) {
				rewrites.push({ zoom, x: px, y: py, rows });
				next.set(parentKey, rows);
			}
			opts.onProgress?.(zoom, ++built, parents.size);
		});
		level = next;
	}
	return rewrites;
}

/** Replaces the rows from `fromSeq` on of every rewritten tile. */
export function writeRows(
	tx: Tx,
	dimensionId: number,
	fromSeq: number,
	rewrites: Rewrite[],
) {
	for (const w of rewrites) {
		tx.delete(tileVersions)
			.where(
				and(
					eq(tileVersions.dimensionId, dimensionId),
					eq(tileVersions.zoom, w.zoom),
					eq(tileVersions.tileX, w.x),
					eq(tileVersions.tileY, w.y),
					gte(tileVersions.seq, fromSeq),
				),
			)
			.run();
	}
	const inserts = rewrites.flatMap((w) =>
		w.rows.map((r) => ({
			dimensionId,
			zoom: w.zoom,
			tileX: w.x,
			tileY: w.y,
			seq: r.seq,
			blobHash: r.hash,
		})),
	);
	for (let i = 0; i < inserts.length; i += 500) {
		tx.insert(tileVersions)
			.values(inserts.slice(i, i + 500))
			.run();
	}
}
