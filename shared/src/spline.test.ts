import { describe, expect, test } from "bun:test";
import { type Bezier, splineBeziers } from "./spline";

type Pt = [number, number];

/** Derivatives at the start (t = 0) and end (t = 1) of a piece, per unit of its own parameter. */
const ends = (from: Pt, [c1, c2, end]: Bezier) => ({
	d1Start: [3 * (c1[0] - from[0]), 3 * (c1[1] - from[1])],
	d1End: [3 * (end[0] - c2[0]), 3 * (end[1] - c2[1])],
	d2Start: [
		6 * (from[0] - 2 * c1[0] + c2[0]),
		6 * (from[1] - 2 * c1[1] + c2[1]),
	],
	d2End: [6 * (c1[0] - 2 * c2[0] + end[0]), 6 * (c1[1] - 2 * c2[1] + end[1])],
});

const knot = (a: Pt, b: Pt) => Math.hypot(b[0] - a[0], b[1] - a[1]) ** 0.5;

/** Checks the derivatives (by the knot parameter) match where each piece meets the next. */
function expectC2(pts: Pt[], closed: boolean) {
	const bz = splineBeziers(pts, closed);
	const starts = [pts[0] as Pt, ...bz.map((b) => b[2])];
	const joints = closed ? bz.length : bz.length - 1;
	for (let i = 0; i < joints; i++) {
		const j = (i + 1) % bz.length;
		const hi = knot(starts[i] as Pt, bz[i]?.[2] as Pt);
		const hj = knot(starts[j] as Pt, bz[j]?.[2] as Pt);
		const a = ends(starts[i] as Pt, bz[i] as Bezier);
		const b = ends(starts[j] as Pt, bz[j] as Bezier);
		for (const k of [0, 1]) {
			expect((a.d1End[k] as number) / hi).toBeCloseTo(
				(b.d1Start[k] as number) / hj,
				6,
			);
			expect((a.d2End[k] as number) / hi ** 2).toBeCloseTo(
				(b.d2Start[k] as number) / hj ** 2,
				6,
			);
		}
	}
	return bz;
}

describe("splineBeziers", () => {
	const zigzag: Pt[] = [
		[0, 0],
		[10, 4],
		[13, 20],
		[40, 22],
		[41, 0],
		[70, 5],
	];

	test("goes through every point", () => {
		const bz = splineBeziers(zigzag, false);
		expect(bz.map((b) => b[2])).toEqual(zigzag.slice(1));
		expect(splineBeziers(zigzag, true).map((b) => b[2])).toEqual([
			...zigzag.slice(1),
			zigzag[0] as Pt,
		]);
	});

	test("has a continuous second derivative, open and closed", () => {
		expectC2(zigzag, false);
		expectC2(zigzag, true);
		expectC2(zigzag.slice(0, 3), true);
	});

	test("no curvature at the ends of an open curve", () => {
		const bz = splineBeziers(zigzag, false);
		const first = ends(zigzag[0] as Pt, bz[0] as Bezier).d2Start;
		const last = ends(bz.at(-2)?.[2] as Pt, bz.at(-1) as Bezier).d2End;
		for (const v of [...first, ...last]) expect(v).toBeCloseTo(0, 6);
	});

	test("two points make a straight line", () => {
		const [b] = splineBeziers(
			[
				[0, 0],
				[9, 3],
			],
			false,
		);
		const want = [
			[3, 1],
			[6, 2],
			[9, 3],
		];
		for (const [i, p] of want.entries())
			for (const k of [0, 1])
				expect(b?.[i]?.[k] as number).toBeCloseTo(p[k] as number, 9);
	});
});
