import type { Dye } from "@blockmap/shared/colors";
import type { FeatureStyle } from "@blockmap/shared/features";

type Listed = { id: number; layerId: number };

type SourceLayer<F extends Listed> = {
	id: number;
	color: Dye;
	style: FeatureStyle | null;
	features: F[];
};

/**
 * Each feature once, styled by its home layer, when any layer it is in is switched on.
 * A feature whose home layer is not known goes under the first visible layer that lists it.
 * With `passes`, only the features it accepts are drawn.
 */
export function buildRenderLayers<F extends Listed, L extends SourceLayer<F>>(
	layers: L[],
	isHidden: (l: L) => boolean,
	passes?: (f: F) => boolean,
) {
	const shown = new Set<number>();
	const orphans = new Map<number, number>();
	const known = new Set(layers.map((l) => l.id));
	for (const l of layers) {
		if (isHidden(l)) continue;
		for (const f of l.features) {
			if (passes && !passes(f)) continue;
			shown.add(f.id);
			if (!known.has(f.layerId) && !orphans.has(f.id)) orphans.set(f.id, l.id);
		}
	}
	const out: {
		id: number;
		color: Dye;
		style: FeatureStyle | null;
		features: F[];
	}[] = [];
	for (const l of layers) {
		const features: F[] = [];
		const seen = new Set<number>();
		for (const f of l.features) {
			if (seen.has(f.id) || !shown.has(f.id)) continue;
			if (f.layerId === l.id || orphans.get(f.id) === l.id) {
				seen.add(f.id);
				features.push(f);
			}
		}
		if (features.length > 0)
			out.push({ id: l.id, color: l.color, style: l.style, features });
	}
	return out;
}

/** How many features the layers that are on hold (each counted once), and how many of them `passes` accepts. */
export function countFeatures<
	F extends { id: number },
	L extends { features: F[] },
>(layers: L[], isHidden: (l: L) => boolean, passes: (f: F) => boolean) {
	const seen = new Set<number>();
	let total = 0;
	let shown = 0;
	for (const l of layers) {
		if (isHidden(l)) continue;
		for (const f of l.features) {
			if (seen.has(f.id)) continue;
			seen.add(f.id);
			total++;
			if (passes(f)) shown++;
		}
	}
	return { shown, total };
}
