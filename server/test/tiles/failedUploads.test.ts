import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { jobs, revisions } from "../../src/db/schema";
import {
	BLACK,
	bootTiles,
	call,
	cleanupTempDirs,
	makeUser,
	RED,
	solid,
	T,
	type TileApp,
	upload,
} from "../helpers";

afterAll(cleanupTempDirs);

/** A failed upload by the editor in the given dimension (an upload with no map data fails). */
async function failed(t: TileApp, dim = "overworld") {
	const id = await upload(t, await solid(T, T, BLACK), 0, 0, t.editor, dim);
	t.db
		.update(revisions)
		.set({ errorDetail: "ENOENT: /secret/path" })
		.where(eq(revisions.id, id))
		.run();
	return id;
}

const listed = async (
	t: TileApp,
	user: Parameters<typeof call>[1],
	query = "",
) =>
	(
		(await call(t, user, "GET", `/api/revisions${query}`)).body.revisions as {
			id: number;
		}[]
	).map((r) => r.id);

async function follow(
	t: TileApp,
	user: Parameters<typeof call>[1],
	topic: string,
) {
	const res = await t.app.request(`/api/events?topics=${topic}`, {
		headers: user?.auth ?? {},
	});
	return (await res.text())
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => JSON.parse(line.slice(5)));
}

describe("who sees failed uploads", () => {
	test("only their author and moderators", async () => {
		const t = await bootTiles();
		const other = await makeUser(t.db, "other");
		const done = await upload(t, await solid(T, T, RED), T, 0);
		const bad = await failed(t);

		for (const [user, sees] of [
			[null, false],
			[other, false],
			[t.editor, true],
			[t.mod, true],
		] as const) {
			const ids = await listed(t, user);
			expect(ids.includes(done)).toBe(true);
			expect(ids.includes(bad)).toBe(sees);
			expect((await listed(t, user, `?active=${bad}`)).includes(bad)).toBe(
				sees,
			);
			expect((await call(t, user, "GET", `/api/revisions/${bad}`)).status).toBe(
				sees ? 200 : 404,
			);
			expect(
				(await call(t, user, "GET", `/api/revisions/${bad}/tiles`)).status,
			).toBe(sees ? 200 : 404);
			const [envelope] = await follow(t, user, `revision:${bad}`);
			expect(envelope).toMatchObject(
				sees
					? { snapshot: true, data: { status: "failed" } }
					: { error: "not found" },
			);
		}
		expect(
			(await call(t, other, "DELETE", `/api/revisions/${bad}`)).status,
		).toBe(404);
		expect(
			(await call(t, t.editor, "DELETE", `/api/revisions/${bad}`)).status,
		).toBe(200);
	});

	test("the technical error is for moderators", async () => {
		const t = await bootTiles();
		const bad = await failed(t);
		const detail = async (user: Parameters<typeof call>[1]) =>
			(await call(t, user, "GET", `/api/revisions/${bad}`)).body.revision
				.errorDetail;
		expect(await detail(t.mod)).toBe("ENOENT: /secret/path");
		expect(await detail(t.editor)).toBeNull();
		const own = (await call(t, t.editor, "GET", "/api/revisions")).body
			.revisions[0];
		expect(own.errorDetail).toBeNull();
		expect(own.error).toBeString();
	});
});

describe("purging failed uploads", () => {
	test("moderators remove every failed upload and nothing else", async () => {
		const t = await bootTiles();
		const done = await upload(t, await solid(T, T, RED), T, 0);
		const a = await failed(t);
		const b = await failed(t, "nether");
		const url = "/api/admin/uploads/purge-failed";

		expect((await call(t, null, "POST", url)).status).toBe(401);
		expect((await call(t, t.editor, "POST", url)).status).toBe(403);
		expect(
			(await call(t, t.editor, "GET", "/api/admin/uploads/failed")).status,
		).toBe(403);
		expect(
			(await call(t, t.mod, "GET", "/api/admin/uploads/failed")).body,
		).toEqual({ count: 2 });

		const dimensions: number[] = [];
		const gone: unknown[] = [];
		const stops = [
			t.services.events.subscribe(`revision:${a}`, (e) => gone.push(e)),
			t.services.events.subscribe(`revision:${b}`, (e) => gone.push(e)),
		];
		for (const dim of [1, 2])
			stops.push(
				t.services.events.subscribe(`revisions:${dim}`, () =>
					dimensions.push(dim),
				),
			);
		const res = await call(t, t.mod, "POST", url);
		for (const stop of stops) stop();
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ removed: 2 });
		expect(gone).toEqual([{ status: "gone" }, { status: "gone" }]);
		expect(dimensions.sort()).toEqual([1, 2]);

		expect(t.db.select({ id: revisions.id }).from(revisions).all()).toEqual([
			{ id: done },
		]);
		expect(
			t.db
				.select()
				.from(jobs)
				.all()
				.map((j) => (j.payload as { revisionId: number }).revisionId),
		).toEqual([done]);
		expect((await call(t, t.mod, "POST", url)).body).toEqual({ removed: 0 });
	});
});
