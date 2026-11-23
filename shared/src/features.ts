import * as z from "zod/mini";
import { DYES } from "./colors";
import { MAX_BUILDERS, type PlayerRef, playerRefSchema } from "./players";
import { blockCoord, MAX_NAME, nonEmpty } from "./schemas";

export { MAX_NAME };
export const MAX_POPUP = 2000;
export const MAX_VERTICES = 2000;
export const MAX_FEATURES_PER_LAYER = 5000;
/** Most layers besides its home that one feature can be shown in. */
export const MAX_ALSO_IN = 50;
/** Live (not deleted) layers one user may have created; moderators are exempt. */
export const MAX_LAYERS_PER_USER = 50;
/** Largest JSON request body the server takes (uploads have their own limit). */
export const MAX_JSON_BYTES = 16 * 1024 * 1024;
/** Entries of a feature's history per request unless asked for fewer. */
export const DEFAULT_HISTORY_LIMIT = 50;
export const MAX_HISTORY_LIMIT = 200;

export const FEATURE_TYPES = ["pin", "line", "polygon"] as const;
type FeatureTypeName = (typeof FEATURE_TYPES)[number];

export const dyeSchema = z.enum(DYES);

/** [x, z] in block coordinates. */
export const pointSchema = z.tuple([blockCoord, blockCoord]);
export type Point = z.infer<typeof pointSchema>;

const distinctPoints = (points: Point[]) =>
	new Set(points.map((p) => `${p[0]},${p[1]}`)).size;

/** Twice the signed area, exact for any coordinates. */
function doubleArea(points: Point[]): bigint {
	let sum = 0n;
	for (let i = 0; i < points.length; i++) {
		const [x1, z1] = points[i] as Point;
		const [x2, z2] = points[(i + 1) % points.length] as Point;
		sum += BigInt(x1) * BigInt(z2) - BigInt(x2) * BigInt(z1);
	}
	return sum;
}

const linePath = z.array(pointSchema).check(
	z.minLength(2),
	z.maxLength(MAX_VERTICES),
	z.refine((g) => distinctPoints(g) >= 2, "a line needs two different points"),
);

/**
 * A line is one path, `[[x, z], ...]`, or several, `[[[x, z], ...], ...]`. A path that ends
 * where it starts is a closed loop, and paths that share a block are joined there, which is how
 * a line branches.
 */
const lineGeometry = z.union([
	linePath,
	z.array(linePath).check(
		z.minLength(1),
		z.refine(
			(paths) => paths.reduce((n, p) => n + p.length, 0) <= MAX_VERTICES,
			`a line can have at most ${MAX_VERTICES} points`,
		),
	),
]);
export type LineGeometry = z.infer<typeof lineGeometry>;

/** The paths of a line, whichever of the two forms it is stored in. */
export function linePaths(geometry: LineGeometry): Point[][] {
	const [first] = geometry;
	return first !== undefined && Array.isArray(first[0])
		? (geometry as Point[][])
		: [geometry as Point[]];
}
const polygonGeometry = z.array(pointSchema).check(
	z.minLength(3),
	z.maxLength(MAX_VERTICES),
	z.refine(
		(g) => distinctPoints(g) >= 3,
		"an area needs three different points",
	),
	z.refine((g) => doubleArea(g) !== 0n, "an area cannot be flat"),
);

export const LINE_DASHES = ["solid", "dashed", "dotted"] as const;
export const AREA_FILLS = [
	"none",
	"solid",
	"stripes",
	"crosshatch",
	"dots",
] as const;
/**
 * How a line goes through its points: straight segments, a curve that keeps its direction
 * (Catmull-Rom), or one that also keeps its curvature (a cubic spline), which is rounder.
 */
