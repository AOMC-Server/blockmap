import { Badge, renumber, Tabs, Toggle } from "@aomc-server/block-ui";
import { MAX_NAME } from "@blockmap/shared/features";
import { canManage, canModerate } from "@blockmap/shared/roles";
import {
	createDimensionSchema,
	DEFAULT_PRELOAD,
	DIMENSION_THEMES,
	type DimensionTheme,
	guessDimensionTheme,
	MAX_COORD,
	type PreloadRing,
	xaeroDimensionSchema,
} from "@blockmap/shared/schemas";
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { loginUrl, showNotice } from "../api";
import { MAX_PRELOAD_TILES, preloadTiles } from "../map/tileLayer";
import { failedUploadCount, purgeFailedUploads } from "../revisions";
import { describeDimensionScale, formatScale, parseScale } from "../scale";
import {
	addDimension,
	deleteDimension,
	mapScope,
	setMaintenance,
	updateDimension,
	updateMapName,
} from "../sharing";
import { slugify } from "../slug";
import { currentMap, type Dimension, user } from "../state";
import { DIMENSION_THEME_NAMES } from "../theme";
import { AdminJobs } from "./AdminJobs";
import { AdminStats } from "./AdminStats";
import { InviteLinks } from "./InviteLinks";
import { BlockIcon } from "./icons";
import { MembersSection } from "./MembersSection";
import { LoadFailed, Page, usePageLoad } from "./Page";

type Tab =
	| "settings"
	| "dimensions"
	| "jobs"
	| "members"
	| "invites"
	| "statistics";

const slugSchema = createDimensionSchema.shape.slug;

const TAB_LABELS: Record<Tab, string> = {
	settings: "Settings",
	dimensions: "Dimensions",
	jobs: "Jobs",
	members: "Members",
	invites: "Invites",
	statistics: "Statistics",
};

function SettingsTab() {
	const detail = currentMap.value;
	const [name, setName] = useState(detail?.map.name ?? "");
	const [busy, setBusy] = useState(false);
	if (!detail) return null;

	const save = async (e: Event) => {
		e.preventDefault();
		setBusy(true);
		try {
			await updateMapName(name.trim());
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
			<section class="admin-section">
				<div class="admin-toolbar">
					<h2>General</h2>
				</div>
				<form class="settings-form" onSubmit={save}>
					<label class="field flow">
						<span class="label">Map name</span>
						<input
							type="text"
							value={name}
							maxLength={MAX_NAME}
							onInput={(e) => setName(e.currentTarget.value)}
						/>
					</label>
					<p class="muted hint">
						Tile size: {detail.map.tileSize} blocks per tile edge (fixed).
					</p>
					<button
						type="submit"
						class="btn primary"
						disabled={busy || !name.trim() || name.trim() === detail.map.name}
					>
						Save
					</button>
				</form>
			</section>
			<section class="admin-section">
				<div class="admin-toolbar">
					<h2>Maintenance</h2>
				</div>
				<MaintenanceToggle />
			</section>
			<section class="admin-section">
				<div class="admin-toolbar">
					<h2>Danger zone</h2>
				</div>
				<FailedUploads />
			</section>
		</>
	);
}

function MaintenanceToggle() {
	const on = currentMap.value?.map.maintenance ?? false;
	const [busy, setBusy] = useState(false);
	return (
		<Toggle
			class={on ? "danger" : ""}
			checked={on}
			disabled={busy}
			onChange={async (next) => {
				setBusy(true);
				try {
					await setMaintenance(next);
				} finally {
					setBusy(false);
				}
			}}
			label="Maintenance mode"
			hint="Makes the map read-only for everyone except owners (pausing uploads, edits, deletions, and invites) and displays a maintenance banner."
		/>
	);
}

function FailedUploads() {
	const [count, setCount] = useState<number | null>(null);
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		void failedUploadCount().then(setCount);
	}, []);
	const purge = async () => {
		if (!confirm("Remove all failed uploads from the upload log?")) return;
		setBusy(true);
		try {
			if ((await purgeFailedUploads()) !== null) setCount(0);
		} finally {
			setBusy(false);
		}
	};
	return (
		<div class="admin-danger">
			<div class="admin-danger-text">
				<b>Failed uploads</b>
				<p class="muted hint">
					Failed uploads are only visible to their uploader and moderators.
					Purging permanently clears them from the log.
				</p>
			</div>
			<button
				type="button"
				class="btn danger"
				disabled={busy || count === 0}
				onClick={purge}
			>
				Purge failed uploads{count ? ` (${count})` : ""}
			</button>
		</div>
	);
}

