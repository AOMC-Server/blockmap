import { describe, expect, test } from "bun:test";
import { type DomainRow, groupDomains, UNKNOWN_LABEL } from "./trafficDomains";

const row = (domain: string, bytes: number, lastSeen = 0): DomainRow => ({
	domain,
	tileRequests: 1,
	blobRequests: 2,
	bytes,
	firstSeen: lastSeen,
	lastSeen,
});

describe("groupDomains", () => {
	test("plain domains stay single rows", () => {
		const groups = groupDomains([row("a.com", 5), row("b.com", 9)], "bytes");
		expect(groups.map((g) => g.name)).toEqual(["b.com", "a.com"]);
		expect(groups.every((g) => g.children.length === 0)).toBe(true);
	});

	test("versions and browsers are added up under their name, largest first", () => {
		const groups = groupDomains(
			[
				row("AOMCGuessr/1.3", 10, 100),
				row("AOMCGuessr/1.4", 30, 200),
				row("This site", 1, 50),
				row("This site/Firefox 133 · Linux", 40, 300),
				row("a.com", 35),
			],
			"bytes",
		);
		expect(groups.map((g) => g.name)).toEqual([
			"This site",
			"AOMCGuessr",
			"a.com",
		]);
		const app = groups[1];
		expect(app?.total).toMatchObject({
			domain: "AOMCGuessr",
			tileRequests: 2,
			blobRequests: 4,
			bytes: 40,
			firstSeen: 100,
			lastSeen: 200,
		});
		expect(app?.children.map((c) => c.label)).toEqual(["1.4", "1.3"]);
		expect(groups[0]?.children.map((c) => c.label)).toEqual([
			"Firefox 133 · Linux",
			UNKNOWN_LABEL,
		]);
	});
});