export const LINE_CURVES = ["straight", "curved", "smooth"] as const;
export type LineCurve = (typeof LINE_CURVES)[number];
export const MIN_LINE_WIDTH = 1;
export const MAX_LINE_WIDTH = 10;
export const DEFAULT_LINE_WIDTH = 3;
export const DEFAULT_AREA_LINE_WIDTH = 2;
export const DEFAULT_FILL_OPACITY = 0.2;

/**
 * How a line or an area is drawn; what is left out is the default (a solid line of 3 pixels, or
 * 2 for the outline of an area, fully opaque, with a solid fill of 20% opacity, straight).
 * `width` is in screen pixels. `dash`, `width`, `opacity` and `curve` are about the line (or an
 * area's outline), `fill` and `fillOpacity` about an area's inside.
 */
export const styleSchema = z.strictObject({
	dash: z.optional(
		z
			.enum(LINE_DASHES)
			.check(
				z.describe(
					"Pattern of the line (or an area's outline), default `solid`",
				),
			),
	),
	width: z.optional(
		z
			.int()
			.check(
				z.minimum(MIN_LINE_WIDTH),
				z.maximum(MAX_LINE_WIDTH),
				z.describe(
					`Width of the line (or an area's outline) in screen pixels, default ${DEFAULT_LINE_WIDTH} (${DEFAULT_AREA_LINE_WIDTH} for an area)`,
				),
			),
	),
	opacity: z.optional(
		z
			.number()
			.check(
				z.minimum(0.1),
				z.maximum(1),
				z.describe("Opacity of the line (or an area's outline), default 1"),
			),
	),
	fill: z.optional(
		z.enum(AREA_FILLS).check(z.describe("Fill of an area, default `solid`")),
	),
	fillOpacity: z.optional(
		z
			.number()
			.check(
				z.minimum(0),
				z.maximum(1),
				z.describe(
					`Opacity of an area's fill, default ${DEFAULT_FILL_OPACITY}`,
				),
			),
	),
	curve: z.optional(
		z
			.enum(LINE_CURVES)
			.check(
				z.describe(
					"How the line (or an area's outline) passes through its points, default `straight`: `curved` keeps its direction (Catmull-Rom), `smooth` also keeps its curvature (a cubic spline, which is rounder); forks remain sharp corners",
				),
			),
	),
	smooth: z.optional(
		z
			.boolean()
			.check(
				z.describe(
					"Legacy form of `curve`, where `true` is `curved` and `false` is `straight`; use `curve` instead",
				),
			),
	),
});
export type FeatureStyle = z.infer<typeof styleSchema>;

/**
 * The style without the fields that are not set, or null when none is. The old `smooth` is
 * turned into `curve`.
 */
export function cleanStyle(
	style: FeatureStyle | null | undefined,
): FeatureStyle | null {
	if (!style) return null;
	const { smooth, ...rest } = style;
	const out = Object.fromEntries(
		Object.entries(rest).filter(([, v]) => v !== undefined),
	) as FeatureStyle;
	if (smooth !== undefined && out.curve === undefined)
		out.curve = smooth ? "curved" : "straight";
	return Object.keys(out).length > 0 ? out : null;
}

/** A style with the fields of `over` laid over those of `base`. */
export function mergeStyle(
	base: FeatureStyle | null | undefined,
	over: FeatureStyle | null | undefined,
): FeatureStyle {
	return { ...cleanStyle(base), ...cleanStyle(over) };
}

function alsoInList() {
	return z.array(z.int().check(z.positive())).check(
		z.maxLength(MAX_ALSO_IN),
		z.refine(
			(list) => new Set(list).size === list.length,
			"a layer is listed twice",
		),
	);
}

const refKey = (r: PlayerRef) =>
	typeof r === "number" ? `#${r}` : r.uuid.toLowerCase();

function builderList() {
	return z.array(playerRefSchema).check(
		z.maxLength(MAX_BUILDERS),
		z.refine(
			(list) => new Set(list.map(refKey)).size === list.length,
			"a builder is listed twice",
		),
	);
}