function ThemeSelect(props: {
	value: DimensionTheme;
	label: string;
	disabled?: boolean;
	onChange: (theme: DimensionTheme) => void;
}) {
	return (
		<select
			class="theme-select"
			value={props.value}
			aria-label={props.label}
			disabled={props.disabled}
			onChange={(e) => props.onChange(e.currentTarget.value as DimensionTheme)}
		>
			{DIMENSION_THEMES.map((t) => (
				<option key={t} value={t}>
					{DIMENSION_THEME_NAMES[t]}
				</option>
			))}
		</select>
	);
}

const formatBlocksShort = (n: number) =>
	n >= 1000 && n % 1024 === 0 ? `${n / 1024}k` : String(n);

/** Accepts "2048", "2k" (2048) or "1.5k"; undefined if invalid. */
function parseBlocks(text: string): number | undefined {
	const m = /^\s*(\d+(?:\.\d+)?)\s*(k?)\s*$/i.exec(text);
	if (!m) return undefined;
	const n = Math.round(Number(m[1]) * (m[2] ? 1024 : 1));
	return n <= MAX_COORD ? n : undefined;
}

function PreloadRingRow(props: {
	ring: PreloadRing;
	slug: string;
	maxZoom: number;
	disabled: boolean;
	onChange: (ring: PreloadRing) => void;
	onRemove: () => void;
}) {
	const { ring } = props;
	const [radius, setRadius] = useState(formatBlocksShort(ring.radius));
	const levels = Array.from({ length: props.maxZoom + 1 }, (_, i) => i);
	return (
		<div class="preload-ring">
			<select
				value={ring.level}
				aria-label={`Preload resolution of ${props.slug}`}
				disabled={props.disabled}
				onChange={(e) =>
					props.onChange({ ...ring, level: Number(e.currentTarget.value) })
				}
			>
				{levels.map((l) => (
					<option key={l} value={l}>
						{l === 0 ? "Full" : `1/${2 ** l}`} resolution
					</option>
				))}
			</select>
			<span class="muted">within</span>
			<input
				type="text"
				inputMode="numeric"
				class="scale-input"
				value={radius}
				aria-label={`Preload radius of ${props.slug} in blocks`}
				disabled={props.disabled}
				onInput={(e) => setRadius(e.currentTarget.value)}
				onBlur={() => {
					const parsed = parseBlocks(radius);
					if (parsed === undefined || parsed === ring.radius) {
						setRadius(formatBlocksShort(ring.radius));
						return;
					}
					props.onChange({ ...ring, radius: parsed });
				}}
				onKeyDown={(e) => {
					if (e.key === "Enter") e.currentTarget.blur();
				}}
			/>
			<span class="muted">blocks of spawn</span>
			<button
				type="button"
				class="btn small"
				disabled={props.disabled}
				aria-label="Remove"
				onClick={props.onRemove}
			>
				✕
			</button>
		</div>
	);
}

