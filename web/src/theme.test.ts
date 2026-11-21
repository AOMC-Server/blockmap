import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { STYLES } from "@aomc-server/block-ui/theme";
import { DYE_HEX, DYES } from "@blockmap/shared/colors";
import { DIMENSION_THEMES } from "@blockmap/shared/schemas";
import { DIMENSION_THEME_NAMES } from "./theme";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

describe("dimension palettes", () => {
	test("every dimension theme has a name", () => {
		expect(Object.keys(DIMENSION_THEME_NAMES).sort()).toEqual(
			[...DIMENSION_THEMES].sort(),
		);
	});

	test("styles.css defines every palette in both modes", () => {
		for (const palette of DIMENSION_THEMES) {
			for (const mode of ["dark", "light"]) {
				expect(css).toContain(
					`[data-palette="${palette}"][data-mode="${mode}"]`,
				);
			}
		}
	});

	test("every palette sets the colours of the map", () => {
		for (const palette of DIMENSION_THEMES) {
			for (const mode of ["dark", "light"]) {
				const start = css.indexOf(
					`[data-palette="${palette}"][data-mode="${mode}"]`,
				);
				const block = css.slice(start, css.indexOf("}", start));
				for (const token of ["--map-bg", "--dye-shade"])
					expect(block, `${palette} ${mode} ${token}`).toContain(`${token}:`);
			}
		}
	});

	test("the non-bedrock styles have their blocks for what the map adds", () => {
		for (const style of STYLES.filter((s) => s.id !== "bedrock")) {
			expect(css).toContain(
				`@scope ([data-style="${style.id}"]) to ([data-style])`,
			);
		}
	});
});

describe("dye palettes", () => {
	test("every dye has one, in the colour the map draws it in", () => {
		for (const dye of DYES) {
			const rule = new RegExp(
				`\\[data-palette="dye-${dye}"\\]\\s*\\{\\s*--dye:\\s*(#[0-9a-f]{6});`,
			).exec(css);
			expect(rule?.[1], dye).toBe(DYE_HEX[dye]);
		}
	});

	test("the dark and light ones set the surfaces and the text", () => {
		for (const mode of ["dark", "light"]) {
			const start = css.indexOf(`[data-palette^="dye-"][data-mode="${mode}"]`);
			expect(start).toBeGreaterThan(0);
			const block = css.slice(start, css.indexOf("}", start));
			for (const token of [
				"--ink",
				"--well",
				"--s1",
				"--s2",
				"--text",
				"--chrome",
			])
				expect(block, `${mode} ${token}`).toContain(`${token}:`);
		}
	});

	test("the tooltip's stronger palette never mixes in more than all of the dye", () => {
		const k = Number(
			/\.palette-scope\.strong,\s*[^{]*\{\s*--dye-k:\s*([\d.]+);/.exec(
				css,
			)?.[1],
		);
		expect(k).toBeGreaterThan(1);
		const amounts = [
			...css.matchAll(/calc\((\d+)% \* var\(--dye-k, 1\)\)/g),
		].map((m) => Number(m[1]));
		expect(amounts.length).toBeGreaterThan(10);
		for (const n of amounts) expect(n * k).toBeLessThanOrEqual(100);
	});
});
