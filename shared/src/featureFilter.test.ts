import { describe, expect, test } from "bun:test";
import {
	type FilterContext,
	type FilterFeature,
	featureTextMatches,
	filterTerms,
	formatFilterTerm,
	MAX_FILTER_LENGTH,
	parseAge,
	parseFeatureFilter,
} from "./featureFilter";

const DAY = 86_400_000;
const NOW = new Date(2026, 5, 15, 12).getTime();

const LAYERS: ReturnType<FilterContext["layerOf"]>[] = [
	undefined,
	{ name: "Town bases", color: "red" },
	{ name: "Roads", color: "gray" },
	{ name: "Nether hub", color: "light_blue" },
];
const ctx: FilterContext = { layerOf: (id) => LAYERS[id], now: NOW };

const pin = (over: Partial<FilterFeature> = {}): FilterFeature => ({
	type: "pin",
	name: "",
	popup: "",
	color: null,
	geometry: [10, 20],
	layerId: 1,
	alsoIn: [],
	owner: null,
	builders: [],
	updatedAt: NOW,
	...over,
});

const line = (over: Partial<FilterFeature> = {}) =>
	pin({
		type: "line",
		geometry: [
			[0, 0],
			[30, 40],
		],
		...over,
	});

const area = (side = 10, over: Partial<FilterFeature> = {}) =>
	pin({
		type: "polygon",
		geometry: [
			[0, 0],
			[side, 0],
			[side, side],
			[0, side],
		],
		...over,
	});

function matches(text: string, f: FilterFeature, c: FilterContext = ctx) {
	const r = parseFeatureFilter(text);
	if (!r.ok) throw new Error(`${text}: ${r.error} at ${r.at}`);
	return r.filter ? r.filter.test(f, c) : true;
}

function failure(text: string) {
	const r = parseFeatureFilter(text);
	if (r.ok) throw new Error(`${text} should not parse`);
	return r;
}

describe("basics", () => {
	test("empty and blank texts pass everything", () => {
		expect(parseFeatureFilter("")).toEqual({ ok: true, filter: null });
		expect(parseFeatureFilter("  \t\n ")).toEqual({ ok: true, filter: null });
	});

	test("keeps the trimmed text", () => {
		const r = parseFeatureFilter("  type:pin  ");
		expect(r.ok && r.filter?.text).toBe("type:pin");
	});

	test("all terms must match", () => {
		const f = pin({ name: "Farm", owner: { name: "Steve" } });
		expect(matches("farm owner:steve", f)).toBe(true);
		expect(matches("farm owner:alex", f)).toBe(false);
	});

	test("field names and values ignore case", () => {
		expect(
			matches("TYPE:Pin Owner:STEVE", pin({ owner: { name: "steve" } })),
		).toBe(true);
	});

	test("a minus is the exact complement of the term", () => {
		const f = pin({ owner: { name: "Steve" } });
		expect(matches("owner:Steve", f)).toBe(true);
		expect(matches("-owner:Steve", f)).toBe(false);
		expect(matches("-owner:Alex", f)).toBe(true);
		expect(matches("-type:pin,line", f)).toBe(false);
		expect(matches("-type:line,area", f)).toBe(true);
	});
});

describe("words", () => {
	test("match name, popup, owner, builders, type label and layer names", () => {
		expect(matches("castle", pin({ name: "Old CASTLE" }))).toBe(true);
		expect(matches("gate", pin({ popup: "by the castle gate" }))).toBe(true);
		expect(matches("steve", pin({ owner: { name: "Steve_01" } }))).toBe(true);
		expect(
			matches("alex", pin({ builders: [{ name: "Bob" }, { name: "Alexa" }] })),
		).toBe(true);
		expect(matches("area", area())).toBe(true);
		expect(matches("line", pin())).toBe(false);
		expect(matches("bases", pin())).toBe(true);
		expect(matches("hub", pin({ alsoIn: [3] }))).toBe(true);
		expect(matches("hub", pin())).toBe(false);
	});

	test("quotes make a phrase, and a minus excludes it", () => {
		const f = pin({ name: "Town hall" });
		expect(matches('"town hall"', f)).toBe(true);
		expect(matches('"hall town"', f)).toBe(false);
		expect(matches('-"town hall"', f)).toBe(false);
		expect(matches("-castle", f)).toBe(true);
	});

	test("quoting lets you search the words and text the language reserves", () => {
		expect(matches('"or"', pin({ name: "Door" }))).toBe(true);
		expect(matches('"a:b"', pin({ popup: "a:b" }))).toBe(true);
		expect(matches('"(x)"', pin({ popup: "(x)" }))).toBe(true);
	});

	test("the Layers search uses the same function", () => {
		const f = pin({ name: "Farm", owner: { name: "Steve" } });
		expect(featureTextMatches(f, ["Roads"], "ROAD")).toBe(true);
		expect(featureTextMatches(f, [], "road")).toBe(false);
		expect(featureTextMatches(f, [], "  ")).toBe(true);
		expect(featureTextMatches(f, [], "pin")).toBe(true);
	});
});