/** The low resolution tiles viewers keep loaded around spawn (0, 0) in this dimension. */
function PreloadEditor(props: {
	d: Dimension;
	busy: boolean;
	run: (fn: () => Promise<boolean>) => void;
}) {
	const detail = currentMap.value;
	if (!detail) return null;
	const { d } = props;
	const rings = d.preload;
	const save = (preload: PreloadRing[]) =>
		props.run(() => updateDimension(d.slug, { preload }));
	const tiles = preloadTiles(rings, detail.map.tileSize, detail.maxZoom).length;
	const isDefault = JSON.stringify(rings) === JSON.stringify(DEFAULT_PRELOAD);
	const coarsest = Math.max(-1, ...rings.map((r) => r.level));

	return (
		<div class="dim-preload">
			<div class="dim-preload-head">
				<span class="dim-label">Preload around spawn</span>
				<span class="muted">
					{rings.length === 0
						? "off"
						: `${tiles} tile${tiles === 1 ? "" : "s"}${tiles >= MAX_PRELOAD_TILES ? " (limit reached; reduce a radius or resolution)" : ""}`}
				</span>
			</div>
			<div>
				{rings.map((ring, i) => (
					<PreloadRingRow
						key={`${i}:${ring.level}:${ring.radius}`}
						ring={ring}
						slug={d.slug}
						maxZoom={detail.maxZoom}
						disabled={props.busy}
						onChange={(next) => save(rings.map((r, j) => (j === i ? next : r)))}
						onRemove={() => save(rings.filter((_, j) => j !== i))}
					/>
				))}
			</div>
			<div class="group">
				<button
					type="button"
					class="btn small"
					disabled={props.busy || rings.length >= 8}
					onClick={() => {
						// A coarser ring reaching twice as far as the coarsest so far.
						const last = rings.find((r) => r.level === coarsest);
						const level = Math.min(coarsest + 1, detail.maxZoom);
						save([
							...rings,
							{
								level: Math.max(level, 0),
								radius: Math.min((last?.radius ?? 1024) * 2, MAX_COORD),
							},
						]);
					}}
				>
					Add ring
				</button>
				{!isDefault && (
					<button
						type="button"
						class="btn small"
						disabled={props.busy}
						onClick={() => save(DEFAULT_PRELOAD)}
					>
						Reset to default
					</button>
				)}
				{rings.length > 0 && (
					<button
						type="button"
						class="btn small"
						disabled={props.busy}
						onClick={() => save([])}
					>
						Turn off
					</button>
				)}
			</div>
		</div>
	);
}

function DimensionRow(props: {
	d: Dimension;
	index: number;
	all: Dimension[];
	busy: boolean;
	run: (fn: () => Promise<boolean>) => void;
}) {
	const { d, all, index } = props;
	const [name, setName] = useState(d.name);
	const [scale, setScale] = useState(formatScale(d.scale));
	const [xaero, setXaero] = useState(d.xaeroDimension);
	const prev = all[index - 1];
	const next = all[index + 1];

	const move = (to: number) =>
		props.run(async () => {
			// Every dimension gets its position, so ties and gaps never hide the move.
			for (const { item, sortOrder } of renumber(all, index, to)) {
				if (!(await updateDimension(item.slug, { sortOrder }))) return false;
			}
			return true;
		});

	return (
		<li class={d.archived ? "archived" : ""}>
			<div class="dim-main">
				<div class="dim-head">
					<input
						type="text"
						value={name}
						maxLength={MAX_NAME}
						aria-label={`Name of ${d.slug}`}
						onInput={(e) => setName(e.currentTarget.value)}
						onBlur={() => {
							const trimmed = name.trim();
							if (trimmed && trimmed !== d.name)
								props.run(() => updateDimension(d.slug, { name: trimmed }));
							else setName(d.name);
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter") e.currentTarget.blur();
						}}
					/>
					<code class="dim-slug">{d.slug}</code>
					{d.archived && <Badge>Archived</Badge>}
				</div>
				<div class="dim-fields">
					<label class="dim-field" title={describeDimensionScale(d.scale)}>
						<span class="dim-label">Scale ×</span>
						<input
							type="text"
							inputMode="decimal"
							placeholder="None"
							value={scale}
							aria-label={`Coordinate scale of ${d.slug}`}
							onInput={(e) => setScale(e.currentTarget.value)}
							onBlur={() => {
								const parsed = parseScale(scale);
								if (parsed === undefined || parsed === d.scale) {
									setScale(formatScale(d.scale));
									return;
								}
								props.run(() => updateDimension(d.slug, { scale: parsed }));
							}}
							onKeyDown={(e) => {
								if (e.key === "Enter") e.currentTarget.blur();
							}}
						/>
					</label>
					<div class="dim-field">
						<span class="dim-label">Theme</span>
						<div class="dim-theme">
							<BlockIcon theme={d.theme} />
							<ThemeSelect
								value={d.theme}
								label={`Theme of ${d.slug}`}
								disabled={props.busy}
								onChange={(theme) =>
									props.run(() => updateDimension(d.slug, { theme }))
								}
							/>
						</div>
					</div>
					<label
						class="dim-field"
						title="Dimension ID used in Xaero's Minimap waypoints (e.g. dim%0 for Overworld, dim%-1 for Nether, dim%1 for The End)"
					>
						<span class="dim-label">Xaero ID</span>
						<input
							type="text"
							class="xaero-input"
							value={xaero}
							aria-label={`Xaero dimension ID of ${d.slug}`}
							onInput={(e) => setXaero(e.currentTarget.value)}
							onBlur={() => {
								const parsed = xaeroDimensionSchema.safeParse(xaero);
								if (!parsed.success || parsed.data === d.xaeroDimension) {
									setXaero(d.xaeroDimension);
									return;
								}
								props.run(() =>
									updateDimension(d.slug, { xaeroDimension: parsed.data }),
								);
							}}
							onKeyDown={(e) => {
								if (e.key === "Enter") e.currentTarget.blur();
							}}
						/>
					</label>
				</div>
				<PreloadEditor d={d} busy={props.busy} run={props.run} />
			</div>
			<div class="group dim-actions">
				<button
					type="button"
					class="btn small"
					disabled={props.busy || !prev}
					aria-label="Move up"
					onClick={() => move(index - 1)}
				>
					↑
				</button>
				<button
					type="button"
					class="btn small"
					disabled={props.busy || !next}
					aria-label="Move down"
					onClick={() => move(index + 1)}
				>
					↓
				</button>
				<button
					type="button"
					class="btn small"
					disabled={props.busy}
					onClick={() =>
						props.run(() => updateDimension(d.slug, { archived: !d.archived }))
					}
				>
					{d.archived ? "Restore" : "Archive"}
				</button>
				{d.archived && currentMap.value && canManage(currentMap.value.role) && (
					<button
						type="button"
						class="btn small danger"
						disabled={props.busy}
						onClick={() => {
							const typed = prompt(
								`Permanently delete “${d.name}” along with all of its uploads, tiles, layers, and features? This cannot be undone.\n\nType the dimension name to confirm:`,
							);
							if (typed?.trim() !== d.name) {
								if (typed !== null)
									showNotice("Dimension name did not match.", "error");
								return;
							}
							props.run(async () => {
								const ok = await deleteDimension(d.slug);
								if (ok)
									showNotice(
										`Queued deletion of ${d.name}. It will be removed once background processing finishes.`,
									);
								return ok;
							});
						}}
					>
						Delete permanently
					</button>
				)}
			</div>
		</li>
	);
}

