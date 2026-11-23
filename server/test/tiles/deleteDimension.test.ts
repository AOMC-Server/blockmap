import { afterAll, describe, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { writeScopeFor } from "../../src/auth/scopes";
import {
	dimensions,
	features,
	jobs,
	layers,
	mapInfo,
	revisions,
	shortLinks,
	tileVersions,
	uploadPatches,
} from "../../src/db/schema";
import {
	BLUE,
	bootTiles,
	call,
	cleanupTempDirs,
	GREEN,
	png,
	RED,
	T,
	type TileApp,
	uploadMany,
} from "../helpers";

afterAll(cleanupTempDirs);

const path = (day: number) => `2026-02-${day}_10.00.00/a.png`;

/** Exports alternating between the dimensions, so the revision numbers interleave. */
async function build() {
	const t = await bootTiles({}, { owner: true });
	const up = async (
		day: number,
		dim: string,
		color: [number, number, number],
	) =>
		uploadMany(
			t,
			[{ data: await png(T, T, () => color), x: 0, z: 0, path: path(day) }],
			t.editor,
			dim,
		);
	await up(10, "overworld", RED);
	await up(11, "nether", GREEN);
	await up(12, "overworld", BLUE);
	await up(13, "nether", RED);
	for (const dim of ["overworld", "nether"]) {
		const layer = (
			await call(t, t.editor, "POST", "/api/layers", {
				dimension: dim,
				name: dim,
				color: "red",
			})
		).body.layer.id;
		await call(t, t.editor, "POST", `/api/layers/${layer}/features`, {
			type: "pin",
			name: "P",
			geometry: [1, 2],
		});
		await call(t, null, "POST", "/api/links", {
			dim,
			x: 0,
			z: 0,
			zoom: 1,
			rev: 4,
		});
	}
	return t;
}

const archive = (t: TileApp, dim = "nether") =>
	call(t, t.mod, "PATCH", `/api/dimensions/${dim}`, { archived: true });
const del = (t: TileApp, user: Parameters<typeof call>[1], dim = "nether") =>
	call(t, user, "DELETE", `/api/dimensions/${dim}`);

const dimId = (t: TileApp, slug: string) =>
	t.db.select().from(dimensions).where(eq(dimensions.slug, slug)).get()
		?.id as number;

describe("deleting a dimension", () => {
	test("only owners, only archived ones, and once", async () => {
		const t = await build();
		expect((await del(t, null)).status).toBe(401);
		for (const user of [t.editor, t.mod])
			expect((await del(t, user)).status).toBe(403);
		expect((await del(t, t.owner, "nowhere")).status).toBe(404);
		expect((await del(t, t.owner)).status).toBe(409);

		await archive(t);
		expect((await del(t, t.mod)).status).toBe(403);
		// Queued already (the worker has not got to it).
		t.db
			.insert(jobs)
			.values({
				type: "delete_dimension",
				payload: { dimensionId: dimId(t, "nether") },
			})
			.run();
		expect((await del(t, t.owner)).status).toBe(409);
		t.db.delete(jobs).where(eq(jobs.type, "delete_dimension")).run();
		expect((await del(t, t.owner)).status).toBe(202);
		await t.services.worker.run();
		expect((await del(t, t.owner)).status).toBe(404);
	});

	test("deleting needs the manage scope, unlike the rest of dimension management", () => {
		expect(writeScopeFor("/api/dimensions/nether", "DELETE")).toBe("manage");
		expect(writeScopeFor("/api/dimensions/nether", "PATCH")).toBe("moderate");
		expect(writeScopeFor("/api/dimensions/nether/tiles", "DELETE")).not.toBe(
			"manage",
		);
	});

	test("removes everything of the dimension and nothing of the others", async () => {
		const t = await build();
		const nether = dimId(t, "nether");
		const overworld = dimId(t, "overworld");
		const rowsOf = (dim: number) =>
			t.db
				.select()
				.from(tileVersions)
				.where(eq(tileVersions.dimensionId, dim))
				.orderBy(
					asc(tileVersions.zoom),
					asc(tileVersions.tileX),
					asc(tileVersions.tileY),
					asc(tileVersions.seq),
				)
				.all();
		const before = rowsOf(overworld);
		const epoch = (t.db.select().from(mapInfo).get()?.epoch ?? 0) as number;
		const overworldRevs = t.db
			.select({ id: revisions.id })
			.from(revisions)
			.where(eq(revisions.dimensionId, overworld))
			.orderBy(asc(revisions.seq))
			.all();
		await archive(t);
		const events: string[] = [];
		for (const topic of [
			"map",
			`layers:${nether}`,
			`revisions:${nether}`,
		] as const)
			t.services.events.subscribe(topic, () => events.push(topic));

		expect((await del(t, t.owner)).status).toBe(202);
		await t.services.worker.run();

		expect(
			t.db
				.select()
				.from(dimensions)
				.all()
				.map((d) => d.slug),
		).not.toContain("nether");
		expect(rowsOf(nether)).toEqual([]);
		expect(rowsOf(overworld)).toEqual(before);
		expect(
			t.db
				.select()
				.from(revisions)
				.orderBy(asc(revisions.rev))
				.all()
				.map((r) => r.id),
		).toEqual(overworldRevs.map((r) => r.id));
		expect(
			t.db
				.select({ rev: revisions.rev })
				.from(revisions)
				.orderBy(asc(revisions.rev))
				.all(),
		).toEqual([{ rev: 1 }, { rev: 2 }]);
		expect(t.db.select().from(mapInfo).get()).toMatchObject({
			headRev: 2,
			epoch: epoch + 1,
		});
		expect(
			t.db
				.select({ id: uploadPatches.revisionId })
				.from(uploadPatches)
				.all()
				.every((p) => overworldRevs.some((r) => r.id === p.id)),
		).toBe(true);
		expect(
			t.db
				.select()
				.from(layers)
				.all()
				.map((l) => l.name),
		).toEqual(["overworld"]);
		expect(t.db.select().from(features).all()).toHaveLength(1);
		expect(
			t.db
				.select()
				.from(shortLinks)
				.all()
				.map((l) => new URLSearchParams(l.query).get("dim")),
		).toEqual(["overworld"]);
		expect(
			t.db
				.select()
				.from(jobs)
				.all()
				.filter((j) => j.type === "process_upload")
				.map((j) => (j.payload as { revisionId: number }).revisionId)
				.sort(),
		).toEqual(overworldRevs.map((r) => r.id).sort());
		expect(new Set(events)).toEqual(
			new Set(["map", `layers:${nether}`, `revisions:${nether}`]),
		);
	});
});
