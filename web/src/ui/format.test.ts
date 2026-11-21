import { describe, expect, test } from "bun:test";
import { formatTime } from "@aomc-server/block-ui/format";
import { formatEventDay, formatEventTime } from "./format";

describe("event time", () => {
	test("is the export time, or else when it was uploaded", () => {
		const exported = {
			exportedAt: 1_700_000_000_000,
			createdAt: 1_800_000_000_000,
		};
		expect(formatEventTime(exported)).toBe(formatTime(exported.exportedAt));
		const plain = { exportedAt: null, createdAt: 1_800_000_000_000 };
		expect(formatEventTime(plain)).toBe(formatTime(plain.createdAt));
		expect(formatEventDay(plain)).toBe(
			new Date(plain.createdAt).toLocaleDateString(undefined, {
				dateStyle: "medium",
			}),
		);
	});
});
