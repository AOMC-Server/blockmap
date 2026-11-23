import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { z } from "zod";
import type { Db } from "./db/client";
import { dimensions, mapInfo, revisions as revisionsTable } from "./db/schema";
import type { Events, Family, MapEvent, RevisionEvent } from "./events";
import { erasing, type LiveJob, queueState, waiting } from "./jobs/queue";
import { progressEvent } from "./jobs/report";
import { canSeeUpload } from "./permissions";
import type { AppEnv } from "./types";

/** How one topic family is followed. Adding a family = an entry in `Events` and one here. */
export type TopicDef<F extends Family> = {
	title: string;
	/** What the key is, for keyed families. */
	key?: string;
	description: string;
	/** Named messages, for the AsyncAPI document; `name` picks the one an event is. */
	messages: Record<string, { summary: string; schema: z.ZodType }>;
	name: (data: Events[F]) => string;
	/** Whether the caller may follow it. Defaults to anyone. */
	authorize?: (c: Context<AppEnv>, key: number | undefined) => boolean;
	/**
	 * The current state, sent first. Must be synchronous, so nothing is emitted between
	 * subscribing and taking it. Null = no such topic.
	 */
	snapshot: (c: Context<AppEnv>, key: number | undefined) => Events[F] | null;
	/** Other topics whose events change this one's snapshot; it is sent again when it differs. */
	refreshOn?: Family[];
	/** After such an event the topic is done and dropped from the stream. */
	terminal?: (data: Events[F]) => boolean;
};

const nullableInt = z.number().int().nullable();
const revNumber = nullableInt
	.optional()
	.describe(
		"The upload's position in history (1 for the oldest export); `null` until it is published",
	);
const revisionError = z
	.string()
	.nullable()
	.optional()
	.describe("Why the upload failed; `null` otherwise");
const waitMessage = z
	.string()
	.optional()
	.describe("What the job is doing or waiting for, as a sentence");
const status = <S extends string>(s: S) =>
	z.literal(s).describe("The status, which is also the event name");
const invalidation = z.object({}).strict();

const jobProgress = z
	.object({
		step: z.number().int().describe("1-based"),
		steps: z.number().int().describe("Total number of steps in the job"),
		message: z.string().describe("The step, as a sentence"),
		done: z
			.number()
			.int()
			.optional()
			.describe("How much of this step is done, in `unit`"),
		total: z
			.number()
			.int()
			.optional()
			.describe("Total work for this step, in `unit`"),
		unit: z
			.string()
			.optional()
			.describe(
				'What done and total count: "images", "tiles", "files" or "uploads"',
			),
		rate: z.number().optional().describe("Units a second in this step so far"),
		facts: z.array(z.string()).describe("Facts about the work, as short lines"),
		startedAt: z.number().int().describe("When the job started (ms)"),
	})
	.describe("What a running job is doing");

const revisionMessages = {
	pending: {
		summary:
			"The job is queued. `message` says what it waits for (for example a running history rebuild, or how many jobs are ahead); a new event follows whenever that changes.",
		schema: z.object({
			status: status("pending"),
			message: waitMessage,
			rev: revNumber,
			error: revisionError,
		}),
	},
	processing: {
		summary:
			"The job is running; `message`, `done` and `total` tell how far, and `progress` the detail: the step of how many, the rate and facts about the work. As the first event, with a `message` that says what it waits for, the upload is waiting for its queued delete to start and is otherwise unchanged.",
		schema: z.object({
			status: status("processing"),
			message: waitMessage,
			done: z.number().int().optional().describe("Same as `progress.done`"),
			total: z.number().int().optional().describe("Same as `progress.total`"),
			progress: jobProgress.optional(),
			rev: revNumber,
			error: revisionError,
		}),
	},
	done: {
		summary: "The job finished; `rev` is the revision number.",
		schema: z.object({
			status: status("done"),
			rev: revNumber,
			error: revisionError,
		}),
	},
	failed: {
		summary: "The job failed; `error` says why.",
		schema: z.object({
			status: status("failed"),
			rev: revNumber,
			error: revisionError,
		}),
	},
	gone: {
		summary:
			"The revision does not exist (any more): a deleted upload ends with this once it is erased.",
		schema: z.object({ status: status("gone") }),
	},
} satisfies Record<RevisionEvent["status"], unknown>;

const jobType = z.enum([
	"process_upload",
	"erase_upload",
	"rebuild_history",
	"gc_blobs",
	"delete_dimension",
]);

/** Whether a dimension exists, for the keyed collection topics. */
const dimensionExists = (db: Db, id: number | undefined) =>
	id !== undefined &&
	db
		.select({ id: dimensions.id })
		.from(dimensions)
		.where(eq(dimensions.id, id))
		.get() !== undefined;

