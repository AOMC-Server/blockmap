/**
 * What the quick controls of the filter panel show and write, on top of the filter text. A control
 * reads the terms of the fields it owns, and is "custom" (disabled) only when the text sets them
 * in a way it can't show: more than once, or with values it has no choice for.
 */
import type { Dye } from "@blockmap/shared/colors";
import {
	type AgeUnit,
	type FilterTerm,
	filterTerms,
	formatFilterTerm,
	parseAge,
} from "@blockmap/shared/featureFilter";

export type Custom = "custom";

/** The one term of any of `fields`: null when there is none, "custom" when there are several or the text doesn't parse. */
function readOne(text: string, fields: readonly string[]) {
	const terms = filterTerms(text);
	if (!terms) return "custom";
	const found = terms.filter((t) => t.field && fields.includes(t.field));
	return found.length > 1 ? "custom" : (found[0] ?? null);
}

/**
 * `text` with the terms `match` picks replaced by `next`: the first one in place, the others
 * dropped; `next` is added at the end when none matches, and nothing is added when it is null.
 */
function setTerm(
	text: string,
	match: (t: FilterTerm) => boolean,
	next: string | null,
): string {
	const terms = filterTerms(text) ?? [];
	const out: string[] = [];
	let placed = next === null;
	for (const t of terms) {
		if (!match(t)) out.push(text.slice(t.start, t.end));
		else if (!placed) {
			out.push(next as string);
			placed = true;
		}
	}
	if (!placed) out.push(next as string);
	return out.join(" ");
}

const isField = (field: string) => (t: FilterTerm) => t.field === field;

export const TYPE_VALUES = ["pin", "line", "area"] as const;
export type TypeValue = (typeof TYPE_VALUES)[number];

/** The feature types the text asks for; none selected means all of them. `-type:pin` reads as lines and areas. */
export function readTypes(text: string): TypeValue[] | Custom {
	const t = readOne(text, ["type"]);
	if (t === "custom") return t;
	if (!t) return [];
	const chosen = TYPE_VALUES.filter((v) => t.values.includes(v) !== t.neg);
	if (chosen.length === 0) return "custom";
	return chosen.length === TYPE_VALUES.length ? [] : chosen;
}

export function writeTypes(text: string, types: readonly TypeValue[]): string {
	const chosen = TYPE_VALUES.filter((t) => types.includes(t));
	const all = chosen.length === TYPE_VALUES.length;
	return setTerm(
		text,
		isField("type"),
		chosen.length === 0 || all
			? null
			: formatFilterTerm({ neg: false, field: "type", values: chosen }),
	);
}

export type PlayerMode = "either" | "owner" | "builder";

export const PLAYER_MODES: readonly PlayerMode[] = [
	"either",
	"owner",
	"builder",
];

const PLAYER_FIELD: Record<PlayerMode, string> = {
	either: "player",
	owner: "owner",
	builder: "builder",
};
const PLAYER_FIELDS = Object.values(PLAYER_FIELD);

/** The players the text names and how they relate to the feature; "either" when it names none. */
export function readPlayers(
	text: string,
): { mode: PlayerMode; names: string[] } | Custom {
	const t = readOne(text, PLAYER_FIELDS);
	if (t === "custom" || t?.neg) return "custom";
	if (!t) return { mode: "either", names: [] };
	return {
		mode: PLAYER_MODES.find((m) => PLAYER_FIELD[m] === t.field) ?? "either",
		names: t.values,
	};
}

/** Writes the names under the field of `mode`, replacing whichever player field the text had. */
export function writePlayers(
	text: string,
	mode: PlayerMode,
	names: readonly string[],
): string {
	return setTerm(
		text,
		(t) => t.field !== null && PLAYER_FIELDS.includes(t.field),
		names.length > 0
			? formatFilterTerm({
					neg: false,
					field: PLAYER_FIELD[mode],
					values: [...names],
				})
			: null,
	);
}

/** The single colour the text asks for, or null for any. */
export function readColour(text: string): Dye | null | Custom {
	const t = readOne(text, ["color"]);
	if (t === "custom" || t?.neg || (t && t.values.length > 1)) return "custom";
	return t ? (t.values[0] as Dye) : null;
}

export function writeColour(text: string, dye: Dye | null): string {
	return setTerm(
		text,
		isField("color"),
		dye === null
			? null
			: formatFilterTerm({ neg: false, field: "color", values: [dye] }),
	);
}

/** Whether a feature must have something (`has:owner`), must not (`-has:owner`), or either. */
export type Presence = "any" | "some" | "none";
export const PRESENCES: readonly Presence[] = ["any", "some", "none"];

export type HasValue = "owner" | "builders" | "name" | "description";

const namesValue = (value: HasValue) => (t: FilterTerm) =>
	t.field === "has" && t.values.includes(value);

/** What the text asks about `value`. Terms for the other has: values are not its business, but a list like `has:owner,builders` is custom. */
export function readHas(text: string, value: HasValue): Presence | Custom {
	const terms = filterTerms(text);
	if (!terms) return "custom";
	const found = terms.filter(namesValue(value));
	const [only] = found;
	if (!only) return "any";
	if (found.length > 1 || only.values.length > 1) return "custom";
	return only.neg ? "none" : "some";
}

export function writeHas(
	text: string,
	value: HasValue,
	presence: Presence,
): string {
	return setTerm(
		text,
		namesValue(value),
		presence === "any"
			? null
			: formatFilterTerm({
					neg: presence === "none",
					field: "has",
					values: [value],
				}),
	);
}

/** The Unnamed switch is `-has:name`; `has:name` (only named ones) is not for it. */
export function readUnnamed(text: string): boolean | Custom {
	const named = readHas(text, "name");
	return named === "any" ? false : named === "none" ? true : "custom";
}

export function writeUnnamed(text: string, on: boolean): string {
	return writeHas(text, "name", on ? "none" : "any");
}

/** The units of the Edited control, in the order it lists them. */
export const EDITED_UNITS: readonly { unit: AgeUnit; name: string }[] = [
	{ unit: "min", name: "minutes" },
	{ unit: "h", name: "hours" },
	{ unit: "d", name: "days" },
	{ unit: "w", name: "weeks" },
	{ unit: "m", name: "months" },
	{ unit: "y", name: "years" },
];

/** `edited:` as the Edited control shows it: how long ago, and whether it is "not edited" (`-edited:`). */
export type Edited = { neg: boolean; n: number; unit: AgeUnit };

/** null when the text has no `edited:`. */
export function readEdited(text: string): Edited | null | Custom {
	const t = readOne(text, ["edited"]);
	if (t === "custom") return t;
	if (!t) return null;
	const age = parseAge(t.values[0] ?? "");
	return age ? { neg: t.neg, ...age } : "custom";
}

/** Writes the Edited control; null removes the term. */
export function writeEdited(text: string, edited: Edited | null): string {
	return setTerm(
		text,
		isField("edited"),
		edited === null
			? null
			: formatFilterTerm({
					neg: edited.neg,
					field: "edited",
					values: [`${edited.n}${edited.unit}`],
				}),
	);
}
