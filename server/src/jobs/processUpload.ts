import { floorDiv } from "@blockmap/shared";
import { and, eq, gt, gte, lt, max } from "drizzle-orm";
import { mapLimit } from "../concurrency";
import type { Db } from "../db/client";
import { dimensions, revisions, uploadPatches } from "../db/schema";
import { loadMap } from "../permissions";
import { decodeRaw, emptyTile, overRegion, storeTile } from "../tiles/compose";
import {
	type Bbox,
	commitRevision,
	SEQS_PER_MS,
	tilePatches,
} from "../tiles/history";
import {
	dbExisting,
	type Rewrite,
	rebuildBase,
	rebuildParents,
	tileKey,
} from "../tiles/rebuild";
import { blackToAlpha } from "../tiles/xaero";
import { messages } from "./messages";
import { noProgress } from "./report";
import {
	incomingDir,
	type JobContext,
	type ProcessUploadPayload,
	UserError,
} from "./types";

/** Memory for the tile canvases held at once while the source files are pasted in. */
const BATCH_BYTES = 64 * 1024 * 1024;

/** The seq of an upload exported at `at`: after the uploads with the same time that are published already. */
function nextSeq(db: Db, at: number): number {
	const first = at * SEQS_PER_MS;
	const newest = db
		.select({ seq: max(revisions.seq) })
		.from(revisions)
		.where(
			and(gte(revisions.seq, first), lt(revisions.seq, first + SEQS_PER_MS)),
		)
		.get()?.seq;
	const seq = newest === null || newest === undefined ? first : newest + 1;
	if (seq >= first + SEQS_PER_MS)
		throw new UserError("too many uploads with the same export time");
	return seq;
}