/** A revision's state right now, as its first event. */
export function revisionSnapshot(
	db: Db,
	id: number,
	live: LiveJob | null = null,
): RevisionEvent {
	// What the running job last said, exactly as it said it, so a refresh resends nothing.
	if (live?.revisionId === id && live.progress)
		return progressEvent(live.progress);
	const current = db
		.select({
			status: revisionsTable.status,
			rev: revisionsTable.rev,
			error: revisionsTable.error,
		})
		.from(revisionsTable)
		.where(eq(revisionsTable.id, id))
		.get();
	if (!current) return { status: "gone" };
	const message = waiting(db, id);
	// A delete leaves the upload's own status alone: it is done until it is gone.
	if (erasing(db, [id]).has(id))
		return message === null
			? { status: "processing" }
			: { status: "processing", message };
	if (message !== null) return { status: "pending", message };
	return { status: current.status, rev: current.rev, error: current.error };
}

export function mapSnapshot(db: Db): MapEvent {
	const m = db.select().from(mapInfo).get();
	return {
		headRev: m?.headRev ?? 0,
		epoch: m?.epoch ?? 0,
		maintenance: m?.maintenance ?? false,
	};
}

export const topics: { [F in Family]: TopicDef<F> } = {
	revision: {
		title: "Revision progress",
		key: "Revision id",
		description:
			"Progress of an upload or of its deletion. The first event is the revision's current status; after that an event is sent for each step. It ends after `done`, `failed` or `gone`. A revision that does not exist is `gone` rather than `not found`: an erased upload cannot be told apart from one that never was. A failed upload of someone else is `not found` unless you are a moderator.",
		messages: revisionMessages,
		name: (d) => d.status,
		snapshot: (c, id) => {
			const upload = c.var.db
				.select({
					status: revisionsTable.status,
					authorId: revisionsTable.authorId,
				})
				.from(revisionsTable)
				.where(eq(revisionsTable.id, id as number))
				.get();
			return upload && !canSeeUpload(c.var.user, c.var.role, upload)
				? null
				: revisionSnapshot(c.var.db, id as number, c.var.svc.worker.live());
		},
		refreshOn: ["queue"],
		terminal: (d) =>
			d.status === "done" || d.status === "failed" || d.status === "gone",
	},
	revisions: {
		title: "Upload log",
		key: "Dimension id",
		description:
			"The dimension's upload log changed: an upload was added, changed status, or is being or was deleted. Fetch `GET /api/revisions` again.",
		messages: {
			changed: { summary: "The upload log changed.", schema: invalidation },
		},
		name: () => "changed",
		snapshot: (c, id) => (dimensionExists(c.var.db, id) ? {} : null),
	},
	layers: {
		title: "Layers",
		key: "Dimension id",
		description:
			"A layer of the dimension, its features or who may see it changed. Fetch `GET /api/layers` again; what you get is still up to your access.",
		messages: {
			changed: { summary: "The layers changed.", schema: invalidation },
		},
		name: () => "changed",
		snapshot: (c, id) => (dimensionExists(c.var.db, id) ? {} : null),
	},
	map: {
		title: "Map",
		description:
			"The map changed: a new head revision, rewritten history (`epoch`), maintenance, or its settings or dimensions. Fetch `GET /api/map` again for the rest.",
		messages: {
			changed: {
				summary: "The map changed.",
				schema: z.object({
					headRev: z
						.number()
						.int()
						.describe("Number of the newest revision (0 before any upload)"),
					epoch: z
						.number()
						.int()
						.describe(
							"Increases when history is rewritten (an upload is deleted, or inserted before newer ones), which renumbers revisions",
						),
					maintenance: z
						.boolean()
						.describe("Whether only owners may make changes right now"),
				}),
			},
		},
		name: () => "changed",
		snapshot: (c) => mapSnapshot(c.var.db),
	},
	queue: {
		title: "Job queue",
		description:
			"Uploads, deletions, history rebuilds, image cleanups and dimension deletions run one at a time. `pending` counts the jobs waiting; `running` is the one being run (`revisionId` null for all but uploads and deletions), with `progress`: what it is doing, sent again as it goes on (at most a few times a second).",
		messages: {
			changed: {
				summary: "The queue changed.",
				schema: z.object({
					pending: z.number().int().describe("How many jobs are waiting"),
					running: z
						.object({
							type: jobType.describe("Kind of job"),
							revisionId: nullableInt.describe(
								"Revision id of the upload or its deletion; `null` for other jobs",
							),
							progress: jobProgress
								.nullable()
								.describe("Current progress; `null` until the job reports"),
						})
						.nullable()
						.describe("The job currently running; `null` when none is"),
				}),
			},
		},
		name: () => "changed",
		snapshot: (c) => queueState(c.var.db, c.var.svc.worker.live()),
	},
};
