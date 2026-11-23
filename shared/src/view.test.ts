import { describe, expect, test } from "bun:test";
import { convertBlock, scaleRatio } from "./view";

describe("scaleRatio", () => {
	test("blocks of the target per block of the source", () => {
		expect(scaleRatio(1, 8)).toBe(1 / 8);
		expect(scaleRatio(8, 1)).toBe(8);
		expect(scaleRatio(null, 1)).toBeNull();
		expect(scaleRatio(1, null)).toBeNull();
	});
});

describe("convertBlock", () => {
	test("overworld to Nether divides by 8, flooring", () => {
		expect(convertBlock(100, 17, 1, 8)).toEqual({ x: 12, z: 2 });
		expect(convertBlock(-1, -9, 1, 8)).toEqual({ x: -1, z: -2 });
		expect(convertBlock(-8, 7, 1, 8)).toEqual({ x: -1, z: 0 });
	});

	test("Nether to overworld multiplies by 8", () => {
		expect(convertBlock(12, -2, 8, 1)).toEqual({ x: 96, z: -16 });
	});

	test("other scales", () => {
		expect(convertBlock(10, -3, 2.5, 1)).toEqual({ x: 25, z: -8 });
	});

	test("unrelated dimensions have no match", () => {
		expect(convertBlock(1, 2, null, 1)).toBeNull();
		expect(convertBlock(1, 2, 1, null)).toBeNull();
	});
});
