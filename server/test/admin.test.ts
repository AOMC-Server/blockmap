import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DAY, FIVE_MINUTES, HOUR, MINUTE } from "@blockmap/shared";
import { eq } from "drizzle-orm";
import {
	blobFiles,
	jobs,
	storageHistory,
	trafficHourly,
} from "../src/db/schema";
import { recordMissingBlobSizes } from "../src/storage";
import {
	appOf,
	browserOf,
	categoryOf,
	createTraffic,
	domainOf,
	NO_REFERRER,
	OTHER_DOMAIN,
	SELF_DOMAIN,
} from "../src/traffic";
import {
	bootTiles,
	call,
	cleanupTempDirs,
	erase,
	makeUser,
	RED,
	solid,
	T,
	upload,
} from "./helpers";

afterAll(cleanupTempDirs);

const boot = () => bootTiles({}, { owner: true });

describe("storage", () => {
	test("blob sizes are recorded when written, and history grows after uploads and deletions", async () => {
		const t = await boot();
		const id = await upload(t, await solid(T, T, RED), 0, 0);
		await upload(t, await solid(T * 2, T, RED), 0, 0);

		const blobs = await t.db.select().from(blobFiles);
		expect(blobs.length).toBeGreaterThan(0);
		const history = await t.db.select().from(storageHistory);
		expect(history.map((h) => h.reason)).toEqual(["upload", "upload"]);
		const last = history[1];
		expect(last?.blobCount).toBe(blobs.length);
		expect(last?.blobBytes).toBe(blobs.reduce((n, b) => n + b.bytes, 0));
		expect(last?.referencedBytes).toBe(last?.blobBytes ?? -1);
		expect(last?.dbBytes).toBeGreaterThan(0);

		await erase(t, id);
		const after = await t.db.select().from(storageHistory);
		expect(after.at(-1)?.reason).toBe("erase");
		expect(after.at(-1)?.blobCount).toBe(blobs.length);
	});

	test("images written before sizes were tracked get a size once", async () => {
		const t = await boot();
		await upload(t, await solid(T, T, RED), 0, 0);
		const [known] = await t.db.select().from(blobFiles);
		await t.db.delete(blobFiles);
		const dir = join(t.env.DATA_DIR, "blobs");
		expect(await recordMissingBlobSizes(t.db, dir)).toBeGreaterThan(0);
		const [again] = await t.db
			.select()
			.from(blobFiles)
			.where(eq(blobFiles.hash, known?.hash ?? ""));
		expect(again?.bytes).toBe(known?.bytes ?? -1);
		expect(await recordMissingBlobSizes(t.db, dir)).toBe(0);

		const stray = join(dir, "zz");
		mkdirSync(stray, { recursive: true });
		writeFileSync(join(stray, "notes.webp"), "x");
		expect(await recordMissingBlobSizes(t.db, dir)).toBe(0);
	});
});

describe("job queue", () => {
	test("anyone sees the queued jobs; moderators also see the ones that ran", async () => {
		const t = await boot();
		const id = await upload(t, await solid(T, T, RED), 0, 0);
		t.db.insert(jobs).values({ type: "gc_blobs", payload: {} }).run();
		t.db
			.insert(jobs)
			.values({ type: "rebuild_history", payload: {}, status: "processing" })
			.run();

		const pub = await call(t, null, "GET", "/api/queue");
		expect(pub.status).toBe(200);
		expect(
			pub.body.jobs.map((j: { type: string; status: string }) => [
				j.type,
				j.status,
			]),
		).toEqual([
			["rebuild_history", "processing"],
			["gc_blobs", "pending"],
		]);
		expect(pub.body.jobs[0]).not.toHaveProperty("error");

		expect((await call(t, t.editor, "GET", "/api/admin/jobs")).status).toBe(
			403,
		);
		const admin = await call(t, t.mod, "GET", "/api/admin/jobs");
		expect(admin.status).toBe(200);
		expect(admin.body.open).toHaveLength(2);
		const [done] = admin.body.recent;
		expect(done).toMatchObject({
			type: "process_upload",
			status: "done",
			revisionId: id,
			author: "editor",
			dimension: "Overworld",
			fileCount: 1,
			attempts: 1,
		});
	});
});

