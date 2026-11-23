import {
	and,
	asc,
	between,
	count,
	desc,
	eq,
	gt,
	gte,
	lt,
	lte,
	sql,
} from "drizzle-orm";
import type { Db } from "../db/client";
import {
	jobs,
	mapInfo,
	revisions,
	tileVersions,
	uploadPatches,
} from "../db/schema";
import { type Rewrite, type TilePatch, writeRows } from "./rebuild";

export type Bbox = { minX: number; minZ: number; maxX: number; maxZ: number };

/** Below the seq of every upload: the map before the first revision. */
export const NO_SEQ = Number.MIN_SAFE_INTEGER;

/** Uploads with the same export time get seqs `time * SEQS_PER_MS` + 0, 1, 2 ... in publish order. */
export const SEQS_PER_MS = 1024;

/** The seq of the upload published as revision `rev`; the map as of rev 0 is `NO_SEQ`. */
export async function seqOfRev(db: Db, rev: number): Promise<number> {
	if (rev <= 0) return NO_SEQ;
	const [row] = await db
		.select({ seq: revisions.seq })
		.from(revisions)
		.where(eq(revisions.rev, rev));
	return row?.seq ?? Number.MAX_SAFE_INTEGER;
}

/** The newest revision made at or before `seq`: how many uploads are published up to it (0 = none). */
export function revOfSeq(db: Db, seq: number): number {
	return (
		db
			.select({ n: count() })
			.from(revisions)
			.where(lte(revisions.seq, seq))
			.get()?.n ?? 0
	);
}

/** Non-empty tiles in a rectangle (inclusive) as of `seq`. Tiles not listed are empty. */
export async function tileHashesIn(
	db: Db,
	dimensionId: number,
	zoom: number,
	rect: { minX: number; minY: number; maxX: number; maxY: number },
	seq: number,
): Promise<{ x: number; y: number; hash: string }[]> {
	// SQLite takes the bare columns of an aggregate query from the row that has the max().
	const rows = await db
		.select({
			x: tileVersions.tileX,
			y: tileVersions.tileY,
			hash: tileVersions.blobHash,
			seq: sql<number>`max(${tileVersions.seq})`,
		})
		.from(tileVersions)
		.where(
			and(
				eq(tileVersions.dimensionId, dimensionId),
				eq(tileVersions.zoom, zoom),
				between(tileVersions.tileX, rect.minX, rect.maxX),
				between(tileVersions.tileY, rect.minY, rect.maxY),
				lte(tileVersions.seq, seq),
			),
		)
		.groupBy(tileVersions.tileX, tileVersions.tileY);
	return rows.flatMap((r) =>
		r.hash ? [{ x: r.x, y: r.y, hash: r.hash }] : [],
	);
}

/** Hash of a tile as of `seq`: its newest version at or before it. Null = empty or never written. */
export async function tileHashAt(
	db: Db,
	dimensionId: number,
	zoom: number,
	x: number,
	y: number,
	seq: number,
): Promise<string | null> {
	const [row] = await db
		.select({ blobHash: tileVersions.blobHash })
		.from(tileVersions)
		.where(
			and(
				eq(tileVersions.dimensionId, dimensionId),
				eq(tileVersions.zoom, zoom),
				eq(tileVersions.tileX, x),
				eq(tileVersions.tileY, y),
				lte(tileVersions.seq, seq),
			),
		)
		.orderBy(desc(tileVersions.seq))
		.limit(1);
	return row?.blobHash ?? null;
}

/** The patches of every published upload that touched a tile, from `fromSeq` on, oldest first. */
export function tilePatches(
	db: Db,
	dimensionId: number,
	x: number,
	y: number,
	fromSeq: number,
): Promise<TilePatch[]> {
	return db
		.select({
			seq: sql<number>`${revisions.seq}`,
			hash: uploadPatches.blobHash,
		})
		.from(uploadPatches)
		.innerJoin(revisions, eq(revisions.id, uploadPatches.revisionId))
		.where(
			and(
				eq(revisions.dimensionId, dimensionId),
				eq(uploadPatches.tileX, x),
				eq(uploadPatches.tileY, y),
				gte(revisions.seq, fromSeq),
			),
		)
		.orderBy(asc(revisions.seq));
}

/**
 * Publishes a finished upload atomically: tile versions, patches, the revision row and the
 * map's head_rev all become visible together, or not at all. Its revision number is its rank
 * by `seq`; the uploads after it move up by one. The job that made it (`jobId`) is marked done
 * in the same transaction, so a crash can never leave a published revision with a job that
 * would run again. `epoch` changes when the upload went in before newer ones, since the past
 * of the map changed.
 */
export function commitRevision(
	db: Db,
	opts: {
		revisionId: number;
		jobId?: number;
		seq: number;
		/** The map's head_rev when the upload was built on; publishing fails if it moved. */
		head: number;
		dimensionId: number;
		rewrites: Rewrite[];
		patches?: { x: number; y: number; hash: string }[];
		bbox: Bbox | null;
	},
) {
	const { revisionId, seq, dimensionId } = opts;
	db.transaction((tx) => {
		const map = tx.select({ headRev: mapInfo.headRev }).from(mapInfo).get();
		if (!map || map.headRev !== opts.head)
			throw new Error("map head moved during processing");

		writeRows(tx, dimensionId, seq, opts.rewrites);
		const patches = opts.patches ?? [];
		for (let i = 0; i < patches.length; i += 500) {
			tx.insert(uploadPatches)
				.values(
					patches.slice(i, i + 500).map((p) => ({
						revisionId,
						tileX: p.x,
						tileY: p.y,
						blobHash: p.hash,
					})),
				)
				.run();
		}

		const before = tx
			.select({ n: count() })
			.from(revisions)
			.where(lt(revisions.seq, seq))
			.get()?.n as number;
		const later = tx
			.select({ n: count() })
			.from(revisions)
			.where(gt(revisions.seq, seq))
			.get()?.n as number;
		shiftRevs(tx, seq, 1);
		tx.update(revisions)
			.set({
				rev: before + 1,
				seq,
				status: "done",
				error: null,
				errorDetail: null,
				completedAt: Date.now(),
				bboxMinX: opts.bbox?.minX ?? null,
				bboxMinZ: opts.bbox?.minZ ?? null,
				bboxMaxX: opts.bbox?.maxX ?? null,
				bboxMaxZ: opts.bbox?.maxZ ?? null,
			})
			.where(eq(revisions.id, revisionId))
			.run();
		tx.update(mapInfo)
			.set({
				headRev: map.headRev + 1,
				...(later > 0 && { epoch: sql`${mapInfo.epoch} + 1` }),
			})
			.run();
		if (opts.jobId !== undefined) {
			tx.update(jobs)
				.set({ status: "done" })
				.where(eq(jobs.id, opts.jobId))
				.run();
		}
	});
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Moves the revision number of every upload after `seq` by `by`. They are unique, so they go negative first. */
export function shiftRevs(tx: Tx, seq: number, by: 1 | -1) {
	tx.update(revisions)
		.set({ rev: sql`-${revisions.rev}` })
		.where(gt(revisions.seq, seq))
		.run();
	tx.update(revisions)
		.set({ rev: sql`-${revisions.rev} + ${by}` })
		.where(gt(revisions.seq, seq))
		.run();
}

/** Whether a revision was already published: done, with its revision number. */
export function isPublished(db: Db, revisionId: number): boolean {
	const row = db
		.select({ status: revisions.status, rev: revisions.rev })
		.from(revisions)
		.where(eq(revisions.id, revisionId))
		.get();
	return row?.status === "done" && row.rev !== null;
}
