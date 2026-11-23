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

/** A row of the table: one domain, or an app's versions or this site's browsers added up. */
export type DomainGroup = {
	name: string;
	total: DomainRow;
	/** The rows it adds up, labelled by what follows the "/"; empty for a plain domain. */
	children: (DomainRow & { label: string })[];
};

/** What a row without a "/" is called among rows that have one (older data, no User-Agent). */
export const UNKNOWN_LABEL = "Unknown";

/**
 * Groups the rows by the part of the domain before the first "/" (an app's versions, this site's
 * browsers; host names have none), sorted by `sort`, largest first, within groups too.
 */
export function groupDomains(
	rows: DomainRow[],
	sort: DomainSort,
): DomainGroup[] {
	const byName = new Map<string, DomainRow[]>();
	for (const row of rows) {
		const name = row.domain.split("/", 1)[0] as string;
		byName.set(name, [...(byName.get(name) ?? []), row]);
	}
	const order = <T extends DomainRow>(a: T, b: T) =>
		b[sort] - a[sort] || a.domain.localeCompare(b.domain);
	return [...byName]
		.map(([name, members]): DomainGroup => {
			const nested = members.some((m) => m.domain.includes("/"));
			return {
				name,
				total: {
					domain: name,
					tileRequests: sum(members, "tileRequests"),
					blobRequests: sum(members, "blobRequests"),
					bytes: sum(members, "bytes"),
					firstSeen: Math.min(...members.map((m) => m.firstSeen)),
					lastSeen: Math.max(...members.map((m) => m.lastSeen)),
				},
				children: nested
					? members
							.map((m) => ({
								...m,
								label: m.domain.includes("/")
									? m.domain.slice(name.length + 1)
									: UNKNOWN_LABEL,
							}))
							.sort(order)
					: [],
			};
		})
		.sort((a, b) => order(a.total, b.total));
}

const sum = (rows: DomainRow[], key: keyof DomainRow & DomainSort) =>
	rows.reduce((n, r) => n + r[key], 0);