function DimensionsTab() {
	const detail = currentMap.value;
	const [newName, setNewName] = useState("");
	const [newSlug, setNewSlug] = useState("");
	const [newScale, setNewScale] = useState("");
	const [newTheme, setNewTheme] = useState<DimensionTheme | null>(null);
	const [slugTouched, setSlugTouched] = useState(false);
	const [busy, setBusy] = useState(false);
	if (!detail) return null;
	const dims = [...detail.dimensions].sort(
		(a, b) => a.sortOrder - b.sortOrder || a.id - b.id,
	);

	const run = async (fn: () => Promise<boolean>) => {
		setBusy(true);
		try {
			await fn();
		} finally {
			setBusy(false);
		}
	};

	const scale = parseScale(newScale);
	// Why the form cannot be submitted yet, once a name has been typed.
	const problem = !newName.trim()
		? null
		: !newSlug
			? "Slug is required (use lowercase letters, numbers, hyphens, or underscores)."
			: !slugSchema.safeParse(newSlug).success
				? "Slug may only contain lowercase letters, numbers, hyphens, and underscores, and must start with a letter or number."
				: scale === undefined
					? "Scale must be a positive number or left blank."
					: null;

	const add = async (e: Event) => {
		e.preventDefault();
		if (!newName.trim() || !newSlug || problem !== null || scale === undefined)
			return;
		const slug = newSlug;
		await run(async () => {
			const ok = await addDimension(
				slug,
				newName.trim(),
				scale,
				newTheme ?? guessDimensionTheme(slug),
			);
			if (ok) {
				setNewName("");
				setNewSlug("");
				setNewScale("");
				setNewTheme(null);
				setSlugTouched(false);
			}
			return ok;
		});
	};

	return (
		<div>
			<details class="admin-help">
				<summary>What do these settings mean?</summary>
				<dl>
					<dt>Archived</dt>
					<dd>
						Hides the dimension from the dimension switcher while keeping its
						tiles and history. Owners can permanently delete archived
						dimensions.
					</dd>
					<dt>Scale</dt>
					<dd>
						Maps a dimension's coordinates to the Overworld (e.g. 1 for
						Overworld, 8 for Nether) so switching dimensions preserves your
						location. Leave blank for dimensions with independent coordinates,
						like The End.
					</dd>
					<dt>Theme</dt>
					<dd>Sets the dimension's icon and UI colour palette.</dd>
					<dt>Xaero ID</dt>
					<dd>
						The identifier used when copying waypoints for Xaero's Minimap:{" "}
						<code>dim%0</code> (Overworld), <code>dim%-1</code> (Nether), or{" "}
						<code>dim%1</code> (The End).
					</dd>
					<dt>Preload around spawn</dt>
					<dd>
						Fetches low-resolution tiles near 0, 0 in the background so the map
						stays visible while zooming or panning. Coarser rings cover wider
						areas using fewer tiles. Users can disable preloading in their
						browser settings.
					</dd>
				</dl>
			</details>
			<ul class="dimension-list">
				{dims.map((d, i) => (
					<DimensionRow
						key={`${d.slug}:${d.name}:${d.sortOrder}:${d.scale}:${d.xaeroDimension}`}
						d={d}
						index={i}
						all={dims}
						busy={busy}
						run={run}
					/>
				))}
			</ul>
			<span class="dim-label dim-add-label">Add a dimension</span>
			<form class="add-dimension" onSubmit={add}>
				<input
					type="text"
					placeholder="New dimension name"
					aria-label="New dimension name"
					value={newName}
					maxLength={MAX_NAME}
					onInput={(e) => {
						setNewName(e.currentTarget.value);
						if (!slugTouched) setNewSlug(slugify(e.currentTarget.value));
					}}
				/>
				<input
					type="text"
					placeholder="Slug"
					aria-label="Dimension slug"
					value={newSlug}
					maxLength={40}
					onInput={(e) => {
						setSlugTouched(true);
						setNewSlug(e.currentTarget.value.toLowerCase());
					}}
				/>
				<input
					type="text"
					inputMode="decimal"
					class="scale-input"
					placeholder="Scale"
					aria-label="Coordinate scale of the new dimension"
					value={newScale}
					onInput={(e) => setNewScale(e.currentTarget.value)}
				/>
				<ThemeSelect
					value={newTheme ?? guessDimensionTheme(newSlug)}
					label="Theme of the new dimension"
					onChange={setNewTheme}
				/>
				<button
					type="submit"
					class="btn"
					disabled={busy || !newName.trim() || problem !== null}
				>
					Add
				</button>
			</form>
			{problem && <p class="hint error-text">{problem}</p>}
		</div>
	);
}

