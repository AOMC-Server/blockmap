import { copyText } from "@aomc-server/block-ui";
import type { Dye } from "@blockmap/shared/colors";
import { currentMap, dimSlug } from "../state";
import { xaeroWaypoint } from "../waypoint";

/** Copies a Xaero's Minimap waypoint for a block of the dimension being viewed. */
export function copyWaypoint(w: {
	name: string;
	x: number;
	z: number;
	color: Dye;
}) {
	const dim = currentMap.value?.dimensions.find(
		(d) => d.slug === dimSlug.value,
	);
	if (!dim) return;
	void copyText(
		xaeroWaypoint({ ...w, dimension: dim.xaeroDimension }),
		"Waypoint copied. Paste in Minecraft chat to share.",
	);
}