describe("traffic classification", () => {
	test("categories", () => {
		expect(categoryOf("/blobs/ab.webp")).toBe("blobs");
		expect(categoryOf("/api/dimensions/overworld/tiles/0/1/2")).toBe("tiles");
		expect(categoryOf("/api/preview.png")).toBe("preview");
		expect(categoryOf("/api/layers")).toBe("api");
		expect(categoryOf("/auth/discord")).toBe("auth");
		expect(categoryOf("/assets/index.js")).toBe("static");
	});

	test("the domain comes from Origin, then Referer", () => {
		const self = "map.example";
		expect(domainOf("https://Other.Site", undefined, self)).toBe("other.site");
		expect(domainOf(undefined, "https://a.b:8080/page?x=1", self)).toBe(
			"a.b:8080",
		);
		expect(domainOf("https://x.y", "https://z.w/", self)).toBe("x.y");
		expect(domainOf("https://map.example", undefined, self)).toBe(SELF_DOMAIN);
		expect(domainOf("null", "not a url", self)).toBe(NO_REFERRER);
		expect(domainOf(undefined, undefined, self)).toBe(NO_REFERRER);
	});

	test("this site's requests are told apart by browser, version and platform", () => {
		const ua = {
			firefoxLinux:
				"Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
			chromeWindows:
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
			edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
			safariMac:
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
			safariIphone:
				"Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
			chromeIphone:
				"Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1",
			chromeAndroid:
				"Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
			samsung:
				"Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36",
		};
		expect(browserOf(ua.firefoxLinux)).toBe("Firefox 133 · Linux");
		expect(browserOf(ua.chromeWindows)).toBe("Chrome 131 · Windows");
		expect(browserOf(ua.edge)).toBe("Edge 131 · Windows");
		expect(browserOf(ua.safariMac)).toBe("Safari 18 · macOS");
		expect(browserOf(ua.safariIphone)).toBe("Safari 18 · iOS");
		expect(browserOf(ua.chromeIphone)).toBe("Chrome 131 · iOS");
		expect(browserOf(ua.chromeAndroid)).toBe("Chrome 131 · Android");
		expect(browserOf(ua.samsung)).toBe("Samsung Internet 26 · Android");
		expect(browserOf("Mozilla/5.0 (compatible; Bot)")).toBe("Other · Other");
		expect(browserOf("AOMCGuessr/1.4")).toBeNull();
		expect(browserOf(undefined)).toBeNull();

		const self = "map.example";
		expect(domainOf("https://map.example", undefined, self, ua.edge)).toBe(
			`${SELF_DOMAIN}/Edge 131 · Windows`,
		);
		expect(domainOf("https://other.site", undefined, self, ua.edge)).toBe(
			"other.site",
		);
	});

	test("without Origin or Referer, the app and version from the User-Agent", () => {
		const self = "map.example";
		expect(
			domainOf(undefined, undefined, self, "AOMCGuessr/1.4.2 (Windows)"),
		).toBe("AOMCGuessr/1.4.2");
		expect(domainOf(undefined, undefined, self, "curl/8.4.0")).toBe(
			"curl/8.4.0",
		);
		expect(domainOf("https://a.b", undefined, self, "AOMCGuessr/1.4")).toBe(
			"a.b",
		);
		expect(appOf("Mozilla/5.0 (X11; Linux x86_64) Firefox/120.0")).toBeNull();
		expect(appOf("AOMCGuessr")).toBeNull();
		expect(appOf("")).toBeNull();
		expect(appOf(undefined)).toBeNull();
		expect(appOf(`${"x".repeat(60)}/1`)).toBeNull();
	});
});

