import { readdir, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { MINUTE } from "@blockmap/shared";
import { inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { blobFiles } from "../db/schema";
import { messages } from "../jobs/messages";
import { noProgress, type Progress } from "../jobs/report";
import { referencedBlobs } from "../storage";
import { classifyBlobFile } from "./blobstore";

/**
 * Deletes the files of the blob directory that no tile version and no upload patch points to
 * (left behind by failed jobs and deleted uploads): stored tiles, their copies in other formats
 * and unfinished writes. Forgets the recorded size of the deleted tiles.
 *
 * Only safe while nothing else writes blobs, which holds inside a worker job: jobs run one at a
 * time and are the only writers.
 */
export async function cleanupBlobs(
	db: Db,
	blobsDir: string,
	progress: Progress = noProgress,
): Promise<{ deleted: number; bytes: number }> {
	progress.steps(2);
	progress.step(messages.cleanup.scanning);
	const referenced = referencedBlobs(db.$client);
	progress.fact("inUse", messages.facts.inUse(referenced.size));
	let deleted = 0;
	let bytes = 0;
	const forgotten: string[] = [];
	const names = await readdir(blobsDir, { recursive: true }).catch(() => []);
	progress.step(messages.cleanup.checking, {
		total: names.length,
		unit: "files",
	});
	let checked = 0;
	for (const rel of names) {
		progress.advance(checked++);
		const file = classifyBlobFile(basename(rel));
		if (!file || (file.kind !== "temp" && referenced.has(file.hash as string)))
			continue;
		const path = join(blobsDir, rel);
		const info = await stat(path);
		// A conversion for an API client may be writing this one right now.
		if (file.kind === "temp" && Date.now() - info.mtimeMs < MINUTE) continue;
		bytes += info.size;
		await rm(path, { force: true });
		deleted++;
		progress.fact("deleted", messages.facts.deleted(deleted, bytes));
		if (file.kind === "blob") forgotten.push(file.hash as string);
	}
	progress.advance(names.length);
	for (let i = 0; i < forgotten.length; i += 500)
		db.delete(blobFiles)
			.where(inArray(blobFiles.hash, forgotten.slice(i, i + 500)))
			.run();
	return { deleted, bytes };
}
