/** What a job tells the people waiting for it, in one place so the wording stays consistent. */
export const messages = {
	starting: "Starting",
	upload: {
		reading: "Reading the uploaded images",
		tiles: "Combining the images into map tiles",
		zoom: (level: number) => `Updating zoomed-out tiles (zoom level ${level})`,
		publishing: "Publishing to the map",
	},
	failed: {
		unreadableImage: (x: number, z: number) =>
			`An image could not be read (at x ${x}, z ${z}). Export it again and upload it again.`,
		interrupted:
			"The server restarted while processing this upload. Upload it again.",
		internal:
			"Something went wrong on the server. Try again, and tell a moderator if it keeps happening.",
	},
	erase: {
		tiles: "Removing the upload from the history of its tiles",
		zoom: (level: number) =>
			`Rebuilding zoomed-out tiles (zoom level ${level})`,
		publishing: "Publishing the changes",
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
		return "Waiting for the image cleanup to finish";
	if (running?.type === "delete_dimension")
		return "Waiting for a dimension to be deleted";
	return `Waiting for ${plural(ahead.length, "job", "jobs")} ahead of it (uploads, deletions, history rebuilds, image cleanups and dimension deletions run one at a time)`;
}
