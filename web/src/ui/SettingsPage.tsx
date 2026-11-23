import {
	ChoicePicker,
	ModePicker,
	StylePicker,
	Toggle,
} from "@aomc-server/block-ui";
import { useEffect, useState } from "preact/hooks";
import { api, attempt, loginUrl } from "../api";
import {
	isMapOutlines,
	isShapeCache,
	MAP_OUTLINE_CHOICES,
	PIN_CLUSTER_MAX,
	PIN_CLUSTER_MIN,
	type Settings,
	SHAPE_CACHE_CHOICES,
	settings,
	TRANSITION_SPEEDS,
	updateSettings,
} from "../settings";
import { user, visibleDimensions } from "../state";
import { ApiTokens } from "./ApiTokens";
import { LoadFailed, Page, usePageLoad } from "./Page";

type BooleanSetting = {
	[K in keyof Settings]: Settings[K] extends boolean ? K : never;
}[keyof Settings];

function SettingToggle(props: {
	field: BooleanSetting;
	label: string;
	hint: string;
}) {
	return (
		<Toggle
			checked={settings.value[props.field]}
			onChange={(checked) => updateSettings({ [props.field]: checked })}
			label={props.label}
			hint={props.hint}
		/>
	);
}

function Appearance() {
	return (
		<section class="page-section">
			<h2>Appearance</h2>
			<p class="muted">Saved in this browser only.</p>
			<ModePicker
				value={settings.value.mode}
				onChange={(mode) => updateSettings({ mode })}
			/>
			<StylePicker
				value={settings.value.style}
				onChange={(style) => updateSettings({ style })}
				previewTitle="Layers"
				previewButtons={["Edit", "Save"]}
			/>
			<SettingToggle
				field="dimensionColours"
				label="Colour the map by dimension"
				hint="Match the UI colour palette to the active dimension (such as red in the Nether or purple in The End) instead of always using Overworld colours."
			/>
		</section>
	);
}

function TransitionPicker() {
	return (
		<ChoicePicker
			label="Camera transitions"
			value={settings.value.transitionSpeed}
			options={TRANSITION_SPEEDS}
			onChange={(transitionSpeed) => updateSettings({ transitionSpeed })}
			hint="Animation speed when panning or zooming automatically (such as jumping to a feature or upload). Instant disables animations."
		/>
	);
}

function Preferences() {
	const dims = visibleDimensions.value;
	const current = settings.value.defaultDimension;
	return (
		<section class="page-section">
			<h2>Preferences</h2>
			<p class="muted">Saved in this browser only.</p>

			<label class="field flow">
				<span class="label">Default dimension</span>
				<select
					value={current ?? ""}
					onChange={(e) =>
						updateSettings({ defaultDimension: e.currentTarget.value || null })
					}
				>
					<option value="">First dimension</option>
					{dims.map((d) => (
						<option key={d.slug} value={d.slug}>
							{d.name}
						</option>
					))}
					{current && !dims.some((d) => d.slug === current) && (
						<option value={current}>{current} (unavailable)</option>
					)}
				</select>
				<span class="muted hint">
					Used when opening the map without a dimension in the URL.
				</span>
			</label>

			<TransitionPicker />

			<SettingToggle
				field="rememberPosition"
				label="Remember last position"
				hint="Restore your last viewed dimension, coordinates, and zoom level when opening the map."
			/>
			<SettingToggle
				field="showCoordinates"
				label="Show cursor coordinates"
				hint="Display block coordinates in the bottom-left corner."
			/>
			<SettingToggle
				field="showOverworldEquivalent"
				label="Show overworld coordinates in other dimensions"
				hint="Show corresponding Overworld coordinates when viewing scaled dimensions like the Nether."
			/>
			<SettingToggle
				field="showScale"
				label="Show zoom scale"
				hint="Display the current pixel-to-block ratio (e.g. “1 px = 4 blocks”)."
			/>
			<label class="field flow">
				<span class="label">
					Pin clustering distance: {settings.value.pinClusterDistance}
				</span>
				<input
					type="range"
					min={PIN_CLUSTER_MIN}
					max={PIN_CLUSTER_MAX}
					step={1}
					value={settings.value.pinClusterDistance}
					onInput={(e) =>
						updateSettings(
							{ pinClusterDistance: Number(e.currentTarget.value) },
							false,
						)
					}
					onChange={(e) =>
						updateSettings({
							pinClusterDistance: Number(e.currentTarget.value),
						})
					}
				/>
				<span class="muted hint">
					Screen distance (in pixels) within which nearby pins merge into a
					numbered cluster. Lower values show more individual pins.
				</span>
			</label>
			<SettingToggle
				field="preloadSpawn"
				label="Preload tiles around spawn"
				hint="Keep low-resolution tiles around 0, 0 loaded in the background to prevent blank areas while panning or zooming. Turn off to save bandwidth on metered connections."
			/>
			<label class="field flow">
				<span class="label">Cache vector shapes while moving</span>
				<select
					value={settings.value.shapeCache}
					onChange={(e) => {
						const value = e.currentTarget.value;
						if (isShapeCache(value)) updateSettings({ shapeCache: value });
					}}
				>
					{SHAPE_CACHE_CHOICES.map((c) => (
						<option key={c.id} value={c.id}>
							{c.name}
						</option>
					))}
				</select>
				<span class="muted hint">
					Rasterize lines and areas while panning and zooming instead of
					redrawing them every frame. Improves performance in browsers with
					slower canvas rendering (enabled automatically in Firefox).
				</span>
			</label>
		</section>
	);
}