describe("type", () => {
	test("pin, line and area (the polygon type); lists mean any of", () => {
		expect(matches("type:pin", pin())).toBe(true);
		expect(matches("type:area", area())).toBe(true);
		expect(matches("type:area", pin())).toBe(false);
		expect(matches("type:pin,line", line())).toBe(true);
		expect(matches("type:pin,line", area())).toBe(false);
		expect(matches("-type:area", pin())).toBe(true);
	});
});

describe("players", () => {
	const f = pin({
		owner: { name: "Steve" },
		builders: [{ name: "Alex" }, { name: "Mr Bean" }],
	});

	test("player is the owner or a builder, with exact names", () => {
		expect(matches("player:steve", f)).toBe(true);
		expect(matches("player:alex", f)).toBe(true);
		expect(matches("player:ste", f)).toBe(false);
		expect(matches("player:Zed,Alex", f)).toBe(true);
		expect(matches("-player:Zed,Alex", f)).toBe(false);
	});

	test("owner and builder are one role each", () => {
		expect(matches("owner:Steve", f)).toBe(true);
		expect(matches("owner:Alex", f)).toBe(false);
		expect(matches("builder:Alex", f)).toBe(true);
		expect(matches("builder:Steve", f)).toBe(false);
		expect(matches("-builder:Steve", f)).toBe(true);
		expect(matches("owner:Steve", pin())).toBe(false);
	});

	test("quoted names may hold spaces", () => {
		expect(matches('builder:"mr bean"', f)).toBe(true);
		expect(matches('builder:Alex,"Mr Bean"', f)).toBe(true);
	});

	test("none is just a name", () => {
		expect(matches("owner:none", pin())).toBe(false);
		expect(matches("owner:none", pin({ owner: { name: "None" } }))).toBe(true);
	});
});

describe("color", () => {
	test("the feature's colour, else its layer's", () => {
		expect(matches("color:red", pin())).toBe(true);
		expect(matches("color:red", pin({ color: "blue" }))).toBe(false);
		expect(matches("color:blue", pin({ color: "blue" }))).toBe(true);
		expect(matches("color:red,blue", pin({ color: "blue" }))).toBe(true);
		expect(matches("-color:red", pin({ color: "blue" }))).toBe(true);
	});

	test("light-blue and light_blue are the same, and colour: works", () => {
		expect(matches("color:light-blue", pin({ layerId: 3 }))).toBe(true);
		expect(matches("COLOR:light_blue", pin({ color: "light_blue" }))).toBe(
			true,
		);
		expect(matches("colour:red", pin())).toBe(true);
	});

	test("a feature in an unknown layer has no fallback colour", () => {
		expect(matches("color:red", pin({ layerId: 0 }))).toBe(false);
	});
});

describe("layer", () => {
	test("any layer the feature is in, by exact name", () => {
		expect(matches("layer:roads", pin({ layerId: 2 }))).toBe(true);
		expect(matches("layer:roads", pin({ layerId: 1, alsoIn: [2] }))).toBe(true);
		expect(matches("layer:roads", pin({ layerId: 1 }))).toBe(false);
		expect(matches("layer:road", pin({ layerId: 2 }))).toBe(false);
		expect(matches('layer:"town bases",Roads', pin())).toBe(true);
		expect(matches("-layer:roads", pin({ layerId: 1, alsoIn: [2] }))).toBe(
			false,
		);
	});
});

describe("has", () => {
	test("owner, builders, name and description, and their absence", () => {
		const bare = pin();
		const full = pin({
			name: "A",
			popup: "b",
			owner: { name: "S" },
			builders: [{ name: "T" }],
		});
		for (const p of ["owner", "builders", "name", "description"]) {
			expect(matches(`has:${p}`, full)).toBe(true);
			expect(matches(`has:${p}`, bare)).toBe(false);
			expect(matches(`-has:${p}`, bare)).toBe(true);
		}
		expect(matches("-has:name", pin({ name: "  " }))).toBe(true);
	});

	test("a list means any of them", () => {
		expect(
			matches("has:owner,builders", pin({ builders: [{ name: "T" }] })),
		).toBe(true);
		expect(matches("has:owner,builders", pin())).toBe(false);
		expect(matches("-has:owner,builders", pin())).toBe(true);
	});
});