/** /manage: map settings, dimensions, members, invite links and statistics, for moderators and owners. */
export function ManagePage() {
	const { status, retry } = usePageLoad();

	const detail = currentMap.value;
	const role = detail?.role;
	const tabs: Tab[] = [];
	if (role && canManage(role)) tabs.push("settings");
	if (role && canModerate(role)) tabs.push("dimensions", "jobs");
	if (role && canManage(role)) tabs.push("members", "invites", "statistics");
	// `?tab=jobs` opens a tab directly, as the map's queue popup does.
	const [tab, setTab] = useState<Tab>(
		() =>
			(new URLSearchParams(location.search).get("tab") as Tab | null) ??
			"settings",
	);
	const active = tabs.includes(tab) ? tab : tabs[0];

	let body: ComponentChildren;
	if (status === "loading") {
		body = <p class="muted">Loading…</p>;
	} else if (status === "failed") {
		body = <LoadFailed retry={retry} />;
	} else if (!detail) {
		body = <p class="error-text">Failed to load map details.</p>;
	} else if (!user.value) {
		body = (
			<>
				<p>Log in to manage this map.</p>
				<a class="btn primary" href={loginUrl()}>
					Log in with Discord
				</a>
			</>
		);
	} else if (!active) {
		body = <p>Only moderators and owners can manage the map.</p>;
	} else {
		body = (
			<>
				<Tabs
					center
					tabs={tabs.map((t) => ({ id: t, label: TAB_LABELS[t] }))}
					value={active}
					onChange={setTab}
				/>
				<div class="page-section">
					{active === "settings" && <SettingsTab />}
					{active === "dimensions" && <DimensionsTab />}
					{active === "jobs" && <AdminJobs />}
					{active === "members" && <MembersSection scope={mapScope} />}
					{active === "invites" && <InviteLinks scope={mapScope} />}
					{active === "statistics" && <AdminStats />}
				</div>
			</>
		);
	}

	return (
		<Page
			title={detail ? `Manage ${detail.map.name}` : "Manage"}
			wide={active === "statistics" || active === "jobs"}
		>
			{body}
		</Page>
	);
}
