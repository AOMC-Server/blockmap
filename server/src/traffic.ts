import { DAY, HOUR, MINUTE } from "@blockmap/shared";
import { sql } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import type { Db } from "./db/client";
import { trafficHourly } from "./db/schema";
import type { Env } from "./env";
import type { AppEnv } from "./types";

/** Per-minute rows older than this are folded into one row per hour. */
export const MINUTE_RETENTION_HOURS = 24;
/** Hourly rows older than this are folded into one row per day. */
export const HOURLY_RETENTION_DAYS = 90;
const FLUSH_EVERY = MINUTE;
const MAX_DOMAINS_PER_HOUR = 200;

export const SELF_DOMAIN = "This site";
export const NO_REFERRER = "No referrer";
export const OTHER_DOMAIN = "Other";

export type TrafficCategory = (typeof trafficHourly.$inferInsert)["category"];
export const TRAFFIC_CATEGORIES: TrafficCategory[] = [
	"tiles",
	"blobs",
	"preview",
	"api",
	"auth",
	"static",
	"files",
];

export function categoryOf(path: string): TrafficCategory {
	if (path.startsWith("/blobs/")) return "blobs";
	if (path.startsWith("/files/")) return "files";
	if (/^\/api\/dimensions\/[^/]+\/tiles\//.test(path)) return "tiles";
	if (path.startsWith("/map/")) return "tiles";
	if (path === "/api/preview.png") return "preview";
	if (path.startsWith("/auth/")) return "auth";
	if (path.startsWith("/api/")) return "api";
	return "static";
}

/**
 * Where a request for tile data came from: the host of its Origin or Referer, or else the app
 * named by its User-Agent (see appOf). Requests from this site are told apart by browser
 * (`This site/Firefox 133 · Linux`, see browserOf).
 *
 * Neither host names nor "This site" contain "/", so the part before the first "/" groups the rows
 * (an app's versions, this site's browsers) and the rest tells them apart.
 */
export function domainOf(
	origin: string | undefined,
	referer: string | undefined,
	selfHost: string,
	userAgent?: string,
): string {
	for (const value of [origin, referer]) {
		if (!value || value === "null") continue;
		try {
			const host = new URL(value).host.toLowerCase().slice(0, 100);
			if (!host) continue;
			if (host !== selfHost) return host;
			const browser = browserOf(userAgent);
			return browser ? `${SELF_DOMAIN}/${browser}` : SELF_DOMAIN;
		} catch {}
	}
	return appOf(userAgent) ?? NO_REFERRER;
}

const BROWSERS: [name: string, pattern: RegExp][] = [
	// Most browsers also claim to be Chrome or Safari, so the more specific ones go first.
	["Edge", /\bEdg(?:e|A|iOS)?\/(\d+)/],
	["Opera", /\b(?:OPR|OPT)\/(\d+)/],
	["Samsung Internet", /\bSamsungBrowser\/(\d+)/],
	["Firefox", /\b(?:Firefox|FxiOS)\/(\d+)/],
	["Chrome", /\b(?:Chrome|CriOS)\/(\d+)/],
	["Safari", /\bVersion\/(\d+)[\d.]* (?:Mobile\/\S+ )?Safari\//],
];

const PLATFORMS: [name: string, pattern: RegExp][] = [
	["iOS", /\b(?:iPhone|iPad|iPod)\b/],
	["Android", /\bAndroid\b/],
	["ChromeOS", /\bCrOS\b/],
	["Windows", /\bWindows\b/],
	["macOS", /\bMac OS X\b/],
	["Linux", /\bLinux\b/],
];

/**
 * The browser, its major version and the platform, from a browser's User-Agent:
 * `Firefox 133 · Linux`. Null for a User-Agent that is not a browser's. On iOS every browser runs
 * on Safari's engine, whatever its name.
 */
export function browserOf(userAgent: string | undefined): string | null {
	if (!userAgent?.startsWith("Mozilla/")) return null;
	const platform = PLATFORMS.find(([, p]) => p.test(userAgent))?.[0] ?? "Other";
	for (const [name, pattern] of BROWSERS) {
		const m = pattern.exec(userAgent);
		if (m) return `${name} ${m[1]} · ${platform}`;
	}
	return `Other · ${platform}`;
}

/**
 * The app and version a User-Agent starts with (`AOMCGuessr/1.4 (Windows)` gives
 * `AOMCGuessr/1.4`), for tools and scripts that send no Origin or Referer. Browsers (whose
 * User-Agent starts with `Mozilla/`) and User-Agents without a version give null. Host names never
 * contain "/", so an app can't be mistaken for a domain.
 */
export function appOf(userAgent: string | undefined): string | null {
	const m = /^([A-Za-z][\w.+-]{0,39})\/([\w.+-]{1,24})/.exec(userAgent ?? "");
	if (!m || m[1] === "Mozilla") return null;
	return `${m[1]}/${m[2]}`;
}

const COUNTERS = ["requests", "bytes", "s2xx", "s3xx", "s4xx", "s5xx"] as const;

type Counter = {
	requests: number;
	bytes: number;
	s2xx: number;
	s3xx: number;
	s4xx: number;
	s5xx: number;
};

/** Counts what the server sends in memory and writes it out in batches. */
export function createTraffic(db: Db, env: Env) {
	const selfHost = new URL(env.PUBLIC_URL).host.toLowerCase();
	let pending = new Map<
		string,
		{
			hour: number;
			category: TrafficCategory;
			domain: string;
		} & Counter
	>();
	const domainsByHour = new Map<number, Set<string>>();
	let timer: ReturnType<typeof setInterval> | undefined;
	let lastFold = 0;

	function limitDomain(hour: number, domain: string): string {
		const seen = domainsByHour.get(hour) ?? new Set<string>();
		domainsByHour.set(hour, seen);
		if (seen.has(domain)) return domain;
		if (seen.size >= MAX_DOMAINS_PER_HOUR) return OTHER_DOMAIN;
		seen.add(domain);
		return domain;
	}

	/** The row of the current minute that counts requests of this category and domain. */
	function rowFor(
		category: TrafficCategory,
		domain: string,
		now: number,
	): Counter {
		const minute = Math.floor(now / MINUTE) * MINUTE;
		const hour = Math.floor(now / HOUR) * HOUR;
		for (const h of domainsByHour.keys()) if (h < hour) domainsByHour.delete(h);
		const d =
			category === "tiles" || category === "blobs"
				? limitDomain(hour, domain)
				: "";
		const key = `${minute}|${category}|${d}`;
		let row = pending.get(key);
		if (!row) {
			row = {
				hour: minute,
				category,
				domain: d,
				requests: 0,
				bytes: 0,
				s2xx: 0,
				s3xx: 0,
				s4xx: 0,
				s5xx: 0,
			};
			pending.set(key, row);
		}
		return row;
	}

	function record(
		category: TrafficCategory,
		domain: string,
		bytes: number,
		status: number,
		now = Date.now(),
	) {
		const row = rowFor(category, domain, now);
		row.requests++;
		row.bytes += bytes;
		if (status < 300) row.s2xx++;
		else if (status < 400) row.s3xx++;
		else if (status < 500) row.s4xx++;
		else row.s5xx++;
	}

	/** Folds rows older than `cutoff` (a multiple of `unit`) into one row per `unit`. */
	function foldInto(unit: number, cutoff: number) {
		const old = db.all<{
			hour: number;
			category: TrafficCategory;
			domain: string;
			requests: number;
			bytes: number;
			s2xx: number;
			s3xx: number;
			s4xx: number;
			s5xx: number;
		}>(sql`
			SELECT (hour / ${unit}) * ${unit} AS hour, category, domain, SUM(requests) AS requests,
				SUM(bytes) AS bytes, SUM(s2xx) AS s2xx, SUM(s3xx) AS s3xx, SUM(s4xx) AS s4xx,
				SUM(s5xx) AS s5xx
			FROM traffic_hourly WHERE hour < ${cutoff} AND hour % ${unit} <> 0
			GROUP BY 1, 2, 3`);
		if (old.length === 0) return;
		db.transaction((tx) => {
			tx.run(
				sql`DELETE FROM traffic_hourly WHERE hour < ${cutoff} AND hour % ${unit} <> 0`,
			);
			for (const row of old) upsert(tx, row);
		});
	}

	/** Per-minute rows become hourly after a day, and hourly rows daily after 90 days. */
	function fold(now = Date.now()) {
		foldInto(
			HOUR,
			Math.floor((now - MINUTE_RETENTION_HOURS * HOUR) / HOUR) * HOUR,
		);
		foldInto(DAY, Math.floor((now - HOURLY_RETENTION_DAYS * DAY) / DAY) * DAY);
	}

	function flush(now = Date.now()) {
		if (pending.size > 0) {
			const written = pending;
			pending = new Map();
			try {
				db.transaction((tx) => {
					for (const row of written.values()) upsert(tx, row);
				});
			} catch (err) {
				// Keep the counts for the next attempt.
				for (const [key, row] of written) {
					const merged = pending.get(key);
					if (!merged) pending.set(key, row);
					else for (const k of COUNTERS) merged[k] += row[k];
				}
				throw err;
			}
		}
		if (now - lastFold >= HOUR) {
			lastFold = now;
			fold(now);
		}
	}

	/**
	 * Takes a domain out of the breakdown: everything counted for it, all time, is added to
	 * "Other" instead, so the totals stay the same. Returns whether it had any traffic.
	 */
	function mergeDomain(domain: string, now = Date.now()): boolean {
		flush(now);
		const rows = db.all<{ hour: number; category: TrafficCategory } & Counter>(
			sql`SELECT hour, category, requests, bytes, s2xx, s3xx, s4xx, s5xx
				FROM traffic_hourly WHERE domain = ${domain}`,
		);
		if (rows.length === 0) return false;
		db.transaction((tx) => {
			tx.run(sql`DELETE FROM traffic_hourly WHERE domain = ${domain}`);
			for (const row of rows) upsert(tx, { ...row, domain: OTHER_DOMAIN });
		});
		return true;
	}

	return {
		record,
		flush,
		mergeDomain,
		/** Starts writing to the database every minute. */
		start() {
			timer = setInterval(() => {
				try {
					flush();
				} catch (err) {
					console.error("writing traffic statistics failed:", err);
				}
			}, FLUSH_EVERY);
			timer.unref?.();
		},
		stop() {
			clearInterval(timer);
			flush();
		},
		middleware: createMiddleware<AppEnv>(async (c, next) => {
			await next();
			const category = categoryOf(c.req.path);
			const domain = domainOf(
				c.req.header("Origin"),
				c.req.header("Referer"),
				selfHost,
				c.req.header("User-Agent"),
			);
			const res = c.res;
			const status = res.status;
			const length = knownLength(res);
			if (length !== null || c.req.method === "HEAD" || !res.body) {
				record(category, domain, length ?? 0, status);
				return;
			}
			// The request is counted now; its bytes are added as the body streams out.
			record(category, domain, 0, status);
			let sent = 0;
			let done = false;
			const finish = () => {
				if (done) return;
				done = true;
				rowFor(category, domain, Date.now()).bytes += sent;
			};
			const reader = res.body.getReader();
			c.res = new Response(
				new ReadableStream<Uint8Array>({
					async pull(controller) {
						try {
							const chunk = await reader.read();
							if (chunk.done) {
								finish();
								controller.close();
							} else {
								sent += chunk.value.byteLength;
								controller.enqueue(chunk.value);
							}
						} catch (err) {
							finish();
							controller.error(err);
						}
					},
					async cancel(reason) {
						finish();
						await reader.cancel(reason);
					},
				}),
				res,
			);
		}),
	};
}

/** Bytes of a response body when its length is known up front (event streams count as 0). */
function knownLength(res: Response): number | null {
	const length = res.headers.get("Content-Length");
	if (length !== null && Number.isFinite(Number(length))) return Number(length);
	const type = res.headers.get("Content-Type") ?? "";
	return type.startsWith("text/event-stream") ? 0 : null;
}

type Writer = Pick<Db, "insert">;

function upsert(
	tx: Writer,
	row: { hour: number; category: TrafficCategory; domain: string } & Counter,
) {
	tx.insert(trafficHourly)
		.values(row)
		.onConflictDoUpdate({
			target: [
				trafficHourly.hour,
				trafficHourly.category,
				trafficHourly.domain,
			],
			set: {
				requests: sql`${trafficHourly.requests} + excluded.requests`,
				bytes: sql`${trafficHourly.bytes} + excluded.bytes`,
				s2xx: sql`${trafficHourly.s2xx} + excluded.s2xx`,
				s3xx: sql`${trafficHourly.s3xx} + excluded.s3xx`,
				s4xx: sql`${trafficHourly.s4xx} + excluded.s4xx`,
				s5xx: sql`${trafficHourly.s5xx} + excluded.s5xx`,
			},
		})
		.run();
}

export type Traffic = ReturnType<typeof createTraffic>;
