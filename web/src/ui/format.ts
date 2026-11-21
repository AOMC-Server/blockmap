import {
	formatDay,
	formatBytes as formatSize,
	formatTime,
} from "@aomc-server/block-ui/format";

/** A size with the "KB" / "MB" labels (still binary) the app has always shown. */
export const formatBytes = (bytes: number): string => formatSize(bytes, "kb");

type Upload = { exportedAt: number | null; createdAt: number };

/** When an upload was made: its export time, or else when it was uploaded. */
export const formatEventTime = (r: Upload): string =>
	formatTime(r.exportedAt ?? r.createdAt);

/** The day an upload was made, as a heading for the upload log. */
export const formatEventDay = (r: Upload): string =>
	formatDay(r.exportedAt ?? r.createdAt);
