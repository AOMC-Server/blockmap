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
	formatRelative,
	formatTime,
} from "@aomc-server/block-ui/format";
import { ADMIN_STATS_RANGES, type AdminStatsRange } from "@blockmap/shared";
import { DAY, HOUR } from "@blockmap/shared/time";
import type { InferResponseType } from "hono/client";
import { type ComponentChildren, Fragment, type JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { api, attempt, showNotice } from "../api";
import { subscribe } from "../events";
import {
	type DomainNode,
	type DomainRow,
	type DomainSort,
	groupDomains,
} from "../trafficDomains";
import { useStats } from "./useStats";

type Body = InferResponseType<typeof api.api.admin.stats.$get, 200>;
type Category = keyof Body["traffic"]["range"]["byCategory"];

const RANGE_NAMES: Record<AdminStatsRange, string> = {
	"1h": "1 hour",
	"6h": "6 hours",
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

/** A titled block of the statistics page, with room in its header for controls. */
function Section(props: {
	title: string;
	actions?: ComponentChildren;
	note?: ComponentChildren;
	children: ComponentChildren;
}) {
	return (
		<section class="admin-section">
			<div class="admin-toolbar">
				<h2>{props.title}</h2>
				{props.actions}
			</div>
			{props.note && <p class="muted admin-note">{props.note}</p>}
			{props.children}
		</section>
	);
}

/** Queues the image cleanup and follows it on the queue topic; `onDone` runs when it has finished. */
function CleanupButton(props: { reclaimable: number; onDone: () => void }) {
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
			class="btn small"
			disabled={queued || running || props.reclaimable <= 0}
			title={props.reclaimable <= 0 ? "No unused images to delete" : undefined}
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
		<Section
			title="Storage"
			note="Calculated from recorded image sizes rather than actual disk usage. Updated after each upload, deletion, and cleanup."
		>
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
						value: (
							<span class="tile-action">
								{formatBytes(reclaimable)}
								<CleanupButton
									reclaimable={reclaimable}
									onDone={props.onCleaned}
								/>
							</span>
						),
						hint: "Can be freed by running cleanup",
					},
					{ label: "Database", value: formatBytes(cur.dbBytes) },
				]}
			/>
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
		</Section>
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
		<Section
			title="Network traffic"
			note="Outgoing traffic from this server. Redirects and error responses transfer minimal data."
			actions={
				<Segmented
					small
					label="Metric"
					value={metric}
					options={["bytes", "requests"] as const}
					names={{ bytes: "Data sent", requests: "Requests" }}
					onChange={setMetric}
				/>
			}
		>
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
								<tr key={c.key} class={on ? "" : "chart-off"}>
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
									<td class="num chart-toggle">
										<input
											type="checkbox"
											class="switch"
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
		</Section>
	);
}

const DOMAIN_COLUMNS: { key: DomainSort; label: string; hint: string }[] = [
	{ key: "tileRequests", label: "Tile lookups", hint: "Requests for a tile" },
	{ key: "blobRequests", label: "Images", hint: "Tile images downloaded" },
	{ key: "bytes", label: "Sent", hint: "Data sent for tiles and images" },
	{ key: "lastSeen", label: "Last seen", hint: "Most recent request" },
];

const PSEUDO_DOMAINS = new Set(["This site", "No referrer", "Other"]);

