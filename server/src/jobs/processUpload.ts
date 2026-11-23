import { floorDiv } from "@blockmap/shared";
import { and, eq, gte, lt, max } from "drizzle-orm";
import { mapLimit } from "../concurrency";
import type { Db } from "../db/client";
import { dimensions, revisions } from "../db/schema";
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
import { type ProgressStep, throttled } from "./report";
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
	const { db, env, blobs, events } = ctx;
	const { revisionId, files } = payload;
	const report = throttled((p: ProgressStep) =>
		events.emit("revision", revisionId, { status: "processing", ...p }),
	);
	const say = (message: string, done?: number, total?: number) =>
		report({ message, done, total });

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

	// One patch per touched tile, files pasted in upload order, and composited into its tile
	// while it is still in memory. Tiles are done in batches to bound memory; within a batch each
	// file is decoded once and pasted into every tile it covers, and the tiles are then encoded
	// several at once.
	const patches: { x: number; y: number; hash: string }[] = [];
	const rewrites: Rewrite[] = [];
	const tiles = [...byTile.values()];
	const batchSize = Math.max(1, Math.floor(batchBytes / (T * T * 4)));
	let n = 0;
	// Decoding a source image can take a while and nothing else is reported meanwhile, so it
	// counts as progress too: how many images each batch reads, in total.
	let reads = 0;
	for (let start = 0; start < tiles.length; start += batchSize) {
		reads += new Set(
			tiles.slice(start, start + batchSize).flatMap((tile) => tile.files),
		).size;
	}
	let read = 0;
	for (let start = 0; start < tiles.length; start += batchSize) {
		const batch = tiles.slice(start, start + batchSize);
		const canvases = batch.map(() => emptyTile(T));
		const covered = new Map<number, number[]>();
		for (const [b, tile] of batch.entries()) {
			for (const index of tile.files) {
				const list = covered.get(index) ?? [];
				list.push(b);
				covered.set(index, list);
			}
		}
		for (const index of [...covered.keys()].sort((a, b) => a - b)) {
			const f = files[index] as (typeof files)[number];
			say(messages.upload.reading, read++, reads);
			const img = await decodeRaw(
				`${incomingDir(env, revisionId)}/${index}.png`,
				env.MAX_IMAGE_DIM,
			).catch(() => {
				throw new UserError(messages.failed.unreadableImage(f.x, f.z));
			});
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
		const done = await mapLimit(
			batch,
			env.JOB_CONCURRENCY,
			async ({ tx, ty }, b) => {
				const patch = canvases[b] as Buffer;
				const hash = await storeTile(blobs, patch, T);
				if (hash) preloaded.set(hash, patch);
				say(messages.upload.tiles, ++n, tiles.length);
				return hash ? { x: tx, y: ty, hash } : null;
			},
		);
		const stored = done.filter((tile) => tile !== null);
		for (const tile of stored) {
			patches.push(tile);
			mine.set(tileKey(tile.x, tile.y), tile.hash);
		}
		rewrites.push(
			...(await rebuildBase({
				blobs,
				tileSize: T,
				concurrency: env.JOB_CONCURRENCY,
				tiles: stored,
				patchesOf,
				existing,
				preloaded,
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
			changed: rewrites,
			existing,
			onProgress: (zoom, done, total) =>
				say(messages.upload.zoom(zoom), done, total),
		})),
	);

	const bbox: Bbox = {
		minX: Math.min(...files.map((f) => f.x)),
		minZ: Math.min(...files.map((f) => f.z)),
		maxX: Math.max(...files.map((f) => f.x + f.width - 1)),
		maxZ: Math.max(...files.map((f) => f.z + f.height - 1)),
	};
	say(messages.upload.publishing);
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
