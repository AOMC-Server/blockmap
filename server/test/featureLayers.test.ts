import { afterAll, describe, expect, test } from "bun:test";
import { MAX_FEATURES_PER_LAYER } from "@blockmap/shared";
import { eq } from "drizzle-orm";
import {
	featureLayers,
	featureRevisions,
	features,
	layers,
} from "../src/db/schema";
import { featuresOfLayers } from "../src/features";
import type { Auth, TileApp } from "./helpers";
import { bootTiles, call, cleanupTempDirs, makeUser } from "./helpers";

afterAll(cleanupTempDirs);

async function makeLayer(
	t: TileApp,
	user: Auth,
	name: string,
	extra: object = {},
) {
	const res = await call(t, user, "POST", "/api/layers", {
		dimension: "overworld",
		name,
		color: "red",
		...extra,
	});
	expect(res.status).toBe(201);
	return res.body.layer.id as number;
}

const pin = (extra: object = {}) => ({
	type: "pin",
	name: "Base",
	geometry: [10, 20],
	...extra,
});

async function addFeature(
	t: TileApp,
	user: Auth,
	layer: number,
	extra: object = {},
) {
	const res = await call(
		t,
		user,
		"POST",
		`/api/layers/${layer}/features`,
		pin(extra),
	);
	expect(res.status).toBe(201);
	return res.body.feature as { id: number; layerId: number; alsoIn: number[] };
}

const listed = async (t: TileApp, user: Auth, layer: number, at = "") => {
	const res = await call(t, user, "GET", `/api/layers${at}`);
	const l = res.body.layers.find((x: { id: number }) => x.id === layer);
	return (l?.features ?? []).map((f: { id: number }) => f.id) as number[];
};