function Debugging() {
	return (
		<section class="page-section">
			<h2>Debugging</h2>
			<p class="muted">Saved in this browser only.</p>
			<SettingToggle
				field="debugRender"
				label="Debug render mode"
				hint="Tint and label tiles by load state (loaded, stale, fallback, missing) and display renderer diagnostics."
			/>
			<SettingToggle
				field="tileOutlines"
				label="Show tile outlines"
				hint="Show map tile boundaries at the current zoom level."
			/>
			<SettingToggle
				field="chunkOutlines"
				label="Show chunk outlines"
				hint="Show the 16×16 chunk grid at 1:1 zoom and closer. Zooming in further reveals chunk coordinates, the block grid, and individual block coordinates."
			/>
			<SettingToggle
				field="regionOutlines"
				label="Show region outlines"
				hint="Show the 512×512 region grid labelled with region filenames (r.X.Z)."
			/>
			<label class="toggle toggle-select">
				<select
					value={settings.value.mapOutlines}
					onChange={(e) => {
						const value = e.currentTarget.value;
						if (isMapOutlines(value)) updateSettings({ mapOutlines: value });
					}}
				>
					{MAP_OUTLINE_CHOICES.map((c) => (
						<option key={c.id} value={c.id}>
							{c.name}
						</option>
					))}
				</select>
				<span class="toggle-text">
					Show in-game map outlines
					<span class="muted hint">
						Show vanilla Minecraft map boundaries and centres. “All scales”
						draws nested grids by scale: 1:1 yellow, 1:2 orange, 1:4 red, 1:8
						purple, 1:16 green.
					</span>
				</span>
			</label>
		</section>
	);
}

/** Download everything stored about you, or delete your account. */
function YourData() {
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Linked to from the privacy statement; the section only appears once the page has loaded.
	useEffect(() => {
		if (location.hash === "#your-data")
			document.getElementById("your-data")?.scrollIntoView();
	}, []);

	const remove = async () => {
		setBusy(true);
		setError(null);
		const res = await attempt(() => api.api.me.$delete());
		setBusy(false);
		if (res.ok) location.href = "/";
		else setError(res.error);
	};

	return (
		<section class="page-section" id="your-data">
			<h2>Your data</h2>
			<p class="muted">
				See the <a href="/privacy">privacy policy</a> for details on how your
				data is stored and used.
			</p>
			<div class="group">
				<a class="btn" href="/api/me/export" download="my-map-data.json">
					Download my data
				</a>
				{!confirming && (
					<button
						type="button"
						class="btn danger"
						onClick={() => setConfirming(true)}
					>
						Delete my account
					</button>
				)}
			</div>
			{confirming && (
				<div class="delete-account">
					<p>
						This logs you out everywhere and permanently deletes your account,
						API tokens, roles, and invite links. This cannot be undone.
					</p>
					<p>
						Your map uploads, layers, features, and uploaded files will remain
						under the name “Deleted user” with no link back to your Discord
						account. Delete any items you want removed before proceeding.
						Logging in again later will create a new account.
					</p>
					<div class="group">
						<button
							type="button"
							class="btn danger"
							disabled={busy}
							onClick={() => void remove()}
						>
							{busy ? "Deleting…" : "Yes, delete my account"}
						</button>
						<button
							type="button"
							class="btn"
							disabled={busy}
							onClick={() => setConfirming(false)}
						>
							Cancel
						</button>
					</div>
					{error && <p class="error-text">{error}</p>}
				</div>
			)}
		</section>
	);
}

/** /settings: your preferences and API tokens. */
export function SettingsPage() {
	const { status, retry } = usePageLoad();

	const u = user.value;
	return (
		<Page title="Settings">
			{u && (
				<section class="page-section account-card">
					{u.avatarUrl && (
						<img
							class="avatar"
							src={u.avatarUrl}
							alt=""
							width={40}
							height={40}
						/>
					)}
					<div>
						<div>{u.username}</div>
						<div class="muted hint">
							Name and avatar come from Discord and update when you log in.
						</div>
					</div>
				</section>
			)}

			<Appearance />
			<Preferences />
			<Debugging />

			{status === "loading" ? null : status === "failed" ? (
				<section class="page-section">
					<LoadFailed retry={retry} />
				</section>
			) : u ? (
				<>
					<ApiTokens />
					<YourData />
				</>
			) : (
				<section class="page-section">
					<h2>API tokens</h2>
					<p class="muted">Log in to create API tokens.</p>
					<a class="btn primary" href={loginUrl()}>
						Log in with Discord
					</a>
				</section>
			)}
		</Page>
	);
}
