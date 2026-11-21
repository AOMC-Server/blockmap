import { formatDay, formatTime } from "@aomc-server/block-ui/format";

type Upload = { exportedAt: number | null; createdAt: number };

/** When an upload was made: its export time, or else when it was uploaded. */
export const formatEventTime = (r: Upload): string =>
	formatTime(r.exportedAt ?? r.createdAt);

/** The day an upload was made, as a heading for the upload log. */
export const formatEventDay = (r: Upload): string =>
	formatDay(r.exportedAt ?? r.createdAt);
