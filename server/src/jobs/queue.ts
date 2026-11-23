import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { dimensions, jobs, revisions, users } from "../db/schema";
import type { QueueEvent } from "../events";
import { waitingMessage } from "./messages";
import { jobRevisionId } from "./target";

/** Ids of the uploads that have an erase queued or running. */
export function erasing(db: Db, ids?: number[]): Set<number> {
	return new Set(
		db
			.select({ id: jobRevisionId })
			.from(jobs)
			.where(
				and(
					eq(jobs.type, "erase_upload"),
					inArray(jobs.status, ["pending", "processing"]),
					ids ? inArray(jobRevisionId, ids) : undefined,
				),
			)
			.all()
			.map((row) => row.id),
	);
}

/**
 * Why the revision's queued job has not started, or null when it has no queued job (it is
 * running, or finished): the history rebuild in the way, or how many jobs are ahead of it.
 */
export function waiting(db: Db, revisionId: number): string | null {
	const open = openJobs(db);
	const at = open.findLastIndex(
		(j) => j.revisionId === revisionId && j.status === "pending",
	);
	if (at < 0) return null;
	return waitingMessage(open.slice(0, at));
}

/** How many jobs wait, and which one runs. */
export function queueState(db: Db): QueueEvent {
	const open = db
		.select({ type: jobs.type, status: jobs.status, revisionId: jobRevisionId })
		.from(jobs)
		.where(inArray(jobs.status, ["pending", "processing"]))
		.orderBy(asc(jobs.id))
		.all();
	const running = open.find((j) => j.status === "processing");
	return {
		pending: open.filter((j) => j.status === "pending").length,
		running: running
			? {
					type: running.type,
					revisionId:
						running.type !== "process_upload" && running.type !== "erase_upload"
							? null
							: (running.revisionId as number | null),
				}
			: null,
	};
}

/** The dimension a job is about: its upload's, or the one it deletes. */
const jobDimensionId = sql<
	number | null
>`coalesce(${revisions.dimensionId}, json_extract(${jobs.payload}, '$.dimensionId'))`;

/** Jobs with what they are about: the upload, its author and the dimension. */
function jobRows(db: Db) {
	return db
		.select({
			id: jobs.id,
			type: jobs.type,
			status: jobs.status,
			attempts: jobs.attempts,
			createdAt: jobs.createdAt,
			completedAt: jobs.completedAt,
			error: sql<string | null>`coalesce(${jobs.error}, ${revisions.error})`,
			/** The internal error behind an upload's failure, for moderators. */
			errorDetail: revisions.errorDetail,
			revisionId: revisions.id,
			fileCount: revisions.fileCount,
			exportedAt: revisions.exportedAt,
			dimension: dimensions.name,
			dimensionArchived: dimensions.archived,
			author: users.username,
		})
		.from(jobs)
		.leftJoin(revisions, eq(revisions.id, jobRevisionId))
		.leftJoin(dimensions, eq(dimensions.id, jobDimensionId))
		.leftJoin(users, eq(users.id, revisions.authorId));
}

export type JobRow = ReturnType<ReturnType<typeof jobRows>["all"]>[number];

type Orderable = {
	id: number;
	type: string;
	status: string;
	exportedAt: number | null;
	createdAt: number;
};

/**
 * The order jobs run in: the running one, then the queued ones by id, except that uploads
 * queued back to back run oldest export first (undated ones count as made when uploaded).
 * Stacking older data before newer spares the rewrite of the newer uploads' tiles. Uploads
 * never pass another kind of job, which stays where it was queued.
 */
export function runOrder<T extends Orderable>(open: T[]): T[] {
	const byId = [...open].sort((a, b) => a.id - b.id);
	const out = byId.filter((j) => j.status !== "pending");
	let uploads: T[] = [];
	const flush = () => {
		uploads.sort(
			(a, b) =>
				(a.exportedAt ?? a.createdAt) - (b.exportedAt ?? b.createdAt) ||
				a.id - b.id,
		);
		out.push(...uploads);
		uploads = [];
	};
	for (const job of byId) {
		if (job.status !== "pending") continue;
		if (job.type === "process_upload") {
			uploads.push(job);
			continue;
		}
		flush();
		out.push(job);
	}
	flush();
	return out;
}

/** The jobs that wait or run, in the order they run (see `runOrder`). */
export function openJobs(db: Db): JobRow[] {
	return runOrder(
		jobRows(db)
			.where(inArray(jobs.status, ["pending", "processing"]))
			.all(),
	);
}

/** The jobs that finished or failed last, newest first. */
export function recentJobs(db: Db, limit: number): JobRow[] {
	return jobRows(db)
		.where(inArray(jobs.status, ["done", "failed"]))
		.orderBy(
			desc(sql`coalesce(${jobs.completedAt}, ${jobs.createdAt})`),
			desc(jobs.id),
		)
		.limit(limit)
		.all();
}

/** What anyone may see of a queued job: no errors, attempts, or archived dimensions. */
export function publicJob(job: JobRow) {
	return {
		id: job.id,
		type: job.type,
		status: job.status as "pending" | "processing",
		createdAt: job.createdAt,
		revisionId: job.revisionId,
		dimension: job.dimensionArchived ? null : job.dimension,
		author: job.author,
		fileCount: job.fileCount,
		exportedAt: job.exportedAt,
	};
}
