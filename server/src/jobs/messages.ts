/** What a job tells the people waiting for it, in one place so the wording stays consistent. */
export const messages = {
	starting: "Starting",
	upload: {
		reading: "Reading uploaded images",
		tiles: "Building map tiles",
		zoom: (level: number) => `Updating zoomed-out tiles (zoom level ${level})`,
		publishing: "Publishing to map",
	},
	failed: {
		unreadableImage: (x: number, z: number) =>
			`Could not read image at x ${x}, z ${z}. Try exporting and uploading it again.`,
		interrupted:
			"Server restarted while processing this upload. Please upload it again.",
		internal:
			"Internal server error while processing. Please try again, or contact a moderator if the issue persists.",
	},
	erase: {
		tiles: "Removing upload from tile history",
		zoom: (level: number) =>
			`Rebuilding zoomed-out tiles (zoom level ${level})`,
		publishing: "Saving changes",
	},
};

const plural = (n: number, one: string, many: string) =>
	`${n} ${n === 1 ? one : many}`;

/**
 * Why a queued job has not started: the history rebuild that is running, or the jobs ahead of
 * it. `ahead` are the unfinished jobs queued before it, oldest first.
 */
export function waitingMessage(
	ahead: { type: string; status: string }[],
): string {
	if (ahead.length === 0) return messages.starting;
	const running = ahead.find((j) => j.status === "processing") ?? ahead[0];
	if (running?.type === "rebuild_history")
		return "Waiting for the history rebuild to finish";
	if (running?.type === "gc_blobs")
		return "Waiting for image cleanup to finish";
	if (running?.type === "delete_dimension")
		return "Waiting for dimension deletion to finish";
	return `Waiting for ${plural(ahead.length, "job", "jobs")} ahead of it`;
}
