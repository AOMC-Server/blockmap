import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { featurePlayers, players } from "../src/db/schema";
import { headFromSkin } from "../src/mojang";
import {
	type Auth,
	addMember,
	call,
	cleanupTempDirs,
	decodeRgba,
	makeTestApp,
	makeUser,
} from "./helpers";

afterAll(cleanupTempDirs);

type Account = { uuid: string; name: string; skin?: Buffer };

/** A skin whose face is `face` and whose hat layer is transparent but for one `hat` pixel. */
async function skin(
	face: [number, number, number],
	hat: [number, number, number],
	height = 64,
) {
	const raw = Buffer.alloc(64 * height * 4);
	const set = (x: number, y: number, c: number[]) =>
		raw.set(c, (y * 64 + x) * 4);
	for (let y = 8; y < 16; y++)
		for (let x = 8; x < 16; x++) set(x, y, [...face, 255]);
	set(40, 8, [...hat, 255]);
	return sharp(raw, { raw: { width: 64, height, channels: 4 } })
		.png()
		.toBuffer();
}

const dashed = (hex: string) =>
	`${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;

/** A stand-in for Mojang's APIs over a mutable set of accounts. */
function fakeMojang(accounts: Account[]) {
	const state = { down: false, calls: 0 };
	const fetchFn = (async (input: string | URL | Request) => {
		const url = String(input instanceof Request ? input.url : input);
		state.calls++;
		if (state.down) throw new Error("network down");
		const byName = url.match(/users\/profiles\/minecraft\/(.+)$/);
		if (byName) {
			const a = accounts.find(
				(a) =>
					a.name.toLowerCase() ===
					decodeURIComponent(byName[1] ?? "").toLowerCase(),
			);
			return a
				? Response.json({ id: a.uuid.replaceAll("-", ""), name: a.name })
				: new Response(null, { status: 404 });
		}
		const profile = url.match(/session\/minecraft\/profile\/([0-9a-f]+)$/);
		if (profile) {
			const a = accounts.find((a) => a.uuid.replaceAll("-", "") === profile[1]);
			if (!a) return new Response(null, { status: 204 });
			const textures = {
				textures: a.skin
					? { SKIN: { url: `http://textures.minecraft.net/texture/${a.name}` } }
					: {},
			};
			return Response.json({
				id: a.uuid.replaceAll("-", ""),
				name: a.name,
				properties: [
					{
						name: "textures",
						value: Buffer.from(JSON.stringify(textures)).toString("base64"),
					},
				],
			});
		}
		const texture = url.match(
			/^https:\/\/textures\.minecraft\.net\/texture\/(.+)$/,
		);
		if (texture) {
			const a = accounts.find((a) => a.name === texture[1]);
			return a?.skin
				? new Response(new Uint8Array(a.skin))
				: new Response(null, { status: 404 });
		}
		return new Response(null, { status: 500 });
	}) as typeof fetch;
	return { fetchFn, state };
}

const NOTCH = dashed("069a79f444e94726a5befca90e38aaf5");
const JEB = dashed("853c80ef3c3749fdaa49938b674adae6");

async function boot(accounts?: Account[]) {
	const list = accounts ?? [
		{ uuid: NOTCH, name: "Notch", skin: await skin([200, 0, 0], [0, 0, 200]) },
		{ uuid: JEB, name: "jeb_" },
	];
	const mojang = fakeMojang(list);
	const t = makeTestApp({}, mojang.fetchFn);
	const editor = await makeUser(t.db, "editor");
	const mod = await makeUser(t.db, "mod");
	await addMember(t, "mod", "moderator");
	return { ...t, editor, mod, accounts: list, mojang };
}
type App = Awaited<ReturnType<typeof boot>>;

async function addPlayer(t: App, uuid: string, user: Auth = t.editor) {
	const res = await call(t, user, "POST", "/api/players", { uuid });
	expect([200, 201]).toContain(res.status);
	return res.body.player as { id: number; uuid: string; name: string };
}

