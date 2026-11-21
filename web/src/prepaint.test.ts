import { describe, expect, test } from "bun:test";
import { prepaintScript } from "@aomc-server/block-ui/theme";
import { DIMENSION_THEMES } from "@blockmap/shared/schemas";
import { prepaint } from "./prepaint";

/** Runs the inline script of index.html like a browser would: against a fake <html>, storage and media query. */
function run(
	stored: Record<string, unknown>,
	where: { pathname?: string; search?: string } = {},
	light = false,
) {
	const dataset: Record<string, string> = {};
	const storage = {
		getItem: (k: string) => (k in stored ? JSON.stringify(stored[k]) : null),
	};
	new Function(
		"document",
		"localStorage",
		"matchMedia",
		"location",
		prepaintScript(prepaint),
	)({ documentElement: { dataset } }, storage, () => ({ matches: light }), {
		pathname: "/",
		search: "",
		...where,
	});
	return dataset;
}

const palette = (p: string, dim = "nether") => ({
	"blockmap.palette": { dim, palette: p },
});

describe("the script of index.html", () => {
	test("knows the same palettes as the app", () => {
		expect(prepaint.palettes).toEqual([...DIMENSION_THEMES]);
	});

	test("starts dark, bedrock and overworld when nothing is saved", () => {
		expect(run({})).toEqual({
			mode: "dark",
			style: "bedrock",
			palette: "overworld",
		});
	});

	test("applies the saved mode and style; system follows the media query", () => {
		const settings = (mode: string) => ({
			"blockmap.settings": { mode, style: "xp" },
		});
		expect(run(settings("light"))).toMatchObject({
			mode: "light",
			style: "xp",
		});
		expect(run(settings("system"), {}, true).mode).toBe("light");
		expect(run(settings("system"), {}, false).mode).toBe("dark");
		expect(
			run({ "blockmap.settings": { mode: "dim", style: "vista" } }),
		).toMatchObject({ mode: "dark", style: "bedrock" });
	});

	test("the map opens in the palette last shown", () => {
		expect(run(palette("nether")).palette).toBe("nether");
		expect(run(palette("nope")).palette).toBe("overworld");
	});

	test("but only for the same dimension", () => {
		expect(run(palette("end", "end"), { search: "?dim=end" }).palette).toBe(
			"end",
		);
		expect(run(palette("end", "end"), { search: "?dim=nether" }).palette).toBe(
			"overworld",
		);
	});

	test("not when the colours do not follow the dimension, nor on the other pages", () => {
		const off = {
			...palette("nether"),
			"blockmap.settings": { dimensionColours: false },
		};
		expect(run(off).palette).toBe("overworld");
		for (const pathname of ["/settings", "/manage/", "/stats", "/invite/abc"])
			expect(run(palette("nether"), { pathname }).palette, pathname).toBe(
				"overworld",
			);
	});
});
