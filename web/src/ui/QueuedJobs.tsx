import { Modal } from "@aomc-server/block-ui";
import { formatRelative } from "@aomc-server/block-ui/format";
import { signal } from "@preact/signals";
import {
	describeStep,
	fetchQueue,
	type JobProgress as Info,
	JOB_LABELS,
	jobSubject,
	overall,
	type QueuedJob,
	useJobList,
	useQueueState,
} from "../jobs";
import { isModerator } from "../state";
import { JobProgress } from "./JobProgress";

export const queueOpen = signal(false);

function JobItem(props: {
	job: QueuedJob;
	position: number;
	progress: Info | null;
}) {
	const { job, progress } = props;
	const running = job.status === "processing";
	const subject = jobSubject(job);
	return (
		<li class={`queue-job ${running ? "running" : ""}`}>
			<div class="queue-job-title">
				<b>{JOB_LABELS[job.type]}</b>
				{subject && <span class="muted"> · {subject}</span>}
			</div>
			{running && progress ? (
				<JobProgress progress={progress} />
			) : (
				<div class="muted queue-job-meta">
					{running
						? "Running…"
						: `#${props.position} in queue · added ${formatRelative(job.createdAt)}`}
				</div>
			)}
		</li>
	);
}

/** The jobs the server is working through, in the order it runs them. */
export function QueueDialog() {
	const { data, failed } = useJobList(fetchQueue);
	const progress = useQueueState()?.running?.progress ?? null;
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
							progress={job.status === "processing" ? progress : null}
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
	const running = state?.running;
	const progress = running?.progress;
	return (
		<div class="dock queue-dock">
			<button
				type="button"
				class={`btn queue-button ${queueOpen.value ? "active" : ""}`}
				title={
					running && progress
						? `${JOB_LABELS[running.type]}: ${describeStep(progress)}`
						: "Background job queue"
				}
				onClick={() => {
					queueOpen.value = true;
				}}
			>
				<span class="queue-spinner" aria-hidden="true" />
				{count} job{count === 1 ? "" : "s"}
				{progress && (
					<span class="queue-button-bar" aria-hidden="true">
						<span
							class="queue-button-fill"
							style={{ width: `${Math.round(overall(progress) * 100)}%` }}
						/>
					</span>
				)}
			</button>
		</div>
	);
}
