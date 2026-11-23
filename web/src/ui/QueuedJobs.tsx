import { Modal } from "@aomc-server/block-ui";
import { formatRelative } from "@aomc-server/block-ui/format";
import { signal } from "@preact/signals";
import {
	fetchQueue,
	JOB_LABELS,
	jobSubject,
	type QueuedJob,
	useJobList,
	useJobProgress,
	useQueueState,
} from "../jobs";
import { isModerator } from "../state";

export const queueOpen = signal(false);

function JobItem(props: { job: QueuedJob; position: number }) {
	const { job } = props;
	const running = job.status === "processing";
	const progress = useJobProgress(running ? job.revisionId : null);
	const subject = jobSubject(job);
	return (
		<li class={`queue-job ${running ? "running" : ""}`}>
			<div class="queue-job-title">
				<b>{JOB_LABELS[job.type]}</b>
				{subject && <span class="muted"> · {subject}</span>}
			</div>
			<div class="muted queue-job-meta">
				{running
					? (progress ?? "Running…")
					: `#${props.position} in queue · added ${formatRelative(job.createdAt)}`}
			</div>
		</li>
	);
}

/** The jobs the server is working through, in the order it runs them. */
export function QueueDialog() {
	const { data, failed } = useJobList(fetchQueue);
	const close = () => {
		queueOpen.value = false;
	};
	return (
		<Modal title="Queued jobs" onClose={close}>
			<p class="muted hint">
				Background jobs run one at a time in the order listed below.
			</p>
			{data === null ? (
				<p class="muted">{failed ? "Failed to load job queue." : "Loading…"}</p>
			) : data.length === 0 ? (
				<p class="muted">Queue is empty.</p>
			) : (
				<ol class="queue-jobs">
					{data.map((job, i) => (
						<JobItem
							key={job.id}
							job={job}
							position={i + (data[0]?.status === "processing" ? 0 : 1)}
						/>
					))}
				</ol>
			)}
			{isModerator.value && (
				<p class="hint">
					<a href="/manage?tab=jobs">View full job history</a>
				</p>
			)}
		</Modal>
	);
}

/** In the top bar while the server has jobs to do: how many, and a way to see them. */
export function QueueButton() {
	const state = useQueueState();
	const count = state ? state.pending + (state.running ? 1 : 0) : 0;
	if (count === 0) return null;
	return (
		<div class="dock queue-dock">
			<button
				type="button"
				class={`btn queue-button ${queueOpen.value ? "active" : ""}`}
				title="Background job queue"
				onClick={() => {
					queueOpen.value = true;
				}}
			>
				<span class="queue-spinner" aria-hidden="true" />
				{count} job{count === 1 ? "" : "s"}
			</button>
		</div>
	);
}