describe("edited", () => {
	const ago = (ms: number) => pin({ updatedAt: NOW - ms });

	test("within the last N days, weeks, months (30 days) or years (365 days)", () => {
		expect(matches("edited:7d", ago(6 * DAY))).toBe(true);
		expect(matches("edited:7d", ago(8 * DAY))).toBe(false);
		expect(matches("edited:2w", ago(14 * DAY))).toBe(true);
		expect(matches("edited:2w", ago(15 * DAY))).toBe(false);
		expect(matches("edited:1m", ago(30 * DAY))).toBe(true);
		expect(matches("edited:1m", ago(31 * DAY))).toBe(false);
		expect(matches("edited:1y", ago(365 * DAY))).toBe(true);
		expect(matches("edited:1y", ago(366 * DAY))).toBe(false);
		expect(matches("EDITED:1Y", ago(DAY))).toBe(true);
	});

	test("minutes and hours: min and h, while m stays months", () => {
		const MIN = 60_000;
		expect(matches("edited:15min", ago(14 * MIN))).toBe(true);
		expect(matches("edited:15min", ago(16 * MIN))).toBe(false);
		expect(matches("edited:2h", ago(119 * MIN))).toBe(true);
		expect(matches("edited:2h", ago(121 * MIN))).toBe(false);
		expect(matches("edited:30m", ago(29 * DAY))).toBe(true);
		expect(matches("EDITED:10MIN", ago(MIN))).toBe(true);
	});

	test("parseAge reads the ages edited: takes", () => {
		expect(parseAge("15min")).toEqual({ n: 15, unit: "min" });
		expect(parseAge("2H")).toEqual({ n: 2, unit: "h" });
		expect(parseAge("6m")).toEqual({ n: 6, unit: "m" });
		expect(parseAge("0d")).toBeNull();
		expect(parseAge("1.5h")).toBeNull();
		expect(parseAge("5mins")).toBeNull();
		expect(parseAge("5s")).toBeNull();
	});

	test("minus is not edited in that time", () => {
		expect(matches("-edited:1y", ago(400 * DAY))).toBe(true);
		expect(matches("-edited:1y", ago(DAY))).toBe(false);
	});
});

describe("area", () => {
	test("bigger or smaller, areas only", () => {
		expect(matches("area>50", area(10))).toBe(true);
		expect(matches("area>100", area(10))).toBe(false);
		expect(matches("area<101", area(10))).toBe(true);
		expect(matches("area<100", area(10))).toBe(false);
		expect(matches("area>1.5", area(10))).toBe(true);
		expect(matches("AREA>5", area(10))).toBe(true);
		expect(matches("area>0", pin())).toBe(false);
		expect(matches("area<9999", line())).toBe(false);
	});

	test("minus keeps everything else, pins and lines too", () => {
		expect(matches("-area>50", area(10))).toBe(false);
		expect(matches("-area>50", area(2))).toBe(true);
		expect(matches("-area>50", pin())).toBe(true);
		expect(matches("-area>50", line())).toBe(true);
	});

	test("an area with too few points matches neither way", () => {
		const broken = pin({ type: "polygon", geometry: [[0, 0]] });
		expect(matches("area>0", broken)).toBe(false);
		expect(matches("area<9", broken)).toBe(false);
	});
});

