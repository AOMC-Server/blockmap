import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	blobFiles,
	jobs,
	storageHistory,
	tileVersions,
} from "../../src/db/schema";
import {
	bootTiles,
	call,
	cleanupTempDirs,
	RED,
	solid,
	T,
	type TileApp,
	upload,
} from "../helpers";

afterAll(cleanupTempDirs);

const URL = "/api/admin/storage/cleanup";

/** Plants a file in the blob directory under `<hash>.<suffix>`. */
function plant(t: TileApp, hash: string, suffix: string, ageMs = 0) {
	const dir = join(t.env.DATA_DIR, "blobs", hash.slice(0, 2), hash.slice(2, 4));
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${hash}.${suffix}`);
	writeFileSync(file, "data");
	const at = new Date(Date.now() - ageMs);
	utimesSync(file, at, at);
	return file;
}

describe("cleaning up unused images", () => {
	test("a job deletes what nothing refers to, with its copies, and keeps the rest", async () => {
		const t = await bootTiles({}, { owner: true });
		await upload(t, await solid(T, T, RED), 0, 0);
		const used = t.db
			.select({ hash: tileVersions.blobHash })
			.from(tileVersions)
			.get()?.hash as string;
		const usedCopy = plant(t, used, "png");
		const orphan = "a".repeat(64);
		const gone = [
			plant(t, orphan, "webp"),
			plant(t, orphan, "png"),
			plant(t, `${"b".repeat(64)}.123abc`, "tmp", 3600_000),
		];
		t.db.insert(blobFiles).values({ hash: orphan, bytes: 4 }).run();
		const points = () => t.db.select().from(storageHistory).all().length;
		const before = points();

		expect((await call(t, t.owner, "POST", URL)).status).toBe(202);
		await t.services.worker.run();

		for (const file of gone) expect(existsSync(file)).toBe(false);
		expect(existsSync(usedCopy)).toBe(true);
		expect(existsSync(t.services.blobs.path(used))).toBe(true);
		expect(
			t.db
				.select()
				.from(blobFiles)
				.all()
				.map((b) => b.hash),
		).not.toContain(orphan);
		expect(t.db.select().from(jobs).all().at(-1)?.status).toBe("done");
		expect(points()).toBe(before + 1);
		expect(t.db.select().from(storageHistory).all().at(-1)?.reason).toBe("gc");
	});

	test("owners only, and one at a time", async () => {
		const t = await bootTiles({}, { owner: true });
		expect((await call(t, null, "POST", URL)).status).toBe(401);
		expect((await call(t, t.editor, "POST", URL)).status).toBe(403);
		expect((await call(t, t.mod, "POST", URL)).status).toBe(403);
		expect((await call(t, t.owner, "POST", URL)).status).toBe(202);
		expect((await call(t, t.owner, "POST", URL)).status).toBe(409);
		await t.services.worker.run();
		expect((await call(t, t.owner, "POST", URL)).status).toBe(202);
		await t.services.worker.run();
	});
});
