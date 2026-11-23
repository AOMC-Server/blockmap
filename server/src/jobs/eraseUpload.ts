import { eq, inArray, sql } from "drizzle-orm";
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
import { type ProgressStep, throttled } from "./report";
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
	const { db, env, blobs, events } = ctx;
	const report = throttled((p: ProgressStep) =>
		events.emit("revision", payload.revisionId, { status: "processing", ...p }),
	);
	const say = (message: string, done?: number, total?: number) =>
		report({ message, done, total });

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

	const base = await rebuildBase({
		blobs,
		tileSize: T,
		concurrency: env.JOB_CONCURRENCY,
		tiles: touched,
		patchesOf: async (x, y) =>
			(await tilePatches(db, dimId, x, y, seq)).filter((p) => p.seq !== seq),
		existing,
		onProgress: (done, total) => say(messages.erase.tiles, done, total),
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
			onProgress: (zoom, done, total) =>
				say(messages.erase.zoom(zoom), done, total),
		})),
	];

	say(messages.erase.publishing);
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
