import { describe, expect, test } from "bun:test";
import type {
	FeatureFilter,
	FilterParse,
} from "@blockmap/shared/featureFilter";
import { type FilterState, NO_FILTER, nextFilterState } from "./filterState";

const filterOf = (text: string): FeatureFilter => ({ text, test: () => true });

/** A parser that accepts anything without a "!" in it. */
const parse = (text: string): FilterParse =>
	text.includes("!")
		? { ok: false, error: "No bangs", at: text.indexOf("!") }
		: { ok: true, filter: filterOf(text.trim()) };

describe("nextFilterState", () => {
	test("a text that parses becomes the filter", () => {
		const s = nextFilterState(NO_FILTER, "type:pin", parse);
		expect(s.text).toBe("type:pin");
		expect(s.filter?.text).toBe("type:pin");
		expect(s.error).toBeNull();
	});

	test("an empty or blank text is no filter and is never parsed", () => {
		const boom = () => {
			throw new Error("parsed");
		};
		const before = nextFilterState(NO_FILTER, "type:pin", parse);
		for (const text of ["", "   "]) {
			const s = nextFilterState(before, text, boom);
			expect(s).toEqual({ text, filter: null, error: null });
		}
	});

	test("a text that doesn't parse keeps the last good filter and reports the problem", () => {
		const good = nextFilterState(NO_FILTER, "type:pin", parse);
		const bad = nextFilterState(good, "type:pin!", parse);
		expect(bad.text).toBe("type:pin!");
		expect(bad.filter).toBe(good.filter);
		expect(bad.error).toEqual({ error: "No bangs", at: 8 });
	});

	test("fixing the text drops the error and uses the new filter", () => {
		const good = nextFilterState(NO_FILTER, "type:pin", parse);
		const bad = nextFilterState(good, "type:pin!", parse);
		const fixed = nextFilterState(bad, "type:line", parse);
		expect(fixed.error).toBeNull();
		expect(fixed.filter?.text).toBe("type:line");
	});

	test("without a good filter before it, a bad text filters nothing", () => {
		const s = nextFilterState(NO_FILTER, "!", parse);
		expect(s.filter).toBeNull();
		expect(s.error).not.toBeNull();
	});

	test("the same text again changes nothing", () => {
		const s: FilterState = nextFilterState(NO_FILTER, "a", parse);
		expect(
			nextFilterState(s, "a", () => {
				throw new Error("parsed");
			}),
		).toBe(s);
	});
});