describe("errors", () => {
	test("or, and and not have no meaning, in any case", () => {
		for (const w of ["or", "OR", "And", "not", "-or"]) {
			const e = failure(`type:pin ${w} type:line`);
			expect(e.error).toContain("no “");
			expect(e.error).toContain("Quote the word");
			expect(e.at).toBe(w.startsWith("-") ? 10 : 9);
		}
		// Each says what to do instead.
		expect(failure("a or b").error).toContain("comma");
		expect(failure("a and b").error).toContain("side by side");
		expect(failure("not b").error).toContain("put - in front");
		expect(parseFeatureFilter('"or" order').ok).toBe(true);
	});

	test("brackets", () => {
		expect(failure("a (b)")).toMatchObject({ at: 2 });
		expect(failure("a (b)").error).toContain("no brackets");
		expect(failure("type:(")).toMatchObject({ at: 5 });
		expect(failure("a)").at).toBe(1);
	});

	test("unknown fields, and words with a colon", () => {
		const e = failure("type:pin nearby:5");
		expect(e).toMatchObject({ at: 9 });
		expect(e.error).toContain("Unknown field “nearby”");
		expect(e.error).toContain("edited");
		expect(failure("12:30").error).toContain("Unknown field");
		expect(failure("is:unnamed").ok).toBe(false);
		expect(failure("updated<30d").ok).toBe(false);
	});

	test("bad values say where", () => {
		expect(failure("type:pin,hat")).toMatchObject({ at: 9 });
		expect(failure("type:polygon").error).toContain("Try pin, line, area");
		expect(failure("color:grey").error).toContain("Unknown colour");
		expect(failure("has:popup").error).toContain("owner, builders");
		expect(failure("-edited:soon").at).toBe(8);
		for (const bad of [
			"edited:0d",
			"edited:30",
			"edited:1.5y",
			"edited:7d,1y",
			"edited:2026-06-01",
		])
			expect(failure(bad).error).toContain("edited");
		expect(failure("area>big").error).toContain("blocks²");
		expect(failure("area>").error).toContain("blocks²");
	});

	test("missing values and wrong operators", () => {
		expect(failure("type:")).toMatchObject({ at: 5 });
		expect(failure("owner:a,")).toMatchObject({ at: 8 });
		expect(failure("area:5000").error).toContain("area>5000");
		expect(failure("area>=5").ok).toBe(false);
		expect(failure("type>pin").error).toContain("type:value");
	});

	test("quotes and a lone minus", () => {
		expect(failure('a "b')).toMatchObject({ at: 2 });
		expect(failure('""').error).toContain("Empty quotes");
		expect(failure("a -")).toMatchObject({ at: 2 });
		expect(parseFeatureFilter("--a").ok).toBe(true);
	});

	test("too long", () => {
		const long = "a".repeat(MAX_FILTER_LENGTH + 1);
		expect(failure(long)).toMatchObject({ at: MAX_FILTER_LENGTH });
		expect(parseFeatureFilter("a".repeat(MAX_FILTER_LENGTH)).ok).toBe(true);
	});

	test("never throws, whatever the input", () => {
		for (const text of [
			"(",
			'"',
			"-",
			"a:",
			"x>",
			"area>",
			"\\",
			"\u0000\u2028",
			"-:",
			":x",
			"<",
		])
			expect(() => parseFeatureFilter(text)).not.toThrow();
		const broken = { ...pin(), builders: null } as never;
		expect(matches("builder:a", broken)).toBe(false);
	});
});

describe("terms", () => {
	test("the flat list of terms, with where each is", () => {
		const text = '-type:Pin,line  color:light-blue "town hall" area>5';
		const at = (part: string) => ({
			start: text.indexOf(part),
			end: text.indexOf(part) + part.length,
		});
		expect(filterTerms(text)).toEqual([
			{
				neg: true,
				field: "type",
				values: ["pin", "line"],
				...at("-type:Pin,line"),
			},
			{
				neg: false,
				field: "color",
				values: ["light_blue"],
				...at("color:light-blue"),
			},
			{ neg: false, field: null, values: ["town hall"], ...at('"town hall"') },
			{ neg: false, field: "area", values: [">5"], ...at("area>5") },
		]);
	});

	test("colour is written color, and quoted values lose their quotes", () => {
		expect(filterTerms('colour:red layer:"A b",C')).toMatchObject([
			{ field: "color" },
			{ field: "layer", values: ["A b", "C"] },
		]);
	});

	test("null for a text that does not parse, and none for a blank one", () => {
		expect(filterTerms("type:hat")).toBeNull();
		expect(filterTerms("  ")).toEqual([]);
	});

	test("a formatted term reads back the same", () => {
		for (const term of [
			{ neg: false, field: "type", values: ["pin", "line"] },
			{ neg: true, field: "has", values: ["owner"] },
			{ neg: false, field: "layer", values: ["Town bases", "Roads"] },
			{ neg: false, field: "player", values: ["Mr, (Bean)"] },
			{ neg: false, field: null, values: ["two words"] },
		]) {
			const text = formatFilterTerm(term);
			expect(filterTerms(text)).toMatchObject([term]);
		}
		expect(
			formatFilterTerm({ neg: true, field: "layer", values: ["A b"] }),
		).toBe('-layer:"A b"');
	});
});