describe("traffic collection", () => {
	test("counts are batched, added up per hour, and attributed to a domain for tiles and blobs only", async () => {
		const t = await boot();
		const traffic = createTraffic(t.db, t.env);
		const now = Date.UTC(2026, 5, 1, 12, 30);
		traffic.record("tiles", "a.com", 0, 302, now);
		traffic.record("blobs", "a.com", 500, 200, now);
		traffic.record("blobs", "a.com", 700, 200, now + 1000);
		traffic.record("api", "a.com", 40, 404, now);
		expect(await t.db.select().from(trafficHourly)).toHaveLength(0);

		traffic.flush(now);
		traffic.record("blobs", "a.com", 100, 200, now);
		traffic.flush(now);
		const rows = await t.db.select().from(trafficHourly);
		const blobs = rows.find((r) => r.category === "blobs");
		expect(blobs).toMatchObject({
			hour: Math.floor(now / MINUTE) * MINUTE,
			domain: "a.com",
			requests: 3,
			bytes: 1300,
			s2xx: 3,
		});
		expect(rows.find((r) => r.category === "api")).toMatchObject({
			domain: "",
			s4xx: 1,
		});
	});

	test("an unbounded number of domains collapses into 'Other'", async () => {
		const t = await boot();
		const traffic = createTraffic(t.db, t.env);
		const now = Date.UTC(2026, 5, 1, 12);
		for (let i = 0; i < 250; i++)
			traffic.record("tiles", `d${i}.com`, 0, 302, now);
		traffic.flush(now);
		const rows = await t.db.select().from(trafficHourly);
		expect(rows).toHaveLength(201);
		expect(rows.find((r) => r.domain === OTHER_DOMAIN)?.requests).toBe(50);
	});

	test("hourly rows past 90 days are folded into days", async () => {
		const t = await boot();
		const traffic = createTraffic(t.db, t.env);
		const now = Date.UTC(2026, 8, 1);
		const day = Date.UTC(2026, 2, 1);
		for (const h of [3, 4, 5])
			traffic.record("api", "", 10, 200, day + h * HOUR);
		traffic.record("api", "", 10, 200, now - HOUR);
		traffic.flush(now);
		const rows = await t.db.select().from(trafficHourly);
		const old = rows.filter((r) => r.hour < now - 90 * DAY);
		expect(old).toHaveLength(1);
		expect(old[0]).toMatchObject({ hour: day, requests: 3, bytes: 30 });
		expect(rows).toHaveLength(2);
	});
});

describe("traffic detail", () => {
	test("rows are per minute for a day, then hourly", async () => {
		const t = await boot();
		const traffic = createTraffic(t.db, t.env);
		const now = Date.UTC(2026, 5, 10, 12, 0);
		const old = now - 30 * HOUR + 5 * MINUTE;
		traffic.record("api", "", 10, 200, old);
		traffic.record("api", "", 10, 200, old + 2 * MINUTE);
		traffic.record("api", "", 10, 200, now - 5 * MINUTE);
		traffic.record("api", "", 10, 200, now - 5 * MINUTE + 1000);
		traffic.flush(now);
		const rows = await t.db.select().from(trafficHourly);
		expect(rows).toHaveLength(2);
		const folded = rows.find((r) => r.hour % HOUR === 0);
		expect(folded).toMatchObject({
			hour: Math.floor(old / HOUR) * HOUR,
			requests: 2,
		});
		const recent = rows.find((r) => r.hour % HOUR !== 0);
		expect(recent).toMatchObject({ hour: now - 5 * MINUTE, requests: 2 });
	});

	test("the last-hour range has one bucket per minute", async () => {
		const t = await boot();
		await t.app.request("/api/map");
		const res = await call(t, t.owner, "GET", "/api/admin/stats?range=1h");
		expect(res.status).toBe(200);
		expect(res.body.traffic.bucketMs).toBe(MINUTE);
		expect(res.body.traffic.points.length).toBeGreaterThanOrEqual(60);
		expect(res.body.traffic.points.length).toBeLessThanOrEqual(62);
		expect(res.body.traffic.range.total.requests).toBeGreaterThanOrEqual(1);
	});

	test("the last-week range has one bucket per three hours", async () => {
		const t = await boot();
		const res = await call(t, t.owner, "GET", "/api/admin/stats?range=7d");
		expect(res.body.traffic.bucketMs).toBe(3 * HOUR);
		expect(res.body.traffic.points.length).toBeGreaterThanOrEqual(56);
		expect(res.body.traffic.points.length).toBeLessThanOrEqual(58);
	});

	test("the last-6-hours range has one bucket per five minutes", async () => {
		const t = await boot();
		await t.app.request("/api/map");
		const res = await call(t, t.owner, "GET", "/api/admin/stats?range=6h");
		expect(res.status).toBe(200);
		expect(res.body.traffic.bucketMs).toBe(FIVE_MINUTES);
		expect(res.body.traffic.points.length).toBeGreaterThanOrEqual(72);
		expect(res.body.traffic.points.length).toBeLessThanOrEqual(74);
		expect(res.body.traffic.range.total.requests).toBeGreaterThanOrEqual(1);
	});
});

