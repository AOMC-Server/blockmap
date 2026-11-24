import { describe, expect, test } from "bun:test";
import { buildRenderLayers, countFeatures } from "./renderLayers";

const layer = (id: number, features: { id: number; layerId: number }[]) => ({
	id,
	color: "red" as const,
	style: null,
	features,
});
const f = (id: number, layerId: number) => ({ id, layerId });

describe("buildRenderLayers", () => {
	test("draws a feature once, under its home layer", () => {
		const layers = [
			layer(1, [f(10, 1), f(11, 2)]),
			layer(2, [f(11, 2), f(10, 1)]),
		];
		const out = buildRenderLayers(layers, () => false);
		expect(out.map((l) => [l.id, l.features.map((x) => x.id)])).toEqual([
			[1, [10]],
			[2, [11]],
		]);
	});

	test("a feature shows while any layer it is in is on", () => {
		const layers = [layer(1, [f(10, 1)]), layer(2, [f(10, 1)])];
		const out = buildRenderLayers(layers, (l) => l.id === 1);
		expect(out.map((l) => l.id)).toEqual([1]);
		expect(buildRenderLayers(layers, () => true)).toEqual([]);
	});

	test("a hidden home layer still styles the feature", () => {
		const layers = [layer(1, [f(10, 1)]), layer(2, [f(10, 1)])];
		const out = buildRenderLayers(layers, (l) => l.id === 1);
		expect(out.map((l) => l.id)).toEqual([1]);
		expect(out[0]?.features.map((x) => x.id)).toEqual([10]);
	});

	test("a feature with an unknown home goes under the first visible layer listing it", () => {
		const layers = [
			layer(1, [f(10, 9)]),
			layer(2, [f(10, 9)]),
			layer(3, [f(10, 9)]),
		];
		const out = buildRenderLayers(layers, (l) => l.id === 1);
		expect(out.map((l) => [l.id, l.features.length])).toEqual([[2, 1]]);
	});

	test("only draws the features the predicate accepts", () => {
		const layers = [layer(1, [f(10, 1), f(11, 1)]), layer(2, [f(12, 2)])];
		const out = buildRenderLayers(
			layers,
			() => false,
			(x) => x.id !== 11,
		);
		expect(out.map((l) => [l.id, l.features.map((x) => x.id)])).toEqual([
			[1, [10]],
			[2, [12]],
		]);
		expect(
			buildRenderLayers(
				layers,
				() => false,
				() => false,
			),
		).toEqual([]);
	});

	test("a filter does not switch layers on", () => {
		const layers = [layer(1, [f(10, 1)]), layer(2, [f(11, 2)])];
		const out = buildRenderLayers(
			layers,
			(l) => l.id === 2,
			() => true,
		);
		expect(out.map((l) => l.id)).toEqual([1]);
	});

	test("a feature in two layers is drawn while one occurrence passes", () => {
		const layers = [layer(1, [f(10, 1)]), layer(2, [f(10, 1)])];
		const out = buildRenderLayers(
			layers,
			() => false,
			() => true,
		);
		expect(out.map((l) => [l.id, l.features.length])).toEqual([[1, 1]]);
	});

	test("a feature with an unknown home that fails the filter is not drawn", () => {
		const layers = [layer(1, [f(10, 9)]), layer(2, [f(10, 9), f(11, 9)])];
		const out = buildRenderLayers(
			layers,
			() => false,
			(x) => x.id === 11,
		);
		expect(out.map((l) => [l.id, l.features.map((x) => x.id)])).toEqual([
			[2, [11]],
		]);
	});
});

describe("countFeatures", () => {
	const layers = [
		layer(1, [f(10, 1), f(11, 1)]),
		layer(2, [f(11, 1), f(12, 2)]),
		layer(3, [f(13, 3)]),
	];

	test("counts each feature of the layers that are on once", () => {
		expect(
			countFeatures(
				layers,
				(l) => l.id === 3,
				(x) => x.id !== 12,
			),
		).toEqual({ shown: 2, total: 3 });
	});

	test("nothing is shown when every layer is off", () => {
		expect(
			countFeatures(
				layers,
				() => true,
				() => true,
			),
		).toEqual({ shown: 0, total: 0 });
	});
});
