import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { z } from "zod";
import type { Db } from "./db/client";
import { dimensions, mapInfo, revisions as revisionsTable } from "./db/schema";
import type { Events, Family, MapEvent, RevisionEvent } from "./events";
import { erasing, queueState, waiting } from "./jobs/queue";
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
const status = <S extends string>(s: S) => z.literal(s);
const invalidation = z.object({}).strict();

const revisionMessages = {
	pending: {
		summary:
			"The job is queued. `message` says what it waits for (for example a running history rebuild, or how many jobs are ahead); a new event follows whenever that changes.",
		schema: z.object({
			status: status("pending"),
			message: z.string().optional(),
			rev: nullableInt.optional(),
			error: z.string().nullable().optional(),
		}),
	},
	processing: {
		summary:
			"The job is running; `message`, `done` and `total` tell how far. As the first event, with a `message` that says what it waits for, the upload is waiting for its queued delete to start and is otherwise unchanged.",
		schema: z.object({
			status: status("processing"),
			message: z.string().optional(),
			done: z.number().int().optional(),
			total: z.number().int().optional(),
			rev: nullableInt.optional(),
			error: z.string().nullable().optional(),
		}),
	},
	done: {
		summary: "The job finished; `rev` is the revision number.",
		schema: z.object({
			status: status("done"),
			rev: nullableInt.optional(),
			error: z.string().nullable().optional(),
		}),
	},
	failed: {
		summary: "The job failed; `error` says why.",
		schema: z.object({
			status: status("failed"),
			rev: nullableInt.optional(),
			error: z.string().nullable().optional(),
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
export function revisionSnapshot(db: Db, id: number): RevisionEvent {
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
				: revisionSnapshot(c.var.db, id as number);
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
					headRev: z.number().int(),
					epoch: z.number().int(),
					maintenance: z.boolean(),
				}),
			},
		},
		name: () => "changed",
		snapshot: (c) => mapSnapshot(c.var.db),
	},
	queue: {
		title: "Job queue",
		description:
			"Uploads, deletions, history rebuilds, image cleanups and dimension deletions run one at a time. `pending` counts the jobs waiting; `running` is the one being run (`revisionId` null for all but uploads and deletions).",
		messages: {
			changed: {
				summary: "The queue changed.",
				schema: z.object({
					pending: z.number().int(),
					running: z
						.object({ type: jobType, revisionId: nullableInt })
						.nullable(),
				}),
			},
		},
		name: () => "changed",
		snapshot: (c) => queueState(c.var.db),
	},
};
