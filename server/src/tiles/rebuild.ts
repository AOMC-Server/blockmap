import { floorDiv } from "@blockmap/shared";
import { and, asc, eq, gte } from "drizzle-orm";
import { createLimiter, type Limiter, mapLimit } from "../concurrency";
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

/** A version being built: its hash, or the encode that will tell it. */
type Pending = { seq: number; hash: string | null | Promise<string | null> };

/** Rows from versions in seq order: one wherever the tile changes from `base`. */
async function toRows(base: string | null, versions: Pending[]) {
	const rows: Row[] = [];
	let prev = base;
	for (const v of versions) {
		const hash = await v.hash;
		if (hash !== prev) rows.push({ seq: v.seq, hash });
		prev = hash;
	}
	return rows;
}

/** The stored tile at `seq`: the last of `rows` at or before it, or else `base`. */
function hashAt(base: string | null, rows: Row[], seq: number) {
	let hash = base;
	for (const r of rows) {
		if (r.seq > seq) break;
		hash = r.hash;
	}
	return hash;
}

/** Shared options of the rebuilds. */
type RebuildOpts = {
	blobs: BlobStore;
	tileSize: number;
	concurrency: number;
	/** Bounds the tile encodes in flight, across every tile being rebuilt; one of `concurrency` by default. */
	limiter?: Limiter;
	/** A tile version was encoded. */
	onVersion?: () => void;
};

/**
 * The versions of zoom 0 tiles from `fromSeq` on. A tile after an upload is the tile before it
 * with the upload's patch over it, so each patch (`patchesOf`: those of the tile at or after
 * `fromSeq`) is laid over the previous result in seq order; a row is stored wherever that
 * changes the tile. Only tiles whose rows differ from the existing ones are returned.
 *
 * Patches are laid over one after the other, but the versions they make are encoded side by
 * side. A patch that changes nothing makes no version. Once the tile is again what is stored at
 * that point (a later upload covered what changed), the rest of the stored rows are kept as
 * they are: the same patches over the same tile give the same versions.
 *
 * `preloaded` holds the images of patches (by hash) that are already in memory, exactly as
 * they were when stored.
 */
export async function rebuildBase(
	opts: RebuildOpts & {
		tiles: { x: number; y: number }[];
		patchesOf: (x: number, y: number) => Promise<TilePatch[]>;
		existing: Existing;
		preloaded?: Map<string, Buffer>;
		onProgress?: (done: number, total: number) => void;
	},
): Promise<Rewrite[]> {
	const { blobs, tileSize: T, existing } = opts;
	const limiter = opts.limiter ?? createLimiter(opts.concurrency);
	let finished = 0;

	const rebuilt = await mapLimit(opts.tiles, opts.concurrency, async (tile) => {
		const { x, y } = tile;
		const patches = (await opts.patchesOf(x, y)).sort((a, b) => a.seq - b.seq);
		const base = await existing.base(0, x, y);
		const old = await existing.rows(0, x, y);
		const versions: Pending[] = [];
		// The tile so far: until a patch has to go over it its hash (null = empty), then its image.
		let current: string | null = base;
		let canvas: Buffer | null = null;
		// The stored image last compared with, kept for the next patch's comparison.
		let seen = null as { hash: string; image: Buffer } | null;

		for (const p of patches) {
			if (canvas === null && current === null) {
				// Over an empty tile the result is the patch itself.
				current = p.hash;
				versions.push({ seq: p.seq, hash: p.hash });
				continue;
			}
			canvas ??= await loadTile(blobs, current as string, T);
			const image =
				opts.preloaded?.get(p.hash) ?? (await loadTile(blobs, p.hash, T));
			if (!overRegion(canvas, T, image, T, T, 0, 0)) continue;

			const was = hashAt(base, old, p.seq);
			if (was !== null) {
				const stored: Buffer =
					seen !== null && seen.hash === was
						? seen.image
						: await loadTile(blobs, was, T);
				seen = { hash: was, image: stored };
				if (stored.equals(canvas)) {
					versions.push({ seq: p.seq, hash: was });
					versions.push(...old.filter((r) => r.seq > p.seq));
					break;
				}
			}
			const copy = Buffer.from(canvas);
			const { done } = await limiter.start(async () => {
				const hash = await storeTile(blobs, copy, T);
				opts.onVersion?.();
				return hash;
			});
			versions.push({ seq: p.seq, hash: done });
		}

		const rows = await toRows(base, versions);
		opts.onProgress?.(++finished, opts.tiles.length);
		return sameRows(rows, old)
			? null
			: ({ zoom: 0, x, y, rows } satisfies Rewrite);
	});
	return rebuilt.filter((r) => r !== null);
}

