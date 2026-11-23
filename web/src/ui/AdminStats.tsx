import {
	Chart,
	type ChartSeries,
	Segmented,
	SortTh,
	TileGrid,
} from "@aomc-server/block-ui";
import {
	formatBytes,
	formatDay,
	formatDuration,
	formatNumber,
	formatTime,
} from "@aomc-server/block-ui/format";
import { ADMIN_STATS_RANGES, type AdminStatsRange } from "@blockmap/shared";
import { DAY, HOUR } from "@blockmap/shared/time";
import type { InferResponseType } from "hono/client";
import { useEffect, useRef, useState } from "preact/hooks";
import { api, attempt, showNotice } from "../api";
import { subscribe } from "../events";
import { useStats } from "./useStats";

type Body = InferResponseType<typeof api.api.admin.stats.$get, 200>;
type Category = keyof Body["traffic"]["range"]["byCategory"];
type Domain = Body["traffic"]["domains"][number];

const RANGE_NAMES: Record<AdminStatsRange, string> = {
	"1h": "Last hour",
	"6h": "Last 6 hours",
	"24h": "24 hours",
	"7d": "7 days",
	"30d": "30 days",
	"90d": "90 days",
	all: "All time",
};

const CATEGORIES: { key: Category; label: string; color: string }[] = [
	{ key: "tiles", label: "Tile lookups", color: "var(--chart-1)" },
	{ key: "blobs", label: "Tile images", color: "var(--chart-2)" },
	{ key: "preview", label: "Link previews", color: "var(--chart-3)" },
	{ key: "api", label: "API", color: "var(--chart-4)" },
	{ key: "static", label: "Web app", color: "var(--chart-5)" },
	{ key: "auth", label: "Login", color: "var(--chart-6)" },
	{ key: "files", label: "File downloads", color: "var(--chart-7)" },
];

const STORAGE_NOTES: Record<string, string> = {
	upload: "After upload",
	erase: "After upload deletion",
	gc: "After image cleanup",
	rebuild: "After history rebuild",
	boot: "Server started",
};

const formatTimeOfDay = (t: number) =>
	new Date(t).toLocaleTimeString(undefined, {
		hour: "numeric",
		minute: "2-digit",
	});
const formatDayTime = (t: number) =>
	new Date(t).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
/** Queues the image cleanup and follows it on the queue topic; `onDone` runs when it has finished. */
function CleanupButton(props: { onDone: () => void }) {
	const [queued, setQueued] = useState(false);
	const [running, setRunning] = useState(false);
	const waiting = useRef(false);
	waiting.current = queued;
	useEffect(
		() =>
			subscribe("queue", {
				onEvent: (q) => {
					setRunning(q.running?.type === "gc_blobs");
					// Nothing left in the queue: what was queued has run.
					if (waiting.current && q.running === null && q.pending === 0) {
						setQueued(false);
						props.onDone();
					}
				},
			}),
		[props.onDone],
	);
	const start = async () => {
		if (!confirm("Delete unused tile images? This cannot be undone.")) return;
		setQueued(true);
		const res = await attempt(() => api.api.admin.storage.cleanup.$post());
		if (!res.ok) {
			setQueued(false);
			showNotice(res.error, "error");
		}
	};
	return (
		<button
			type="button"
			class="btn"
			disabled={queued || running}
			onClick={start}
		>
			{queued || running ? "Cleaning up…" : "Clean up now"}
		</button>
	);
}

