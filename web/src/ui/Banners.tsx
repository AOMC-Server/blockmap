import { canManage } from "@blockmap/shared/roles";
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { setRev } from "../controller";
import { activeFilter, clearFilter, filterCounts } from "../filter";
import { setMaintenance } from "../sharing";
import {
	currentMap,
	editor,
	effectiveRev,
	isolatedUpload,
	rev,
	revisionsData,
	sidePanel,
} from "../state";
import { formatEventTime } from "./format";

function BossBar(props: {
	title: ComponentChildren;
	fill: number;
	color: "yellow" | "purple" | "maintenance";
	action?: string;
	onAction?: () => void;
	/** More buttons, after `action`. */
	actions?: ComponentChildren;
}) {
	return (
		<div class={`bossbar ${props.color}`} role="status">
			<div class="bossbar-main">
				<div class="bossbar-title">{props.title}</div>
				<div class={`bossbar-track ${props.color}`}>
					<span style={{ width: `${Math.round(props.fill * 100)}%` }} />
				</div>
			</div>
			{props.action && (
				<button type="button" class="btn small" onClick={props.onAction}>
					{props.action}
				</button>
			)}
			{props.actions}
		</div>
	);
}

/** Always visible while the map is in maintenance, so it is clear why nothing can be changed. */
function MaintenanceBar() {
	const detail = currentMap.value;
	const [busy, setBusy] = useState(false);
	if (!detail?.map.maintenance) return null;
	const owner = canManage(detail.role);
	return (
		<BossBar
			color="maintenance"
			fill={1}
			title={
				owner ? (
					<>
						<b>Maintenance mode</b> · only owners can make changes
					</>
				) : (
					<>
						<b>Maintenance mode</b> · the map is currently read-only
					</>
				)
			}
			action={owner ? (busy ? "Turning off…" : "Turn off") : undefined}
			onAction={async () => {
				if (busy) return;
				setBusy(true);
				try {
					await setMaintenance(false);
				} finally {
					setBusy(false);
				}
			}}
		/>
	);
}

/** The bars at the top of the map: maintenance, what point in time is shown, and the feature filter. */
export function Banners() {
	return (
		<div class="bossbar-wrap">
			<MaintenanceBar />
			<HistoryBanner />
			<FilterBanner />
		</div>
	);
}

/** Visible while a filter is hiding features, so it is clear the map is not showing everything. The filter panel shows the same itself. */
function FilterBanner() {
	if (!activeFilter.value) return null;
	if (sidePanel.value === "filter" && !editor.value) return null;
	const { shown, total } = filterCounts.value;
	return (
		<BossBar
			color="yellow"
			fill={total ? shown / total : 0}
			title={
				<>
					<b>Filter:</b> {shown} of {total} feature{total === 1 ? "" : "s"}
				</>
			}
			action="Edit"
			onAction={() => {
				sidePanel.value = "filter";
			}}
			actions={
				<button type="button" class="btn small" onClick={clearFilter}>
					Clear
				</button>
			}
		/>
	);
}

/** Always visible while looking at the past, so it is clear that edits are off. */
function HistoryBanner() {
	const only = isolatedUpload.value;
	if (only) {
		return (
			<BossBar
				color="purple"
				fill={1}
				title={
					<>
						Viewing isolated upload by <b>{only.authorName}</b> ·{" "}
						{formatEventTime(only)}
					</>
				}
				action="Show everything"
				onAction={() => {
					isolatedUpload.value = null;
				}}
			/>
		);
	}
	if (rev.value === null) return null;
	const head = currentMap.value?.map.headRev ?? 0;
	const current = effectiveRev.value;
	const r = revisionsData.value.find((x) => x.rev === current);
	return (
		<BossBar
			color="yellow"
			fill={head ? current / head : 0}
			title={
				r ? (
					<>
						Viewing <b>{formatEventTime(r)}</b> · #{current} by {r.authorName}{" "}
						(read-only)
					</>
				) : (
					<>
						Revision <b>{current}</b> of {head} (read-only)
					</>
				)
			}
			action="Back to latest"
			onAction={() => setRev(null)}
		/>
	);
}
