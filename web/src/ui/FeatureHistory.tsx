import { Modal } from "@aomc-server/block-ui";
import { formatTime } from "@aomc-server/block-ui/format";
import { signal } from "@preact/signals";
import { useEffect, useState } from "preact/hooks";
import { dyeLabel, pointsOf, TYPE_LABEL } from "../featureInfo";
import { alsoInChange } from "../featureLayers";
import { type AttributionChange, attributionChange } from "../players";
import {
	type FeatureHistoryEntry,
	loadFeatureHistory,
	restoreFeatureRevision,
} from "../revisions";
import { isModerator, layersData, popup, readOnly } from "../state";
import { PlayerHead } from "./PlayerHead";

/** The feature whose revision list is open. */
export const featureHistoryFor = signal<{
	featureId: number;
	title: string;
} | null>(null);

const close = () => {
	featureHistoryFor.value = null;
};

function summary(e: FeatureHistoryEntry): string {
	const points = pointsOf(e);
	const first = points[0];
	const where =
		e.type === "pin" && first
			? `at ${first[0]}, ${first[1]}`
			: `${new Set(points.map(String)).size} points`;
	const color = e.color ? `, ${dyeLabel(e.color)}` : "";
	return `${TYPE_LABEL[e.type]} "${e.name || "unnamed"}" ${where}${color}`;
}

/** "Moved to …" when the entry put the feature in another layer than the one before it. */
function moved(e: FeatureHistoryEntry, older: FeatureHistoryEntry | undefined) {
	if (!older || older.layerId === e.layerId) return null;
	// Names of layers the user cannot see are not known to the client.
	const name = layersData.value.find((l) => l.id === e.layerId)?.name;
	return name ? `Moved to ${name}` : "Moved to another layer";
}

/** "Added to …" / "Removed from …" lines for the layers an entry changed. */
function layerNotes(
	e: FeatureHistoryEntry,
	older: FeatureHistoryEntry | undefined,
) {
	const change = alsoInChange(older?.alsoIn, e.alsoIn);
	if (!change) return [];
	const name = (id: number) =>
		`“${layersData.value.find((l) => l.id === id)?.name ?? "another layer"}”`;
	return [
		...change.added.map((id) => `Added to ${name(id)}`),
		...change.removed.map((id) => `Removed from ${name(id)}`),
	];
}

function PlayerName(props: { player: { id: number; name: string } }) {
	return (
		<span class="fh-player">
			<PlayerHead player={props.player} size={16} /> {props.player.name}
		</span>
	);
}

/** Who the feature is attributed to differently than in the version before. */
function AttributionNote(props: { change: AttributionChange }) {
	const { owner, added, removed } = props.change;
	return (
		<>
			{owner && (
				<div class="muted">
					{owner.from && owner.to
						? "Owner: "
						: owner.to
							? "Owner set: "
							: "Owner removed: "}
					{owner.from && <PlayerName player={owner.from} />}
					{owner.from && owner.to && " → "}
					{owner.to && <PlayerName player={owner.to} />}
				</div>
			)}
			{(added.length > 0 || removed.length > 0) && (
				<div class="muted">
					Builders:{" "}
					{[
						...added.map((p) => (
							<span key={`+${p.id}`} class="fh-added">
								+<PlayerName player={p} />
							</span>
						)),
						...removed.map((p) => (
							<span key={`-${p.id}`} class="fh-removed">
								−<PlayerName player={p} />
							</span>
						)),
					].flatMap((el, i) => (i === 0 ? [el] : [", ", el]))}
				</div>
			)}
		</>
	);
}

/** Revision list of one feature. Moderators can make an old version current again. */
export function FeatureHistory() {
	const target = featureHistoryFor.value;
	const [entries, setEntries] = useState<FeatureHistoryEntry[] | null>(null);
	const [failed, setFailed] = useState(false);
	const [busy, setBusy] = useState(false);
	const [nextBefore, setNextBefore] = useState<number | null>(null);
	const [loadingMore, setLoadingMore] = useState(false);
	const featureId = target?.featureId;

	useEffect(() => {
		if (featureId === undefined) return;
		setEntries(null);
		setFailed(false);
		setNextBefore(null);
		void loadFeatureHistory(featureId).then((page) => {
			setEntries(page?.history ?? null);
			setNextBefore(page?.nextBefore ?? null);
			setFailed(page === null);
		});
	}, [featureId]);

	if (!target) return null;

	const loadOlder = async () => {
		if (nextBefore === null || loadingMore) return;
		setLoadingMore(true);
		try {
			const page = await loadFeatureHistory(target.featureId, nextBefore);
			if (!page) return;
			setEntries((prev) => [...(prev ?? []), ...page.history]);
			setNextBefore(page.nextBefore);
		} finally {
			setLoadingMore(false);
		}
	};

	/** The change of attribution an entry made, once the version before it is known. */
	const attributionNote = (i: number) => {
		const e = entries?.[i];
		if (!e || e.deleted) return null;
		const older = entries?.[i + 1];
		if (!older && nextBefore !== null) return null;
		const change = attributionChange(older ?? null, e);
		return change && <AttributionNote change={change} />;
	};

	const restore = async (e: FeatureHistoryEntry) => {
		const what = e.deleted ? "the deleted state" : "this version";
		if (!confirm(`Restore ${what} from ${formatTime(e.createdAt)}?`)) return;
		setBusy(true);
		let ok = false;
		try {
			ok = await restoreFeatureRevision(target.featureId, e.revisionId);
		} finally {
			setBusy(false);
		}
		if (ok) {
			close();
			popup.value = null;
		}
	};

	return (
		<Modal title={`History: ${target.title}`} onClose={close}>
			{entries === null && !failed && <p class="muted">Loading…</p>}
			{failed && <p class="error-text">Failed to load history.</p>}
			<ul class="feature-history">
				{entries?.map((e, i) => (
					<li key={e.revisionId} class={e.deleted ? "deleted" : ""}>
						<div class="fh-main">
							<div>
								{e.deleted ? (
									<b>Deleted</b>
								) : i === entries.length - 1 && nextBefore === null ? (
									<b>Created</b>
								) : (
									<b>Edited</b>
								)}
								{i === 0 && <span class="badge">current</span>}
							</div>
							{moved(e, entries[i + 1]) && (
								<div class="muted">{moved(e, entries[i + 1])}</div>
							)}
							{layerNotes(e, entries[i + 1]).map((note) => (
								<div key={note} class="muted">
									{note}
								</div>
							))}
							<div class="muted">{summary(e)}</div>
							{attributionNote(i)}
							<div class="muted">
								{e.authorName} · {formatTime(e.createdAt)}
							</div>
						</div>
						{isModerator.value && !readOnly.value && i > 0 && (
							<button
								type="button"
								class="btn small"
								disabled={busy}
								onClick={() => restore(e)}
							>
								Restore
							</button>
						)}
					</li>
				))}
			</ul>
			{nextBefore !== null && (
				<button
					type="button"
					class="btn small"
					disabled={loadingMore}
					onClick={loadOlder}
				>
					{loadingMore ? "Loading…" : "Load older"}
				</button>
			)}
			{!isModerator.value && entries && (
				<p class="muted">Only moderators can restore earlier versions.</p>
			)}
			{isModerator.value && readOnly.value && entries && (
				<p class="muted">
					Earlier versions cannot be restored while the map is in maintenance
					mode.
				</p>
			)}
		</Modal>
	);
}
