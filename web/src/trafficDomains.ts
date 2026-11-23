/** One row of the server's tile traffic breakdown. */
export type DomainRow = {
	domain: string;
	tileRequests: number;
	blobRequests: number;
	bytes: number;
	firstSeen: number;
	lastSeen: number;
};

export type DomainSort = "bytes" | "tileRequests" | "blobRequests" | "lastSeen";

/**
 * A row of the table: one domain, or rows added up (an app's versions, this site's browsers, one
 * browser's versions), which it opens up into.
 */
export type DomainNode = {
	/** Unique in the table. */
	key: string;
	label: string;
	total: DomainRow;
	/** The server's rows it covers. */
	domains: string[];
	children: DomainNode[];
};

/** What a row without a "/" is called among rows that have one (older data, no User-Agent). */
export const UNKNOWN_LABEL = "Unknown";
const SELF_DOMAIN = "This site";

/**
 * Groups the rows by the part of the domain before the first "/" (an app's versions, this site's
 * browsers; host names have none), and this site's browsers again by browser, so versions and
 * platforms are under it. Sorted by `sort`, largest first, at every level.
 */
export function groupDomains(
	rows: DomainRow[],
	sort: DomainSort,
): DomainNode[] {
	const byName = groupBy(rows, (r) => r.domain.split("/", 1)[0] as string);
	const order = (a: DomainNode, b: DomainNode) =>
		b.total[sort] - a.total[sort] || a.key.localeCompare(b.key);
	return [...byName]
		.map(([name, members]) => {
			if (!members.some((m) => m.domain.includes("/")))
				return node(name, name, members, []);
			const leaves = members.map((m) => {
				const label = m.domain.includes("/")
					? m.domain.slice(name.length + 1)
					: UNKNOWN_LABEL;
				return node(m.domain, label, [m], []);
			});
			const children =
				name === SELF_DOMAIN ? byBrowser(name, leaves, order) : leaves;
			return node(name, name, members, children.sort(order));
		})
		.sort(order);
}

/** Puts this site's rows (`Firefox 133 · Linux`) under their browser (`Firefox`, then `133 · Linux`). */
function byBrowser(
	parent: string,
	leaves: DomainNode[],
	order: (a: DomainNode, b: DomainNode) => number,
): DomainNode[] {
	const out: DomainNode[] = [];
	const families = new Map<string, DomainNode[]>();
	for (const leaf of leaves) {
		const parsed = splitBrowser(leaf.label);
		if (!parsed) {
			out.push(leaf);
			continue;
		}
		const list = families.get(parsed.browser) ?? [];
		list.push({ ...leaf, label: parsed.rest });
		families.set(parsed.browser, list);
	}
	for (const [browser, list] of families) {
		const n = node(
			`${parent}/${browser}`,
			browser,
			list.map((l) => l.total),
			list.sort(order),
		);
		out.push(n);
	}
	return out;
}

/** `Firefox 133 · Linux` → Firefox, `133 · Linux`; `Other · Linux` → Other, `Linux`. */
export function splitBrowser(
	label: string,
): { browser: string; rest: string } | null {
	const versioned = /^(.+?) (\d+) · (.+)$/.exec(label);
	if (versioned)
		return {
			browser: versioned[1] as string,
			rest: `${versioned[2]} · ${versioned[3]}`,
		};
	const plain = /^(.+?) · (.+)$/.exec(label);
	if (plain) return { browser: plain[1] as string, rest: plain[2] as string };
	return null;
}

function node(
	key: string,
	label: string,
	rows: DomainRow[],
	children: DomainNode[],
): DomainNode {
	return {
		key,
		label,
		total: {
			domain: key,
			tileRequests: sum(rows, "tileRequests"),
			blobRequests: sum(rows, "blobRequests"),
			bytes: sum(rows, "bytes"),
			firstSeen: Math.min(...rows.map((r) => r.firstSeen)),
			lastSeen: Math.max(...rows.map((r) => r.lastSeen)),
		},
		domains: rows.map((r) => r.domain),
		children,
	};
}

function groupBy<T>(items: T[], keyOf: (item: T) => string) {
	const out = new Map<string, T[]>();
	for (const item of items) {
		const k = keyOf(item);
		out.set(k, [...(out.get(k) ?? []), item]);
	}
	return out;
}

const sum = (rows: DomainRow[], key: DomainSort) =>
	rows.reduce((n, r) => n + r[key], 0);
