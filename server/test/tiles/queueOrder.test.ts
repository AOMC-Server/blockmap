import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { jobs, mapInfo, revisions } from "../../src/db/schema";
import { runOrder, waiting } from "../../src/jobs/queue";
import {
	BLUE,
	bootTiles,
	cleanupTempDirs,
	postUpload,
	RED,
	solid,
	T,
	type TileApp,
} from "../helpers";

afterAll(cleanupTempDirs);

const job = (
	id: number,
	type: string,
	exportedAt: number | null = null,
	status = "pending",
) => ({ id, type, status, exportedAt, createdAt: 1000 + id });

describe("run order", () => {
	test("uploads queued back to back run oldest export first", () => {
		const order = runOrder([
			job(1, "process_upload", 300),
			job(2, "process_upload", 100),
			job(3, "process_upload"),
			job(4, "process_upload", 200),
		]);
		expect(order.map((j) => j.id)).toEqual([2, 4, 1, 3]);
	});

	test("uploads never pass another kind of job, and the running one stays first", () => {
		const order = runOrder([
			job(1, "process_upload", 300),
			job(2, "process_upload", 100),
			job(3, "erase_upload"),
			job(4, "process_upload", 50),
			job(5, "gc_blobs", null, "processing"),
		]);
		expect(order.map((j) => j.id)).toEqual([5, 2, 1, 3, 4]);
	});
});

/** Queues an upload without running it. */
async function queue(t: TileApp, path: string, color = RED) {
	const res = await postUpload(
		t,
		t.editor,
		[{ name: "f.png", data: await solid(T, T, color) }],
		{
			coords: [{ x: 0, z: 0 }],
			paths: [path],
		},
	);
	expect(res.status).toBe(202);
	return ((await res.json()) as { revisionId: number }).revisionId;
}

describe("queue", () => {
	test("an older export queued behind a newer one is published first, without rewriting history", async () => {
		const t = await bootTiles();
		t.services.worker.kick = () => {};
		const newer = await queue(t, "2026-03-01_10.00.00/f.png", BLUE);
		const older = await queue(t, "2026-02-01_10.00.00/f.png");

		expect(waiting(t.db, older)).toBe("Starting");
		expect(waiting(t.db, newer)).toStartWith("Waiting for 1 job ");

		await t.services.worker.run();
		const revOf = (id: number) =>
			t.db
				.select({ rev: revisions.rev })
				.from(revisions)
				.where(eq(revisions.id, id))
				.get()?.rev;
		expect([revOf(older), revOf(newer)]).toEqual([1, 2]);
		// Going on top each time: had the newer one run first, the epoch would have moved.
		expect(t.db.select().from(mapInfo).get()).toMatchObject({
			headRev: 2,
			epoch: 0,
		});
		expect(
			t.db
				.select({ status: jobs.status })
				.from(jobs)
				.all()
				.map((j) => j.status),
		).toEqual(["done", "done"]);
	});
});
