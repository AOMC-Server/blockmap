import { readdir, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { MINUTE } from "@blockmap/shared";
import { inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { blobFiles } from "../db/schema";
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
): Promise<{ deleted: number; bytes: number }> {
	const referenced = referencedBlobs(db.$client);
	let deleted = 0;
	let bytes = 0;
	const forgotten: string[] = [];
	const names = await readdir(blobsDir, { recursive: true }).catch(() => []);
	for (const rel of names) {
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
		if (file.kind === "blob") forgotten.push(file.hash as string);
	}
	for (let i = 0; i < forgotten.length; i += 500)
		db.delete(blobFiles)
			.where(inArray(blobFiles.hash, forgotten.slice(i, i + 500)))
			.run();
	return { deleted, bytes };
}
