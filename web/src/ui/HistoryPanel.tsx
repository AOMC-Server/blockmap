import { Panel } from "@aomc-server/block-ui";
import { formatDuration, formatTime } from "@aomc-server/block-ui/format";
import { effect } from "@preact/signals";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { isolateUpload, mapView, setRev } from "../controller";
import { subscribe } from "../events";
import {
	describeCount,
	describeStep,
	type JobProgress,
	overall,
	useQueueState,
} from "../jobs";
import type { Bounds } from "../map/geometry";
import { inFlight } from "../revisionLog";
import { deleting, loadRevisions } from "../revisions";
import { panelResize, settings, updateSettings } from "../settings";
import {
	currentMap,
	dimSlug,
	effectiveRev,
	highlightedUpload,
	hoveredRevision,
	isolatedUpload,
	type RevisionInfo,
	readOnly,
	rev,
	revisionsData,
	sidePanel,
	user,
	view,
} from "../state";
import {
	eventForRev,
	filterRevisions,
	groupByDay,
	timelineEvents,
	viewBounds,
} from "../timeline";
import { deleteUploadFor } from "./DeleteUploadDialog";
import { formatEventDay, formatEventTime } from "./format";
import { pointAt, Timeline } from "./Timeline";

/**
 * Looks at the map as of the upload, and at where it was made. With "In view" the camera stays
 * where it is, since moving it would change which uploads are listed.
 */
function showRevision(r: RevisionInfo) {
	if (r.rev === null) return;
	setRev(r.rev);
	highlightedUpload.value = r;
	if (r.bbox && !settings.value.historyInView)
		mapView.value?.fitBounds(r.bbox, { padding: 120, closestZoom: 0 });
}

/** The reason for a failure, with the technical error under it for moderators (the server sends it to them only). */
const errorTitle = (r: RevisionInfo) =>
	[r.error, r.errorDetail && `Technical: ${r.errorDetail}`]
		.filter(Boolean)
		.join("\n\n");

function describe(r: RevisionInfo): string {
	const files = `${r.fileCount} file${r.fileCount === 1 ? "" : "s"}`;
	return r.viaMod ? `${files} via mod` : files;
}

/** Whether you may delete the upload now; the server decides, this only hides the button. */
function deletable(r: RevisionInfo, now: number) {
	return (
		!readOnly.value &&
		r.kind === "upload" &&
		(r.status === "done" || r.status === "failed") &&
		r.canDelete &&
		!r.deleting &&
		(r.deletableUntil === null || now < r.deletableUntil)
	);
}

/** A badge for a running job: how far it is in all, and its step in the tooltip. */
function running(verb: string, p: JobProgress) {
	const count = describeCount(p);
	return {
		label: `${verb} ${Math.round(overall(p) * 100)}%`,
		detail: count ? `${describeStep(p)} (${count})` : describeStep(p),
	};
}