function Storage(props: { data: Body; onCleaned: () => void }) {
	const { storage, now, since, overview } = props.data;
	const cur = storage.current;
	const reclaimable = cur.blobBytes - cur.referencedBytes;

	const history = storage.history;
	const readings = [...history, cur];
	const xs = [...history.map((h) => Math.max(h.at, since ?? 0)), now];
	const series: ChartSeries[] = [
		{
			key: "all",
			label: "Tile images",
			color: "var(--chart-1)",
			values: readings.map((r) => r.blobBytes),
		},
		{
			key: "used",
			label: "In use",
			color: "var(--chart-2)",
			values: readings.map((r) => r.referencedBytes),
		},
		{
			key: "db",
			label: "Database",
			color: "var(--chart-3)",
			values: readings.map((r) => r.dbBytes),
		},
	];
	const spanMs = (xs[xs.length - 1] ?? 0) - (xs[0] ?? 0);
	const formatX =
		spanMs > 3 * DAY
			? formatDay
			: spanMs <= 6 * HOUR
				? formatTimeOfDay
				: formatDayTime;

	return (
		<>
			<h2>Storage</h2>
			<p class="muted">
				Calculated from recorded image sizes rather than actual disk usage.
				Updated after each upload, deletion, and cleanup.
			</p>
			<TileGrid
				plain
				tiles={[
					{
						label: "Tile images",
						value: formatBytes(cur.blobBytes),
						hint: `${formatNumber(cur.blobCount)} images, avg ${formatBytes(overview.tiles.averageImageBytes)}`,
					},
					{
						label: "In use",
						value: formatBytes(cur.referencedBytes),
						hint: `${formatNumber(cur.referencedBlobs)} images, avg ${overview.tiles.reuse}× reuse`,
					},
					{
						label: "Unused images",
						value: formatBytes(reclaimable),
						hint: "Can be freed by running cleanup",
					},
					{ label: "Database", value: formatBytes(cur.dbBytes) },
				]}
			/>
			<div class="admin-block">
				<CleanupButton onDone={props.onCleaned} />
			</div>
			<div class="admin-block">
				<Chart
					kind="steps"
					xs={xs}
					series={series}
					formatY={formatBytes}
					formatX={formatX}
					formatTip={formatTime}
					note={(i) =>
						i === xs.length - 1
							? "Now"
							: (STORAGE_NOTES[history[i]?.reason ?? ""] ?? null)
					}
				/>
			</div>
		</>
	);
}

