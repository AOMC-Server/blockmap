import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
	jobs,
	mapInfo,
	revisions,
	tileVersions,
	tileVersionsRebuild,
	uploadPatches,
} from "../db/schema";
import { loadMap } from "../permissions";
import {
	emptyExisting,
	parseKey,
	type Rewrite,
	rebuildBase,
	rebuildParents,
	type TilePatch,
	tileKey,
} from "../tiles/rebuild";
import type { JobContext } from "./types";

const FLUSH_ROWS = 2000;

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const published = (db: Db | Tx) =>
	db
		.select({
			id: revisions.id,
			dimensionId: revisions.dimensionId,
		})
		.from(revisions)
		.where(isNotNull(revisions.seq))
		.orderBy(asc(revisions.seq))
		.all();

/** On boot: queues the rebuild a migration asked for (see map_info.recompute_pending). Returns whether it queued one. */
export function queueRebuildIfPending(db: Db): boolean {
	return db.transaction((tx) => {
		const pending = tx
			.select({ pending: mapInfo.rebuildPending })
			.from(mapInfo)
			.get()?.pending;
		const busy = tx
			.select({ id: jobs.id })
			.from(jobs)
			.where(
				and(
					eq(jobs.type, "rebuild_history"),
					inArray(jobs.status, ["pending", "processing"]),
				),
			)
			.get();
		if (!pending || busy) return false;
		tx.insert(jobs).values({ type: "rebuild_history", payload: {} }).run();
		return true;
	});
}

/**
 * Rebuilds every tile version from the uploads' patches, laid over each other in seq order,
 * and gives the uploads their revision numbers in that order. The result of normal operation
 * already is that; this is for when the stored tiles may not be (a migration asked for it).
 *
 * The new rows are written to tile_versions_rebuild and swapped in, together with the revision
 * numbers, in one transaction that also marks the job done. Until then nothing visible
 * changes, so an interrupted run leaves the old history in place.
 */
export async function rebuildHistory(ctx: JobContext, jobId: number) {
	const { db, env, blobs } = ctx;
	const map = await loadMap(db);
	const T = map.tileSize;
	const startHead = map.headRev;

	const uploads = published(db);

	db.delete(tileVersionsRebuild).run();
	let pending: (typeof tileVersionsRebuild.$inferInsert)[] = [];
	const flush = () => {
		if (pending.length === 0) return;
		const chunk = pending;
		pending = [];
		db.transaction((tx) => {
			for (let i = 0; i < chunk.length; i += 500) {
				tx.insert(tileVersionsRebuild)
					.values(chunk.slice(i, i + 500))
					.run();
			}
		});
	};
	const write = (dimensionId: number, rewrites: Rewrite[]) => {
		for (const w of rewrites) {
			for (const r of w.rows) {
				pending.push({
					dimensionId,
					zoom: w.zoom,
					tileX: w.x,
					tileY: w.y,
					seq: r.seq,
					blobHash: r.hash,
				});
			}
			if (pending.length >= FLUSH_ROWS) flush();
		}
	};

	const dimIds = [
		...new Set(
			uploads.flatMap((u) => (u.dimensionId === null ? [] : [u.dimensionId])),
		),
	];
	for (const dimId of dimIds) {
		const patches = db
			.select({
				seq: sql<number>`${revisions.seq}`,
				x: uploadPatches.tileX,
				y: uploadPatches.tileY,
				hash: uploadPatches.blobHash,
			})
			.from(uploadPatches)
			.innerJoin(revisions, eq(revisions.id, uploadPatches.revisionId))
			.where(and(eq(revisions.dimensionId, dimId), isNotNull(revisions.seq)))
			.all();
		const byTile = new Map<string, TilePatch[]>();
		for (const p of patches) {
			const key = tileKey(p.x, p.y);
			const list = byTile.get(key) ?? [];
			list.push({ seq: p.seq, hash: p.hash });
			byTile.set(key, list);
		}

		const base = await rebuildBase({
			blobs,
			tileSize: T,
			concurrency: env.JOB_CONCURRENCY,
			tiles: [...byTile.keys()].map((key) => {
				const [x, y] = parseKey(key);
				return { x, y };
			}),
			patchesOf: async (x, y) => byTile.get(tileKey(x, y)) ?? [],
			existing: emptyExisting,
		});
		write(dimId, base);
		write(
			dimId,
			await rebuildParents({
				blobs,
				tileSize: T,
				maxZoom: env.MAX_ZOOM,
				concurrency: env.JOB_CONCURRENCY,
				changed: base,
				existing: emptyExisting,
			}),
		);
	}
	flush();

	db.transaction((tx) => {
		// Only the worker publishes or deletes uploads, and it runs one job at a time; this guards
		// against that ever changing.
		const head = tx.select({ headRev: mapInfo.headRev }).from(mapInfo).get();
		const now = published(tx);
		if (
			head?.headRev !== startHead ||
			now.length !== uploads.length ||
			now.some((u, i) => u.id !== uploads[i]?.id)
		) {
			throw new Error("the map changed during the rebuild");
		}

		tx.delete(tileVersions).run();
		tx.run(sql`INSERT INTO tile_versions (dimension_id, zoom, tile_x, tile_y, seq, blob_hash)
			SELECT dimension_id, zoom, tile_x, tile_y, seq, blob_hash FROM tile_versions_rebuild`);
		tx.delete(tileVersionsRebuild).run();

		// Revision numbers are unique, so they are moved out of the way before being reassigned.
		tx.update(revisions)
			.set({ rev: sql`-${revisions.rev}` })
			.where(isNotNull(revisions.rev))
			.run();
		for (const [i, u] of uploads.entries()) {
			tx.update(revisions)
				.set({ rev: i + 1 })
				.where(eq(revisions.id, u.id))
				.run();
		}

		tx.update(mapInfo)
			.set({
				headRev: uploads.length,
				epoch: sql`${mapInfo.epoch} + 1`,
				rebuildPending: false,
			})
			.run();
		tx.update(jobs)
			.set({ status: "done", error: null, completedAt: Date.now() })
			.where(eq(jobs.id, jobId))
			.run();
	});
}