describe("GET /api/admin/stats", () => {
	test("owners only", async () => {
		const t = await boot();
		expect((await call(t, null, "GET", "/api/admin/stats")).status).toBe(401);
		expect((await call(t, t.mod, "GET", "/api/admin/stats")).status).toBe(403);
		const editor = await makeUser(t.db, "someone");
		expect((await call(t, editor, "GET", "/api/admin/stats")).status).toBe(403);
		const invalid = await call(t, t.owner, "GET", "/api/admin/stats?range=1y");
		expect(invalid.status).toBe(400);
		expect(invalid.body.error).toBe("invalid request");
		expect(invalid.body.issues.length).toBeGreaterThan(0);
		expect((await call(t, t.owner, "GET", "/api/admin/stats")).status).toBe(
			200,
		);
	});

	test("reports storage, traffic by domain and an overview", async () => {
		const t = await boot();
		await upload(t, await solid(T, T, RED), 0, 0);
		const tile = await t.app.request("/api/dimensions/overworld/tiles/0/0/0", {
			headers: { Referer: "https://other.example/page" },
		});
		expect(tile.status).toBe(302);
		const blob = await t.app.request(tile.headers.get("location") as string, {
			headers: { Referer: "https://other.example/page" },
		});
		const size = (await blob.arrayBuffer()).byteLength;
		await t.app.request("/api/dimensions/overworld/tiles/0/0/0");

		const res = await call(t, t.owner, "GET", "/api/admin/stats?range=24h");
		expect(res.status).toBe(200);
		const { storage, traffic, overview } = res.body;

		expect(storage.current.blobCount).toBeGreaterThan(0);
		expect(storage.history.length).toBeGreaterThan(0);

		const other = traffic.domains.find(
			(d: { domain: string }) => d.domain === "other.example",
		);
		expect(other).toMatchObject({
			tileRequests: 1,
			blobRequests: 1,
			bytes: size,
		});
		expect(
			traffic.domains.find((d: { domain: string }) => d.domain === NO_REFERRER)
				.tileRequests,
		).toBeGreaterThanOrEqual(1);
		expect(traffic.range.byCategory.blobs.bytes).toBe(size);
		expect(traffic.allTime.total.requests).toBeGreaterThanOrEqual(3);
		expect(traffic.bucketMs).toBe(HOUR);
		expect(traffic.points.length).toBeGreaterThan(0);

		expect(overview.users.total).toBe(3);
		expect(overview.map.uploadsDone).toBe(1);
		expect(overview.tiles.images).toBe(storage.current.blobCount);
		expect(overview.jobs).toMatchObject({ pending: 0, failed: 0 });
		expect(overview.process.uptimeSeconds).toBeGreaterThanOrEqual(0);
	});

	test("tools without a Referer are listed by the app and version in their User-Agent", async () => {
		const t = await boot();
		await t.app.request("/api/dimensions/overworld/tiles/0/0/0", {
			headers: { "User-Agent": "AOMCGuessr/1.4 (Windows)" },
		});
		const res = await call(t, t.owner, "GET", "/api/admin/stats?range=24h");
		expect(
			res.body.traffic.domains.find(
				(d: { domain: string }) => d.domain === "AOMCGuessr/1.4",
			)?.tileRequests,
		).toBe(1);
	});

	test("server errors are counted apart from client errors", async () => {
		const t = await boot();
		const now = Date.now();
		t.services.traffic.record("api", "", 10, 404, now);
		t.services.traffic.record("api", "", 10, 500, now);
		t.services.traffic.record("api", "", 10, 503, now);
		const res = await call(t, t.owner, "GET", "/api/admin/stats?range=24h");
		const { total, byCategory } = res.body.traffic.range;
		expect(total.s4xx).toBe(1);
		expect(total.s5xx).toBe(2);
		expect(byCategory.api.s5xx).toBe(2);
		expect(byCategory.tiles.s5xx).toBe(0);
		expect(res.body.traffic.allTime.total.s5xx).toBe(2);
	});

	test("the all-time range with no traffic yields a short series", async () => {
		const t = await boot();
		const res = await call(t, t.owner, "GET", "/api/admin/stats?range=all");
		expect(res.body.since).toBeNull();
		expect(res.body.traffic.bucketMs).toBe(DAY);
		expect(res.body.traffic.points.length).toBeLessThan(5);
	});
});