function Traffic(props: { data: Body }) {
	const { traffic } = props.data;
	const [metric, setMetric] = useState<"bytes" | "requests">("bytes");

	const [hidden, setHidden] = useState<ReadonlySet<Category>>(new Set());
	const toggle = (key: Category) =>
		setHidden((prev) => {
			const next = new Set(prev);
			if (!next.delete(key)) next.add(key);
			return next;
		});

	const series: ChartSeries[] = CATEGORIES.filter((c) => !hidden.has(c.key))
		.map((c) => ({
			key: c.key,
			label: c.label,
			color: c.color,
			values: traffic.points.map((p) => p[metric][c.key]),
		}))
		.filter((s) => s.values.some((v) => v > 0));

	const range = traffic.range;
	const shown = CATEGORIES.filter((c) => !hidden.has(c.key));
	const sum = (
		src: Body["traffic"]["range"]["byCategory"],
		f: (r: Body["traffic"]["range"]["byCategory"][Category]) => number,
	) => shown.reduce((n, c) => n + f(src[c.key]), 0);
	const periodBytes = sum(range.byCategory, (r) => r.bytes);
	const periodRequests = sum(range.byCategory, (r) => r.requests);
	const totalBytes = sum(traffic.allTime.byCategory, (r) => r.bytes);
	const totalRequests = sum(traffic.allTime.byCategory, (r) => r.requests);
	const errors = sum(range.byCategory, (r) => r.s4xx + r.s5xx);
	return (
		<>
			<div class="admin-toolbar">
				<h2>Network traffic</h2>
				<Segmented
					small
					label="Metric"
					value={metric}
					options={["bytes", "requests"] as const}
					names={{ bytes: "Data sent", requests: "Requests" }}
					onChange={setMetric}
				/>
			</div>
			<p class="muted">
				Outgoing traffic from this server. Redirects and error responses
				transfer minimal data.
			</p>
			<TileGrid
				plain
				tiles={[
					{
						label: "Data sent",
						value: formatBytes(periodBytes),
						hint: `${formatBytes(totalBytes)} all time`,
					},
					{
						label: "Requests",
						value: formatNumber(periodRequests),
						hint: `${formatNumber(totalRequests)} all time`,
					},
					{
						label: "Failed requests",
						value: formatNumber(errors),
						hint:
							periodRequests > 0
								? `${((errors / periodRequests) * 100).toFixed(1)}% of requests`
								: undefined,
					},
				]}
			/>
			<div class="admin-block">
				<Chart
					kind="bars"
					xs={traffic.points.map((p) => p.t)}
					series={series}
					formatY={metric === "bytes" ? formatBytes : formatNumber}
					formatTip={traffic.bucketMs < DAY ? formatTime : formatDay}
					formatX={
						traffic.bucketMs < HOUR
							? formatTimeOfDay
							: traffic.bucketMs < DAY
								? formatDayTime
								: formatDay
					}
				/>
			</div>
			<div class="table-wrap flush">
				<table class="table plain compact nowrap">
					<thead>
						<tr>
							<th>Category</th>
							<th class="num">Requests</th>
							<th class="num">Sent</th>
							<th class="num">Redirects</th>
							<th class="num">Errors</th>
							<th class="num">All-time sent</th>
							<th class="num">Chart</th>
						</tr>
					</thead>
					<tbody>
						{CATEGORIES.map((c) => {
							const r = range.byCategory[c.key];
							const on = !hidden.has(c.key);
							return (
								<tr key={c.key} style={{ opacity: on ? 1 : 0.5 }}>
									<td>
										<span
											class="chart-swatch"
											style={{ background: c.color }}
										/>
										{c.label}
									</td>
									<td class="num">{formatNumber(r.requests)}</td>
									<td class="num">{formatBytes(r.bytes)}</td>
									<td class="num">{formatNumber(r.s3xx)}</td>
									<td class="num">{formatNumber(r.s4xx + r.s5xx)}</td>
									<td class="num">
										{formatBytes(traffic.allTime.byCategory[c.key].bytes)}
									</td>
									<td
										class="num"
										style={{ textAlign: "right", verticalAlign: "middle" }}
									>
										<input
											type="checkbox"
											class="switch"
											style={{ margin: 0, verticalAlign: "middle" }}
											checked={on}
											aria-label={`Show ${c.label} in chart`}
											onChange={() => toggle(c.key)}
										/>
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
		</>
	);
}

type DomainSort = "bytes" | "tileRequests" | "blobRequests" | "lastSeen";

const DOMAIN_COLUMNS: { key: DomainSort; label: string; hint: string }[] = [
	{ key: "tileRequests", label: "Tile lookups", hint: "Requests for a tile" },
	{ key: "blobRequests", label: "Images", hint: "Tile images downloaded" },
	{ key: "bytes", label: "Sent", hint: "Data sent for tiles and images" },
	{ key: "lastSeen", label: "Last seen", hint: "Most recent request" },
];

const PSEUDO_DOMAINS = new Set(["This site", "No referrer", "Other"]);

function Domains(props: { data: Body }) {
	const [sort, setSort] = useState<DomainSort>("bytes");
	const rows: Domain[] = [...props.data.traffic.domains].sort(
		(a, b) => b[sort] - a[sort] || a.domain.localeCompare(b.domain),
	);
	const total = rows.reduce((n, d) => n + d.bytes, 0);
	return (
		<>
			<h2>Tile traffic by domain</h2>
			<p class="muted">
				Grouped by the request's Origin or Referer header. “No referrer”
				includes scripts and direct downloads.
			</p>
			{rows.length === 0 ? (
				<p class="muted">No tile requests in this period.</p>
			) : (
				<div class="table-wrap flush">
					<table class="table plain compact nowrap">
						<thead>
							<tr>
								<th>Domain</th>
								{DOMAIN_COLUMNS.map((c) => (
									<SortTh
										key={c.key}
										label={c.label}
										col={c.key}
										sort={sort}
										dir="desc"
										onSort={(col) => setSort(col as DomainSort)}
										num
										hint={c.hint}
									/>
								))}
								<th>Share</th>
							</tr>
						</thead>
						<tbody>
							{rows.map((d) => {
								const share = total > 0 ? d.bytes / total : 0;
								return (
									<tr key={d.domain}>
										<td
											class={PSEUDO_DOMAINS.has(d.domain) ? "muted-cell" : ""}
										>
											{d.domain}
										</td>
										<td class="num">{formatNumber(d.tileRequests)}</td>
										<td class="num">{formatNumber(d.blobRequests)}</td>
										<td class="num">{formatBytes(d.bytes)}</td>
										<td class="num">{formatTime(d.lastSeen)}</td>
										<td>
											<span class="share-bar" aria-hidden="true">
												<span
													class="share-fill"
													style={{ width: `${share * 100}%` }}
												/>
											</span>{" "}
											{(share * 100).toFixed(1)}%
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}
		</>
	);
}

function Overview(props: { data: Body }) {
	const o = props.data.overview;
	return (
		<>
			<h2>Server</h2>
			<TileGrid
				plain
				tiles={[
					{
						label: "Users",
						value: formatNumber(o.users.total),
						hint: `${formatNumber(o.users.active7d)} active (7d), ${formatNumber(o.users.active30d)} (30d)`,
					},
					{
						label: "Sessions / API tokens",
						value: `${formatNumber(o.users.sessions)} / ${formatNumber(o.users.tokens)}`,
						hint: `${formatNumber(o.users.tokensUsed30d)} tokens used in the last 30 days`,
					},
					{
						label: "Uploads",
						value: formatNumber(o.map.uploadsDone),
						hint: `${formatNumber(o.map.uploadsViaMod)} via mod, ${formatNumber(o.map.uploadsFailed)} failed`,
					},
					{
						label: "Layers",
						value: formatNumber(o.map.publicLayers + o.map.privateLayers),
						hint: `${formatNumber(o.map.privateLayers)} private across ${formatNumber(o.map.dimensions)} dimensions`,
					},
					{
						label: "Features",
						value: formatNumber(o.map.features),
						hint: `${formatNumber(o.map.featureRevisions)} revisions`,
					},
					{
						label: "Tile versions",
						value: formatNumber(o.tiles.tileVersions),
						hint: `${formatNumber(o.tiles.references)} image references`,
					},
					{
						label: "Job queue",
						value: `${formatNumber(o.jobs.pending + o.jobs.processing)} active`,
						hint: `${formatNumber(o.jobs.failed)} failed`,
					},
					{
						label: "Uptime",
						value: formatDuration(o.process.uptimeSeconds),
						hint: `${formatBytes(o.process.rssBytes)} memory, Bun ${o.process.bun}`,
					},
				]}
			/>
		</>
	);
}

/** The owners' view of storage, network traffic and the server. */
export function AdminStats() {
	const [range, setRange] = useState<AdminStatsRange>("7d");
	const { data, error, reload } = useStats(
		() => api.api.admin.stats.$get({ query: { range } }),
		[range],
	);

	return (
		<div class="admin-stats">
			<Segmented
				label="Time range"
				value={range}
				options={ADMIN_STATS_RANGES}
				names={RANGE_NAMES}
				onChange={setRange}
			/>
			{error && <p class="error-text">Failed to load statistics: {error}</p>}
			{!data ? (
				!error && <p class="muted">Loading…</p>
			) : (
				<>
					<Storage data={data} onCleaned={reload} />
					<Traffic data={data} />
					<Domains data={data} />
					<Overview data={data} />
				</>
			)}
		</div>
	);
}
