import { formatProgress } from "@aomc-server/block-ui/format";
import type { InferResponseType } from "hono/client";
import { useEffect, useRef, useState } from "preact/hooks";
import type { QueueEvent, RevisionEvent } from "../../server/src/events";
import { api, attempt } from "./api";
import { subscribe } from "./events";

export type QueuedJob = InferResponseType<
	typeof api.api.queue.$get,
	200
>["jobs"][number];
export type AdminJobs = InferResponseType<typeof api.api.admin.jobs.$get, 200>;
export type AdminJob = AdminJobs["open"][number];
export type JobType = QueuedJob["type"];

export const JOB_LABELS: Record<JobType, string> = {
	process_upload: "Upload",
	erase_upload: "Upload deletion",
	rebuild_history: "History rebuild",
	gc_blobs: "Image cleanup",
	delete_dimension: "Dimension deletion",
};

/** What the job is about: "by Steve · Overworld · 3 files". */
export function jobSubject(job: {
	author: string | null;
	dimension: string | null;
	fileCount: number | null;
	type: JobType;
}): string {
	const parts: string[] = [];
	if (job.author) parts.push(`by ${job.author}`);
	if (job.dimension) parts.push(job.dimension);
	if (job.type === "process_upload" && job.fileCount)
		parts.push(`${job.fileCount} file${job.fileCount === 1 ? "" : "s"}`);
	return parts.join(" · ");
}

export const fetchQueue = async (): Promise<QueuedJob[] | null> => {
	const res = await attempt(() => api.api.queue.$get());
	return res.ok ? res.body.jobs : null;
};

export const fetchAdminJobs = async (): Promise<AdminJobs | null> => {
	const res = await attempt(() => api.api.admin.jobs.$get());
	return res.ok ? res.body : null;
};

/** The queue as the server announces it: how many wait and which runs; null until known. */
export function useQueueState(): QueueEvent | null {
	const [state, setState] = useState<QueueEvent | null>(null);
	useEffect(() => subscribe("queue", { onEvent: setState }), []);
	return state;
}

/**
 * Loads `load` now and again whenever the queue changes (or, while the live stream is down,
 * every few seconds). `failed` is set when the last load did not work.
 */
export function useJobList<T>(load: () => Promise<T | null>) {
	const [data, setData] = useState<T | null>(null);
	const [failed, setFailed] = useState(false);
	const loader = useRef(load);
	loader.current = load;
	useEffect(() => {
		let live = true;
		const reload = () =>
			void loader.current().then((next) => {
				if (!live) return;
				setFailed(next === null);
				if (next !== null) setData(next);
			});
		reload();
		const stop = subscribe("queue", {
			onEvent: reload,
			poll: reload,
			pollMs: 5000,
		});
		return () => {
			live = false;
			stop();
		};
	}, []);
	return { data, failed };
}

/** How far the running upload or upload deletion is, as text; null when not known. */
export function useJobProgress(revisionId: number | null): string | null {
	const [progress, setProgress] = useState<string | null>(null);
	useEffect(() => {
		setProgress(null);
		if (revisionId === null) return;
		return subscribe(`revision:${revisionId}`, {
			onEvent: (e: RevisionEvent) => {
				if (e.status !== "processing" || !e.message) return;
				setProgress(formatProgress(e.message, e.done, e.total));
			},
		});
	}, [revisionId]);
	return progress;
}
