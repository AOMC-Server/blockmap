import { describe, expect, test } from "bun:test";
import {
	type Attribution,
	attributionChange,
	featureMapUrl,
	groupPlayerFeatures,
	MAX_RECENT_PLAYERS,
	type PlayerFeature,
	parseRecentPlayers,
	withRecentPlayer,
} from "./players";

const player = (id: number, name: string) => ({ id, uuid: `uuid-${id}`, name });
const A = player(1, "Alex");
const B = player(2, "Beth");
const C = player(3, "Cyd");

const attribution = (
	owner: ReturnType<typeof player> | null,
	builders: ReturnType<typeof player>[] = [],
): Attribution => ({
	ownerId: owner?.id ?? null,
	owner,
	builderIds: builders.map((b) => b.id),
	builders,
});

describe("attributionChange", () => {
	test("nothing changed", () => {
		const a = attribution(A, [B]);
		expect(attributionChange(a, attribution(A, [B]))).toBeNull();
		expect(attributionChange(null, attribution(null))).toBeNull();
	});

	test("owner replaced, set and removed", () => {
		expect(attributionChange(attribution(A), attribution(B))?.owner).toEqual({
			from: A,
			to: B,
		});
		expect(attributionChange(attribution(null), attribution(B))?.owner).toEqual(
			{ from: null, to: B },
		);
		expect(attributionChange(attribution(A), attribution(null))?.owner).toEqual(
			{ from: A, to: null },
		);
	});

	test("builders added and removed", () => {
		const out = attributionChange(
			attribution(A, [B, C]),
			attribution(A, [C, A]),
		);
		expect(out?.owner).toBeNull();
		expect(out?.added).toEqual([A]);
		expect(out?.removed).toEqual([B]);
	});

	test("a first version lists everything as new", () => {
		const out = attributionChange(null, attribution(A, [B]));
		expect(out?.owner).toEqual({ from: null, to: A });
		expect(out?.added).toEqual([B]);
		expect(out?.removed).toEqual([]);
	});
});

describe("featureMapUrl", () => {
	test("names the feature, so the map can go to it", () => {
		expect(
			featureMapUrl({ id: 7, dimension: "nether", center: [10, -20] }),
		).toBe("/?dim=nether&x=10&z=-20&feature=7");
	});
});

describe("recent players", () => {
	test("a pick goes to the front, once, and the oldest fall off", () => {
		expect(withRecentPlayer([A, B], C)).toEqual([C, A, B]);
		expect(withRecentPlayer([A, B, C], B)).toEqual([B, A, C]);
		const many = Array.from({ length: MAX_RECENT_PLAYERS }, (_, i) =>
			player(i + 10, `P${i}`),
		);
		const next = withRecentPlayer(many, A);
		expect(next).toHaveLength(MAX_RECENT_PLAYERS);
		expect(next[0]).toBe(A);
		expect(next).not.toContainEqual(many.at(-1));
	});

	test("stored lists are read leniently", () => {
		expect(parseRecentPlayers(JSON.stringify([A, B]))).toEqual([A, B]);
		expect(parseRecentPlayers(null)).toEqual([]);
		expect(parseRecentPlayers("not json")).toEqual([]);
		expect(parseRecentPlayers('{"a":1}')).toEqual([]);
		expect(
			parseRecentPlayers(
				JSON.stringify([A, { id: "x" }, null, 3, { ...A, name: 4 }, A, B]),
			),
		).toEqual([A, B]);
	});
});

describe("groupPlayerFeatures", () => {
	const feature = (
		id: number,
		layerId: number,
		extra: Partial<PlayerFeature> = {},
	): PlayerFeature => ({
		id,
		layerId,
		layerName: `Layer ${layerId}`,
		layerColor: "red",
		dimension: "overworld",
		type: "pin",
		name: `Feature ${id}`,
		color: null,
		center: [0, 0],
		ownerId: A.id,
		builderIds: [],
		...extra,
	});
	const players = new Map([A, B, C].map((p) => [p.id, p]));

	test("one row per feature, grouped by layer, the layers with most owned first", () => {
		const shared = feature(3, 20, { builderIds: [A.id] });
		const groups = groupPlayerFeatures({
			playerId: A.id,
			owned: [feature(1, 10), shared, feature(4, 20)],
			built: [shared, feature(2, 10, { ownerId: B.id, builderIds: [A.id] })],
			players,
		});
		expect(groups.map((g) => [g.layerId, g.owned, g.built])).toEqual([
			[20, 2, 1],
			[10, 1, 1],
		]);
		expect(groups[0]?.features.map((f) => [f.id, f.owns, f.built])).toEqual([
			[3, true, true],
			[4, true, false],
		]);
		expect(
			groupPlayerFeatures({
				playerId: A.id,
				owned: [feature(1, 10), shared, feature(4, 20)],
				built: [shared, feature(2, 10, { ownerId: B.id, builderIds: [A.id] })],
				players,
				sort: "name",
			}).map((g) => g.layerId),
		).toEqual([10, 20]);
	});

	test("the others are the owner, then the builders, without the player", () => {
		const [group] = groupPlayerFeatures({
			playerId: A.id,
			owned: [],
			built: [
				feature(1, 10, { ownerId: B.id, builderIds: [A.id, B.id, C.id] }),
			],
			players,
		});
		expect(group?.features[0]?.others).toEqual([
			{ player: B, role: "owner" },
			{ player: C, role: "builder" },
		]);
	});

	test("search: a matching layer whole, else matching features or players", () => {
		const opts = {
			playerId: A.id,
			owned: [
				feature(1, 10, { name: "Castle" }),
				feature(2, 10, { name: "Farm", builderIds: [C.id] }),
				feature(3, 20, { name: "Tower" }),
			],
			built: [],
			players,
		};
		const ids = (query: string) =>
			groupPlayerFeatures({ ...opts, query }).flatMap((g) =>
				g.features.map((f) => f.id),
			);
		expect(ids("cast")).toEqual([1]);
		expect(ids("cyd")).toEqual([2]);
		expect(ids("layer 20")).toEqual([3]);
		expect(ids("nothing")).toEqual([]);
	});
});
