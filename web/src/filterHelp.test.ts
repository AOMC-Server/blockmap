import { describe, expect, test } from "bun:test";
import { parseFeatureFilter } from "@blockmap/shared/featureFilter";
import { FILTER_EXAMPLES } from "./filterHelp";

describe("filter help", () => {
	test("every example is a valid filter", () => {
		for (const e of FILTER_EXAMPLES) {
			const parsed = parseFeatureFilter(e.text);
			expect({ text: e.text, ok: parsed.ok }).toEqual({
				text: e.text,
				ok: true,
			});
		}
	});
});
