import { and, count, countDistinct, eq, gt, inArray, sql } from "drizzle-orm";
import {
	jobs,
	mapInfo,
	revisions,
	uploadFiles,
	uploadPatches,
} from "../db/schema";
import { loadMap } from "../permissions";
import { shiftRevs, tilePatches } from "../tiles/history";
import {
	dbExisting,
	rebuildBase,
	rebuildParents,
	writeRows,
} from "../tiles/rebuild";
import { messages } from "./messages";
import { noProgress } from "./report";
import { jobRevisionId } from "./target";
import { type EraseUploadPayload, type JobContext, UserError } from "./types";

/**
 * Deletes an upload as if it had never been made: it leaves the map, every past revision, the
 * upload log and the job history. No other upload changes; the ones after it move down a
 * revision number.
 *
 * Only the tiles the upload touched are rewritten, and only from its place in the history on:
 * for each one, the patches of the later uploads are laid over the tile as it was before, and a
 * row is stored wherever that changes it. The zoomed-out tiles above are rebuilt from
 * the rewritten rows the same way. Everything is swapped in with one transaction.
 */
export async function eraseUpload(
	ctx: JobContext,
	payload: EraseUploadPayload,
) {
	const { db, env, blobs } = ctx;
	const progress = ctx.progress ?? noProgress;

	const [target] = await db
		.select()
		.from(revisions)
		.where(eq(revisions.id, payload.revisionId));
	if (
		target?.kind !== "upload" ||
		target.seq === null ||
		target.dimensionId === null
	) {
		throw new UserError("target revision is not a finished upload");
	}
	const seq = target.seq;
	const dimId = target.dimensionId;
	const T = (await loadMap(db)).tileSize;

	const existing = dbExisting(db, dimId, seq);
	const touched = await db
		.select({ x: uploadPatches.tileX, y: uploadPatches.tileY })
		.from(uploadPatches)
		.where(eq(uploadPatches.revisionId, target.id));

	progress.steps(env.MAX_ZOOM + 2);
	progress.fact("tiles", messages.facts.tilesTouched(touched.length));
	// The later uploads on the same tiles are laid over what was under it again.
	const mine = db
		.select({ x: uploadPatches.tileX, y: uploadPatches.tileY })
		.from(uploadPatches)
		.where(eq(uploadPatches.revisionId, target.id));
	const newer = db
		.select({
			uploads: countDistinct(uploadPatches.revisionId),
			tiles: countDistinct(
				sql`${uploadPatches.tileX} || ',' || ${uploadPatches.tileY}`,
			),
		})
		.from(uploadPatches)
		.innerJoin(revisions, eq(revisions.id, uploadPatches.revisionId))
		.where(
			and(
				eq(revisions.dimensionId, dimId),
				gt(revisions.seq, seq),
				sql`(${uploadPatches.tileX}, ${uploadPatches.tileY}) IN ${mine}`,
			),
		)
		.get();
	progress.fact(
		"newer",
		newer && newer.uploads > 0
			? messages.facts.newerUploads(newer.uploads, newer.tiles)
			: messages.facts.noNewerUploads,
	);
	const later =
		db
			.select({ n: count() })
			.from(revisions)
			.where(gt(revisions.seq, seq))
			.get()?.n ?? 0;
	if (later > 0) progress.fact("later", messages.facts.renumbered(later));
	progress.step(messages.erase.tiles, {
		total: touched.length,
		unit: "tiles",
	});

	const base = await rebuildBase({
		blobs,
		tileSize: T,
		concurrency: env.JOB_CONCURRENCY,
		tiles: touched,
		patchesOf: async (x, y) =>
			(await tilePatches(db, dimId, x, y, seq)).filter((p) => p.seq !== seq),
		existing,
		onProgress: (done) => progress.advance(done),
	});
	const rewrites = [
		...base,
		...(await rebuildParents({
			blobs,
			tileSize: T,
			maxZoom: env.MAX_ZOOM,
			concurrency: env.JOB_CONCURRENCY,
			changed: base,
			existing,
			onLevel: (zoom, total) =>
				progress.step(messages.erase.zoom(zoom), {
					at: 1 + zoom,
					total,
					unit: "tiles",
				}),
			onProgress: (_zoom, done) => progress.advance(done),
		})),
	];

	progress.step(messages.erase.publishing, { at: env.MAX_ZOOM + 2 });
	const ids = [target.id];
	db.transaction((tx) => {
		writeRows(tx, dimId, seq, rewrites);

		tx.delete(uploadPatches)
			.where(inArray(uploadPatches.revisionId, ids))
			.run();
		tx.delete(uploadFiles).where(inArray(uploadFiles.revisionId, ids)).run();
		tx.delete(jobs).where(inArray(jobRevisionId, ids)).run();
		tx.delete(revisions).where(inArray(revisions.id, ids)).run();

		// The uploads after it move down a revision number.
		shiftRevs(tx, seq, -1);
		tx.update(mapInfo)
			.set({
				headRev: sql`${mapInfo.headRev} - 1`,
				epoch: sql`${mapInfo.epoch} + 1`,
			})
			.run();
	});
}
