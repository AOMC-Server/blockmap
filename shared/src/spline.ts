import type { LineCurve } from "./features";

type Pt = [number, number];

/** One piece of a curve: control points and the end, after the start of the piece. */
export type Bezier = [c1: Pt, c2: Pt, end: Pt];

/** The kinds of line that are curves. */
export type CurveKind = Exclude<LineCurve, "straight">;

type InPt = readonly [number, number];

/** Knot spacing exponent (centripetal): keeps the curve from looping at sharp turns. */
const ALPHA = 0.5;

const knot = (a: InPt, b: InPt) =>
	Math.max(Math.hypot(b[0] - a[0], b[1] - a[1]) ** ALPHA, 1e-3);

/** Solves a tridiagonal system: row i is `a[i] x[i-1] + b[i] x[i] + c[i] x[i+1] = r[i]`. */
function tridiagonal(a: number[], b: number[], c: number[], r: number[]) {
	const n = r.length;
	const cp = new Array<number>(n);
	const x = new Array<number>(n);
	let m = b[0] as number;
	cp[0] = (c[0] as number) / m;
	x[0] = (r[0] as number) / m;
	for (let i = 1; i < n; i++) {
		m = (b[i] as number) - (a[i] as number) * (cp[i - 1] as number);
		cp[i] = (c[i] as number) / m;
		x[i] = ((r[i] as number) - (a[i] as number) * (x[i - 1] as number)) / m;
	}
	for (let i = n - 2; i >= 0; i--)
		x[i] = (x[i] as number) - (cp[i] as number) * (x[i + 1] as number);
	return x;
}

/**
 * Solves a cyclic tridiagonal system (row 0 also has `a[0] x[n-1]`, row n-1 also has
 * `c[n-1] x[0]`), by Sherman-Morrison. Needs at least 3 rows.
 */
function cyclic(a: number[], b: number[], c: number[], r: number[]) {
	const n = r.length;
	const alpha = c[n - 1] as number;
	const beta = a[0] as number;
	const gamma = -(b[0] as number);
	const bb = b.slice();
	bb[0] = (b[0] as number) - gamma;
	bb[n - 1] = (b[n - 1] as number) - (alpha * beta) / gamma;
	const x = tridiagonal(a, bb, c, r);
	const u = new Array<number>(n).fill(0);
	u[0] = gamma;
	u[n - 1] = alpha;
	const z = tridiagonal(a, bb, c, u);
	const fact =
		((x[0] as number) + (beta * (x[n - 1] as number)) / gamma) /
		(1 + (z[0] as number) + (beta * (z[n - 1] as number)) / gamma);
	return x.map((v, i) => v - fact * (z[i] as number));
}

/**
 * The pieces of the cubic spline through `pts`, as cubic Béziers: the curve goes through every
 * point and its first and second derivatives are continuous everywhere (also where a closed curve
 * meets its start). An open curve has no curvature at its ends (a natural spline). Knots are
 * spaced centripetally.
 */