function RevisionRow(props: {
	r: RevisionInfo;
	now: number;
	/** What the server is doing with it, while its job runs. */
	progress: JobProgress | null;
}) {
	const { r, progress } = props;
	const row = useRef<HTMLLIElement>(null);
	const active =
		r.rev !== null && rev.value !== null && effectiveRev.value === r.rev;
	// Started in this browser (with progress), or queued by someone else.
	const removing =
		deleting.value.get(r.id) ??
		(r.deleting
			? progress
				? running("deleting", progress)
				: {
						label: "deleting…",
						detail: "Queued for deletion",
					}
			: undefined);
	const processing =
		progress && r.status === "processing"
			? running("processing", progress)
			: undefined;
	const busy = inFlight(r) || removing !== undefined;
	const canView = r.rev !== null && r.status === "done" && !removing;
	const canDelete = deletable(r, props.now) && !busy;
	const canIsolate = r.kind === "upload" && r.status === "done" && !removing;
	const isolated = isolatedUpload.value?.id === r.id;
	const hover = hoveredRevision.value;
	const hovered = hover?.id === r.id;
	const pointedFromTimeline = hovered && hover?.from === "timeline";

	// Keep the row being looked at, or pointed at on the time line, in sight.
	useEffect(() => {
		if (active || pointedFromTimeline)
			row.current?.scrollIntoView({ block: "nearest" });
	}, [active, pointedFromTimeline]);

	return (
		<li
			ref={row}
			class={`revision ${active || isolated ? "active" : ""} ${hovered ? "hovered" : ""} ${r.status}`}
			onMouseEnter={() => pointAt(r, "log")}
			onMouseLeave={() => pointAt(null, "log")}
		>
			<button
				type="button"
				class="plain revision-main"
				disabled={!canView}
				onClick={() => showRevision(r)}
				title={canView ? "View map at this revision" : undefined}
			>
				<span class="rev-no">{r.rev !== null ? `#${r.rev}` : "…"}</span>
				<span class="rev-what">
					{r.authorName}
					<span class="rev-files"> · {describe(r)}</span>
				</span>
				<span class="rev-meta">
					{r.exportedAt !== null
						? `Exported ${formatTime(r.exportedAt)} · uploaded ${formatTime(r.createdAt)}`
						: `Uploaded ${formatTime(r.createdAt)}`}
				</span>
			</button>
			<div class="rev-badges">
				{busy && (
					<span
						class="badge"
						title={
							removing?.detail ??
							processing?.detail ??
							(r.status === "pending"
								? "Waiting in the background job queue"
								: "Processing upload…")
						}
					>
						{removing?.label ??
							processing?.label ??
							(r.status === "pending" ? "queued" : "processing…")}
					</span>
				)}
				{r.status === "done" && r.error && (
					<span class="badge error" title={errorTitle(r)}>
						{r.error}
					</span>
				)}
				{r.status === "failed" && (
					<span class="badge error" title={errorTitle(r)}>
						failed{r.error ? `: ${r.error}` : ""}
					</span>
				)}
			</div>
			{canIsolate && (
				<button
					type="button"
					class={`btn small ${isolated ? "active" : ""}`}
					aria-pressed={isolated}
					title="Show only tiles from this upload"
					onClick={() => {
						if (isolated) isolatedUpload.value = null;
						else isolateUpload(r, !settings.value.historyInView);
					}}
				>
					{isolated ? "Show all" : "Isolate"}
				</button>
			)}
			{canDelete && (
				<button
					type="button"
					class="btn small danger"
					title={
						r.deletableUntil !== null
							? `You can delete your own upload for another ${formatDuration(Math.ceil((r.deletableUntil - props.now) / 60_000) * 60)}`
							: "Permanently delete this upload from the map and history"
					}
					onClick={() => {
						deleteUploadFor.value = r;
					}}
				>
					Delete
				</button>
			)}
		</li>
	);
}