export async function processUpload(
	ctx: JobContext,
	payload: ProcessUploadPayload,
	jobId?: number,
	batchBytes = BATCH_BYTES,
) {
	const { db, env, blobs } = ctx;
	const progress = ctx.progress ?? noProgress;
	let made = 0;
	const onVersion = () =>
		progress.fact("made", messages.facts.versionsMade(++made));
	const { revisionId, files } = payload;

	const [revision] = await db
		.select()
		.from(revisions)
		.where(eq(revisions.id, revisionId));
	if (!revision || revision.dimensionId === null)
		throw new Error("revision not found");
	const map = await loadMap(db);
	const [dim] = await db
		.select()
		.from(dimensions)
		.where(eq(dimensions.id, revision.dimensionId));
	if (!dim) throw new Error("dimension not found");
	const T = map.tileSize;
	const head = map.headRev;

	// Which files touch which zoom 0 tile (tile_y indexes the z axis).
	const byTile = new Map<string, { tx: number; ty: number; files: number[] }>();
	files.forEach((f, index) => {
		for (
			let ty = floorDiv(f.z, T);
			ty <= floorDiv(f.z + f.height - 1, T);
			ty++
		) {
			for (
				let tx = floorDiv(f.x, T);
				tx <= floorDiv(f.x + f.width - 1, T);
				tx++
			) {
				const key = tileKey(tx, ty);
				const entry = byTile.get(key) ?? { tx, ty, files: [] };
				entry.files.push(index);
				byTile.set(key, entry);
			}
		}
	});

	// The upload goes into the history by its export time. The tiles it touches are rebuilt from
	// its place on: its patch over what was there, then every newer patch over that.
	const seq = nextSeq(db, revision.exportedAt ?? revision.createdAt);
	const existing = dbExisting(db, dim.id, seq);
	const mine = new Map<string, string>();
	const patchesOf = async (x: number, y: number) => {
		const patches = await tilePatches(db, dim.id, x, y, seq);
		const hash = mine.get(tileKey(x, y));
		if (hash) patches.push({ seq, hash });
		return patches;
	};

	progress.fact("tiles", messages.facts.tilesTouched(byTile.size));
	const newer = newerOver(db, dim.id, seq, byTile);
	progress.fact(
		"newer",
		newer.uploads > 0
			? messages.facts.newerUploads(newer.uploads, newer.tiles)
			: messages.facts.noNewerUploads,
	);

	// One patch per touched tile, files pasted in upload order, and composited into its tile
	// while it is still in memory. Tiles are done in batches to bound memory; within a batch each
	// file is decoded once and pasted into every tile it covers, and the tiles are then encoded
	// several at once.
	const patches: { x: number; y: number; hash: string }[] = [];
	const rewrites: Rewrite[] = [];
	const tiles = [...byTile.values()];
	const batchSize = Math.max(1, Math.floor(batchBytes / (T * T * 4)));
	// Each batch is three steps (read the images, build the tiles, merge them into the history),
	// then one per zoom level and the publishing.
	const batches = Math.max(1, Math.ceil(tiles.length / batchSize));
	const zoomStep = 3 * batches;
	progress.steps(zoomStep + env.MAX_ZOOM + 1);
	let reads = 0;
	for (let start = 0; start < tiles.length; start += batchSize) {
		reads += new Set(
			tiles.slice(start, start + batchSize).flatMap((tile) => tile.files),
		).size;
	}
	let read = 0;
	let empty = 0;
	for (let start = 0; start < tiles.length; start += batchSize) {
		const batch = tiles.slice(start, start + batchSize);
		const batchNo = start / batchSize + 1;
		const canvases = batch.map(() => emptyTile(T));
		const covered = new Map<number, number[]>();
		for (const [b, tile] of batch.entries()) {
			for (const index of tile.files) {
				const list = covered.get(index) ?? [];
				list.push(b);
				covered.set(index, list);
			}
		}
		progress.step(messages.batch(messages.upload.reading, batchNo, batches), {
			total: covered.size,
			unit: "images",
		});
		let readHere = 0;
		for (const index of [...covered.keys()].sort((a, b) => a - b)) {
			const f = files[index] as (typeof files)[number];
			const img = await decodeRaw(
				`${incomingDir(env, revisionId)}/${index}.png`,
				env.MAX_IMAGE_DIM,
			).catch(() => {
				throw new UserError(messages.failed.unreadableImage(f.x, f.z));
			});
			progress.advance(++readHere);
			read++;
			// With one batch, the step already counts them.
			if (batches > 1)
				progress.fact("images", messages.facts.images(read, reads));
			blackToAlpha(img.data);
			for (const b of covered.get(index) as number[]) {
				const { tx, ty } = batch[b] as (typeof batch)[number];
				overRegion(
					canvases[b] as Buffer,
					T,
					img.data,
					img.width,
					img.height,
					f.x - tx * T,
					f.z - ty * T,
				);
			}
		}
		// Storing zeroes the colour under transparent pixels, so a canvas is then exactly what
		// the stored patch decodes to.
		const preloaded = new Map<string, Buffer>();
		progress.step(messages.batch(messages.upload.tiles, batchNo, batches), {
			total: batch.length,
			unit: "tiles",
		});
		let built = 0;
		const done = await mapLimit(
			batch,
			env.JOB_CONCURRENCY,
			async ({ tx, ty }, b) => {
				const patch = canvases[b] as Buffer;
				const hash = await storeTile(blobs, patch, T);
				if (hash) preloaded.set(hash, patch);
				progress.advance(++built);
				return hash ? { x: tx, y: ty, hash } : null;
			},
		);
		const stored = done.filter((tile) => tile !== null);
		empty += batch.length - stored.length;
		if (empty > 0) progress.fact("empty", messages.facts.emptyTiles(empty));
		progress.step(messages.batch(messages.upload.merging, batchNo, batches), {
			total: stored.length,
			unit: "tiles",
		});
		for (const tile of stored) {
			patches.push(tile);
			mine.set(tileKey(tile.x, tile.y), tile.hash);
		}
		rewrites.push(
			...(await rebuildBase({
				blobs,
				tileSize: T,
				concurrency: env.JOB_CONCURRENCY,
				onVersion,
				tiles: stored,
				patchesOf,
				existing,
				preloaded,
				onProgress: (n) => progress.advance(n),
			})),
		);
	}
	if (patches.length === 0) throw new UserError("upload contains no map data");

	rewrites.push(
		...(await rebuildParents({
			blobs,
			tileSize: T,
			maxZoom: env.MAX_ZOOM,
			concurrency: env.JOB_CONCURRENCY,
			onVersion,
			changed: rewrites,
			existing,
			onLevel: (zoom, total) =>
				progress.step(messages.upload.zoom(zoom), {
					at: zoomStep + zoom,
					total,
					unit: "tiles",
				}),
			onProgress: (_zoom, done) => progress.advance(done),
		})),
	);

	const bbox: Bbox = {
		minX: Math.min(...files.map((f) => f.x)),
		minZ: Math.min(...files.map((f) => f.z)),
		maxX: Math.max(...files.map((f) => f.x + f.width - 1)),
		maxZ: Math.max(...files.map((f) => f.z + f.height - 1)),
	};
	progress.step(messages.upload.publishing, {
		at: zoomStep + env.MAX_ZOOM + 1,
	});
	commitRevision(db, {
		revisionId,
		jobId,
		seq,
		head,
		dimensionId: dim.id,
		rewrites,
		patches,
		bbox,
	});
}

/**
 * The published uploads after `seq` that cover any of `tiles`: they are laid over the new
 * tiles again. How many of them, and on how many tiles.
 */
function newerOver(
	db: Db,
	dimensionId: number,
	seq: number,
	tiles: Map<string, unknown>,
): { uploads: number; tiles: number } {
	const rows = db
		.select({
			id: uploadPatches.revisionId,
			x: uploadPatches.tileX,
			y: uploadPatches.tileY,
		})
		.from(uploadPatches)
		.innerJoin(revisions, eq(revisions.id, uploadPatches.revisionId))
		.where(and(eq(revisions.dimensionId, dimensionId), gt(revisions.seq, seq)))
		.all()
		.filter((r) => tiles.has(tileKey(r.x, r.y)));
	return {
		uploads: new Set(rows.map((r) => r.id)).size,
		tiles: new Set(rows.map((r) => tileKey(r.x, r.y))).size,
	};
}