export function splineBeziers(pts: readonly InPt[], closed: boolean): Bezier[] {
	const n = pts.length;
	const P = (i: number): Pt => {
		const p = pts[((i % n) + n) % n] as InPt;
		return [p[0], p[1]];
	};
	if (n < 2) return n === 1 && closed ? [[P(0), P(0), P(0)]] : [];
	const segments = closed ? n : n - 1;
	const h: number[] = [];
	for (let i = 0; i < segments; i++) {
		h.push(knot(P(i), P(i + 1)));
	}
	const H = (i: number) => h[((i % segments) + segments) % segments] as number;

	// Unknowns: the derivative D[i] at each point. C2 at point i (between knot intervals
	// h[i-1] and h[i]):
	//   h[i] D[i-1] + 2 (h[i-1] + h[i]) D[i] + h[i-1] D[i+1]
	//     = 3 (h[i] (P[i] - P[i-1]) / h[i-1] + h[i-1] (P[i+1] - P[i]) / h[i])
	const a: number[] = [];
	const b: number[] = [];
	const c: number[] = [];
	const rx: number[] = [];
	const rz: number[] = [];
	for (let i = 0; i < n; i++) {
		const p = P(i);
		if (!closed && (i === 0 || i === n - 1)) {
			// Natural end: no second derivative.
			const q = i === 0 ? P(1) : P(n - 2);
			const hh = i === 0 ? H(0) : H(n - 2);
			const s = i === 0 ? 1 : -1;
			a.push(i === 0 ? 0 : 1);
			b.push(2);
			c.push(i === 0 ? 1 : 0);
			rx.push((s * 3 * (q[0] - p[0])) / hh);
			rz.push((s * 3 * (q[1] - p[1])) / hh);
			continue;
		}
		const h0 = H(i - 1);
		const h1 = H(i);
		const prev = P(i - 1);
		const next = P(i + 1);
		a.push(h1);
		b.push(2 * (h0 + h1));
		c.push(h0);
		rx.push(3 * ((h1 * (p[0] - prev[0])) / h0 + (h0 * (next[0] - p[0])) / h1));
		rz.push(3 * ((h1 * (p[1] - prev[1])) / h0 + (h0 * (next[1] - p[1])) / h1));
	}

	let dx: number[];
	let dz: number[];
	if (!closed) {
		dx = tridiagonal(a, b, c, rx);
		dz = tridiagonal(a, b, c, rz);
	} else if (n === 2) {
		// Both neighbours of each point are the other point.
		const m01 = (a[0] as number) + (c[0] as number);
		const m10 = (a[1] as number) + (c[1] as number);
		const det = (b[0] as number) * (b[1] as number) - m01 * m10;
		const solve = (r: number[]) => [
			((r[0] as number) * (b[1] as number) - m01 * (r[1] as number)) / det,
			((b[0] as number) * (r[1] as number) - m10 * (r[0] as number)) / det,
		];
		dx = solve(rx);
		dz = solve(rz);
	} else {
		dx = cyclic(a, b, c, rx);
		dz = cyclic(a, b, c, rz);
	}

	const out: Bezier[] = [];
	for (let i = 0; i < segments; i++) {
		const j = (i + 1) % n;
		const p1 = P(i);
		const p2 = P(i + 1);
		const k = (h[i] as number) / 3;
		out.push([
			[p1[0] + k * (dx[i] as number), p1[1] + k * (dz[i] as number)],
			[p2[0] - k * (dx[j] as number), p2[1] - k * (dz[j] as number)],
			p2,
		]);
	}
	return out;
}

/**
 * The pieces of the centripetal Catmull-Rom curve through `pts`, as cubic Béziers: the curve goes
 * through every point and keeps its direction there, but not its curvature. Each piece depends
 * only on the points next to it, and it never overshoots.
 */
export function catmullRomBeziers(
	pts: readonly InPt[],
	closed: boolean,
): Bezier[] {
	const n = pts.length;
	const at = (i: number): Pt => {
		let p: InPt;
		if (closed) p = pts[((i % n) + n) % n] as InPt;
		else if (i < 0) {
			const [a, b] = [pts[0] as InPt, pts[1] as InPt];
			return [2 * a[0] - b[0], 2 * a[1] - b[1]];
		} else if (i >= n) {
			const [a, b] = [pts[n - 1] as InPt, pts[n - 2] as InPt];
			return [2 * a[0] - b[0], 2 * a[1] - b[1]];
		} else p = pts[i] as InPt;
		return [p[0], p[1]];
	};
	const out: Bezier[] = [];
	if (n < 2 && !(closed && n === 1)) return out;
	const count = closed ? n : n - 1;
	for (let i = 0; i < count; i++) {
		const p0 = at(i - 1);
		const p1 = at(i);
		const p2 = at(i + 1);
		const p3 = at(i + 2);
		const d1 = knot(p0, p1);
		const d2 = knot(p1, p2);
		const d3 = knot(p2, p3);
		const tangent = (k: 0 | 1) => {
			const t1 =
				(p1[k] - p0[k]) / d1 -
				(p2[k] - p0[k]) / (d1 + d2) +
				(p2[k] - p1[k]) / d2;
			const t2 =
				(p2[k] - p1[k]) / d2 -
				(p3[k] - p1[k]) / (d2 + d3) +
				(p3[k] - p2[k]) / d3;
			return [d2 * t1, d2 * t2] as const;
		};
		const [x1, x2] = tangent(0);
		const [z1, z2] = tangent(1);
		out.push([
			[p1[0] + x1 / 3, p1[1] + z1 / 3],
			[p2[0] - x2 / 3, p2[1] - z2 / 3],
			p2,
		]);
	}
	return out;
}

/** The pieces of the curve of the given kind through `pts`, as cubic Béziers. */
export function curveBeziers(
	pts: readonly InPt[],
	closed: boolean,
	curve: CurveKind,
): Bezier[] {
	return curve === "smooth"
		? splineBeziers(pts, closed)
		: catmullRomBeziers(pts, closed);
}