const common = {
	name: z
		.string()
		.check(
			z.trim(),
			z.maxLength(MAX_NAME),
			z.describe(`Name, at most ${MAX_NAME} characters`),
		),
	popup: z
		._default(z.string().check(z.maxLength(MAX_POPUP)), "")
		.check(
			z.describe(`Popup text, at most ${MAX_POPUP} characters, default empty`),
		),
	color: z
		._default(z.nullable(dyeSchema), null)
		.check(
			z.describe("Dye colour; `null` (default) uses the colour of the layer"),
		),
	alsoIn: z
		._default(alsoInList(), [])
		.check(
			z.describe(
				`Ids of other layers of the same dimension to show the feature in as well (you must be able to edit them); at most ${MAX_ALSO_IN}, default none. The feature's own layer, its home, decides its colour and style`,
			),
		),
	owner: z
		._default(z.nullable(playerRefSchema), null)
		.check(
			z.describe(
				"The player who owns it: a player id or `{uuid, name}`; `null` (default) for none",
			),
		),
	builders: z
		._default(builderList(), [])
		.check(
			z.describe(
				`Players who helped build it, as player ids or \`{uuid, name}\`; at most ${MAX_BUILDERS}, default none`,
			),
		),
};

const featureStyle = z
	._default(z.nullable(styleSchema), null)
	.check(
		z.describe(
			"How the feature is drawn; omitted fields fall back to the layer's style, then to defaults",
		),
	);

const featureType = <T extends FeatureTypeName>(type: T) =>
	z
		.literal(type)
		.check(z.describe("Kind of feature: `pin`, `line` or `polygon`"));

export const featureInputSchema = z.discriminatedUnion("type", [
	z.object({
		type: featureType("pin"),
		geometry: pointSchema.check(z.describe("`[x, z]` in block coordinates")),
		...common,
	}),
	z.object({
		type: featureType("line"),
		geometry: lineGeometry.check(
			z.describe(
				`One path \`[[x, z], ...]\` or several \`[[[x, z], ...], ...]\` in block coordinates, with at least 2 different points and at most ${MAX_VERTICES} points in total`,
			),
		),
		style: featureStyle,
		...common,
	}),
	z.object({
		type: featureType("polygon"),
		geometry: polygonGeometry.check(
			z.describe(
				`Corners \`[[x, z], ...]\` in block coordinates, 3 to ${MAX_VERTICES} points that do not all lie on a single line`,
			),
		),
		style: featureStyle,
		...common,
	}),
]);
export type FeatureInput = z.infer<typeof featureInputSchema>;
export type FeatureType = FeatureInput["type"];

/** Partial update; the merged result is validated with featureInputSchema. */
export const featurePatchSchema = z.object({
	baseRevisionId: z.optional(
		z
			.int()
			.check(
				z.positive(),
				z.describe(
					"The `revisionId` the edit is based on; if the feature has a newer revision, the update answers 409",
				),
			),
	),
	type: z.optional(
		z
			.enum(FEATURE_TYPES)
			.check(z.describe("New kind of feature; send a matching `geometry`")),
	),
	name: z.optional(
		z.string().check(z.describe(`New name, at most ${MAX_NAME} characters`)),
	),
	popup: z.optional(
		z
			.string()
			.check(z.describe(`New popup text, at most ${MAX_POPUP} characters`)),
	),
	color: z.optional(
		z
			.nullable(dyeSchema)
			.check(z.describe("New dye colour; `null` uses the colour of the layer")),
	),
	style: z.optional(
		z
			.nullable(styleSchema)
			.check(
				z.describe(
					"New style, replacing the old one; `null` clears it so the layer's style applies",
				),
			),
	),
	geometry: z.optional(
		z
			.unknown()
			.check(
				z.describe(
					"New geometry matching the feature's type; validated against it after the update",
				),
			),
	),
	alsoIn: z.optional(
		alsoInList().check(
			z.describe(
				"New list of other layers to show the feature in, replacing the old one",
			),
		),
	),
	owner: z.optional(
		z
			.nullable(playerRefSchema)
			.check(
				z.describe(
					"New owner, a player id or `{uuid, name}`; `null` removes the owner",
				),
			),
	),
	builders: z.optional(
		builderList().check(
			z.describe("New list of builders, replacing the old one"),
		),
	),
	layerId: z.optional(
		z
			.int()
			.check(
				z.positive(),
				z.describe(
					"Id of the layer to move the feature to, in the same dimension",
				),
			),
	),
});