async function makeLayer(t: App) {
	const res = await call(t, t.editor, "POST", "/api/layers", {
		dimension: "overworld",
		name: "Bases",
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

describe("heads", () => {
	test("the face with the hat layer over it", async () => {
		const head = await decodeRgba(
			await headFromSkin(await skin([200, 0, 0], [0, 0, 200])),
		);
		expect([head.width, head.height]).toEqual([8, 8]);
		expect([...head.data.subarray(0, 4)]).toEqual([0, 0, 200, 255]);
		expect([...head.data.subarray(4, 8)]).toEqual([200, 0, 0, 255]);
	});

	test("old 64x32 skins work too", async () => {
		const head = await decodeRgba(
			await headFromSkin(await skin([0, 200, 0], [0, 0, 0], 32)),
		);
		expect([...head.data.subarray(4, 8)]).toEqual([0, 200, 0, 255]);
	});

	test("a skin of the wrong size is refused", async () => {
		const bad = await sharp(Buffer.alloc(16 * 16 * 4), {
			raw: { width: 16, height: 16, channels: 4 },
		})
			.png()
			.toBuffer();
		expect(headFromSkin(bad)).rejects.toThrow();
	});
});

describe("lookup", () => {
	test("by name, by UUID with or without dashes", async () => {
		const t = await boot();
		for (const q of ["notch", NOTCH, NOTCH.replaceAll("-", "").toUpperCase()]) {
			const res = await call(t, t.editor, "GET", `/api/players/lookup?q=${q}`);
			expect(res.status).toBe(200);
			expect(res.body).toEqual({ uuid: NOTCH, name: "Notch", existing: null });
		}
	});

	test("needs a login", async () => {
		const t = await boot();
		expect(
			(await call(t, null, "GET", "/api/players/lookup?q=Notch")).status,
		).toBe(401);
	});

	test("unknown names, bad input and Mojang being down", async () => {
		const t = await boot();
		const missing = await call(
			t,
			t.editor,
			"GET",
			"/api/players/lookup?q=nobody",
		);
		expect(missing.status).toBe(404);
		expect(missing.body.error).toContain("nobody");
		expect(
			(await call(t, t.editor, "GET", "/api/players/lookup?q=not%20a%20name"))
				.status,
		).toBe(400);
		t.mojang.state.down = true;
		expect(
			(await call(t, t.editor, "GET", "/api/players/lookup?q=someone")).status,
		).toBe(502);
	});

	test("says when the map already has the player", async () => {
		const t = await boot();
		const p = await addPlayer(t, NOTCH);
		const res = await call(t, t.editor, "GET", "/api/players/lookup?q=Notch");
		expect(res.body.existing).toEqual({ ...p, owned: 0, built: 0 });
	});

	test("head preview", async () => {
		const t = await boot();
		const res = await t.app.request(
			`/api/players/lookup/head.png?uuid=${NOTCH}`,
			{
				headers: t.editor.auth,
			},
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/png");
	});
});

describe("adding players", () => {
	test("takes the name and head from Mojang, not from the request", async () => {
		const t = await boot();
		const res = await call(t, t.editor, "POST", "/api/players", {
			uuid: NOTCH.replaceAll("-", ""),
			name: "Impostor",
		});
		expect(res.status).toBe(201);
		expect(res.body.player).toMatchObject({ uuid: NOTCH, name: "Notch" });
		const row = t.db
			.select()
			.from(players)
			.where(eq(players.uuid, NOTCH))
			.get();
		expect(row?.head).not.toBeNull();
		expect(row?.checkedAt).toBeGreaterThan(0);

		const head = await t.app.request(
			`/api/players/${res.body.player.id}/head.png`,
		);
		expect(head.status).toBe(200);
		const img = await decodeRgba(new Uint8Array(await head.arrayBuffer()));
		expect([...img.data.subarray(4, 8)]).toEqual([200, 0, 0, 255]);
	});

	test("the same UUID again returns the player, with its new name", async () => {
		const t = await boot();
		const first = await addPlayer(t, NOTCH);
		(t.accounts[0] as Account).name = "Notch2";
		const again = await call(t, t.editor, "POST", "/api/players", {
			uuid: NOTCH,
		});
		expect(again.status).toBe(200);
		expect(again.body.player).toEqual({ ...first, name: "Notch2" });
	});

	test("unknown accounts and Mojang being down", async () => {
		const t = await boot();
		const unknown = dashed("0".repeat(32));
		expect(
			(await call(t, t.editor, "POST", "/api/players", { uuid: unknown }))
				.status,
		).toBe(404);
		t.mojang.state.down = true;
		expect(
			(await call(t, t.editor, "POST", "/api/players", { uuid: NOTCH })).status,
		).toBe(502);
		expect(t.db.select().from(players).all()).toEqual([]);
	});

	test("a default head for a default skin", async () => {
		const t = await boot();
		const p = await addPlayer(t, JEB);
		const head = await t.app.request(`/api/players/${p.id}/head.png`);
		expect(head.status).toBe(200);
		expect(head.headers.get("content-type")).toBe("image/png");
	});

	test("anonymous visitors cannot add players", async () => {
		const t = await boot();
		expect(
			(await call(t, null, "POST", "/api/players", { uuid: NOTCH })).status,
		).toBe(401);
	});
});

describe("attribution", () => {
	test("owner and builders on create, edit, history and the player page", async () => {
		const t = await boot();
		const notch = await addPlayer(t, NOTCH);
		const jeb = await addPlayer(t, JEB);
		const layer = await makeLayer(t);

		const created = await call(
			t,
			t.editor,
			"POST",
			`/api/layers/${layer}/features`,
			pin({ owner: notch.id, builders: [jeb.id] }),
		);
		expect(created.status).toBe(201);
		expect(created.body.feature).toMatchObject({
			ownerId: notch.id,
			builderIds: [jeb.id],
			owner: notch,
			builders: [jeb],
		});
		const id = created.body.feature.id;

		const listed = await call(t, null, "GET", "/api/layers");
		expect(listed.body.layers[0].features[0].owner).toEqual(notch);

		// Changing only the name keeps the attribution.
		const renamed = await call(t, t.editor, "PATCH", `/api/features/${id}`, {
			name: "Castle",
		});
		expect(renamed.body.feature.owner).toEqual(notch);

		const moved = await call(t, t.editor, "PATCH", `/api/features/${id}`, {
			owner: jeb.id,
			builders: [],
		});
		expect(moved.body.feature).toMatchObject({ owner: jeb, builders: [] });

		const history = await call(t, null, "GET", `/api/features/${id}/history`);
		expect(
			history.body.history.map(
				(h: { owner: { name: string } | null }) => h.owner?.name,
			),
		).toEqual(["jeb_", "Notch", "Notch"]);

		const page = await call(t, null, "GET", `/api/players/${notch.id}`);
		expect(page.status).toBe(200);
		expect(page.body.owned).toEqual([]);
		expect(page.body.built).toEqual([]);
		expect(page.body.ownership).toMatchObject([
			{
				featureId: id,
				featureName: "Castle",
				from: notch.id,
				to: jeb.id,
				by: "editor",
			},
			{ featureId: id, featureName: "Base", from: null, to: notch.id },
		]);
		expect(page.body.players[jeb.id]).toEqual(jeb);

		const jebPage = await call(t, null, "GET", `/api/players/${JEB}`);
		expect(jebPage.body.owned).toMatchObject([
			{
				id,
				name: "Castle",
				type: "pin",
				dimension: "overworld",
				center: [10, 20],
			},
		]);

		const list = await call(t, null, "GET", "/api/players?q=j");
		expect(list.body.players).toEqual([{ ...jeb, owned: 1, built: 0 }]);
	});

	test("unknown player ids are refused", async () => {
		const t = await boot();
		const layer = await makeLayer(t);
		const res = await call(
			t,
			t.editor,
			"POST",
			`/api/layers/${layer}/features`,
			pin({ owner: 999 }),
		);
		expect(res.status).toBe(404);
		expect(res.body.error).toBe("player not found");
	});

	test("a builder listed twice is refused", async () => {
		const t = await boot();
		const notch = await addPlayer(t, NOTCH);
		const layer = await makeLayer(t);
		const res = await call(
			t,
			t.editor,
			"POST",
			`/api/layers/${layer}/features`,
			pin({ builders: [notch.id, notch.id] }),
		);
		expect(res.status).toBe(400);
	});

	test("feature_players follows deletes and restores", async () => {
		const t = await boot();
		const notch = await addPlayer(t, NOTCH);
		const layer = await makeLayer(t);
		const created = await call(
			t,
			t.editor,
			"POST",
			`/api/layers/${layer}/features`,
			pin({ owner: notch.id, builders: [notch.id] }),
		);
		const id = created.body.feature.id;
		const rows = () => t.db.select().from(featurePlayers).all().length;
		expect(rows()).toBe(2);
		await call(t, t.editor, "DELETE", `/api/features/${id}`);
		expect(rows()).toBe(0);
		const first = created.body.feature.revisionId;
		expect(
			(await call(t, t.mod, "POST", `/api/features/${id}/restore/${first}`))
				.status,
		).toBe(201);
		expect(rows()).toBe(2);
	});

	test("export gives players by UUID, and import adds the ones the map lacks", async () => {
		const source = await boot();
		const notch = await addPlayer(source, NOTCH);
		const layer = await makeLayer(source);
		await call(
			source,
			source.editor,
			"POST",
			`/api/layers/${layer}/features`,
			pin({ owner: notch.id }),
		);
		const exported = await call(
			source,
			null,
			"GET",
			`/api/layers/${layer}/export`,
		);
		expect(exported.body[0]).toMatchObject({
			owner: { uuid: NOTCH, name: "Notch" },
			builders: [],
		});

		const target = await boot();
		const other = await makeLayer(target);
		const imported = await call(
			target,
			target.editor,
			"POST",
			`/api/layers/${other}/import`,
			exported.body,
		);
		expect(imported.status).toBe(201);
		const added = target.db.select().from(players).all();
		expect(added).toMatchObject([{ uuid: NOTCH, name: "Notch", checkedAt: 0 }]);

		// The refresher checks players added by an import with Mojang.
		await target.services.playerRefresher.tick();
		const checked = target.db.select().from(players).get();
		expect(checked?.checkedAt).toBeGreaterThan(0);
		expect(checked?.head).not.toBeNull();
	});
});

describe("moderation", () => {
	test("refresh picks up a new name; only moderators", async () => {
		const t = await boot();
		const p = await addPlayer(t, NOTCH);
		(t.accounts[0] as Account).name = "Renamed";
		expect(
			(await call(t, t.editor, "POST", `/api/players/${p.id}/refresh`)).status,
		).toBe(403);
		const res = await call(t, t.mod, "POST", `/api/players/${p.id}/refresh`);
		expect(res.status).toBe(200);
		expect(res.body.player.name).toBe("Renamed");
	});

	test("only players nobody was ever attributed to can be deleted", async () => {
		const t = await boot();
		const used = await addPlayer(t, NOTCH);
		const unused = await addPlayer(t, JEB);
		const layer = await makeLayer(t);
		const created = await call(
			t,
			t.editor,
			"POST",
			`/api/layers/${layer}/features`,
			pin({ builders: [used.id] }),
		);
		// Still in the history after the builder is removed.
		await call(
			t,
			t.editor,
			"PATCH",
			`/api/features/${created.body.feature.id}`,
			{
				builders: [],
			},
		);
		expect(
			(await call(t, t.editor, "DELETE", `/api/players/${unused.id}`)).status,
		).toBe(403);
		expect(
			(await call(t, t.mod, "DELETE", `/api/players/${used.id}`)).status,
		).toBe(409);
		expect(
			(await call(t, t.mod, "DELETE", `/api/players/${unused.id}`)).status,
		).toBe(200);
	});
});