/** The blocks in view, following the camera with a short delay. */
function useViewBounds(enabled: boolean): Bounds | null {
	const [bounds, setBounds] = useState<Bounds | null>(null);
	useEffect(() => {
		if (!enabled) {
			setBounds(null);
			return;
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		let first = true;
		const stop = effect(() => {
			const v = view.value;
			const mv = mapView.value;
			if (!mv) return;
			const update = () => setBounds(viewBounds(v, mv.getSize()));
			clearTimeout(timer);
			if (first) update();
			else timer = setTimeout(update, 150);
			first = false;
		});
		return () => {
			stop();
			clearTimeout(timer);
		};
	}, [enabled]);
	if (!enabled) return null;
	const mv = mapView.peek();
	return bounds ?? (mv ? viewBounds(view.peek(), mv.getSize()) : null);
}

/** A time line over the dimension's uploads and the upload log; uploads can be deleted here. */
export function HistoryPanel() {
	const head = currentMap.value?.map.headRev ?? 0;
	const epoch = currentMap.value?.map.epoch ?? 0;
	const dim = dimSlug.value;
	const me = user.value;
	const { historyInView: inView, historyMineOnly } = settings.value;
	const mine = historyMineOnly && me !== null;
	const bounds = useViewBounds(inView);
	const [now, setNow] = useState(Date.now());
	const runningJob = useQueueState()?.running;

	// Reload when a new head, rewritten history or another dimension appears.
	useEffect(() => {
		void loadRevisions();
	}, [head, epoch, dim]);

	// The server says when the log changes (an upload added, started, finished or deleted);
	// polling is only the fallback while its stream is down.
	const dimensionId = currentMap.value?.dimensions.find(
		(d) => d.slug === dim,
	)?.id;
	useEffect(() => {
		if (dimensionId === undefined) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const unsubscribe = subscribe(`revisions:${dimensionId}`, {
			onEvent: () => {
				clearTimeout(timer);
				timer = setTimeout(() => void loadRevisions(), 200);
			},
			poll: () => void loadRevisions(),
			pollMs: 10_000,
		});
		return () => {
			unsubscribe();
			clearTimeout(timer);
		};
	}, [dimensionId]);

	// Times shown relative to now (how long an upload can still be deleted) move on.
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 30_000);
		return () => clearInterval(timer);
	}, []);

	useEffect(
		() => () => {
			highlightedUpload.value = null;
			hoveredRevision.value = null;
		},
		[],
	);

	const all = revisionsData.value;
	const shown = useMemo(
		() =>
			filterRevisions(all, {
				inView: inView ? (bounds ?? null) : null,
				authorId: mine ? (me?.id ?? null) : null,
			}),
		[all, inView, bounds, mine, me?.id],
	);
	const events = useMemo(() => timelineEvents(shown), [shown]);
	const pending = useMemo(
		() => shown.filter((r) => r.kind === "upload" && inFlight(r)),
		[shown],
	);
	const days = useMemo(() => groupByDay(shown, formatEventDay), [shown]);

	const current =
		rev.value === null ? null : eventForRev(timelineEvents(all), rev.value);
	const uploads = all.filter((r) => r.kind === "upload").length;
	const filtered = shown.length !== all.length;

	return (
		<Panel
			resize={panelResize}
			title="History"
			class="history-panel"
			onClose={() => (sidePanel.value = null)}
			tabs={
				<div class="history-head">
					<div class="history-filters">
						<fieldset class="history-scope">
							<legend class="visually-hidden">Upload filter</legend>
							<div class="segmented">
								<button
									type="button"
									class={`btn small ${inView ? "" : "active"}`}
									aria-pressed={!inView}
									title="Show all uploads in this dimension"
									onClick={() => updateSettings({ historyInView: false })}
								>
									All
								</button>
								<button
									type="button"
									class={`btn small ${inView ? "active" : ""}`}
									aria-pressed={inView}
									title="Only uploads within the current map view"
									onClick={() => updateSettings({ historyInView: true })}
								>
									In view
								</button>
							</div>
						</fieldset>
						{me && (
							<button
								type="button"
								class={`btn small ${mine ? "active" : ""}`}
								aria-pressed={mine}
								title="Only your own uploads"
								onClick={() => updateSettings({ historyMineOnly: !mine })}
							>
								Mine
							</button>
						)}
					</div>

					<div class="muted slider-info" aria-live="polite">
						{head === 0 ? (
							"No uploads yet."
						) : rev.value === null ? (
							<>
								Viewing <b>latest</b> map
								{filtered
									? ` · ${shown.length} of ${all.length} uploads listed`
									: ` · ${uploads} upload${uploads === 1 ? "" : "s"}`}
							</>
						) : current ? (
							<>
								Viewing <b>{formatEventTime(current)}</b> · #{current.rev} by{" "}
								{current.authorName}
							</>
						) : (
							"Before the first upload"
						)}
					</div>

					<Timeline events={events} pending={pending} describe={describe} />
				</div>
			}
		>
			<h3 class="section-title">Upload log</h3>
			{days.map((g) => (
				<section key={g.day} class="rev-day">
					<h4 class="rev-day-title">
						{g.day}
						<span class="muted">
							{" "}
							· {g.items.length} upload{g.items.length === 1 ? "" : "s"}
						</span>
					</h4>
					<ul class="revisions">
						{g.items.map((r) => (
							<RevisionRow
								key={r.id}
								r={r}
								now={now}
								progress={
									runningJob?.revisionId === r.id ? runningJob.progress : null
								}
							/>
						))}
					</ul>
				</section>
			))}
			{shown.length === 0 && (
				<p class="muted">
					{all.length === 0
						? "No uploads in this dimension yet."
						: inView && mine
							? "None of your uploads are in the current view. Zoom out or switch to All."
							: inView
								? "No uploads in the current view. Zoom out or switch to All."
								: "You haven't uploaded anything to this dimension yet."}
				</p>
			)}
		</Panel>
	);
}
