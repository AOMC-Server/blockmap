import { describe, expect, test } from "bun:test";
import {
	type DomainNode,
	type DomainRow,
	groupDomains,
	splitBrowser,
	UNKNOWN_LABEL,
} from "./trafficDomains";

const row = (domain: string, bytes: number, lastSeen = 0): DomainRow => ({
	domain,
	tileRequests: 1,
	blobRequests: 2,
	bytes,
	firstSeen: lastSeen,
	lastSeen,
});
const labels = (nodes: DomainNode[] | undefined) => nodes?.map((n) => n.label);

describe("groupDomains", () => {
	test("plain domains stay single rows", () => {
		const groups = groupDomains([row("a.com", 5), row("b.com", 9)], "bytes");
		expect(labels(groups)).toEqual(["b.com", "a.com"]);
		expect(groups.every((g) => g.children.length === 0)).toBe(true);
		expect(groups[0]?.domains).toEqual(["b.com"]);
	});

	test("an app's versions are added up under its name, largest first", () => {
		const [app] = groupDomains(
			[row("AOMCGuessr/1.3", 10, 100), row("AOMCGuessr/1.4", 30, 200)],
			"bytes",
		);
		expect(app?.total).toMatchObject({
			tileRequests: 2,
			blobRequests: 4,
			bytes: 40,
			firstSeen: 100,
			lastSeen: 200,
		});
		expect(labels(app?.children)).toEqual(["1.4", "1.3"]);
		expect(app?.domains.sort()).toEqual(["AOMCGuessr/1.3", "AOMCGuessr/1.4"]);
	});

	test("this site's rows are grouped by browser, then version and platform", () => {
		const groups = groupDomains(
			[
				row("This site", 1),
				row("This site/Firefox 133 · Linux", 40),
				row("This site/Firefox 132 · Windows", 5),
				row("This site/Chrome 131 · Android", 20),
				row("This site/Other · Linux", 2),
				row("a.com", 35),
			],
			"bytes",
		);
		expect(labels(groups)).toEqual(["This site", "a.com"]);
		const self = groups[0];
		expect(self?.total.bytes).toBe(68);
		expect(labels(self?.children)).toEqual([
			"Firefox",
			"Chrome",
			"Other",
			UNKNOWN_LABEL,
		]);
		const firefox = self?.children[0];
		expect(firefox?.total.bytes).toBe(45);
		expect(labels(firefox?.children)).toEqual(["133 · Linux", "132 · Windows"]);
		expect(firefox?.domains.sort()).toEqual([
			"This site/Firefox 132 · Windows",
			"This site/Firefox 133 · Linux",
		]);
		expect(labels(self?.children[2]?.children)).toEqual(["Linux"]);
	});
});

describe("splitBrowser", () => {
	test("browser names may have spaces", () => {
		expect(splitBrowser("Samsung Internet 26 · Android")).toEqual({
			browser: "Samsung Internet",
			rest: "26 · Android",
		});
		expect(splitBrowser(UNKNOWN_LABEL)).toBeNull();
	});
});