describe("features in several layers", () => {
	test("create with alsoIn: listed in both layers, home first, home decides the style", async () => {
		const t = await bootTiles();
		const a = await makeLayer(t, t.editor, "A");
		const b = await makeLayer(t, t.editor, "B", { color: "blue" });
		const own = await addFeature(t, t.editor, b);
		const f = await addFeature(t, t.editor, a, { alsoIn: [b] });
		expect(f).toMatchObject({ layerId: a, alsoIn: [b] });

		const res = await call(t, null, "GET", "/api/layers");
		const byId = (id: number) =>
			res.body.layers.find((l: { id: number }) => l.id === id);
		expect(byId(a).features.map((x: { id: number }) => x.id)).toEqual([f.id]);
		// B's own feature first, then the one only shown there.
		expect(byId(b).features.map((x: { id: number }) => x.id)).toEqual([
			own.id,
			f.id,
		]);
		expect(byId(b).features[1]).toMatchObject({ layerId: a, alsoIn: [b] });
	});

	test("the home is not one of the others, and duplicates are refused", async () => {
		const t = await bootTiles();
		const a = await makeLayer(t, t.editor, "A");
		const b = await makeLayer(t, t.editor, "B");
		const f = await addFeature(t, t.editor, a, { alsoIn: [a, b] });
		expect(f.alsoIn).toEqual([b]);
		const dup = await call(
			t,
			t.editor,
			"POST",
			`/api/layers/${a}/features`,
			pin({ alsoIn: [b, b] }),
		);
		expect(dup.status).toBe(400);
	});

	test("PUT and DELETE link and unlink; the home layer cannot be unlinked", async () => {
		const t = await bootTiles();
		const a = await makeLayer(t, t.editor, "A");
		const b = await makeLayer(t, t.editor, "B");
		const f = await addFeature(t, t.editor, a);

		const put = await call(
			t,
			t.editor,
			"PUT",
			`/api/features/${f.id}/layers/${b}`,
		);
		expect(put.status).toBe(201);
		expect(put.body.feature.alsoIn).toEqual([b]);
		expect(
			(await call(t, t.editor, "PUT", `/api/features/${f.id}/layers/${b}`))
				.status,
		).toBe(200);
		expect(
			(await call(t, t.editor, "PUT", `/api/features/${f.id}/layers/${a}`))
				.status,
		).toBe(400);
		expect(await listed(t, null, b)).toEqual([f.id]);
		expect(t.db.select().from(featureLayers).all()).toHaveLength(1);

		const del = await call(
			t,
			t.editor,
			"DELETE",
			`/api/features/${f.id}/layers/${b}`,
		);
		expect(del.status).toBe(200);
		expect(del.body.feature.alsoIn).toEqual([]);
		expect(await listed(t, null, b)).toEqual([]);
		expect(t.db.select().from(featureLayers).all()).toHaveLength(0);
		expect(
			(await call(t, t.editor, "DELETE", `/api/features/${f.id}/layers/${b}`))
				.status,
		).toBe(404);
		expect(
			(await call(t, t.editor, "DELETE", `/api/features/${f.id}/layers/${a}`))
				.status,
		).toBe(400);
	});

	test("PATCH alsoIn replaces the list; moving the home keeps the others", async () => {
		const t = await bootTiles();
		const a = await makeLayer(t, t.editor, "A");
		const b = await makeLayer(t, t.editor, "B");
		const c = await makeLayer(t, t.editor, "C");
		const f = await addFeature(t, t.editor, a, { alsoIn: [b] });

		const set = await call(t, t.editor, "PATCH", `/api/features/${f.id}`, {
			alsoIn: [c],
		});
		expect(set.body.feature.alsoIn).toEqual([c]);
		// Editing something else leaves the layers alone.
		const renamed = await call(t, t.editor, "PATCH", `/api/features/${f.id}`, {
			name: "Castle",
		});
		expect(renamed.body.feature.alsoIn).toEqual([c]);

		// Moving the home into a layer it is shown in makes that layer the home.
		const moved = await call(t, t.editor, "PATCH", `/api/features/${f.id}`, {
			layerId: c,
		});
		expect(moved.body.feature).toMatchObject({ layerId: c, alsoIn: [] });
		const back = await call(t, t.editor, "PATCH", `/api/features/${f.id}`, {
			layerId: a,
			alsoIn: [b, c],
		});
		expect(back.body.feature).toMatchObject({ layerId: a, alsoIn: [b, c] });
	});

	test("you need to edit the layer you add or take a feature out of", async () => {
		const t = await bootTiles();
		const other = await makeUser(t.db, "other");
		const privateLayer = await makeLayer(t, t.editor, "Mine", {
			visibility: "private",
		});
		const open = await makeLayer(t, t.editor, "Open");
		const f = await addFeature(t, t.editor, open);

		// Not even visible: 404; and a layer that is only readable is 403.
		expect(
			(
				await call(
					t,
					other,
					"PUT",
					`/api/features/${f.id}/layers/${privateLayer}`,
				)
			).status,
		).toBe(404);
		expect(
			(
				await call(t, t.editor, "PATCH", `/api/features/${f.id}`, {
					alsoIn: [privateLayer],
				})
			).status,
		).toBe(200);
		// `other` cannot take it out of the private layer, nor change the feature's other layers.
		expect(
			(
				await call(
					t,
					other,
					"DELETE",
					`/api/features/${f.id}/layers/${privateLayer}`,
				)
			).status,
		).toBe(403);
		expect(
			(await call(t, other, "PATCH", `/api/features/${f.id}`, { alsoIn: [] }))
				.status,
		).toBe(403);
	});

	test("someone who edits only the other layer can link and unlink, but not edit the feature", async () => {
		const t = await bootTiles();
		const friend = await makeUser(t.db, "friend");
		const home = await makeLayer(t, t.editor, "Home", {
			visibility: "private",
		});
		const there = await makeLayer(t, friend, "There");
		const f = await addFeature(t, t.editor, home);
		await call(t, t.editor, "POST", `/api/layers/${home}/members`, {
			userId: "friend",
			role: "viewer",
		});
		const put = await call(
			t,
			friend,
			"PUT",
			`/api/features/${f.id}/layers/${there}`,
		);
		expect(put.status).toBe(201);
		expect(
			(await call(t, friend, "PATCH", `/api/features/${f.id}`, { name: "x" }))
				.status,
		).toBe(403);
		expect(
			(await call(t, friend, "DELETE", `/api/features/${f.id}/layers/${there}`))
				.status,
		).toBe(200);
	});

	test("a feature from a layer you cannot see shows in the layer you can, and is not editable", async () => {
		const t = await bootTiles();
		const friend = await makeUser(t.db, "friend");
		const home = await makeLayer(t, t.editor, "Home", {
			visibility: "private",
		});
		const open = await makeLayer(t, t.editor, "Open");
		const f = await addFeature(t, t.editor, home, { alsoIn: [open] });

		expect(await listed(t, friend, open)).toEqual([f.id]);
		expect(await listed(t, friend, home)).toEqual([]);
		const history = await call(
			t,
			friend,
			"GET",
			`/api/features/${f.id}/history`,
		);
		expect(history.status).toBe(200);
		expect(
			(await call(t, friend, "PATCH", `/api/features/${f.id}`, { name: "x" }))
				.status,
		).toBe(403);
		expect(
			(await call(t, friend, "DELETE", `/api/features/${f.id}`)).status,
		).toBe(403);
	});

	test("deleting the feature removes it from every layer; restoring brings the layers back", async () => {
		const t = await bootTiles();
		const a = await makeLayer(t, t.editor, "A");
		const b = await makeLayer(t, t.editor, "B");
		const f = await addFeature(t, t.editor, a, { alsoIn: [b] });
		await call(t, t.editor, "DELETE", `/api/features/${f.id}`);
		expect(await listed(t, null, a)).toEqual([]);
		expect(await listed(t, null, b)).toEqual([]);

		const history = await call(
			t,
			t.mod,
			"GET",
			`/api/features/${f.id}/history`,
		);
		const first = history.body.history.at(-1).revisionId;
		const restored = await call(
			t,
			t.mod,
			"POST",
			`/api/features/${f.id}/restore/${first}`,
		);
		expect(restored.status).toBe(201);
		expect(restored.body.feature.alsoIn).toEqual([b]);
		expect(await listed(t, null, b)).toEqual([f.id]);
	});

	test("links count towards a layer's limit", async () => {
		const t = await bootTiles();
		const a = await makeLayer(t, t.editor, "A");
		const b = await makeLayer(t, t.editor, "B");
		const f = await addFeature(t, t.editor, a);
		// Fill B to the limit straight in the database.
		t.db.transaction((tx) => {
			for (let i = 0; i < MAX_FEATURES_PER_LAYER; i++) {
				const row = tx
					.insert(features)
					.values({ layerId: b, sortOrder: i })
					.returning()
					.get();
				tx.insert(featureRevisions)
					.values({
						featureId: row.id,
						authorId: "editor",
						layerId: b,
						type: "pin",
						name: "x",
						geometry: [0, 0],
					})
					.run();
			}
		});
		const put = await call(
			t,
			t.editor,
			"PUT",
			`/api/features/${f.id}/layers/${b}`,
		);
		expect(put.status).toBe(409);
		const patch = await call(t, t.editor, "PATCH", `/api/features/${f.id}`, {
			alsoIn: [b],
		});
		expect(patch.status).toBe(409);
	});

	test("deleting layers: features with it as home go, shown ones stay", async () => {
		const t = await bootTiles();
		const a = await makeLayer(t, t.editor, "A");
		const b = await makeLayer(t, t.editor, "B");
		const own = await addFeature(t, t.editor, b);
		const shown = await addFeature(t, t.editor, a, { alsoIn: [b] });

		// B is not empty, so only a moderator may delete it.
		expect((await call(t, t.editor, "DELETE", `/api/layers/${b}`)).status).toBe(
			403,
		);
		expect((await call(t, t.mod, "DELETE", `/api/layers/${b}`)).status).toBe(
			200,
		);
		expect(await listed(t, null, a)).toEqual([shown.id]);
		expect(await listed(t, null, b)).toEqual([]);
		expect(await listed(t, null, a)).not.toContain(own.id);

		// Deleting A, the home of what is left, takes the feature along.
		expect((await call(t, t.mod, "DELETE", `/api/layers/${a}`)).status).toBe(
			200,
		);
		const c = await makeLayer(t, t.editor, "C");
		const lonely = await addFeature(t, t.editor, c);
		await call(t, t.editor, "DELETE", `/api/features/${lonely.id}`);
		// Empty layers can be deleted by their creator.
		expect((await call(t, t.editor, "DELETE", `/api/layers/${c}`)).status).toBe(
			200,
		);
	});

	test("a feature whose home layer is deleted is gone from the layers it is shown in", async () => {
		const t = await bootTiles();
		const home = await makeLayer(t, t.editor, "Home");
		const other = await makeLayer(t, t.editor, "Other");
		const f = await addFeature(t, t.editor, home, { alsoIn: [other] });
		expect(await listed(t, null, other)).toEqual([f.id]);
		await call(t, t.mod, "DELETE", `/api/layers/${home}`);
		expect(await listed(t, null, other)).toEqual([]);
	});

	test("reading as of an earlier time uses the layers it was shown in then", async () => {
		const t = await bootTiles();
		const a = await makeLayer(t, t.editor, "A");
		const b = await makeLayer(t, t.editor, "B");
		const f = await addFeature(t, t.editor, a, { alsoIn: [b] });
		await call(t, t.editor, "PATCH", `/api/features/${f.id}`, { alsoIn: [] });
		const revs = t.db.select().from(featureRevisions).all();
		expect(revs).toHaveLength(2);
		t.db
			.update(featureRevisions)
			.set({ createdAt: 1000 })
			.where(eq(featureRevisions.id, revs[0]?.id ?? 0))
			.run();
		t.db
			.update(featureRevisions)
			.set({ createdAt: 2000 })
			.where(eq(featureRevisions.id, revs[1]?.id ?? 0))
			.run();
		t.db.update(layers).set({ createdAt: 0 }).run();
		const ids = (at: number | null) =>
			(featuresOfLayers(t.db, [b], at).get(b) ?? []).map((x) => x.id);
		expect(ids(1500)).toEqual([f.id]);
		expect(ids(2500)).toEqual([]);
		expect(ids(null)).toEqual([]);
		expect(ids(500)).toEqual([]);
	});

	test("reordering covers the layer's own features only", async () => {
		const t = await bootTiles();
		const a = await makeLayer(t, t.editor, "A");
		const b = await makeLayer(t, t.editor, "B");
		const one = await addFeature(t, t.editor, b);
		const two = await addFeature(t, t.editor, b);
		const shown = await addFeature(t, t.editor, a, { alsoIn: [b] });
		const reorder = await call(
			t,
			t.editor,
			"POST",
			`/api/layers/${b}/features/reorder`,
			{
				ids: [two.id, one.id],
			},
		);
		expect(reorder.status).toBe(200);
		expect(await listed(t, null, b)).toEqual([two.id, one.id, shown.id]);
		const all = await call(
			t,
			t.editor,
			"POST",
			`/api/layers/${b}/features/reorder`,
			{
				ids: [one.id, two.id, shown.id],
			},
		);
		expect(all.status).toBe(409);
	});

	test("export and replace-import leave features shown in a layer alone", async () => {
		const t = await bootTiles();
		const a = await makeLayer(t, t.editor, "A");
		const b = await makeLayer(t, t.editor, "B");
		const shown = await addFeature(t, t.editor, a, { alsoIn: [b] });
		await addFeature(t, t.editor, b, { name: "Own" });

		const exported = await call(t, null, "GET", `/api/layers/${b}/export`);
		expect(exported.body.map((x: { name: string }) => x.name)).toEqual([
			"Own",
			"Base",
		]);
		expect(exported.body[0]).not.toHaveProperty("alsoIn");

		const imported = await call(
			t,
			t.editor,
			"POST",
			`/api/layers/${b}/import?replace=1`,
			[{ type: "pin", name: "New", geometry: [1, 1], alsoIn: [a] }],
		);
		expect(imported.status).toBe(201);
		expect(imported.body).toEqual({ imported: 1, replaced: 2 });
		// The one from A is still in A, just no longer shown in B.
		expect(await listed(t, null, a)).toEqual([shown.id]);
		const names = (await call(t, null, "GET", "/api/layers")).body.layers
			.find((l: { id: number }) => l.id === b)
			.features.map((x: { name: string; alsoIn: number[] }) => [
				x.name,
				x.alsoIn,
			]);
		expect(names).toEqual([["New", []]]);
	});
});
