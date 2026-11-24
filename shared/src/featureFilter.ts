/**
 * Feature filters: a search-style language that picks which features the map shows.
 *
 * A filter is terms separated by spaces; all of them must match. `-` in front of a term means
 * not. A term is a word or "quoted phrase" (searched like the Layers panel does), or
 * `field:value` with `a,b` for any of several values and quotes for values with spaces, or
 * `area>5000` / `area<100`. Fields: type, player, owner, builder, color, layer, has, edited
 * (`edited:15min`, `2h`, `7d`, `2w`, `6m`, `1y`).
 * There is no OR, AND or brackets.
 *
 * The exports below are relied on by the web app and the server.
 */
import { DYES, type Dye } from "./colors";
import { type FeatureType, type Point, TYPE_LABEL } from "./features";
import { MAX_FILTER_LENGTH } from "./schemas";

export { MAX_FILTER_LENGTH };

/** What a filter looks at in a feature. Both the web app's FeatureData and the server's FeatureView fit. */
export type FilterFeature = {
	type: FeatureType;
	name: string;
	popup: string;
	color: Dye | null;
	/** A pin's point, a line's path(s) or an area's ring, as stored. */
	geometry: unknown;
	/** The home layer, then the others it is shown in. */
	layerId: number;
	alsoIn: number[];
	owner: { name: string } | null;
	builders: { name: string }[];
	/** Last edit, unix ms. */
	updatedAt: number;
};

/** What a filter needs from outside the feature. */
export type FilterContext = {
	/** A layer the feature is in; undefined when not known (hidden from the viewer). */
	layerOf: (id: number) => { name: string; color: Dye } | undefined;
	/** "Now" for `edited:30d`, unix ms. */
	now: number;
};

export type FeatureFilter = {
	/** The text it was parsed from, trimmed. */
	text: string;
	test: (feature: FilterFeature, ctx: FilterContext) => boolean;
};

export type FilterParse =
	/** `filter` is null for an empty (or all-whitespace) text: everything passes. */
	| { ok: true; filter: FeatureFilter | null }
	/** `at` is the character index in the text where the problem is. */
	| { ok: false; error: string; at: number };

/**
 * One term of a filter text. `field` is null for a word. Values are as written, except that
 * `type`, `color` and `has` values are their canonical spelling, and `area` has one value like
 * ">5000". `start` and `end` are where the term is in the text, `-` included.
 */
export type FilterTerm = {
	neg: boolean;
	field: string | null;
	values: string[];
	start: number;
	end: number;
};

/**
 * Whether `query` is in the feature's name, popup, owner, builders, type label or the name of
 * one of its layers (ignoring case). An empty query matches everything. The filter's bare words
 * and the Layers panel search both use it.
 */
export function featureTextMatches(
	f: Pick<FilterFeature, "name" | "popup" | "type"> &
		Partial<Pick<FilterFeature, "owner" | "builders">>,
	layerNames: readonly string[],
	query: string,
): boolean {
	const q = query.trim().toLowerCase();
	if (!q) return true;
	return [
		f.name,
		f.popup,
		TYPE_LABEL[f.type],
		...(f.owner ? [f.owner.name] : []),
		...(f.builders ?? []).map((b) => b.name),
		...layerNames,
	].some((text) => text.toLowerCase().includes(q));
}

type Pred = (f: FilterFeature, ctx: FilterContext) => boolean;
type Term = FilterTerm & { test: Pred };
type Value = { text: string; at: number };

class FilterError extends Error {
	at: number;
	constructor(message: string, at: number) {
		super(message);
		this.at = at;
	}
}

const fail = (message: string, at: number): never => {
	throw new FilterError(message, at);
};

const SPACE = /\s/;
const NO_BRACKETS =
	"There are no brackets: list alternatives in one field with a comma (color:red,blue), and put - in front of a term to leave it out. Quote the text to search for it.";
const LOGIC_HINT: Record<string, string> = {
	and: "terms side by side must all match already",
	or: "list the alternatives in one field with a comma (color:red,blue)",
	not: "put - in front of a term to leave it out (-type:pin)",
};
const NO_LOGIC = (word: string) =>
	`There's no “${word}”: ${LOGIC_HINT[word.toLowerCase()] ?? "see the help below"}. Quote the word to search for it.`;

/** The spans of the space-separated terms. Quotes may hold spaces; brackets are not part of the language. */
function tokenize(text: string): { start: number; end: number }[] {
	const out: { start: number; end: number }[] = [];
	let i = 0;
	while (i < text.length) {
		if (SPACE.test(text[i] as string)) {
			i++;
			continue;
		}
		const start = i;
		while (i < text.length && !SPACE.test(text[i] as string)) {
			const c = text[i];
			if (c === '"') {
				const close = text.indexOf('"', i + 1);
				if (close < 0) return fail("Missing closing quote", i);
				i = close + 1;
			} else if (c === "(" || c === ")") {
				return fail(NO_BRACKETS, i);
			} else {
				i++;
			}
		}
		out.push({ start, end: i });
	}
	return out;
}