type Kid = {
	/** Before its first row. */
	base: string | null;
	rows: Row[];
	/** What is stored for it now, when that may differ from `rows`. */
	old?: Row[];
};

/**
 * The versions of a zoomed-out tile, from the versions of its four children (in quadrant order:
 * top left, top right, bottom left, bottom right). Before its first row a child is `base`; the
 * parent starts as `base` and gets a row wherever the mix of its children changes it. `mixes`
 * maps the hashes of four children to the parent they make, and may be shared between calls.
 *
 * With `old` (the parent's stored rows, and the children's), every mix that is stored already
 * is known without making it again. The new mixes are made one after the other and encoded side
 * by side.
 */
export async function parentRows(
	opts: Pick<RebuildOpts, "blobs" | "tileSize" | "onVersion"> & {
		kids: Kid[];
		base: string | null;
		old?: Row[];
		mixes: Map<string, Pending["hash"]>;
		limiter: Limiter;
	},
): Promise<Row[]> {
	const { blobs, tileSize: T, kids, mixes } = opts;
	const keyAt = (seq: number, rowsOf: (k: Kid) => Row[]) =>
		kids.map((k) => hashAt(k.base, rowsOf(k), seq)).join("|");

	if (opts.old) {
		const old = opts.old;
		const oldOf = (k: Kid) => k.old ?? k.rows;
		mixes.set(kids.map((k) => k.base).join("|"), opts.base);
		const seqs = new Set([
			...old.map((r) => r.seq),
			...kids.flatMap((k) => oldOf(k).map((r) => r.seq)),
		]);
		for (const seq of seqs) {
			const key = keyAt(seq, oldOf);
			if (!mixes.has(key)) mixes.set(key, hashAt(opts.base, old, seq));
		}
	}

	const seqs = [...new Set(kids.flatMap((k) => k.rows.map((r) => r.seq)))].sort(
		(a, b) => a - b,
	);
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
	const versions: Pending[] = [];
	for (const seq of seqs) {
		const hashes = kids.map((k) => hashAt(k.base, k.rows, seq));
		const key = hashes.join("|");
		if (!mixes.has(key)) {
			const canvas = composeParent(
				T,
				await Promise.all(hashes.map((hash, q) => image(q, hash))),
			);
			mixes.set(
				key,
				canvas
					? (
							await opts.limiter.start(async () => {
								const hash = await storeTile(blobs, canvas, T);
								opts.onVersion?.();
								return hash;
							})
						).done
					: null,
			);
		}
		versions.push({ seq, hash: mixes.get(key) ?? null });
	}
	return toRows(opts.base, versions);
}

/**
 * Rebuilds the ancestors (zoom 1 to maxZoom) of rewritten zoom 0 tiles: each parent follows its
 * four children, wherever any of them changes. Children that were not rewritten are read from
 * `existing`. Only parents whose rows differ from the existing ones are returned.
 */
export async function rebuildParents(
	opts: RebuildOpts & {
		maxZoom: number;
		changed: Rewrite[];
		existing: Existing;
		onProgress?: (zoom: number, done: number, total: number) => void;
		/** A zoom level is started, with how many tiles of it are built. */
		onLevel?: (zoom: number, total: number) => void;
	},
): Promise<Rewrite[]> {
	const { blobs, tileSize: T, existing } = opts;
	const limiter = opts.limiter ?? createLimiter(opts.concurrency);
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
		const mixes = new Map<string, Pending["hash"]>();
		let built = 0;
		opts.onLevel?.(zoom, parents.size);
		await mapLimit([...parents], opts.concurrency, async (parentKey) => {
			const [px, py] = parseKey(parentKey);
			const kids = await Promise.all(
				[0, 1, 2, 3].map(async (q): Promise<Kid> => {
					const cx = 2 * px + (q % 2);
					const cy = 2 * py + Math.floor(q / 2);
					const stored = await existing.rows(zoom - 1, cx, cy);
					return {
						base: await base(zoom - 1, cx, cy),
						rows: level.get(tileKey(cx, cy)) ?? stored,
						old: stored,
					};
				}),
			);
			const old = await existing.rows(zoom, px, py);
			const rows = await parentRows({
				blobs,
				tileSize: T,
				kids,
				base: await base(zoom, px, py),
				old,
				mixes,
				limiter,
				onVersion: opts.onVersion,
			});
			if (!sameRows(rows, old)) {
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
