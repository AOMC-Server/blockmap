import {
	Avatar,
	Badge,
	Chart,
	Empty,
	ErrorBox,
	Loading,
	Segmented,
	SortTh,
	Tabs,
	TileGrid,
} from "@aomc-server/block-ui";
import { formatNumber } from "@aomc-server/block-ui/format";
import { STATS_RANGES, type StatsRange } from "@blockmap/shared";
import { DAY } from "@blockmap/shared/time";
import type { InferResponseType } from "hono/client";
import { useEffect, useState } from "preact/hooks";
import { api, loginUrl } from "../api";
import { loadUser } from "../controller";
import { user } from "../state";
import { Page } from "./Page";
import { useStats } from "./useStats";

type StatsBody = InferResponseType<typeof api.api.stats.$get, 200>;
type UserStats = NonNullable<StatsBody["me"]>;
type Row = StatsBody["leaderboard"][number];

const RANGE_NAMES: Record<StatsRange, string> = {
	all: "All time",
	"30d": "30 days",
	"7d": "7 days",
};

type Column = {
	key:
		| "uploads"
		| "modUploads"
		| "modAreaTiles"
		| "tiles"
		| "areaTiles"
		| "featuresCreated"
		| "featureEdits"
		| "layersCreated";
	label: string;
	hint: string;
	/** Part of the AOMC Webmapper group of columns. */
	mod?: boolean;
};

const COLUMNS: Column[] = [
	{ key: "uploads", label: "Uploads", hint: "Completed uploads" },
	{
		key: "tiles",
		label: "Tiles",
		hint: "Total map tiles uploaded, including updates",
	},
	{ key: "areaTiles", label: "Area", hint: "Unique area mapped" },
	{
		key: "featuresCreated",
		label: "Features",
		hint: "Pins, lines, and areas created",
	},
	{
		key: "featureEdits",
		label: "Edits",
		hint: "Subsequent edits to existing features",
	},
	{ key: "layersCreated", label: "Layers", hint: "Layers created" },
	{
		key: "modUploads",
		label: "Uploads",
		hint: "Uploads sent via AOMC Webmapper (included in Uploads)",
		mod: true,
	},
	{
		key: "modAreaTiles",
		label: "Area",
		hint: "Unique area mapped via AOMC Webmapper (included in Area)",
		mod: true,
	},
];

const MAIN_COLUMNS = COLUMNS.filter((c) => !c.mod).length;
const MOD_COLUMNS = COLUMNS.length - MAIN_COLUMNS;

const MEDALS = ["gold", "silver", "bronze"];
const PLACES = ["1st", "2nd", "3rd"];

/** An area of square blocks in km² (a block is a metre). */
function formatArea(blocks: number): string {
	return `${(blocks / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 })} km²`;
}

function count(n: number, noun: string): string {
	return `${formatNumber(n)} ${noun}${n === 1 ? "" : "s"}`;
}

function cell(s: UserStats, key: Column["key"]): string {
	if (key === "areaTiles") return formatArea(s.areaBlocks);
	if (key === "modAreaTiles") return formatArea(s.modAreaBlocks);
	return formatNumber(s[key]);
}

function readRange(): StatsRange {
	const r = new URLSearchParams(location.search).get("range");
	return (STATS_RANGES as readonly string[]).includes(r ?? "")
		? (r as StatsRange)
		: "all";
}

type StatTab = "me" | "global";

const STAT_TABS: { id: StatTab; label: string }[] = [
	{ id: "me", label: "Your stats" },
	{ id: "global", label: "Global stats" },
];

/**
 * The contributions, then the part of them sent by the AOMC Webmapper mod. `note` is about the
 * contributions (the mod cannot touch layers), so it goes between the two.
 */
