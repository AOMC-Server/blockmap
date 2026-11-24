/**
 * The feature filter in effect on the map: which features are drawn, besides the layers' own
 * on/off choices. It works like those choices do: your own text is remembered for the next
 * visit, and a link may carry one (`filter=`) that applies to that visit only, until you change
 * the filter yourself. It never goes into the address bar.
 */
import {
	type FeatureFilter,
	type FilterContext,
	filterTerms,
	MAX_FILTER_LENGTH,
} from "@blockmap/shared/featureFilter";
import {
	batch,
	computed,
	effect,
	type ReadonlySignal,
	signal,
} from "@preact/signals";
import {
	type FilterError,
	type FilterState,
	NO_FILTER,
	nextFilterState,
} from "./filterState";
import { countFeatures } from "./renderLayers";
import { loadFilterText, saveFilterText } from "./settings";
import { type FeatureData, isLayerHidden, layersData, popup } from "./state";

const state = signal<FilterState>(nextFilterState(NO_FILTER, loadFilterText()));
const shared = signal(false);

/** The text shown in the filter box: a shared link's, else your own. */
export const filterText: ReadonlySignal<string> = computed(
	() => state.value.text,
);

/** What is wrong with the text, while it doesn't parse; the last good filter stays in effect meanwhile. */
export const filterError: ReadonlySignal<FilterError | null> = computed(
	() => state.value.error,
);

/** The filter in effect (a shared link's, else your own), or null when there is none. */
export const activeFilter: ReadonlySignal<FeatureFilter | null> = computed(
	() => state.value.filter,
);

/** The filter comes from a link and has not been changed since; your own saved filter is untouched. */
export const filterIsShared: ReadonlySignal<boolean> = computed(
	() => shared.value,
);

/** Sets the filter of a link for this visit, without touching the one you saved. */
export function setSharedFilter(text: string) {
	batch(() => {
		state.value = nextFilterState(NO_FILTER, text.slice(0, MAX_FILTER_LENGTH));
		shared.value = true;
	});
}

/** Changes the filter. It becomes your own, and replaces a shared one. */
export function setFilterText(text: string) {
	const next = text.slice(0, MAX_FILTER_LENGTH);
	batch(() => {
		state.value = nextFilterState(state.peek(), next);
		shared.value = false;
	});
	saveFilterText(next);
}

export const clearFilter = () => setFilterText("");

/** Ticks once a minute while the filter has an `edited:` term, so that features age out of it. */
const clock = signal(0);
effect(() => {
	const text = activeFilter.value?.text;
	if (!text || !filterTerms(text)?.some((t) => t.field === "edited")) return;
	const timer = setInterval(() => {
		clock.value++;
	}, 60_000);
	return () => clearInterval(timer);
});

/** The layers' details a filter looks up; "now" is taken when the filter or the layers change, and on each tick. */
const context = computed<FilterContext>(() => {
	state.value;
	clock.value;
	const byId = new Map(layersData.value.map((l) => [l.id, l]));
	return { layerOf: (id) => byId.get(id), now: Date.now() };
});

/** Whether a feature passes the filter in effect (everything does when there is none). */
export function passesFilter(f: FeatureData): boolean {
	const filter = activeFilter.value;
	return !filter || filter.test(f, context.value);
}

/** The feature whose popup was opened directly and is shown although the filter hides it. */
export const exemptFeature = signal<number | null>(null);

/** Call together with opening the popup of `f` (in one batch): it stays drawn while that popup is open. */
export function exemptFromFilter(f: FeatureData) {
	exemptFeature.value = passesFilter(f) ? null : f.id;
}

effect(() => {
	const open = popup.value?.featureId;
	if (exemptFeature.peek() !== null && exemptFeature.peek() !== open)
		exemptFeature.value = null;
});

/** What the map draws: the filter, plus the exempt feature. null when there is no filter. */
export const drawFilter: ReadonlySignal<((f: FeatureData) => boolean) | null> =
	computed(() => {
		const filter = activeFilter.value;
		if (!filter) return null;
		const ctx = context.value;
		const exempt = exemptFeature.value;
		return (f) => f.id === exempt || filter.test(f, ctx);
	});

/** Features in the layers that are switched on, and how many of them the filter lets through. */
export const filterCounts: ReadonlySignal<{ shown: number; total: number }> =
	computed(() => {
		const filter = activeFilter.value;
		const ctx = context.value;
		return countFeatures(
			layersData.value,
			isLayerHidden,
			(f: FeatureData) => !filter || filter.test(f, ctx),
		);
	});
