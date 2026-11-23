import { Modal } from "@aomc-server/block-ui";
import { formatTime } from "@aomc-server/block-ui/format";
import { signal } from "@preact/signals";
import { mapView } from "../controller";
import { deleteUpload } from "../revisions";
import { highlightedUpload, type RevisionInfo, user } from "../state";

/** The upload whose delete is being confirmed. */
export const deleteUploadFor = signal<RevisionInfo | null>(null);

const close = () => {
	deleteUploadFor.value = null;
	highlightedUpload.value = null;
};

/** Asks before deleting an upload for good, with what it is and where. */
export function DeleteUploadDialog() {
	const r = deleteUploadFor.value;
	if (!r) return null;
	const failed = r.status === "failed";
	const own = r.authorId === user.value?.id;
	const box = r.bbox;

	return (
		<Modal title="Delete upload" onClose={close}>
			<dl class="delete-facts">
				<dt>By</dt>
				<dd>{own ? `${r.authorName} (you)` : r.authorName}</dd>
				{r.exportedAt !== null && (
					<>
						<dt>Exported</dt>
						<dd>{formatTime(r.exportedAt)}</dd>
					</>
				)}
				<dt>Uploaded</dt>
				<dd>{formatTime(r.createdAt)}</dd>
				<dt>Files</dt>
				<dd>{r.fileCount}</dd>
				{box && (
					<>
						<dt>Area</dt>
						<dd>
							{box.maxX - box.minX + 1} × {box.maxZ - box.minZ + 1} blocks, from{" "}
							{box.minX}, {box.minZ}
						</dd>
					</>
				)}
				{r.rev !== null && (
					<>
						<dt>Revision</dt>
						<dd>#{r.rev}</dd>
					</>
				)}
			</dl>
			<p class={failed ? "muted" : "warn-text"}>
				{failed
					? "This upload failed to process, so it hasn't affected the map. Deleting it removes it from the log."
					: "This will permanently remove the upload from the map and all past revisions. To restore it later, you'll need to upload the files again."}
			</p>
			<div class="modal-actions">
				<button
					type="button"
					class="btn danger"
					onClick={() => {
						close();
						void deleteUpload(r.id);
					}}
				>
					Delete permanently
				</button>
				{box && (
					<button
						type="button"
						class="btn"
						onClick={() => {
							highlightedUpload.value = r;
							mapView.value?.fitBounds(box, { padding: 120, closestZoom: 0 });
						}}
					>
						Show area
					</button>
				)}
				<span class="spacer" />
				<button type="button" class="btn" onClick={close}>
					Cancel
				</button>
			</div>
		</Modal>
	);
}
