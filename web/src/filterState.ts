import {
	type FeatureFilter,
	type FilterParse,
	parseFeatureFilter,
} from "@blockmap/shared/featureFilter";

export type FilterError = { error: string; at: number };

/** A filter text and what it is in effect: the filter it gives, or while it doesn't parse the last good one. */
export type FilterState = {
	text: string;
	filter: FeatureFilter | null;
	error: FilterError | null;
};

export const NO_FILTER: FilterState = { text: "", filter: null, error: null };

/** The state after `text` is typed. A text that doesn't parse keeps the previous filter in effect. */
export function nextFilterState(
	prev: FilterState,
	text: string,
	parse: (text: string) => FilterParse = parseFeatureFilter,
): FilterState {
	if (text === prev.text) return prev;
	if (text.trim() === "") return { text, filter: null, error: null };
	const result = parse(text);
	if (result.ok) return { text, filter: result.filter, error: null };
	return {
		text,
		filter: prev.filter,
		error: { error: result.error, at: result.at },
	};
}
