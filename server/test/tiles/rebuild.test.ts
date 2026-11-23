import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createDb, runMigrations } from "../../src/db/client";
import {
	jobs,
	mapInfo,
	revisions,
	storageHistory,
	tileVersions,
	tileVersionsRebuild,
} from "../../src/db/schema";
import { messages, waitingMessage } from "../../src/jobs/messages";
import { queueRebuildIfPending } from "../../src/jobs/rebuildHistory";
import { SEQS_PER_MS } from "../../src/tiles/history";
import {
	BLUE,
	bootTiles,
	cleanupTempDirs,
	GREEN,
	makeTempDir,
	png,
	postUpload,
	RED,
	T,
	type TileApp,
	uploadMany,
} from "../helpers";

afterAll(cleanupTempDirs);

async function build() {
	const t = await bootTiles();
	const colors = [RED, GREEN, BLUE];
	for (const [i, day] of [10, 12, 11].entries()) {
		await uploadMany(t, [
			{
				data: await png(2 * T, T, () => colors[i] ?? RED),
				x: i * T,
				z: 0,
				path: `2026-02-${day}_10.00.00/a.png`,
			},
		]);
	}
	return t;
}

const rows = (t: TileApp) =>
	t.db
		.select()
		.from(tileVersions)
		.orderBy(
			asc(tileVersions.dimensionId),
			asc(tileVersions.zoom),
			asc(tileVersions.tileX),
			asc(tileVersions.tileY),
			asc(tileVersions.seq),
		)
		.all();

const map = (t: TileApp) =>
	t.db.select().from(mapInfo).get() as typeof mapInfo.$inferSelect;

const rebuildJob = (t: TileApp) =>
	t.db.select().from(jobs).where(eq(jobs.type, "rebuild_history")).get();

const rebuild = async (t: TileApp) => {
	t.db.update(mapInfo).set({ rebuildPending: true }).run();
	expect(queueRebuildIfPending(t.db)).toBe(true);
	await t.services.worker.run();
};

describe("rebuilding the history", () => {
	test("gives back the tile versions and revision numbers, bumping the epoch", async () => {
		const t = await build();
		const before = rows(t);
		const revs = t.db.select().from(revisions).orderBy(asc(revisions.id)).all();
		const epoch = map(t).epoch;
		t.db.delete(tileVersions).run();
		// Revision numbers that do not follow the export order.
		t.db.update(revisions).set({ rev: -1 }).where(eq(revisions.id, 1)).run();

		await rebuild(t);

		expect(rows(t)).toEqual(before);
		expect(
			t.db.select().from(revisions).orderBy(asc(revisions.id)).all(),
		).toEqual(revs);
		expect(map(t)).toMatchObject({
			headRev: 3,
			epoch: epoch + 1,
			rebuildPending: false,
			maintenance: false,
		});
		expect(t.db.select().from(tileVersionsRebuild).all()).toEqual([]);
		expect(rebuildJob(t)?.status).toBe("done");
		expect(t.db.select().from(storageHistory).all().at(-1)?.reason).toBe(
			"rebuild",
		);
	});

	test("is only queued when asked for, and once", async () => {
		const t = await build();
		expect(queueRebuildIfPending(t.db)).toBe(false);
		t.db.update(mapInfo).set({ rebuildPending: true }).run();
		expect(queueRebuildIfPending(t.db)).toBe(true);
		expect(queueRebuildIfPending(t.db)).toBe(false);
		await t.services.worker.run();
		expect(map(t).rebuildPending).toBe(false);
	});

	test("makes the map read only meanwhile, unless it already was", async () => {
		for (const already of [false, true]) {
			const t = await build();
			t.db.update(mapInfo).set({ maintenance: already }).run();
			const seen: boolean[] = [];
			t.services.events.subscribe("map", (m) => seen.push(m.maintenance));
			await rebuild(t);
			expect(seen[0]).toBe(true);
			expect(map(t).maintenance).toBe(already);
		}
	});

	test("a failed rebuild leaves history as it was", async () => {
		const t = await build();
		const before = rows(t);
		const { headRev, epoch } = map(t);
		// The patches can't be read any more.
		await rm(join(t.env.DATA_DIR, "blobs"), { recursive: true, force: true });
		await rebuild(t);
		expect(rows(t)).toEqual(before);
		expect(map(t)).toMatchObject({ headRev, epoch, maintenance: false });
		expect(t.db.select().from(tileVersionsRebuild).all()).toEqual([]);
		expect(rebuildJob(t)).toMatchObject({
			status: "failed",
			error: "internal error",
		});
	});

	test("an interrupted rebuild starts over on boot", async () => {
		const t = await build();
		t.db.update(mapInfo).set({ rebuildPending: true }).run();
		queueRebuildIfPending(t.db);
		t.db
			.update(jobs)
			.set({ status: "processing", attempts: 1 })
			.where(eq(jobs.type, "rebuild_history"))
			.run();
		t.services.worker.start();
		t.services.worker.stop();
		await t.services.worker.run();
		expect(rebuildJob(t)?.status).toBe("done");
	});
});

