import { describe, expect, test } from "bun:test";
import { addLayer, makePrimary, matchLayers, removeLayer } from "./layerPick";

const pick = { primary: 1, also: [2, 3] };

describe("layer pick", () => {
	test("adding keeps what is there", () => {
		expect(addLayer(pick, 4)).toEqual({ primary: 1, also: [2, 3, 4] });
		expect(addLayer(pick, 2)).toBe(pick);
		expect(addLayer(pick, 1)).toBe(pick);
	});

	test("removing never removes the primary", () => {
		expect(removeLayer(pick, 2)).toEqual({ primary: 1, also: [3] });
		expect(removeLayer(pick, 1)).toBe(pick);
		expect(removeLayer(pick, 9)).toBe(pick);
	});

	test("making a layer primary swaps it with the old primary", () => {
		expect(makePrimary(pick, 3)).toEqual({ primary: 3, also: [2, 1] });
		expect(makePrimary(pick, 1)).toBe(pick);
		// A layer that was not picked yet joins as the primary.
		expect(makePrimary(pick, 7)).toEqual({ primary: 7, also: [1, 2, 3] });
	});

	test("searching ignores case, and names that start with it come first", () => {
		const layers = [
			{ name: "Roads" },
			{ name: "Nether roads" },
			{ name: "Bases" },
			{ name: "road signs" },
		];
		expect(matchLayers(layers, " ROAD ").map((l) => l.name)).toEqual([
			"Roads",
			"road signs",
			"Nether roads",
		]);
		expect(matchLayers(layers, "")).toHaveLength(4);
		expect(matchLayers(layers, "zzz")).toEqual([]);
	});
});
