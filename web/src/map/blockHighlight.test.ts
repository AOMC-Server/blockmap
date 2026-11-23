import { describe, expect, test } from "bun:test";
import { hoveredBlockRect } from "./blockHighlight";

describe("hoveredBlockRect", () => {
	const size = { width: 100, height: 100 };

	test("covers the whole block under the pointer", () => {
		// zoom -3: 8 px per block, so the centre (50, 50) is the corner of block 0, 0.
		const view = { centerX: 0, centerZ: 0, zoom: -3 };
		expect(hoveredBlockRect(view, size, 53, 57)).toEqual({
			x: 50,
			y: 50,
			size: 8,
		});
		expect(hoveredBlockRect(view, size, 49, 50)).toEqual({
			x: 42,
			y: 50,
			size: 8,
		});
	});

	test("rounds negative coordinates down to the block", () => {
		const view = { centerX: -0.5, centerZ: -0.5, zoom: -3 };
		expect(hoveredBlockRect(view, size, 50, 50)).toEqual({
			x: 46,
			y: 46,
			size: 8,
		});
	});

	test("nothing when blocks are too small to point at", () => {
		expect(
			hoveredBlockRect({ centerX: 0, centerZ: 0, zoom: -1 }, size, 50, 50),
		).toBeNull();
	});
});
