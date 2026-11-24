import { describe, expect, test } from "bun:test";
import {
	readColour,
	readEdited,
	readHas,
	readPlayers,
	readTypes,
	readUnnamed,
	writeColour,
	writeEdited,
	writeHas,
	writePlayers,
	writeTypes,
	writeUnnamed,
} from "./filterQuick";

describe("types", () => {
	test("reads the types in a fixed order; none or all is no choice", () => {
		expect(readTypes("")).toEqual([]);
		expect(readTypes("type:area,pin")).toEqual(["pin", "area"]);
		expect(readTypes("type:pin,line,area")).toEqual([]);
	});

	test("a negated type is the other two", () => {
		expect(readTypes("-type:pin")).toEqual(["line", "area"]);
		expect(readTypes("-type:pin,line,area")).toBe("custom");
	});

	test("custom: twice, or a text that doesn't parse", () => {
		expect(readTypes("type:pin type:line")).toBe("custom");
		expect(readTypes("type:hat")).toBe("custom");
	});

	test("writes the chosen types in place; none or all removes the term", () => {
		expect(writeTypes("owner:a", ["area", "pin"])).toBe(
			"owner:a type:pin,area",
		);
		expect(writeTypes("type:pin owner:a", ["line"])).toBe("type:line owner:a");
		expect(writeTypes("-type:pin owner:a", ["line", "area"])).toBe(
			"type:line,area owner:a",
		);
		expect(writeTypes("type:pin owner:a", [])).toBe("owner:a");
		expect(writeTypes("type:pin", ["pin", "line", "area"])).toBe("");
	});
});

describe("players", () => {
	test("none by default, else the field and names", () => {
		expect(readPlayers("type:pin")).toEqual({ mode: "either", names: [] });
		expect(readPlayers("player:Steve,Alex")).toEqual({
			mode: "either",
			names: ["Steve", "Alex"],
		});
		expect(readPlayers('owner:"Mr Bean"')).toEqual({
			mode: "owner",
			names: ["Mr Bean"],
		});
		expect(readPlayers("builder:A")).toEqual({ mode: "builder", names: ["A"] });
	});

	test("custom: two player fields or a negated one", () => {
		expect(readPlayers("owner:a builder:b")).toBe("custom");
		expect(readPlayers("player:a player:b")).toBe("custom");
		expect(readPlayers("-owner:a")).toBe("custom");
	});

	test("writes under the field of the mode, replacing the old one", () => {
		expect(writePlayers("type:pin", "owner", ["Mr Bean"])).toBe(
			'type:pin owner:"Mr Bean"',
		);
		expect(writePlayers("owner:a type:pin", "builder", ["a"])).toBe(
			"builder:a type:pin",
		);
		expect(writePlayers("player:a type:pin", "either", [])).toBe("type:pin");
	});
});

describe("colour", () => {
	test("one colour, any, or custom", () => {
		expect(readColour("")).toBeNull();
		expect(readColour("colour:light-blue")).toBe("light_blue");
		expect(readColour("color:red,blue")).toBe("custom");
		expect(readColour("-color:red")).toBe("custom");
	});

	test("writes the canonical spelling", () => {
		expect(writeColour("colour:red type:pin", "light_blue")).toBe(
			"color:light_blue type:pin",
		);
		expect(writeColour("color:red type:pin", null)).toBe("type:pin");
	});
});

describe("presence (owner, builders, name, description)", () => {
	test("any, has, none", () => {
		expect(readHas("type:pin", "owner")).toBe("any");
		expect(readHas("has:owner", "owner")).toBe("some");
		expect(readHas("-has:owner", "owner")).toBe("none");
	});

	test("each value is its own question", () => {
		const text = "has:owner -has:builders";
		expect(readHas(text, "owner")).toBe("some");
		expect(readHas(text, "builders")).toBe("none");
		expect(readHas(text, "name")).toBe("any");
	});

	test("a list or a repeat is custom", () => {
		expect(readHas("has:owner,builders", "owner")).toBe("custom");
		expect(readHas("has:owner,builders", "builders")).toBe("custom");
		expect(readHas("has:owner,builders", "name")).toBe("any");
		expect(readHas("has:owner -has:owner", "owner")).toBe("custom");
		expect(readHas("has:hat", "owner")).toBe("custom");
	});

	test("writes separate terms and leaves the others alone", () => {
		let text = writeHas("type:pin", "owner", "some");
		text = writeHas(text, "builders", "none");
		expect(text).toBe("type:pin has:owner -has:builders");
		expect(writeHas(text, "owner", "none")).toBe(
			"type:pin -has:owner -has:builders",
		);
		expect(writeHas(text, "builders", "any")).toBe("type:pin has:owner");
	});

	test("the Unnamed switch is -has:name", () => {
		expect(readUnnamed("type:pin")).toBe(false);
		expect(readUnnamed("type:pin -has:name")).toBe(true);
		expect(readUnnamed("has:name")).toBe("custom");
		expect(writeUnnamed("type:pin", true)).toBe("type:pin -has:name");
		expect(writeUnnamed("-has:name type:pin", false)).toBe("type:pin");
	});
});

describe("edited", () => {
	test("reads any age, in every unit, and whether it is negated", () => {
		expect(readEdited("")).toBeNull();
		expect(readEdited("edited:7d")).toEqual({ neg: false, n: 7, unit: "d" });
		expect(readEdited("EDITED:30D")).toEqual({ neg: false, n: 30, unit: "d" });
		expect(readEdited("edited:15min")).toEqual({
			neg: false,
			n: 15,
			unit: "min",
		});
		expect(readEdited("edited:2h")).toEqual({ neg: false, n: 2, unit: "h" });
		expect(readEdited("-edited:1y")).toEqual({ neg: true, n: 1, unit: "y" });
	});

	test("repeats are custom", () => {
		expect(readEdited("edited:7d edited:30d")).toBe("custom");
	});

	test("writes and removes the term", () => {
		expect(writeEdited("type:pin", { neg: false, n: 30, unit: "min" })).toBe(
			"type:pin edited:30min",
		);
		expect(
			writeEdited("edited:7d type:pin", { neg: true, n: 1, unit: "y" }),
		).toBe("-edited:1y type:pin");
		expect(writeEdited("edited:7d", null)).toBe("");
	});
});

describe("the help's own examples", () => {
	test("leave their controls usable", () => {
		expect(readUnnamed("type:pin -has:name")).toBe(true);
		expect(readTypes("type:pin -has:name")).toEqual(["pin"]);
		expect(readHas("type:area -has:owner", "owner")).toBe("none");
		expect(readEdited("type:pin edited:30d")).toEqual({
			neg: false,
			n: 30,
			unit: "d",
		});
		expect(readEdited("has:owner -edited:1y")).toEqual({
			neg: true,
			n: 1,
			unit: "y",
		});
	});
});
