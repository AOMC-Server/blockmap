/** The layers a feature is in: its primary (home) layer and the others it is shown in. */
export type LayerPick = { primary: number; also: number[] };

/** Adds a layer to the others; the primary and layers already picked stay as they are. */
export function addLayer(p: LayerPick, id: number): LayerPick {
	return id === p.primary || p.also.includes(id)
		? p
		: { ...p, also: [...p.also, id] };
}

/** Takes a layer out of the others. The primary stays: make another one primary first. */
export function removeLayer(p: LayerPick, id: number): LayerPick {
	return p.also.includes(id)
		? { ...p, also: p.also.filter((x) => x !== id) }
		: p;
}

/** Makes a layer the primary one; the old primary becomes one of the others, in its place. */
export function makePrimary(p: LayerPick, id: number): LayerPick {
	if (id === p.primary) return p;
	if (!p.also.includes(id))
		return { primary: id, also: [p.primary, ...p.also] };
	return {
		primary: id,
		also: p.also.map((x) => (x === id ? p.primary : x)),
	};
}

/** Layers whose name has the query in it, those that start with it first; all without a query. */
export function matchLayers<T extends { name: string }>(
	layers: readonly T[],
	query: string,
): T[] {
	const q = query.trim().toLowerCase();
	if (!q) return [...layers];
	const starts: T[] = [];
	const contains: T[] = [];
	for (const l of layers) {
		const name = l.name.toLowerCase();
		if (name.startsWith(q)) starts.push(l);
		else if (name.includes(q)) contains.push(l);
	}
	return [...starts, ...contains];
}
