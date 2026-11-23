import { describe, expect, test } from "bun:test";
import { dashPattern, hitTolerance, resolveStyle } from "./featureStyle";

describe("resolveStyle", () => {
	test("no style is the look features had before styles", () => {
		expect(resolveStyle(null, false)).toEqual({
			dash: "solid",
			width: 3,
			opacity: 1,
			fill: "solid",
			fillOpacity: 0.2,
			curve: "straight",
		});
		expect(resolveStyle(undefined, true).width).toBe(2);
		expect(resolveStyle({ curve: "smooth" }, false).curve).toBe("smooth");
		expect(resolveStyle(null, false, { curve: "curved" }).curve).toBe("curved");
		expect(
			resolveStyle({ curve: "straight" }, false, { curve: "smooth" }).curve,
		).toBe("straight");
	});

	test("the old smooth switch is read as a curve", () => {
		expect(resolveStyle({ smooth: true }, false).curve).toBe("curved");
		expect(
			resolveStyle({ smooth: false }, false, { curve: "smooth" }).curve,
		).toBe("straight");
		expect(resolveStyle(null, false, { smooth: true }).curve).toBe("curved");
		expect(resolveStyle({ smooth: true, curve: "smooth" }, false).curve).toBe(
			"smooth",
		);
	});

	test("what is set wins, the rest stays default", () => {
		expect(resolveStyle({ dash: "dotted", fill: "none" }, true)).toMatchObject({
			dash: "dotted",
			width: 2,
			fill: "none",
			fillOpacity: 0.2,
		});
		expect(resolveStyle({ width: 7, fillOpacity: 0 }, true)).toMatchObject({
			width: 7,
			fillOpacity: 0,
		});
	});
});

describe("a layer's default style", () => {
	test("is used for what the feature leaves unset", () => {
		const layer = { dash: "dashed", width: 6, fill: "stripes" } as const;
		expect(resolveStyle(null, false, layer)).toMatchObject({
			dash: "dashed",
			width: 6,
			fill: "stripes",
			opacity: 1,
		});
		expect(
			resolveStyle({ width: 2, dash: "solid" }, true, layer),
		).toMatchObject({ dash: "solid", width: 2, fill: "stripes" });
	});

	test("without one, areas keep their thinner outline", () => {
		expect(resolveStyle(null, true, null).width).toBe(2);
		expect(resolveStyle(null, true, { width: 5 }).width).toBe(5);
	});
});

test("a thick line is easier to hit", () => {
	expect(hitTolerance(1)).toBe(7);
	expect(hitTolerance(10)).toBe(9);
});

describe("dashPattern", () => {
	test("solid has no dashes; the others grow with the width", () => {
		expect(dashPattern("solid", 5)).toEqual([]);
		const [on1, off1] = dashPattern("dashed", 1) as [number, number];
		const [on9, off9] = dashPattern("dashed", 9) as [number, number];
		expect(on9).toBeGreaterThan(on1);
		expect(off9).toBeGreaterThan(off1);
		const [dot, gap] = dashPattern("dotted", 4) as [number, number];
		expect(dot).toBeLessThan(1);
		expect(gap).toBeGreaterThan(4);
	});
});