/** A database as of the migration before the one that orders history by seq. */
function legacyDb() {
	const dir = makeTempDir();
	const folder = join(dir, "migrations");
	cpSync(join(import.meta.dir, "../../src/db/migrations"), folder, {
		recursive: true,
	});
	const journalPath = join(folder, "meta/_journal.json");
	const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
		entries: { tag: string }[];
	};
	const at = journal.entries.findIndex((e) => e.tag === "0020_history_by_seq");
	expect(at).toBeGreaterThan(0);
	writeFileSync(
		journalPath,
		JSON.stringify({ ...journal, entries: journal.entries.slice(0, at) }),
	);
	const db = createDb(join(dir, "db.sqlite"));
	migrate(drizzle(db.$client), { migrationsFolder: folder });
	const sql = db.$client;
	sql.run(
		"INSERT INTO map_info (id, name, tile_size, head_rev, created_at) VALUES (1, 'm', 16, 4, 0)",
	);
	sql.run(
		"INSERT INTO users (id, username, created_at, last_login_at) VALUES ('u', 'u', 0, 0)",
	);
	for (const [id, slug] of [
		[1, "overworld"],
		[2, "nether"],
	] as const)
		sql.run(
			"INSERT INTO dimensions (id, slug, name, created_at) VALUES (?, ?, ?, 0)",
			[id, slug, slug],
		);
	return {
		db,
		/** An upload with its revision number, in dimension `dim`, exported at `at` (null: uploaded at `created`). */
		upload: (
			id: number,
			rev: number | null,
			dim: number,
			at: number | null,
			created = 0,
			status = "done",
		) =>
			sql.run(
				"INSERT INTO revisions (id, rev, kind, dimension_id, author_id, status, exported_at, created_at) VALUES (?, ?, 'upload', ?, 'u', ?, ?, ?)",
				[id, rev, dim, status, at, created],
			),
		/** A version of a tile, stored at the revision `rev`. */
		version: (zoom: number, rev: number, hash: string | null, dim = 1) =>
			sql.run(
				"INSERT INTO tile_versions (dimension_id, zoom, tile_x, tile_y, rev, blob_hash) VALUES (?, ?, 0, 0, ?, ?)",
				[dim, zoom, rev, hash],
			),
		link: (code: string, query: string) =>
			sql.run(
				"INSERT INTO short_links (code, query, created_at) VALUES (?, ?, 0)",
				[code, query],
			),
	};
}