function Domains(props: { data: Body; onChange: () => void }) {
	const [sort, setSort] = useState<DomainSort>("bytes");
	const [busy, setBusy] = useState(false);
	const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
	const toggle = (name: string) =>
		setOpen((prev) => {
			const next = new Set(prev);
			if (!next.delete(name)) next.add(name);
			return next;
		});
	/** Removes the rows (an app's versions: all of them) after asking. */
	const remove = async (label: string, domains: string[]) => {
		const what =
			domains.length > 1
				? `"${label}" (${domains.length} versions)`
				: `"${label}"`;
		if (
			!confirm(
				`Remove ${what} from this list? Its traffic is added to "Other". It will reappear if it requests tiles again.`,
			)
		)
			return;
		setBusy(true);
		for (const domain of domains) {
			const res = await attempt(() =>
				api.api.admin.traffic.domains[":domain{.+}"].$delete({
					param: { domain },
				}),
			);
			if (!res.ok) {
				showNotice(res.error, "error");
				break;
			}
		}
		setBusy(false);
		props.onChange();
	};
	const rows: DomainRow[] = props.data.traffic.domains;
	const groups = groupDomains(rows, sort);
	const total = rows.reduce((n, d) => n + d.bytes, 0);

	const cells = (d: DomainRow) => {
		const share = total > 0 ? d.bytes / total : 0;
		return (
			<>
				<td class="num">{formatNumber(d.tileRequests)}</td>
				<td class="num">{formatNumber(d.blobRequests)}</td>
				<td class="num">{formatBytes(d.bytes)}</td>
				<td class="num">{formatTime(d.lastSeen)}</td>
				<td>
					<span class="share-bar" aria-hidden="true">
						<span class="share-fill" style={{ width: `${share * 100}%` }} />
					</span>{" "}
					{(share * 100).toFixed(1)}%
				</td>
			</>
		);
	};
	/** A row and, when open, the rows under it; `fixed`: rows that cannot be deleted. */
	const rowsOf = (
		n: DomainNode,
		depth: number,
		fixed: boolean,
	): JSX.Element => {
		const expanded = open.has(n.key);
		const nested = n.children.length > 0;
		return (
			<Fragment key={n.key}>
				<tr>
					<td
						class={depth === 0 ? (fixed ? "muted-cell" : "") : "domain-child"}
						style={{
							// Rows without a chevron line up with the labels of rows that have one.
							paddingLeft:
								depth > 0 ? `${depth * 1.6 + (nested ? 0 : 1.3)}em` : undefined,
						}}
					>
						{nested ? (
							<button
								type="button"
								class="plain"
								aria-expanded={expanded}
								onClick={() => toggle(n.key)}
							>
								<span class="chevron" aria-hidden="true">
									{expanded ? "▼" : "▶"}
								</span>{" "}
								{n.label} <span class="muted">({n.children.length})</span>
							</button>
						) : (
							n.label
						)}
					</td>
					{cells(n.total)}
					<td>
						{!fixed && (
							<button
								type="button"
								class="btn small danger"
								disabled={busy}
								onClick={() => void remove(n.key, n.domains)}
							>
								Delete
							</button>
						)}
					</td>
				</tr>
				{expanded && n.children.map((c) => rowsOf(c, depth + 1, fixed))}
			</Fragment>
		);
	};

	return (
		<Section title="Tile traffic by domain">
			<details class="admin-help">
				<summary>How requests are grouped</summary>
				<p class="muted">
					Requests are grouped by their Origin or Referer header, with this
					site's own traffic broken down by browser. Tools that send neither are
					listed by the name and version their User-Agent starts with (such as{" "}
					<code>AOMCGuessr/1.4</code>); “No referrer” is everything else, such
					as direct downloads.
				</p>
			</details>
			{rows.length === 0 ? (
				<p class="admin-empty muted">No tile requests in this period.</p>
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
								<th aria-label="Actions" />
							</tr>
						</thead>
						<tbody>
							{groups.map((g) => rowsOf(g, 0, PSEUDO_DOMAINS.has(g.key)))}
						</tbody>
					</table>
				</div>
			)}
		</Section>
	);
}

function Overview(props: { data: Body }) {
	const o = props.data.overview;
	return (
		<Section title="Server">
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
		</Section>
	);
}

/** The owners' view of storage, network traffic and the server. */
export function AdminStats() {
	const [range, setRange] = useState<AdminStatsRange>("7d");
	const { data, error, loading, reload } = useStats(
		() => api.api.admin.stats.$get({ query: { range } }),
		[range],
	);

	return (
		<div class="admin-stats" aria-busy={loading}>
			<div class="admin-controls">
				<Segmented
					label="Time range"
					value={range}
					options={ADMIN_STATS_RANGES}
					names={RANGE_NAMES}
					onChange={setRange}
				/>
				<div class="admin-refresh">
					{data && (
						<span class="muted" title={formatTime(data.now)}>
							Updated {formatRelative(data.now)}
						</span>
					)}
					<button
						type="button"
						class="btn small"
						disabled={loading}
						onClick={reload}
					>
						{loading ? "Refreshing…" : "Refresh"}
					</button>
				</div>
			</div>
			{error && <p class="error-text">Failed to load statistics: {error}</p>}
			{!data ? (
				!error && <p class="muted">Loading…</p>
			) : (
				<div class={loading ? "admin-body loading" : "admin-body"}>
					<Storage data={data} onCleaned={reload} />
					<Traffic data={data} />
					<Domains data={data} onChange={reload} />
					<Overview data={data} />
				</div>
			)}
		</div>
	);
}
