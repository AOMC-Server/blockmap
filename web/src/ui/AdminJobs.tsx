import { formatRelative, formatTime } from "@aomc-server/block-ui/format";
import {
	type AdminJob,
	fetchAdminJobs,
	JOB_LABELS,
	jobSubject,
	useJobList,
	useJobProgress,
} from "../jobs";

const STATUS_NAMES: Record<AdminJob["status"], string> = {
	pending: "Queued",
	processing: "Running",
	done: "Done",
	failed: "Failed",
};

function When(props: { at: number | null }) {
	if (props.at === null) return <span class="muted">–</span>;
	return <span title={formatTime(props.at)}>{formatRelative(props.at)}</span>;
}

function Progress(props: { job: AdminJob }) {
	const progress = useJobProgress(props.job.revisionId);
	return <span class="muted">{progress ?? "Running…"}</span>;
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
				<span class={`job-status ${job.status}`}>
					{STATUS_NAMES[job.status]}
				</span>
				{job.status === "processing" && (
					<div>
						<Progress job={job} />
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
			<h2>Queue</h2>
			<p class="muted">
				Background jobs run one at a time in the order listed below. Updates
				automatically.
			</p>
			{data.open.length === 0 ? (
				<p class="muted">Queue is empty.</p>
			) : (
				<JobTable jobs={data.open} open />
			)}
			<h2>Recently finished</h2>
			{data.recent.length === 0 ? (
				<p class="muted">No recent jobs.</p>
			) : (
				<JobTable jobs={data.recent} open={false} />
			)}
		</>
	);
}