describe("ordering history by seq (migration)", () => {
	test("uploads made in export order keep their numbers and versions, and need no rebuild", () => {
		const { db, upload, version, link } = legacyDb();
		upload(1, 1, 1, 1000);
		upload(2, 2, 2, 2000);
		upload(3, 3, 1, null, 3000);
		upload(4, null, 1, null, 4000, "failed");
		version(0, 1, "a");
		version(0, 3, "c");
		version(1, 1, "pa");
		version(0, 2, "n", 2);
		link("aaaaaaa", "dim=overworld&x=1&z=2&zoom=1&rev=3&layers=1");
		link("bbbbbbb", "dim=overworld&x=1&z=2&zoom=1&rev=0");
		link("ccccccc", "dim=overworld&x=1&z=2&zoom=1&rev=99");
		link("ddddddd", "dim=overworld&x=1&z=2&zoom=1");
		db.$client.run(
			"INSERT INTO jobs (type, payload, status, created_at) VALUES ('recompute_history', '{}', 'pending', 0)",
		);

		runMigrations(db);

		const seq = (ms: number) => ms * SEQS_PER_MS;
		expect(
			db
				.select({
					id: revisions.id,
					rev: revisions.rev,
					seq: revisions.seq,
				})
				.from(revisions)
				.orderBy(asc(revisions.id))
				.all(),
		).toEqual([
			{ id: 1, rev: 1, seq: seq(1000) },
			{ id: 2, rev: 2, seq: seq(2000) },
			{ id: 3, rev: 3, seq: seq(3000) },
			{ id: 4, rev: null, seq: null },
		]);
		expect(
			db
				.select({
					dim: tileVersions.dimensionId,
					zoom: tileVersions.zoom,
					seq: tileVersions.seq,
					hash: tileVersions.blobHash,
				})
				.from(tileVersions)
				.orderBy(asc(tileVersions.dimensionId), asc(tileVersions.seq))
				.all(),
		).toEqual([
			{ dim: 1, zoom: 0, seq: seq(1000), hash: "a" },
			{ dim: 1, zoom: 1, seq: seq(1000), hash: "pa" },
			{ dim: 1, zoom: 0, seq: seq(3000), hash: "c" },
			{ dim: 2, zoom: 0, seq: seq(2000), hash: "n" },
		]);
		const info = db.select().from(mapInfo).get();
		expect(info).toMatchObject({ headRev: 3, rebuildPending: false });
		expect(queueRebuildIfPending(db)).toBe(false);
		expect(db.select().from(jobs).all()).toEqual([]);
		expect(
			db.$client
				.query("SELECT query FROM short_links ORDER BY code")
				.all()
				.map((r) => (r as { query: string }).query),
		).toEqual([
			`dim=overworld&x=1&z=2&zoom=1&seq=${seq(3000)}&layers=1`,
			"dim=overworld&x=1&z=2&zoom=1&seq=-9007199254740991",
			`dim=overworld&x=1&z=2&zoom=1&seq=${seq(3000)}`,
			"dim=overworld&x=1&z=2&zoom=1",
		]);
	});

	test("late uploads are renumbered by export order and ask for a rebuild", () => {
		const { db, upload, version, link } = legacyDb();
		// Published as 1, 2, 3 but exported as 2nd, 3rd, 1st; the nether one is no late upload.
		upload(1, 1, 1, 2000);
		upload(2, 2, 1, 3000);
		upload(3, 3, 1, 1000);
		upload(4, 4, 2, 500);
		version(0, 3, "x");
		link("aaaaaaa", "dim=overworld&x=1&z=2&zoom=1&rev=1");

		runMigrations(db);

		expect(
			db
				.select({ id: revisions.id, rev: revisions.rev })
				.from(revisions)
				.orderBy(asc(revisions.seq))
				.all(),
		).toEqual([
			{ id: 4, rev: 1 },
			{ id: 3, rev: 2 },
			{ id: 1, rev: 3 },
			{ id: 2, rev: 4 },
		]);
		expect(db.select().from(mapInfo).get()).toMatchObject({
			headRev: 4,
			rebuildPending: true,
		});
		expect(db.select().from(tileVersions).get()?.seq).toBe(1000 * SEQS_PER_MS);
		// The link named revision 1, the upload with id 1.
		expect(
			(
				db.$client.query("SELECT query FROM short_links").get() as {
					query: string;
				}
			).query,
		).toBe(`dim=overworld&x=1&z=2&zoom=1&seq=${2000 * SEQS_PER_MS}`);
		expect(queueRebuildIfPending(db)).toBe(true);
	});

	test("uploads exported at the same time follow each other in publish order", () => {
		const { db, upload } = legacyDb();
		upload(1, 1, 1, 1000);
		upload(2, 2, 1, 1000);
		upload(3, 3, 1, 1000);
		runMigrations(db);
		expect(
			db
				.select({ rev: revisions.rev, seq: revisions.seq })
				.from(revisions)
				.orderBy(asc(revisions.rev))
				.all(),
		).toEqual([
			{ rev: 1, seq: 1000 * SEQS_PER_MS },
			{ rev: 2, seq: 1000 * SEQS_PER_MS + 1 },
			{ rev: 3, seq: 1000 * SEQS_PER_MS + 2 },
		]);
		expect(db.select().from(mapInfo).get()?.rebuildPending).toBe(false);
	});

	test("an upload whose delete was interrupted stays published, and failed ones get no place", () => {
		const { db, upload, version } = legacyDb();
		upload(1, 1, 1, 1000);
		// Old servers marked an upload "processing" while erasing it, keeping its number.
		upload(2, 2, 1, 2000, 0, "processing");
		upload(3, null, 1, 3000, 0, "failed");
		version(0, 2, "b");
		runMigrations(db);
		expect(
			db
				.select({
					id: revisions.id,
					rev: revisions.rev,
					seq: revisions.seq,
					status: revisions.status,
				})
				.from(revisions)
				.orderBy(asc(revisions.id))
				.all(),
		).toEqual([
			{ id: 1, rev: 1, seq: 1000 * SEQS_PER_MS, status: "done" },
			{ id: 2, rev: 2, seq: 2000 * SEQS_PER_MS, status: "done" },
			{ id: 3, rev: null, seq: null, status: "failed" },
		]);
		expect(db.select().from(tileVersions).get()?.seq).toBe(2000 * SEQS_PER_MS);
	});

	test("an empty database migrates", () => {
		const db = createDb(join(makeTempDir(), "db.sqlite"));
		runMigrations(db);
		db.$client.run(
			"INSERT INTO map_info (id, name, tile_size, created_at) VALUES (1, 'm', 16, 0)",
		);
		expect(queueRebuildIfPending(db)).toBe(false);
	});
});