export const featureImportSchema = z
	.array(featureInputSchema)
	.check(z.maxLength(MAX_FEATURES_PER_LAYER));

/** New order of the layers of a dimension, or of the features of a layer, as ids. */
export const reorderSchema = z.object({
	ids: z
		.array(z.int().check(z.positive()))
		.check(
			z.maxLength(10_000),
			z.describe(
				"Ids of all features in the layer, in the new order; the update answers 409 if the list is out of date",
			),
		),
});
export const reorderLayersSchema = z.extend(reorderSchema, {
	ids: z
		.array(z.int().check(z.positive()))
		.check(
			z.maxLength(10_000),
			z.describe(
				"Ids of all layers you can see in the dimension, in the new order; the update answers 409 if the list is out of date",
			),
		),
	dimension: z
		.string()
		.check(z.minLength(1), z.describe("Slug of the dimension")),
});

export const featureHistoryQuerySchema = z.object({
	limit: z
		._default(
			z.pipe(
				z.coerce.number(),
				z.int().check(z.minimum(1), z.maximum(MAX_HISTORY_LIMIT)),
			),
			DEFAULT_HISTORY_LIMIT,
		)
		.check(
			z.describe(
				`Entries per page, at most ${MAX_HISTORY_LIMIT}, default ${DEFAULT_HISTORY_LIMIT}`,
			),
		),
	before: z.optional(
		z
			.pipe(z.coerce.number(), z.int().check(z.positive()))
			.check(
				z.describe(
					"Only entries older than this revision id; pass `nextBefore` from the previous page",
				),
			),
	),
});

export const layerVisibilitySchema = z
	.enum(["public", "private"])
	.check(
		z.describe(
			"`public` layers are shown to everyone, `private` ones only to their creator, members and moderators",
		),
	);

const layerName = z
	.string()
	.check(z.trim(), z.minLength(1), z.maxLength(MAX_NAME));

const layerColor = dyeSchema.check(
	z.describe(
		"Dye colour of the layer's pins, lines and areas that do not set their own",
	),
);
const layerHiddenByDefault = z
	.boolean()
	.check(z.describe("Whether the layer starts hidden on the map"));
const layerStyle = z
	.nullable(styleSchema)
	.check(
		z.describe(
			"How the lines and areas of the layer are drawn unless they specify their own style; `null` clears it",
		),
	);

export const createLayerSchema = z.object({
	dimension: z
		.string()
		.check(z.minLength(1), z.describe("Slug of the dimension")),
	name: layerName.check(z.describe("Layer name")),
	color: z._default(layerColor, "white"),
	hiddenByDefault: z._default(layerHiddenByDefault, false),
	visibility: z._default(layerVisibilitySchema, "public"),
	style: z._default(layerStyle, null),
});
export type CreateLayer = z.infer<typeof createLayerSchema>;

export const updateLayerSchema = z
	.object({
		name: z.optional(layerName.check(z.describe("Layer name"))),
		color: z.optional(layerColor),
		hiddenByDefault: z.optional(layerHiddenByDefault),
		visibility: z.optional(layerVisibilitySchema),
		style: z.optional(layerStyle),
	})
	.check(z.refine(nonEmpty, "nothing to update"));
export type UpdateLayer = z.infer<typeof updateLayerSchema>;
