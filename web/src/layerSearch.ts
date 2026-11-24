import { featureTextMatches } from "@blockmap/shared/featureFilter";
import type { FeatureData, LayerData } from "./state";

const normalize = (s: string) => s.trim().toLowerCase();

/** A feature matches when the query is in its name, its popup text, its type (pin, line, area), the name of its owner or a builder, or of a layer it is in (`layerNames`). */
export function featureMatches(
	f: Pick<FeatureData, "name" | "popup" | "type"> &
		Partial<Pick<FeatureData, "owner" | "builders">>,
	query: string,
	layerNames: readonly string[] = [],
): boolean {
	return featureTextMatches(f, layerNames, query);
}

export type LayerMatch = { layer: LayerData; features: FeatureData[] };

/**
 * The layers that have something to show for the query, each with the features to list. A layer
 * whose own name matches is listed whole; otherwise only its matching features are.
 */
export function searchLayers(layers: LayerData[], query: string): LayerMatch[] {
	const q = normalize(query);
	if (!q) return layers.map((layer) => ({ layer, features: layer.features }));
	const out: LayerMatch[] = [];
	for (const layer of layers) {
		if (layer.name.toLowerCase().includes(q)) {
			out.push({ layer, features: layer.features });
			continue;
		}
		const features = layer.features.filter((f) => featureMatches(f, q));
		if (features.length > 0) out.push({ layer, features });
	}
	return out;
}