describe("telling people what is going on", () => {
	test("progress messages read as sentences and say how far", async () => {
		const t = await bootTiles();
		const seen: { message?: string; done?: number; total?: number }[] = [];
		// The first revision of a new map is 1; the worker starts as soon as it is queued.
		t.services.events.subscribe("revision:1", (e) => {
			if (e.status !== "gone") seen.push(e);
		});
		const res = await postUpload(t, t.editor, [
			{ name: "a_x0_z0.png", data: await png(T, T, () => RED) },
		]);
		expect(((await res.json()) as { revisionId: number }).revisionId).toBe(1);
		await t.services.worker.run();
		const said = seen.map((e) => e.message);
		expect(said).toContain(messages.starting);
		expect(said).toContain(messages.upload.reading);
		expect(said).toContain(messages.upload.tiles);
		expect(said).toContain(messages.upload.zoom(1));
		expect(said).toContain(messages.upload.publishing);
		const zoom = seen.filter((e) => e.message === messages.upload.zoom(1));
		expect(zoom.at(-1)?.done).toBe(zoom.at(-1)?.total);
	});

	test("a queued upload says what it waits for, and again when that changes", async () => {
		const t = await build();
		t.db.update(mapInfo).set({ rebuildPending: true }).run();
		queueRebuildIfPending(t.db);
		const res = await postUpload(t, t.editor, [
			{ name: "b_x0_z0.png", data: await png(T, T, () => BLUE) },
		]);
		const { revisionId } = (await res.json()) as { revisionId: number };

		const events = await t.app.request(`/api/revisions/${revisionId}/events`);
		const reader = (events.body as ReadableStream).getReader();
		const first = new TextDecoder().decode((await reader.read()).value);
		expect(first).toContain("event: pending");
		expect(first).toContain("Waiting for the history rebuild to finish");
		await reader.cancel();
		await t.services.worker.run();
	});

	test("what a job waits for", () => {
		expect(waitingMessage([])).toBe(messages.starting);
		expect(
			waitingMessage([{ type: "rebuild_history", status: "processing" }]),
		).toBe("Waiting for the history rebuild to finish");
		expect(
			waitingMessage([
				{ type: "process_upload", status: "processing" },
				{ type: "erase_upload", status: "pending" },
			]),
		).toContain("Waiting for 2 jobs ahead of it");
		expect(
			waitingMessage([{ type: "process_upload", status: "pending" }]),
		).toContain("Waiting for 1 job ahead of it");
	});
});
