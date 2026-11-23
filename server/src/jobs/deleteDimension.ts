import { rm } from "node:fs/promises";
import { count, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
	dimensions,
	jobs,
	layers,
	mapInfo,
	revisions,
	shortLinks,
} from "../db/schema";
import { messages } from "./messages";
import { noProgress } from "./report";
import { jobRevisionId } from "./target";
import {
	type DeleteDimensionPayload,
	incomingDir,
	type JobContext,
} from "./types";

/**
 * Deletes an archived dimension with everything in it: its uploads, tile versions, layers with
 * their features, and the short links to it. One transaction, so it is all or nothing. The
 * uploads that are left keep their order and are renumbered without the gap; the images are left
 * for the cleanup. Returns the ids of the removed uploads.
 */
export async function deleteDimension(
	ctx: JobContext,
	payload: DeleteDimensionPayload,
): Promise<number[]> {
	const { db, env } = ctx;
	const progress = ctx.progress ?? noProgress;
	const id = payload.dimensionId;
	const name = db
		.select({ name: dimensions.name })
		.from(dimensions)
		.where(eq(dimensions.id, id))
		.get()?.name;
	if (name !== undefined) {
		const n = (q: { n: number } | undefined) => q?.n ?? 0;
		progress.steps(2);
		progress.fact(
			"uploads",
			messages.facts.uploadCount(
				n(
					db
						.select({ n: count() })
						.from(revisions)
						.where(eq(revisions.dimensionId, id))
						.get(),
				),
			),
		);
		progress.fact(
			"layers",
			messages.facts.layers(
				n(
					db
						.select({ n: count() })
						.from(layers)
						.where(eq(layers.dimensionId, id))
						.get(),
				),
			),
		);
		progress.step(messages.deleteDimension.deleting(name));
	}
	const removed = db.transaction((tx) => {
		const dim = tx.select().from(dimensions).where(eq(dimensions.id, id)).get();
		if (!dim) return [];
		if (!dim.archived) throw new Error("the dimension is not archived");

		const ids = tx
			.select({ id: revisions.id })
			.from(revisions)
			.where(eq(revisions.dimensionId, id))
			.all()
			.map((r) => r.id);
		for (let i = 0; i < ids.length; i += 500)
			tx.delete(jobs)
				.where(inArray(jobRevisionId, ids.slice(i, i + 500)))
				.run();
		// Patches and source file records go with their revision, tile versions with the dimension.
		tx.delete(revisions).where(eq(revisions.dimensionId, id)).run();
		// Features, their versions, members and invites go with their layer.
		tx.delete(layers).where(eq(layers.dimensionId, id)).run();
		const links = tx.select().from(shortLinks).all();
		for (const link of links)
			if (new URLSearchParams(link.query).get("dim") === dim.slug)
				tx.delete(shortLinks).where(eq(shortLinks.code, link.code)).run();
		tx.delete(dimensions).where(eq(dimensions.id, id)).run();

		// Revision numbers are the rank by seq, which has a gap now.
		tx.update(revisions)
			.set({ rev: sql`-${revisions.rev}` })
			.where(isNotNull(revisions.rev))
			.run();
		tx.update(revisions)
			.set({
				rev: sql`(SELECT count(*) FROM revisions r WHERE r.seq <= revisions.seq)`,
			})
			.where(isNotNull(revisions.seq))
			.run();
		tx.update(revisions)
			.set({ rev: null })
			.where(sql`${revisions.seq} IS NULL AND ${revisions.rev} IS NOT NULL`)
			.run();
		const published = tx
			.select({ n: sql<number>`count(*)` })
			.from(revisions)
			.where(isNotNull(revisions.seq))
			.get()?.n as number;
		tx.update(mapInfo)
			.set({ headRev: published, epoch: sql`${mapInfo.epoch} + 1` })
			.run();
		return ids;
	});
	progress.step(messages.deleteDimension.files, {
		total: removed.length,
		unit: "uploads",
	});
	for (const [i, revisionId] of removed.entries()) {
		await rm(incomingDir(env, revisionId), { recursive: true, force: true });
		progress.advance(i + 1);
	}
	return removed;
}
