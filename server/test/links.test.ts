import { afterAll, describe, expect, test } from "bun:test";
import { MAX_FILTER_LENGTH } from "@blockmap/shared/featureFilter";
import { createApiToken } from "../src/auth/tokens";
import { SHORT_LINK_RATE_LIMIT } from "../src/ratelimit";
import { viewQuery } from "../src/routes/links";
import {
	bootTiles,
	call,
	cleanupTempDirs,
	erase,
	makeTestApp,
	makeUser,
	RED,
	solid,
	T,
	uploadFrom,
} from "./helpers";

afterAll(cleanupTempDirs);

const view = { dim: "overworld", x: 120, z: -40, zoom: 1.5 };

describe("short links", () => {
	test("anyone can make one; it redirects to the view", async () => {
		const t = await bootTiles();
		for (const [i, day] of [10, 11, 12].entries())
			await uploadFrom(
				t,
				await solid(T, T, RED),
				i * T,
				0,
				`2026-02-${day}_10.00.00/a.png`,
			);
		const res = await call(t, null, "POST", "/api/links", {
			...view,
			rev: 3,
			layers: [5, 2, 5],
		});
		expect(res.status).toBe(201);
		expect(res.body.url).toBe(`http://localhost:3000/s/${res.body.code}`);
		expect(res.body.code).toMatch(/^[0-9A-Za-z]{7}$/);

		const open = await t.app.request(`/s/${res.body.code}`);
		expect(open.status).toBe(302);
		expect(open.headers.get("Location")).toBe(
			"/v2/?dim=overworld&x=120&z=-40&zoom=1.5&rev=3&layers=2%2C5",
		);
	});

	test("a link keeps its moment when uploads are added before it or deleted", async () => {
		const t = await bootTiles();
		const png = await solid(T, T, RED);
		const at = (day: number) =>
			`2026-02-${String(day).padStart(2, "0")}_10.00.00/a.png`;
		const a = await uploadFrom(t, png, 0, 0, at(10));
		await uploadFrom(t, png, T, 0, at(12));
		const link = async (rev: number) =>
			(await call(t, null, "POST", "/api/links", { ...view, rev })).body.code;
		const opens = async (code: string) =>
			new URL(
				(await t.app.request(`/s/${code}`)).headers.get("Location") as string,
				"http://x",
			).searchParams.get("rev");
		const [first, second, none] = [await link(1), await link(2), await link(0)];
		expect(await link(9)).not.toBe(second);

		// An older export lands between the two: the second moves to revision 3.
		await uploadFrom(t, png, 2 * T, 0, at(11));
		expect([
			await opens(first),
			await opens(second),
			await opens(none),
		]).toEqual(["1", "3", "0"]);

		// And one before everything moves them all up.
		await uploadFrom(t, png, 3 * T, 0, at(9));
		expect([await opens(first), await opens(second)]).toEqual(["2", "4"]);

		await erase(t, a);
		expect([await opens(first), await opens(second)]).toEqual(["1", "3"]);
		expect(await opens(await link(9))).toBeNull();
	});

	test("the same view gets the same link, however its layers are listed", async () => {
		const t = makeTestApp();
		const user = await makeUser(t.db, "1");
		const a = await call(t, null, "POST", "/api/links", {
			...view,
			layers: [3, 1],
		});
		const b = await call(t, user, "POST", "/api/links", {
			...view,
			layers: [1, 3, 3],
		});
		expect(b.status).toBe(200);
		expect(b.body.code).toBe(a.body.code);

		// No layers listed (their defaults) and no layers shown are different views.
		const none = await call(t, null, "POST", "/api/links", {
			...view,
			layers: [],
		});
		const defaults = await call(t, null, "POST", "/api/links", view);
		expect(
			new Set([a.body.code, none.body.code, defaults.body.code]).size,
		).toBe(3);
		const open = await t.app.request(`/s/${none.body.code}`);
		expect(open.headers.get("Location")).toEndWith("&layers=");
	});

	test("a filter is part of the link, the same filter gets the same link", async () => {
		const t = makeTestApp();
		const a = await call(t, null, "POST", "/api/links", {
			...view,
			filter: "type:area owner:Notch",
		});
		expect(a.status).toBe(201);
		const open = await t.app.request(`/s/${a.body.code}`);
		expect(open.headers.get("Location")).toBe(
			"/v2/?dim=overworld&x=120&z=-40&zoom=1.5&filter=type%3Aarea+owner%3ANotch",
		);
		const again = await call(t, null, "POST", "/api/links", {
			...view,
			filter: "type:area owner:Notch",
		});
		expect(again.status).toBe(200);
		expect(again.body.code).toBe(a.body.code);

		const other = await call(t, null, "POST", "/api/links", {
			...view,
			filter: "-color:red",
		});
		const none = await call(t, null, "POST", "/api/links", view);
		expect(new Set([a.body.code, other.body.code, none.body.code]).size).toBe(
			3,
		);
	});

	test("a filter that is too long, or empty, is rejected", async () => {
		const t = makeTestApp();
		for (const filter of ["x".repeat(MAX_FILTER_LENGTH + 1), "   "])
			expect(
				(await call(t, null, "POST", "/api/links", { ...view, filter })).status,
			).toBe(400);
		const longest = await call(t, null, "POST", "/api/links", {
			...view,
			filter: "x".repeat(MAX_FILTER_LENGTH),
		});
		expect(longest.status).toBe(201);
	});

	test("views are validated", async () => {
		const t = makeTestApp();
		for (const bad of [
			{ ...view, dim: "nowhere" },
			{ ...view, x: 1.5 },
			{ ...view, zoom: -100 },
			{ ...view, layers: [0] },
			{ ...view, rev: -1 },
			{ x: 0, z: 0, zoom: 0 },
		])
			expect((await call(t, null, "POST", "/api/links", bad)).status).toBe(400);
	});

	test("unknown links answer 404", async () => {
		const t = makeTestApp();
		expect((await t.app.request("/s/nope123")).status).toBe(404);
		expect((await t.app.request("/s/not-a-code!")).status).toBe(404);
	});

	test("making links is rate limited per client", async () => {
		const t = makeTestApp();
		for (let i = 0; i < SHORT_LINK_RATE_LIMIT; i++)
			expect(
				(await call(t, null, "POST", "/api/links", { ...view, x: i })).status,
			).toBe(201);
		expect(
			(await call(t, null, "POST", "/api/links", { ...view, x: -1 })).status,
		).toBe(429);
	});

	test("any token may make links", async () => {
		const t = makeTestApp();
		await makeUser(t.db, "1");
		const { token } = await createApiToken(t.db, "1", "read only", null, [
			"read",
		]);
		const res = await call(
			t,
			{ auth: { Authorization: `Bearer ${token}` } },
			"POST",
			"/api/links",
			view,
		);
		expect(res.status).toBe(201);
	});

	test("the query matches the address bar's rounding", () => {
		expect(viewQuery({ ...view, zoom: 1.23456 })).toBe(
			"dim=overworld&x=120&z=-40&zoom=1.23",
		);
	});
});
