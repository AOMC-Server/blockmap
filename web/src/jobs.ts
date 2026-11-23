import { formatNumber } from "@aomc-server/block-ui/format";
import type { InferResponseType } from "hono/client";
import { useEffect, useRef, useState } from "preact/hooks";
import type { JobProgress, QueueEvent } from "../../server/src/events";
import { api, attempt } from "./api";
import { subscribe } from "./events";

export type QueuedJob = InferResponseType<
	typeof api.api.queue.$get,
	200
>["jobs"][number];
export type AdminJobs = InferResponseType<typeof api.api.admin.jobs.$get, 200>;
export type AdminJob = AdminJobs["open"][number];
export type JobType = QueuedJob["type"];
export type { JobProgress };

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

/** Which jobs are in the queue, leaving out how far the running one is. */
const membership = (q: QueueEvent) =>
	JSON.stringify([
		q.pending,
		q.running?.type,
		q.running?.revisionId,
		q.running?.progress?.startedAt,
	]);

/**
 * Loads `load` now and again whenever jobs join or leave the queue (or, while the live stream is down,
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
		let last = "";
		const stop = subscribe("queue", {
			// The running job's progress comes several times a second; only reload for new jobs.
			onEvent: (q) => {
				const key = membership(q);
				if (key === last) return;
				last = key;
				reload();
			},
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

/** "Step 3 of 7: Building map tiles". */
export const describeStep = (p: JobProgress) =>
	`Step ${p.step} of ${p.steps}: ${p.message}`;

/** "12 of 40 tiles · 85 tiles/s", or null when the step counts nothing. */
export function describeCount(p: JobProgress): string | null {
	if (p.total === undefined) return null;
	const unit = p.unit ? ` ${p.unit}` : "";
	const count = `${formatNumber(p.done ?? 0)} of ${formatNumber(p.total)}${unit}`;
	if (p.rate === undefined) return count;
	const rate = p.rate >= 10 ? Math.round(p.rate) : p.rate;
	return `${count} · ${formatNumber(rate)}${unit}/s`;
}

/** How far the whole job is, from 0 to 1: the steps done, and the part of the current one. */
export const overall = (p: JobProgress) =>
	(p.step - 1 + (p.total ? (p.done ?? 0) / p.total : 0)) / p.steps;
