import { inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { jobs, revisions } from "../db/schema";

/** The revision a job is about, read from its payload. */
export const jobRevisionId = sql<number>`json_extract(${jobs.payload}, '$.revisionId')`;

/** Removes uploads that never finished, with their jobs (files and patches go with the revision). */
export function removeUploads(db: Db, ids: number[]) {
	db.transaction((tx) => {
		for (let i = 0; i < ids.length; i += 500) {
			const chunk = ids.slice(i, i + 500);
			tx.delete(jobs).where(inArray(jobRevisionId, chunk)).run();
			tx.delete(revisions).where(inArray(revisions.id, chunk)).run();
		}
	});
}
