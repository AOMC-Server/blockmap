import { afterAll, describe, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import {
	featureRevisions,
	layers,
	mapInfo,
	revisions,
	tileVersions,
} from "../../src/db/schema";
import { timeOfRev } from "../../src/features";
import { SEQS_PER_MS } from "../../src/tiles/history";
import {
	BLACK,
	BLUE,
	bootTiles,
	call,
	cleanupTempDirs,
	erase,
	GREEN,
	png,
	RED,
	readTile,
	T,
	type TileApp,
	uploadMany,
} from "../helpers";

afterAll(cleanupTempDirs);

type Export = {
	path: string;
	dim: string;
	x: number;
	z: number;
	data: () => Promise<Buffer>;
};

/** Overlapping exports (partly black, so the order they are stacked in matters), oldest first. */
const EXPORTS: Record<string, Export> = {
	n: {
		path: "2026-02-09_10.00.00/n.png",
		dim: "nether",
		x: 3 * T,
		z: -T,
		data: () => png(T, T, () => RED),
	},
	a: {
		path: "2026-02-10_10.00.00/a.png",
		dim: "overworld",
		x: 0,
		z: 0,
		data: () => png(2 * T, T, () => RED),
	},
	c: {
		path: "2026-02-11_10.00.00/c.png",
		dim: "overworld",
		x: 0,
		z: 0,
		data: () => png(2 * T, 2 * T, (_, y) => (y % 2 ? BLACK : GREEN)),
	},
	b: {
		path: "2026-02-12_10.00.00/b.png",
		dim: "overworld",
		x: 0,
		z: 0,
		data: () => png(T, T, (x) => (x < T / 2 ? BLACK : BLUE)),
	},
};
const ORDER = Object.keys(EXPORTS);

async function build(names: string[]) {
	const t = await bootTiles();
	const ids: Record<string, number> = {};
	for (const name of names) {
		const e = EXPORTS[name] as Export;
		ids[name] = await uploadMany(
			t,
			[{ data: await e.data(), x: e.x, z: e.z, path: e.path }],
			t.editor,
			e.dim,
		);
	}
	return { t, ids };
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

/** (revision id, rev, seq) of every upload, in rev order. */
const revs = (t: TileApp) =>
	t.db
		.select({ id: revisions.id, rev: revisions.rev, seq: revisions.seq })
		.from(revisions)
		.orderBy(asc(revisions.rev))
		.all();

const map = (t: TileApp) =>
	t.db.select().from(mapInfo).get() as typeof mapInfo.$inferSelect;

/** The overworld at every zoom as of `rev`, for comparing two maps. */
async function snapshot(t: TileApp, rev?: number) {
	const out: Record<string, number[] | null> = {};
	for (let zoom = 0; zoom <= 3; zoom++) {
		for (let y = -1; y <= 2; y++) {
			for (let x = -1; x <= 2; x++) {
				const tile = await readTile(t, zoom, x, y, rev);
				out[`${zoom}/${x}/${y}`] = tile ? [...tile] : null;
			}
		}
	}
	return out;
}

/** The orders to upload in: the right one, its reverse, and every rotation of both. */
const orders = [ORDER, [...ORDER].reverse()].flatMap((o) =>
	o.map((_, i) => [...o.slice(i), ...o.slice(0, i)]),
);

describe("history is in export order", () => {
	test("any upload order gives the same tile versions and revision numbers", async () => {
		const reference = await build(ORDER);
		const expected = rows(reference.t);
		expect(expected.length).toBeGreaterThan(0);
		for (const order of orders) {
			const { t, ids } = await build(order);
			expect(rows(t)).toEqual(expected);
			expect(revs(t).map((r) => r.seq)).toEqual(
				revs(reference.t).map((r) => r.seq),
			);
			expect(
				ORDER.map((name) => revs(t).find((r) => r.id === ids[name])?.rev),
			).toEqual([1, 2, 3, 4]);
			expect(map(t).headRev).toBe(4);
			expect(await snapshot(t)).toEqual(await snapshot(reference.t));
		}
	});

	test("the map at revision k holds exactly the k oldest exports", async () => {
		const shuffled = await build(["b", "n", "c", "a"]);
		for (let k = 0; k <= ORDER.length; k++) {
			const oldest = await build(ORDER.slice(0, k));
			expect(await snapshot(shuffled.t, k)).toEqual(await snapshot(oldest.t));
		}
	});

	test("deleting an upload is as if it was never made, and leaves no gap in the revisions", async () => {
		for (const skip of ORDER) {
			const full = await build(["b", "n", "c", "a"]);
			await erase(full.t, full.ids[skip] as number);
			const without = await build(
				["b", "n", "c", "a"].filter((name) => name !== skip),
			);
			expect(rows(full.t)).toEqual(rows(without.t));
			expect(revs(full.t).map((r) => r.rev)).toEqual([1, 2, 3]);
			expect(map(full.t).headRev).toBe(3);
		}
	});

	test("the epoch changes when history is rewritten, not when an upload goes on top", async () => {
		const { t, ids } = await build(["a", "c"]);
		expect(map(t).epoch).toBe(0);
		await uploadMany(t, [
			{
				data: await EXPORTS.b?.data(),
				x: 0,
				z: 0,
				path: EXPORTS.b?.path,
			},
		] as Parameters<typeof uploadMany>[1]);
		expect(map(t)).toMatchObject({ headRev: 3, epoch: 0 });

		// An export older than the newest one goes in underneath it.
		await uploadMany(t, [
			{
				data: await png(T, T, () => RED),
				x: 5 * T,
				z: 0,
				path: "2026-02-01_10.00.00/old.png",
			},
		]);
		expect(map(t)).toMatchObject({ headRev: 4, epoch: 1 });

		await erase(t, ids.c as number);
		expect(map(t)).toMatchObject({ headRev: 3, epoch: 2 });
	});

	test("seqs are the export time times 1024, uploads with the same time following each other", async () => {
		const t = await bootTiles();
		const path = "2026-02-10_10.00.00/a.png";
		for (const [i, color] of [RED, GREEN, BLUE].entries()) {
			await uploadMany(t, [
				{ data: await png(T, T, () => color), x: i * T, z: 0, path },
			]);
		}
		const [first] = revs(t);
		expect(first?.seq).toBe(Date.UTC(2026, 1, 10, 10) * SEQS_PER_MS);
		expect(
			revs(t).map((r) => (r.seq as number) - (first?.seq as number)),
		).toEqual([0, 1, 2]);
	});
});

describe("features as of a revision", () => {
	test("follow the export time of the upload, whenever it was uploaded", async () => {
		const { t } = await build(["b", "a", "c"]);
		const time = (name: string) =>
			Date.UTC(2026, 1, Number(name === "a" ? 10 : name === "c" ? 11 : 12), 10);
		expect(timeOfRev(t.db, 3, 1)).toBe(time("a"));
		expect(timeOfRev(t.db, 3, 2)).toBe(time("c"));
		expect(timeOfRev(t.db, 3, 3)).toBeNull();
		expect(timeOfRev(t.db, 3, 0)).toBe(0);
		expect(timeOfRev(t.db, 3, 9)).toBeNull();
	});

	test("a feature made between two exports is there as of the newer one only", async () => {
		const { t } = await build(["c", "a"]);
		const layer = (
			await call(t, t.editor, "POST", "/api/layers", {
				dimension: "overworld",
				name: "L",
				color: "red",
			})
		).body.layer.id;
		const feature = await call(
			t,
			t.editor,
			"POST",
			`/api/layers/${layer}/features`,
			{ type: "pin", name: "P", geometry: [1, 2] },
		);
		// Between the exports of a (revision 1) and c (revision 2), though c was uploaded first.
		t.db
			.update(featureRevisions)
			.set({ createdAt: Date.UTC(2026, 1, 10, 12) })
			.where(eq(featureRevisions.featureId, feature.body.feature.id))
			.run();
		t.db.update(layers).set({ createdAt: 0 }).run();
		const at = async (rev: number) =>
			(await call(t, null, "GET", `/api/layers?dim=overworld&at=${rev}`)).body
				.layers[0]?.features.length;
		expect(await at(1)).toBe(0);
		expect(await at(2)).toBe(1);
	});
});