/** The text in [from, to) cut at commas outside quotes, with the quotes removed. */
function splitValues(text: string, from: number, to: number): Value[] {
	const out: Value[] = [];
	let value = "";
	let at = from;
	let quoted = false;
	for (let i = from; i < to; i++) {
		const c = text[i] as string;
		if (c === '"') quoted = !quoted;
		else if (c === "," && !quoted) {
			out.push({ text: value, at });
			value = "";
			at = i + 1;
		} else value += c;
	}
	out.push({ text: value, at });
	return out;
}

type Compiled = { values: string[]; test: Pred };

const lower = (values: Value[]) => values.map((v) => v.text.toLowerCase());

function oneOf(
	values: Value[],
	label: string,
	allowed: readonly string[],
	hint = allowed.join(", "),
	normalize = (s: string) => s.toLowerCase(),
): string[] {
	return values.map((v) => {
		const n = normalize(v.text);
		return allowed.includes(n)
			? n
			: fail(`Unknown ${label} “${v.text}”. Try ${hint}.`, v.at);
	});
}

const named = (s: string) => s.trim() !== "";

const HAS: Record<string, Pred> = {
	owner: (f) => f.owner !== null,
	builders: (f) => f.builders.length > 0,
	name: (f) => named(f.name),
	description: (f) => named(f.popup),
};

const TYPES: Record<string, FeatureType> = {
	pin: "pin",
	line: "line",
	area: "polygon",
};

const isPoint = (p: unknown): p is Point =>
	Array.isArray(p) &&
	typeof p[0] === "number" &&
	typeof p[1] === "number" &&
	Number.isFinite(p[0]) &&
	Number.isFinite(p[1]);

function areaOf(f: FilterFeature): number | undefined {
	if (f.type !== "polygon" || !Array.isArray(f.geometry)) return undefined;
	const ring = f.geometry.filter(isPoint);
	if (ring.length < 3) return undefined;
	let sum = 0;
	for (let i = 0; i < ring.length; i++) {
		const [x1, z1] = ring[i] as Point;
		const [x2, z2] = ring[(i + 1) % ring.length] as Point;
		sum += x1 * z2 - x2 * z1;
	}
	return Math.abs(sum) / 2;
}

const MINUTE = 60_000;
const DAY = 1440 * MINUTE;

/** The units of `edited:`, shortest first, and how long each is in ms. `m` is a month (30 days); minutes are `min`. */
export const AGE_UNITS = {
	min: MINUTE,
	h: 60 * MINUTE,
	d: DAY,
	w: 7 * DAY,
	m: 30 * DAY,
	y: 365 * DAY,
} as const;
export type AgeUnit = keyof typeof AGE_UNITS;

/** An `edited:` age such as `15min` or `2w`, or null when it isn't one. */
export function parseAge(text: string): { n: number; unit: AgeUnit } | null {
	const age = /^(\d+)(min|h|d|w|m|y)$/i.exec(text.trim());
	const n = Number(age?.[1]);
	if (!age || !(n > 0)) return null;
	return { n, unit: (age[2] as string).toLowerCase() as AgeUnit };
}

const layerNamesOf = (f: FilterFeature, ctx: FilterContext) =>
	[f.layerId, ...f.alsoIn].flatMap((id) => ctx.layerOf(id)?.name ?? []);

const FIELDS: Record<string, (values: Value[]) => Compiled> = {
	type: (values) => {
		const types = oneOf(values, "type", Object.keys(TYPES));
		return {
			values: types,
			test: (f) => types.some((t) => TYPES[t] === f.type),
		};
	},
	player: (values) => {
		const names = lower(values);
		return {
			values: values.map((v) => v.text),
			test: (f) =>
				[f.owner?.name, ...f.builders.map((b) => b.name)].some(
					(n) => n !== undefined && names.includes(n.toLowerCase()),
				),
		};
	},
	owner: (values) => {
		const names = lower(values);
		return {
			values: values.map((v) => v.text),
			test: (f) =>
				f.owner !== null && names.includes(f.owner.name.toLowerCase()),
		};
	},
	builder: (values) => {
		const names = lower(values);
		return {
			values: values.map((v) => v.text),
			test: (f) => f.builders.some((b) => names.includes(b.name.toLowerCase())),
		};
	},
	color: (values) => {
		const dyes = oneOf(
			values,
			"colour",
			DYES,
			"red, blue, light_blue, lime or another dye",
			(s) => s.toLowerCase().replace(/-/g, "_"),
		) as Dye[];
		return {
			values: dyes,
			test: (f, ctx) => {
				const dye = f.color ?? ctx.layerOf(f.layerId)?.color;
				return dye !== undefined && dyes.includes(dye);
			},
		};
	},
	layer: (values) => {
		const names = lower(values);
		return {
			values: values.map((v) => v.text),
			test: (f, ctx) =>
				layerNamesOf(f, ctx).some((n) => names.includes(n.toLowerCase())),
		};
	},
	has: (values) => {
		const props = oneOf(values, "property", Object.keys(HAS));
		return {
			values: props,
			test: (f, ctx) => props.some((p) => (HAS[p] as Pred)(f, ctx)),
		};
	},
	edited: (values) => {
		const [only] = values as [Value];
		const age = parseAge(only.text);
		if (values.length > 1 || !age)
			return fail(
				`“edited” takes one age like 15min, 2h, 7d, 2w, 6m or 1y, not “${values.map((v) => v.text).join(",")}”`,
				only.at,
			);
		const limit = age.n * AGE_UNITS[age.unit];
		return {
			values: [`${age.n}${age.unit}`],
			test: (f, ctx) => ctx.now - f.updatedAt <= limit,
		};
	},
};

