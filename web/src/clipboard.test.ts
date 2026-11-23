import { afterEach, describe, expect, mock, test } from "bun:test";

const toasts: [string, string][] = [];
mock.module("@aomc-server/block-ui", () => ({
	toast: (text: string, kind: string) => toasts.push([text, kind]),
}));
const { copyText } = await import("./clipboard");

const g = globalThis as unknown as Record<string, unknown>;
const saved = { navigator: g.navigator, document: g.document };

function fakeDocument(execResult: boolean | "throws") {
	const log: string[] = [];
	const field = {
		value: "",
		style: { cssText: "" },
		setAttribute() {},
		focus: () => log.push("focus field"),
		select: () => log.push("select"),
		remove: () => log.push("remove"),
	};
	const body = { appendChild: () => log.push("append") };
	g.document = {
		activeElement: null,
		body,
		createElement: () => field,
		execCommand: (cmd: string) => {
			log.push(cmd);
			if (execResult === "throws") throw new Error("no");
			return execResult;
		},
	};
	return { log, field };
}

afterEach(() => {
	toasts.length = 0;
	g.navigator = saved.navigator;
	g.document = saved.document;
});

describe("copyText", () => {
	test("uses the clipboard API when there is one", async () => {
		let copied = "";
		g.navigator = {
			clipboard: { writeText: async (t: string) => (copied = t) },
		};
		await copyText("hello", "Copied");
		expect(copied).toBe("hello");
		expect(toasts).toEqual([["Copied", "ok"]]);
	});

	test("falls back to selecting text when the API is missing or refuses", async () => {
		for (const nav of [
			{},
			{ clipboard: { writeText: async () => Promise.reject(new Error("no")) } },
		]) {
			g.navigator = nav;
			const { log, field } = fakeDocument(true);
			await copyText("hello", "Copied");
			expect(field.value).toBe("hello");
			expect(log).toEqual([
				"append",
				"focus field",
				"select",
				"copy",
				"remove",
			]);
			expect(toasts.pop()).toEqual(["Copied", "ok"]);
		}
	});

	test("says so when nothing works", async () => {
		g.navigator = {};
		fakeDocument(false);
		await copyText("hello", "Copied");
		expect(toasts[0]?.[1]).toBe("error");
		fakeDocument("throws");
		await copyText("hello", "Copied");
		expect(toasts[1]?.[1]).toBe("error");
	});
});
