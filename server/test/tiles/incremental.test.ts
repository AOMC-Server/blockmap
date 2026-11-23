import { afterAll, describe, expect, test } from "bun:test";
import { and, asc, eq, gt } from "drizzle-orm";
import { createLimiter } from "../../src/concurrency";
import { tileVersions } from "../../src/db/schema";
import type { QueueEvent } from "../../src/events";
import { messages } from "../../src/jobs/messages";
import { overRegion } from "../../src/tiles/compose";
import {
	BLUE,
	bootTiles,
	cleanupTempDirs,
	RED,
	solid,
	T,
	uploadFrom,
} from "../helpers";

afterAll(cleanupTempDirs);

describe("limiter", () => {
	test("keeps at most `limit` tasks running, and hands each back once it has started", async () => {
		const limiter = createLimiter(2);
		let running = 0;
		let most = 0;
		const finish: (() => void)[] = [];
		const task = () =>
			new Promise<void>((resolve) => {
				running++;
				most = Math.max(most, running);
				finish.push(() => {
					running--;
					resolve();
				});
			});
		const a = await limiter.start(task);
		const b = await limiter.start(task);
		let third = false;
		const c = limiter.start(task).then((started) => {
			third = true;
			return started;
		});
		await Bun.sleep(1);
		expect(third).toBe(false);
		finish.shift()?.();
		await a.done;
		const started = await c;
		expect(third).toBe(true);
		for (const f of finish.splice(0)) f();
		await Promise.all([b.done, started.done]);
		expect(most).toBe(2);
	});

	test("a failed task fails whoever waits for it, and frees its slot", async () => {
		const limiter = createLimiter(1);
		const { done } = await limiter.start(async () => {
			throw new Error("broken");
		});
		expect(done).rejects.toThrow("broken");
		const next = await limiter.start(async () => 1);
		expect(await next.done).toBe(1);
	});
});

describe("overRegion", () => {
	test("says whether it changed anything", () => {
		const dst = Buffer.from([10, 20, 30, 255, 0, 0, 0, 0]);
		expect(overRegion(dst, 2, Buffer.from([10, 20, 30, 255]), 1, 1, 0, 0)).toBe(
			false,
		);
		expect(overRegion(dst, 2, Buffer.from([1, 2, 3, 0]), 1, 1, 1, 0)).toBe(
			false,
		);
		expect(overRegion(dst, 2, Buffer.from([1, 2, 3, 255]), 1, 1, 1, 0)).toBe(
			true,
		);
		expect([...dst]).toEqual([10, 20, 30, 255, 1, 2, 3, 255]);
	});
});

describe("putting an upload under newer ones", () => {
	test("keeps what a newer upload covered, and only makes the images that are new", async () => {
		const t = await bootTiles();
		await uploadFrom(
			t,
			await solid(T, T, BLUE),
			0,
			0,
			"2026-03-01_10.00.00/a.png",
		);
		const later = () =>
			t.db
				.select({
					zoom: tileVersions.zoom,
					seq: tileVersions.seq,
					hash: tileVersions.blobHash,
				})
				.from(tileVersions)
				.orderBy(asc(tileVersions.zoom), asc(tileVersions.seq))
				.all();
		const before = later();

		const facts = new Set<string>();
		t.services.events.subscribe("queue", (q: QueueEvent) => {
			for (const f of q.running?.progress?.facts ?? []) facts.add(f);
		});
		// Older, and covered all over by the newer one.
		await uploadFrom(
			t,
			await solid(T, T, RED),
			0,
			0,
			"2026-02-01_10.00.00/b.png",
		);

		// The newer upload's versions are untouched; the older one only adds its own, before them.
		const after = later();
		expect(after.filter((r) => before.some((b) => b.seq === r.seq))).toEqual(
			before,
		);
		const added = after.filter((r) => !before.some((b) => b.seq === r.seq));
		expect(added.map((r) => r.zoom)).toEqual([0, 1, 2, 3]);
		// One new image per zoom level (zoom 0 is the uploaded patch itself); nothing else is
		// made again.
		expect(facts).toContain(messages.facts.versionsMade(3));
		expect(facts).not.toContain(messages.facts.versionsMade(4));
		expect(
			t.db
				.select()
				.from(tileVersions)
				.where(
					and(
						eq(tileVersions.zoom, 0),
						gt(tileVersions.seq, added[0]?.seq ?? 0),
					),
				)
				.all(),
		).toHaveLength(1);
	});
});