function StatTiles(props: { stats: UserStats; note: string }) {
	const s = props.stats;
	const byType = s.featuresByType;
	return (
		<>
			<TileGrid
				plain
				tiles={[
					{ label: "Uploads", value: formatNumber(s.uploads) },
					{ label: "Tiles uploaded", value: formatNumber(s.tiles) },
					{
						label: "Area uploaded",
						value: formatArea(s.uploadedBlocks),
						hint: "Total area across all uploads, including re-uploaded regions",
					},
					{
						label: "Area mapped",
						value: formatArea(s.areaBlocks),
						hint: `${formatNumber(s.areaTiles)} unique tiles`,
					},
					{
						label: "Features created",
						value: formatNumber(s.featuresCreated),
						hint: `${count(byType.pin, "pin")} · ${count(byType.line, "line")} · ${count(byType.polygon, "area")}`,
					},
					{ label: "Feature edits", value: formatNumber(s.featureEdits) },
					{ label: "Layers created", value: formatNumber(s.layersCreated) },
				]}
			/>
			<p class="muted hint">{props.note}</p>
			<h3 class="stats-group">AOMC Webmapper</h3>
			<p class="muted hint">
				Subset of the stats above uploaded via the in-game mod.
			</p>
			<TileGrid
				plain
				tiles={[
					{
						label: "AOMC Webmapper uploads",
						value: formatNumber(s.modUploads),
					},
					{
						label: "Area uploaded by AOMC Webmapper",
						value: formatArea(s.modUploadedBlocks),
						hint: "Total area across all uploads, including re-uploaded regions",
					},
					{
						label: "Area mapped by AOMC Webmapper",
						value: formatArea(s.modAreaBlocks),
						hint: `${formatNumber(s.modAreaTiles)} unique tiles`,
					},
				]}
			/>
		</>
	);
}

function AreaChart(props: { data: StatsBody; signedIn: boolean }) {
	const { areaHistory: points, since } = props.data;
	const mine = props.signedIn && props.data.me !== null;
	const xs = points.map((p) => p.t);
	const short = since !== null && Date.now() - since <= 7 * DAY;
	return (
		<Chart
			kind="steps"
			xs={xs}
			series={[
				{
					key: "map",
					label: "Whole map",
					color: "var(--chart-1)",
					values: points.map((p) => p.totalBlocks),
				},
				...(mine
					? [
							{
								key: "me",
								label: "You",
								color: "var(--chart-2)",
								values: points.map((p) => p.myBlocks ?? 0),
							},
						]
					: []),
			]}
			formatY={formatArea}
			formatX={(t) =>
				new Date(t).toLocaleString(
					undefined,
					short
						? { month: "short", day: "numeric", hour: "numeric" }
						: { year: "numeric", month: "short", day: "numeric" },
				)
			}
			formatTip={(t) =>
				new Date(t).toLocaleString(
					undefined,
					short
						? {
								year: "numeric",
								month: "short",
								day: "numeric",
								hour: "numeric",
							}
						: { year: "numeric", month: "short", day: "numeric" },
				)
			}
		/>
	);
}

/** Rows by `sort` (best first), each with its place: rows with the same value share one. */
function rank(rows: Row[], sort: Column["key"]) {
	const sorted = [...rows].sort(
		(a, b) =>
			b[sort] - a[sort] ||
			b.tiles - a.tiles ||
			a.username.localeCompare(b.username),
	);
	let place = 0;
	return sorted.map((row, i) => {
		if (i === 0 || row[sort] !== sorted[i - 1]?.[sort]) place = i + 1;
		return { row, place };
	});
}

function RankChip(props: { place: number; medal: boolean }) {
	const i = props.place - 1;
	const medal = props.medal && i < MEDALS.length ? MEDALS[i] : undefined;
	return (
		<span
			class={medal ? `rank-chip ${medal}` : "rank-chip"}
			title={medal ? `${PLACES[i]} place` : undefined}
		>
			{props.place}
		</span>
	);
}

