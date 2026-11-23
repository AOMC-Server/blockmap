import { Badge, type BadgeKind, Count } from "@aomc-server/block-ui";
import { formatRelative, formatTime } from "@aomc-server/block-ui/format";
import {
	type AdminJob,
	fetchAdminJobs,
	JOB_LABELS,
	jobSubject,
	useJobList,
	useQueueState,
} from "../jobs";
import { JobProgress } from "./JobProgress";

const STATUS_NAMES: Record<AdminJob["status"], string> = {
	pending: "Queued",
	processing: "Running",
	done: "Done",
	failed: "Failed",
};

const STATUS_KINDS: Record<AdminJob["status"], BadgeKind | undefined> = {
	pending: undefined,
	processing: "running",
	done: "ok",
	failed: "error",
};

function When(props: { at: number | null }) {
	if (props.at === null) return <span class="muted">–</span>;
	return <span title={formatTime(props.at)}>{formatRelative(props.at)}</span>;
}

/** What the running job is doing, from the queue topic (only one job runs at a time). */
function Running() {
	const progress = useQueueState()?.running?.progress;
	return progress ? (
		<JobProgress progress={progress} />
	) : (
		<span class="muted">Running…</span>
	);
}

function JobRow(props: { job: AdminJob; open: boolean }) {
	const { job } = props;
	const subject = jobSubject(job);
	const error = job.errorDetail ?? job.error;
	return (
		<tr class={`job-row ${job.status}`}>
			<td class="num muted">{job.id}</td>
			<td>
				<b>{JOB_LABELS[job.type]}</b>
				{subject && <div class="muted">{subject}</div>}
			</td>
			<td>
				<Badge kind={STATUS_KINDS[job.status]}>
					{STATUS_NAMES[job.status]}
				</Badge>
				{job.status === "processing" && (
					<div class="job-running">
						<Running />
					</div>
				)}
				{job.status === "failed" && error && (
					<div class="error-text job-error">{error}</div>
				)}
			</td>
			<td class="num">{job.attempts}</td>
			<td>
				<When at={job.createdAt} />
			</td>
			{!props.open && (
				<td>
					<When at={job.completedAt} />
				</td>
			)}
		</tr>
	);
}

function JobTable(props: { jobs: AdminJob[]; open: boolean }) {
	return (
		<div class="table-wrap flush">
			<table class="table plain compact">
				<thead>
					<tr>
						<th class="num">#</th>
						<th>Job</th>
						<th>Status</th>
						<th class="num" title="Number of attempts">
							Tries
						</th>
						<th>Queued</th>
						{!props.open && <th>Finished</th>}
					</tr>
				</thead>
				<tbody>
					{props.jobs.map((job) => (
						<JobRow key={job.id} job={job} open={props.open} />
					))}
				</tbody>
			</table>
		</div>
	);
}

/** The manage page's Jobs tab: the queue as it is now, and the jobs that ran last. */
export function AdminJobs() {
	const { data, failed } = useJobList(fetchAdminJobs);
	if (!data)
		return <p class="muted">{failed ? "Failed to load jobs." : "Loading…"}</p>;
	return (
		<>
			<section class="admin-section">
				<div class="admin-toolbar">
					<h2>Queue</h2>
					{data.open.length > 0 && <Count>{data.open.length}</Count>}
				</div>
				<p class="muted admin-note">
					Background jobs run one at a time in the order listed below. This
					queue updates automatically.
				</p>
				{data.open.length === 0 ? (
					<div class="admin-empty">
						<b>All caught up</b>
						<p class="muted">
							Nothing is waiting or running. Uploads, deletions and cleanups
							show up here while they run.
						</p>
					</div>
				) : (
					<JobTable jobs={data.open} open />
				)}
			</section>
			<section class="admin-section">
				<div class="admin-toolbar">
					<h2>Recently finished</h2>
				</div>
				{data.recent.length === 0 ? (
					<p class="admin-empty muted">No recent jobs.</p>
				) : (
					<JobTable jobs={data.recent} open={false} />
				)}
			</section>
		</>
	);
}