describe("DELETE /api/admin/traffic/domains/:domain", () => {
	test("moves the domain's traffic to 'Other', keeping the totals", async () => {
		const t = await boot();
		const now = Date.now();
		const { traffic } = t.services;
		traffic.record("tiles", "spam.example", 0, 302, now - 2 * DAY);
		traffic.record("blobs", "spam.example", 500, 200, now);
		traffic.record("blobs", "kept.example", 100, 200, now);
		traffic.record("blobs", OTHER_DOMAIN, 50, 200, now);
		const before = await call(t, t.owner, "GET", "/api/admin/stats?range=all");

		const path = `/api/admin/traffic/domains/${encodeURIComponent("spam.example")}`;
		expect((await call(t, t.mod, "DELETE", path)).status).toBe(403);
		expect((await call(t, t.owner, "DELETE", path)).status).toBe(200);
		expect((await call(t, t.owner, "DELETE", path)).status).toBe(404);

		const after = await call(t, t.owner, "GET", "/api/admin/stats?range=all");
		const domains = after.body.traffic.domains as {
			domain: string;
			tileRequests: number;
			bytes: number;
		}[];
		expect(domains.map((d) => d.domain).sort()).toEqual([
			"Other",
			"kept.example",
		]);
		expect(domains.find((d) => d.domain === OTHER_DOMAIN)).toMatchObject({
			tileRequests: 1,
			bytes: 550,
		});
		// The test's own API requests are counted too, so only tiles and images are compared.
		for (const category of ["tiles", "blobs"])
			expect(after.body.traffic.allTime.byCategory[category]).toEqual(
				before.body.traffic.allTime.byCategory[category],
			);
	});

	test("an app version can be removed", async () => {
		const t = await boot();
		t.services.traffic.record("tiles", "AOMCGuessr/1.4", 0, 302);
		const res = await call(
			t,
			t.owner,
			"DELETE",
			`/api/admin/traffic/domains/${"AOMCGuessr/1.4"}`,
		);
		expect(res.status).toBe(200);
		const rows = await t.db.select().from(trafficHourly);
		expect(rows.map((r) => r.domain)).not.toContain("AOMCGuessr/1.4");
	});

	test("the grouped rows and this site's browsers cannot be removed", async () => {
		const t = await boot();
		for (const name of [
			SELF_DOMAIN,
			`${SELF_DOMAIN}/Firefox 133 · Linux`,
			NO_REFERRER,
			OTHER_DOMAIN,
		]) {
			const res = await call(
				t,
				t.owner,
				"DELETE",
				`/api/admin/traffic/domains/${encodeURIComponent(name)}`,
			);
			expect(res.status).toBe(400);
		}
	});
});
