import { describe, expect, test } from "bun:test";
import { formatTime } from "@aomc-server/block-ui/format";
import { formatBytes, formatEventDay, formatEventTime } from "./format";

describe("formatBytes", () => {
	test("keeps the KB and MB labels", () => {
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(2048)).toBe("2.00 KB");
		expect(formatBytes(5 * 1024 * 1024)).toBe("5.00 MB");
		expect(formatBytes(150 * 1024)).toBe("150 KB");
	});
});

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