const FIELD_NAMES = [...Object.keys(FIELDS), "area"];
const ALIASES: Record<string, string> = { colour: "color" };

function areaTerm(op: string, text: string, at: number): Compiled {
	if (!/^\d+(\.\d+)?$/.test(text))
		return fail(`“area${op}” needs an area in blocks², like area${op}5000`, at);
	const limit = Number(text);
	return {
		values: [op + text],
		test: (f) => {
			const a = areaOf(f);
			return a !== undefined && (op === ">" ? a > limit : a < limit);
		},
	};
}

const FIELD_START = /^([^\s:<>"]+)([:<>])/;

function parseTerm(text: string, token: { start: number; end: number }): Term {
	const { start, end } = token;
	if (end - start === 1 && text[start] === "-")
		return fail("Put a term after “-”, like -type:pin", start);
	const neg = text[start] === "-";
	const from = start + (neg ? 1 : 0);
	const body = text.slice(from, end);
	const head = FIELD_START.exec(body);
	let field: string | null = null;
	let compiled: Compiled;
	if (head) {
		const written = (head[1] as string).toLowerCase();
		const op = head[2] as string;
		field = ALIASES[written] ?? written;
		const valueAt = from + (head[0] as string).length;
		if (field === "area") {
			if (op === ":")
				fail("“area” is used as area>5000 or area<100", from + written.length);
			compiled = areaTerm(op, text.slice(valueAt, end), valueAt);
		} else {
			const build = FIELDS[field];
			if (!build)
				return fail(
					`Unknown field “${head[1]}”. Fields: ${FIELD_NAMES.join(", ")}. Quote the text to search for it.`,
					from,
				);
			if (op !== ":")
				fail(`“${field}” is used as ${field}:value`, from + written.length);
			const values = splitValues(text, valueAt, end);
			for (const v of values)
				if (v.text === "") fail(`Missing value after “${written}:”`, v.at);
			compiled = build(values);
		}
	} else {
		if (["or", "and", "not"].includes(body.toLowerCase()))
			return fail(NO_LOGIC(body), from);
		const word = body.replace(/"/g, "");
		if (word.trim() === "")
			return fail(
				"Empty quotes: put a word between them, or remove them",
				from,
			);
		compiled = {
			values: [word],
			test: (f, ctx) => featureTextMatches(f, layerNamesOf(f, ctx), word),
		};
	}
	const { test } = compiled;
	return {
		neg,
		field,
		values: compiled.values,
		start,
		end,
		test: neg ? (f, ctx) => !test(f, ctx) : test,
	};
}

function tryParse(
	text: string,
): { ok: true; terms: Term[] } | { ok: false; error: string; at: number } {
	if (text.length > MAX_FILTER_LENGTH)
		return {
			ok: false,
			error: `Too long: at most ${MAX_FILTER_LENGTH} characters`,
			at: MAX_FILTER_LENGTH,
		};
	try {
		return {
			ok: true,
			terms: tokenize(text).map((token) => parseTerm(text, token)),
		};
	} catch (e) {
		if (e instanceof FilterError)
			return { ok: false, error: e.message, at: e.at };
		return { ok: false, error: "Cannot read this filter", at: 0 };
	}
}

/** Parses a filter text. Never throws. */
export function parseFeatureFilter(text: string): FilterParse {
	const parsed = tryParse(String(text));
	if (!parsed.ok) return parsed;
	const { terms } = parsed;
	if (terms.length === 0) return { ok: true, filter: null };
	return {
		ok: true,
		filter: {
			text: String(text).trim(),
			test: (f, ctx) => {
				try {
					return terms.every((t) => t.test(f, ctx));
				} catch {
					return false;
				}
			},
		},
	};
}

/** The terms of a filter text, or null when it does not parse. */
export function filterTerms(text: string): FilterTerm[] | null {
	const parsed = tryParse(text);
	return parsed.ok
		? parsed.terms.map(({ neg, field, values, start, end }) => ({
				neg,
				field,
				values,
				start,
				end,
			}))
		: null;
}

const needsQuotes = /[\s",()]|^$/;

/** A term as text, like `-owner:"Mr Bean",Steve`: values are quoted when they need it. */
export function formatFilterTerm(
	term: Pick<FilterTerm, "neg" | "field" | "values">,
): string {
	const values = term.values.map((v) =>
		needsQuotes.test(v) ? `"${v.replace(/"/g, "")}"` : v,
	);
	return `${term.neg ? "-" : ""}${term.field ? `${term.field}:` : ""}${values.join(",")}`;
}
