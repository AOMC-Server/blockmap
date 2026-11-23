import { describe, expect, test } from "bun:test";
import { alsoInChange } from "./featureLayers";

describe("alsoInChange", () => {
	test("is null without an older version or without a change", () => {
		expect(alsoInChange(undefined, [1])).toBeNull();
		expect(alsoInChange([1, 2], [2, 1])).toBeNull();
	});

	test("lists added and removed layers", () => {
		expect(alsoInChange([1, 2], [2, 3])).toEqual({ added: [3], removed: [1] });
		expect(alsoInChange([], [4])).toEqual({ added: [4], removed: [] });
	});
});
