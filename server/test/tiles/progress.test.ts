import { afterAll, describe, expect, test } from "bun:test";
import { jobs, mapInfo } from "../../src/db/schema";
import type { JobProgress, QueueEvent } from "../../src/events";
import { messages } from "../../src/jobs/messages";
import { queueRebuildIfPending } from "../../src/jobs/rebuildHistory";
import { createProgress, progressEvent } from "../../src/jobs/report";
import { revisionSnapshot } from "../../src/topics";
import {
	BLUE,
	bootTiles,
	call,
	cleanupTempDirs,
	erase,
	RED,
	solid,
	T,
	type TileApp,
	uploadFrom,
} from "../helpers";

afterAll(cleanupTempDirs);

describe("progress reporter", () => {
	test("numbers steps, counts within them, tells the rate and keeps facts in order", () => {
		let t = 0;
		const sent: JobProgress[] = [];
		const p = createProgress((e) => sent.push(e), { ms: 100, now: () => t });
		p.steps(3);
		p.fact("a", "first");
		p.step("Reading", { total: 10, unit: "images" });
		expect(sent.at(-1)).toEqual({
			step: 1,
			steps: 3,
			message: "Reading",
			done: 0,
			total: 10,
			unit: "images",
			facts: ["first"],
			startedAt: 0,
		});

		// Counting is throttled; the last of a step always goes out.
		const before = sent.length;
		t = 10;
		p.advance(1);
		expect(sent.length).toBe(before);
		t = 2000;
		p.advance(4);
		expect(sent.at(-1)).toMatchObject({ done: 4, rate: 2 });
		p.fact("b", "second");
		p.fact("a", "first, again");
		p.advance(10);
		expect(sent.at(-1)).toMatchObject({
			done: 10,
			facts: ["first, again", "second"],
		});

		// A step can be skipped to; one past the count raises it.
		p.step("Publishing", { at: 4 });
		expect(sent.at(-1)).toMatchObject({ step: 4, steps: 4 });
		expect(sent.at(-1)).not.toHaveProperty("done");
	});

	test("a running revision's snapshot is its last progress, as it was sent", () => {
		const progress: JobProgress = {
			step: 2,
			steps: 5,
			message: "Building map tiles",
			done: 3,
			total: 8,
			facts: [],
			startedAt: 1,
		};
		const t = { db: null as never };
		expect(
			revisionSnapshot(t.db, 7, { jobId: 1, revisionId: 7, progress }),
		).toEqual(progressEvent(progress));
	});
});

/** Every progress the queue told while `run` ran. */
async function queueProgress(t: TileApp, run: () => Promise<unknown>) {
	const seen: JobProgress[] = [];
	const stop = t.services.events.subscribe("queue", (q: QueueEvent) => {
		if (q.running?.progress) seen.push(q.running.progress);
	});
	await run();
	stop();
	return seen;
}

const facts = (seen: JobProgress[]) => new Set(seen.flatMap((p) => p.facts));
const said = (seen: JobProgress[]) => seen.map((p) => p.message);

describe("what jobs say they are doing", () => {
	test("an older export put under a newer one says what it lays over again", async () => {
		const t = await bootTiles();
		await uploadFrom(
			t,
			await solid(T, T, BLUE),
			0,
			0,
			"2026-03-01_10.00.00/a.png",
		);
		const red = await solid(T, T, RED);
		const seen = await queueProgress(t, () =>
			uploadFrom(t, red, 0, 0, "2026-02-01_10.00.00/b.png"),
		);
		expect(facts(seen)).toContain(messages.facts.newerUploads(1, 1));
		expect(said(seen)).toContain(messages.upload.merging);
		const steps = seen.map((p) => p.step);
		expect(steps).toEqual([...steps].sort((a, b) => a - b));
	});

	test("a delete says how many tiles and later uploads it touches", async () => {
		const t = await bootTiles();
		const first = await uploadFrom(
			t,
			await solid(T, T, RED),
			0,
			0,
			"2026-02-01_10.00.00/a.png",
		);
		await uploadFrom(
			t,
			await solid(T, T, BLUE),
			0,
			0,
			"2026-03-01_10.00.00/b.png",
		);
		const seen = await queueProgress(t, () => erase(t, first));
		expect(facts(seen)).toContain(messages.facts.tilesTouched(1));
		expect(facts(seen)).toContain(messages.facts.newerUploads(1, 1));
		expect(facts(seen)).toContain(messages.facts.renumbered(1));
		expect(said(seen).at(-1)).toBe(messages.erase.publishing);
	});

	test("a history rebuild goes through each dimension", async () => {
		const t = await bootTiles();
		await uploadFrom(
			t,
			await solid(T, T, RED),
			0,
			0,
			"2026-02-01_10.00.00/a.png",
		);
		t.db.update(mapInfo).set({ rebuildPending: true }).run();
		queueRebuildIfPending(t.db);
		const seen = await queueProgress(t, () => t.services.worker.run());
		expect(said(seen)).toContain(messages.rebuild.tiles("Overworld"));
		expect(facts(seen)).toContain(messages.facts.uploads(1));
		expect(said(seen).at(-1)).toBe(messages.rebuild.publishing);
	});

	test("an image cleanup counts what it checks and deletes", async () => {
		const t = await bootTiles({}, { owner: true });
		const id = await uploadFrom(
			t,
			await solid(T, T, RED),
			0,
			0,
			"2026-02-01_10.00.00/a.png",
		);
		await erase(t, id);
		t.db.insert(jobs).values({ type: "gc_blobs", payload: {} }).run();
		const seen = await queueProgress(t, () => t.services.worker.run());
		expect(said(seen)).toEqual(
			expect.arrayContaining([
				messages.cleanup.scanning,
				messages.cleanup.checking,
			]),
		);
		const last = seen.at(-1);
		expect(last?.done).toBe(last?.total);
		expect([...facts(seen)].some((f) => f.includes("deleted"))).toBe(true);
	});

	test("a dimension deletion names the dimension", async () => {
		const t = await bootTiles({}, { owner: true });
		await call(t, t.mod, "PATCH", "/api/dimensions/nether", { archived: true });
		t.services.worker.kick = () => {};
		expect(
			(await call(t, t.owner, "DELETE", "/api/dimensions/nether")).status,
		).toBe(202);
		const seen = await queueProgress(t, () => t.services.worker.run());
		expect(said(seen)[0]).toBe(messages.deleteDimension.deleting("Nether"));
	});
});
