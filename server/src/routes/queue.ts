import { Hono } from "hono";
import { openJobs, publicJob } from "../jobs/queue";
import { doc } from "../openapi";
import type { AppEnv } from "../types";

export const queueRoutes = new Hono<AppEnv>().get(
	"/",
	doc({
		tag: "Revisions",
		summary: "List the queued jobs",
		description:
			"Uploads, deletions, history rebuilds, image cleanups and dimension deletions run one at a time. `jobs` are the ones waiting or running, in the order they run: the running one (`status` `processing`) first. `revisionId`, `author` and `fileCount` are set for uploads and their deletions; `dimension` is the name of the dimension the job is about, when it has one. Follow the `queue` topic to know when to fetch it again.",
	}),
	(c) => c.json({ jobs: openJobs(c.var.db).map(publicJob) }),
);
