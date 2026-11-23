import {
	type AREA_FILLS,
	DEFAULT_AREA_LINE_WIDTH,
	DEFAULT_FILL_OPACITY,
	DEFAULT_LINE_WIDTH,
	type FeatureStyle,
	type LINE_DASHES,
	type LineCurve,
	mergeStyle,
} from "./features";
import type { CurveKind } from "./spline";

export type ResolvedStyle = {
	dash: (typeof LINE_DASHES)[number];
	width: number;
	opacity: number;
	fill: (typeof AREA_FILLS)[number];
	fillOpacity: number;
	curve: LineCurve;
};

/**
 * The style with the defaults filled in: what the feature sets, else what its layer sets
 * (`layerStyle`), else the built-in look. `area` is for the outline of an area, which is thinner.
 */
export function resolveStyle(
	style: FeatureStyle | null | undefined,
	area: boolean,
	layerStyle?: FeatureStyle | null,
): ResolvedStyle {
	const s = mergeStyle(layerStyle, style);
	return {
		dash: s.dash ?? "solid",
		width: s.width ?? (area ? DEFAULT_AREA_LINE_WIDTH : DEFAULT_LINE_WIDTH),
		opacity: s.opacity ?? 1,
		fill: s.fill ?? "solid",
		fillOpacity: s.fillOpacity ?? DEFAULT_FILL_OPACITY,
		curve: s.curve ?? "straight",
	};
}

/** The curve a line in this style is drawn as, or null when it is straight. */
export const curveOf = (style: ResolvedStyle): CurveKind | null =>
	style.curve === "straight" ? null : style.curve;

/** Canvas dash lengths (screen px) for a line of the given width; dots need round caps. */
export function dashPattern(
	dash: ResolvedStyle["dash"],
	width: number,
): number[] {
	if (dash === "dashed") return [8 + 2 * width, 5 + 2 * width];
	if (dash === "dotted") return [0.01, 2.5 * width + 4];
	return [];
}

/** Width of a line when it is hovered or selected: a little thicker, and never thinner than 5. */
export const emphasisedWidth = (width: number) => Math.max(width + 2, 5);

/** How far from a line (in screen pixels) a click still hits it. */
export const hitTolerance = (width: number) => Math.max(7, width / 2 + 4);
