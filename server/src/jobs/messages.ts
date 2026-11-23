/** What a job tells the people waiting for it, in one place so the wording stays consistent. */
export const messages = {
	starting: "Starting",
	upload: {
		reading: "Reading uploaded images",
		tiles: "Building map tiles",
		merging: "Merging tiles into map history",
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
	rebuild: {
		tiles: (dimension: string) => `Rebuilding ${dimension}: map tiles`,
		zoom: (dimension: string, level: number) =>
			`Rebuilding ${dimension}: zoomed-out tiles (zoom level ${level})`,
		publishing: "Swapping in rebuilt history",
	},
	cleanup: {
		scanning: "Finding images in use",
		checking: "Checking stored images",
	},
	deleteDimension: {
		deleting: (dimension: string) =>
			`Deleting ${dimension}: uploads, tile history and layers`,
		files: "Removing leftover upload files",
	},
	/** The same step done once per batch of tiles, when there is more than one batch. */
	batch: (message: string, batch: number, batches: number) =>
		batches > 1 ? `${message} (batch ${batch} of ${batches})` : message,
	/** Facts about the work a running job does, shown beside its progress. */
	facts: {
		tilesTouched: (n: number) =>
			`${plural(n, "map tile", "map tiles")} touched`,
		images: (read: number, total: number) => `Images read: ${read} of ${total}`,
		emptyTiles: (n: number) =>
			`${plural(n, "tile was", "tiles were")} empty and skipped`,
		newerUploads: (uploads: number, tiles: number) =>
			`${plural(uploads, "newer upload", "newer uploads")} to lay over again, on ${plural(tiles, "tile", "tiles")}`,
		noNewerUploads: "Newest data here: nothing to lay over it",
		renumbered: (n: number) =>
			`${plural(n, "later upload", "later uploads")} to renumber`,
		uploads: (n: number) => `${plural(n, "upload", "uploads")} to replay`,
		dimension: (name: string, at: number, of: number) =>
			`Dimension ${at} of ${of}: ${name}`,
		versionsMade: (n: number) =>
			`${plural(n, "tile image", "tile images")} made so far`,
		versionsWritten: (n: number) =>
			`${plural(n, "tile version", "tile versions")} written`,
		inUse: (n: number) => `${plural(n, "image", "images")} in use`,
		deleted: (n: number, bytes: number) =>
			`${plural(n, "file", "files")} deleted (${formatSize(bytes)})`,
		layers: (n: number) => plural(n, "layer", "layers"),
		uploadCount: (n: number) => plural(n, "upload", "uploads"),
	},
};

function formatSize(bytes: number): string {
	const units = ["B", "KB", "MB", "GB", "TB"];
	let n = bytes;
	let u = 0;
	while (n >= 1024 && u < units.length - 1) {
		n /= 1024;
		u++;
	}
	return `${u === 0 ? n : n.toFixed(1)} ${units[u]}`;
}

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