function Leaderboard(props: { rows: Row[]; me: string | null }) {
	const [sort, setSort] = useState<Column["key"]>("tiles");
	if (props.rows.length === 0)
		return (
			<Empty>No contributions in this time range yet. Try a longer one.</Empty>
		);
	const rows = rank(props.rows, sort);
	return (
		<div class="table-wrap flush">
			<table class="table plain compact nowrap leaderboard">
				<thead>
					<tr class="leaderboard-groups">
						<th class="player-cell" />
						<th colSpan={MAIN_COLUMNS} class="col-group">
							Contributions
						</th>
						<th colSpan={MOD_COLUMNS} class="col-group mod">
							AOMC Webmapper
						</th>
					</tr>
					<tr>
						<th class="player-cell">Player</th>
						{COLUMNS.map((c) => (
							<SortTh
								key={c.key}
								label={c.label}
								col={c.key}
								sort={sort}
								dir="desc"
								onSort={(col) => setSort(col as Column["key"])}
								num
								hint={c.hint}
							/>
						))}
					</tr>
				</thead>
				<tbody>
					{rows.map(({ row: r, place }) => (
						<tr key={r.userId} class={r.userId === props.me ? "me" : ""}>
							<td class="player-cell">
								<span class="player-name">
									<RankChip place={place} medal={r[sort] > 0} />
									<Avatar name={r.username} src={r.avatarUrl ?? undefined} />
									<span class="player-label">{r.username}</span>
									{r.userId === props.me && <Badge kind="ok">You</Badge>}
								</span>
							</td>
							{COLUMNS.map((c, i) => (
								<td
									key={c.key}
									class={[
										"num",
										c.key === sort && "sorted",
										i === MAIN_COLUMNS && "group-start",
									]
										.filter(Boolean)
										.join(" ")}
								>
									{cell(r, c.key)}
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function Account(props: {
	user: { username: string; avatarUrl?: string | null };
	rows: Row[];
	me: string;
}) {
	const { user: u } = props;
	const mine = rank(props.rows, "tiles").find((r) => r.row.userId === props.me);
	return (
		<div class="account-card stats-account">
			<Avatar name={u.username} src={u.avatarUrl ?? undefined} size={48} />
			<div>
				<div>{u.username}</div>
				<div class="muted hint">
					{mine
						? `#${mine.place} of ${props.rows.length} on the leaderboard (by tiles)`
						: "Not on the leaderboard for this time range"}
				</div>
			</div>
		</div>
	);
}

/** /stats: your contributions and a leaderboard of everyone's. */
export function StatsPage() {
	const [range, setRange] = useState<StatsRange>(readRange);
	const [picked, setPicked] = useState<StatTab | null>(null);

	useEffect(() => {
		void loadUser();
	}, []);

	useEffect(() => {
		const url = new URL(location.href);
		if (range === "all") url.searchParams.delete("range");
		else url.searchParams.set("range", range);
		history.replaceState(null, "", url);
	}, [range]);

	const { data, error, loading, reload } = useStats(
		() => api.api.stats.$get({ query: { range } }),
		[range],
	);

	const u = user.value;
	const section = loading && data ? "page-section fade" : "page-section";
	// Until one is picked, show your own stats when logged in and the global ones otherwise.
	const tab: StatTab = picked ?? (data && !data.me ? "global" : "me");
	return (
		<Page title="Statistics" wide>
			<Segmented
				label="Time range"
				value={range}
				options={STATS_RANGES}
				names={RANGE_NAMES}
				onChange={setRange}
			/>
			{error && (
				<ErrorBox
					message={`Failed to load statistics: ${error}`}
					onRetry={reload}
				/>
			)}

			<Tabs center tabs={STAT_TABS} value={tab} onChange={setPicked} />

			<section class={section}>
				<h2>{tab === "me" ? "Your stats" : "Global stats"}</h2>
				{!data ? (
					<Loading />
				) : tab === "global" ? (
					<StatTiles
						stats={data.totals}
						note="Combined contributions from all users. Excludes private layers."
					/>
				) : data.me && u ? (
					<>
						<Account user={u} rows={data.leaderboard} me={u.id} />
						<StatTiles stats={data.me} note="Includes your private layers." />
					</>
				) : (
					<>
						<p class="muted">Log in to view your personal stats.</p>
						<a class="btn primary" href={loginUrl()}>
							Log in with Discord
						</a>
					</>
				)}
			</section>

			<section class={section}>
				<h2>Mapped area</h2>
				<p class="muted">
					Cumulative unique area mapped over time, ordered by export date (or
					upload date when undated). Excludes deleted uploads.
				</p>
				{data ? <AreaChart data={data} signedIn={u !== null} /> : <Loading />}
			</section>

			<section class={section}>
				<h2>Leaderboard</h2>
				{data ? (
					<Leaderboard rows={data.leaderboard} me={u?.id ?? null} />
				) : (
					<Loading />
				)}
			</section>
		</Page>
	);
}
