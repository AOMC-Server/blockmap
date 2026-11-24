import { PopupText } from "@aomc-server/block-ui";
import { curveOf, resolveStyle } from "@blockmap/shared/featureStyle";
import { copyText } from "../clipboard";
import { mapView } from "../controller";
import { featureStats, featureTitle, TYPE_LABEL } from "../featureInfo";
import { passesFilter } from "../filter";
import { deleteFeature } from "../layers";
import { featureMapUrl, playerPageUrl } from "../players";
import {
	canEditMap,
	dimSlug,
	editor,
	embed,
	layerOfFeature,
	layersData,
	popup,
	view,
} from "../state";
import { dyeScope } from "../theme";
import { measureFrom } from "../tools/measure";
import { formatBlocks } from "../tools/measureMath";
import { featureHistoryFor } from "./FeatureHistory";
import { Banner } from "./icons";
import { PlayerHead, PlayerLink } from "./PlayerHead";
import { copyWaypoint } from "./shareCommon";

/** DOM popup for the clicked feature, anchored to the map position and following pans and zooms. */
export function Popup() {
	const p = popup.value;
	const mv = mapView.value;
	view.value; // re-render when the camera moves
	if (!p || !mv) return null;

	const listing = layerOfFeature(p.featureId, p.layerId);
	const feature = listing?.features.find((f) => f.id === p.featureId);
	if (!listing || !feature) return null;
	const home = layersData.value.find((l) => l.id === p.layerId);
	const layer = home ?? listing;
	const alsoIn = feature.alsoIn
		.map((id) => layersData.value.find((l) => l.id === id)?.name)
		.filter((n): n is string => !!n);

	const at = mv.blockToScreen(p.x, p.z);
	const size = mv.getSize();
	const left = Math.min(Math.max(at.x, 150), size.width - 150);
	const placeBelow = at.y < 190;
	const top = placeBelow
		? at.y + 14
		: at.y - (feature.type === "pin" ? 34 : 12);
	const dye = feature.color ?? layer.color;
	const editable = !!home && home.canEdit && canEditMap.value;
	const spot = p.at;
	const soleBuilderIsOwner =
		!!feature.owner &&
		feature.builders.length === 1 &&
		feature.builders[0]?.id === feature.owner.id;
	const stats = featureStats(
		feature,
		curveOf(
			resolveStyle(feature.style, feature.type === "polygon", layer.style),
		),
	);

	return (
		<div class="palette-scope" {...dyeScope(dye)}>
			<div
				class={`popup ${placeBelow ? "below" : ""}`}
				style={{ left: `${left}px`, top: `${top}px` }}
				role="dialog"
				aria-label={featureTitle(feature)}
			>
				<button
					type="button"
					class="btn small close popup-close"
					aria-label="Close"
					onClick={() => (popup.value = null)}
				>
					×
				</button>
				<h3 class={`dye-${dye}`}>
					<Banner dye={dye} />
					{featureTitle(feature)}
				</h3>
				<div class="popup-meta">
					<span class="popup-kind">
						{TYPE_LABEL[feature.type]} · {home ? home.name : "another layer"}
						{alsoIn.length > 0 && ` · also in ${alsoIn.join(", ")}`}
					</span>
					<button
						type="button"
						class="plain popup-coords"
						title="Copy coordinates (x, z)"
						onClick={() =>
							void copyText(
								`${spot.x}, ${spot.z}`,
								`Copied ${spot.x}, ${spot.z}`,
							)
						}
					>
						{spot.x}, {spot.z}
					</button>
				</div>
				{!passesFilter(feature) && (
					<p class="popup-note">Hidden by your filter</p>
				)}
				{(feature.owner || feature.builders.length > 0) && (
					<div class="popup-players">
						{feature.owner && (
							<span class="popup-owner">
								{soleBuilderIsOwner ? "Owned/built by" : "Owned by"}{" "}
								<PlayerLink player={feature.owner} newTab={embed.value} />
							</span>
						)}
						{feature.builders.length > 0 && !soleBuilderIsOwner && (
							<span class="popup-builders">
								Built by
								{feature.builders.map((b) => (
									<a
										key={b.id}
										class="popup-builder"
										href={playerPageUrl(b)}
										target={embed.value ? "_blank" : undefined}
										rel={embed.value ? "noopener" : undefined}
									>
										<PlayerHead player={b} size={20} />
									</a>
								))}
							</span>
						)}
					</div>
				)}
				{(stats.length !== undefined || stats.area !== undefined) && (
					<p class="popup-stats">
						{stats.length !== undefined && (
							<span>Length: {formatBlocks(stats.length)} blocks</span>
						)}
						{stats.perimeter !== undefined && (
							<span>Perimeter: {formatBlocks(stats.perimeter)} blocks</span>
						)}
						{stats.area !== undefined && (
							<span>Area: {formatBlocks(stats.area)} blocks²</span>
						)}
					</p>
				)}
				{feature.popup && <PopupText text={feature.popup} />}
				<div class="popup-footer">
					<div class="popup-actions">
						<button
							type="button"
							class="btn small"
							title="Copy a link that opens the map at this feature"
							onClick={() => {
								const dim = dimSlug.value;
								if (!dim) return;
								const url = featureMapUrl({
									id: feature.id,
									dimension: dim,
									center: [spot.x, spot.z],
								});
								void copyText(`${location.origin}${url}`, "Link copied");
							}}
						>
							Copy link
						</button>
						<button
							type="button"
							class="btn small"
							title="Copy as a Xaero's Minimap waypoint to paste in Minecraft chat"
							onClick={() =>
								copyWaypoint({ name: feature.name, ...spot, color: dye })
							}
						>
							Copy waypoint
						</button>
						{!embed.value && (
							<button
								type="button"
								class="btn small"
								title="Measure from here"
								onClick={() => {
									popup.value = null;
									measureFrom(spot);
								}}
							>
								Measure
							</button>
						)}
					</div>
					<div class="popup-actions">
						{editable && (
							<button
								type="button"
								class="btn small"
								onClick={() => {
									popup.value = null;
									editor.value = {
										mode: "edit",
										layerId: layer.id,
										featureId: feature.id,
									};
								}}
							>
								Edit
							</button>
						)}
						<button
							type="button"
							class="btn small"
							onClick={() => {
								featureHistoryFor.value = {
									featureId: feature.id,
									title: featureTitle(feature),
								};
							}}
						>
							History
						</button>
						{editable && (
							<button
								type="button"
								class="btn small danger"
								onClick={async () => {
									if (!confirm(`Delete "${featureTitle(feature)}"?`)) return;
									popup.value = null;
									await deleteFeature(feature.id);
								}}
							>
								Delete
							</button>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
