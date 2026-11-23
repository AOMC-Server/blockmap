import { type ShareView, shareViewSchema } from "@blockmap/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Db } from "../db/client";
import { shortLinks } from "../db/schema";
import { dimensionBySlug } from "../dimensionLookup";
import { doc } from "../openapi";
import { clientKey } from "../ratelimit";
import { revOfSeq, seqOfRev } from "../tiles/history";
import type { AppEnv } from "../types";
import { validate } from "../validate";

const ALPHABET =
	"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** 62^7 is about 3.5 trillion codes: guessing one that exists is hopeless. */
const CODE_LENGTH = 7;
const CODE_RE = /^[0-9A-Za-z]{1,32}$/;

function randomCode(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
	// 62 does not divide 256, which favours the first few characters very slightly; harmless here.
	return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
}

/**
 * The query string the web app reads for a view. The same view always gives the same string,
 * so it gets the same link: layers are sorted and deduplicated and the zoom is rounded the way
 * the app writes it in the address bar. A revision is kept as the `seq` of its upload, so the
 * link keeps its moment when uploads are added before it or deleted.
 */
export function viewQuery(v: ShareView, seq?: number): string {
	const q = new URLSearchParams();
	q.set("dim", v.dim);
	q.set("x", String(v.x));
	q.set("z", String(v.z));
	q.set("zoom", String(Math.round(v.zoom * 100) / 100));
	if (seq !== undefined) q.set("seq", String(seq));
	if (v.layers !== undefined)
		q.set("layers", [...new Set(v.layers)].sort((a, b) => a - b).join(","));
	return q.toString();
}

function findOrCreate(db: Db, query: string, userId: string | null) {
	return db.transaction((tx) => {
		const existing = tx
			.select({ code: shortLinks.code })
			.from(shortLinks)
			.where(eq(shortLinks.query, query))
			.get();
		if (existing) return { code: existing.code, created: false };
		for (let attempt = 0; attempt < 5; attempt++) {
			const code = randomCode();
			const taken = tx
				.select({ code: shortLinks.code })
				.from(shortLinks)
				.where(eq(shortLinks.code, code))
				.get();
			if (taken) continue;
			tx.insert(shortLinks).values({ code, query, createdBy: userId }).run();
			return { code, created: true };
		}
		throw new Error("no free short link code");
	});
}

/** /api/links: making short links. Anyone may, logged in or not. */
export const linkRoutes = new Hono<AppEnv>().post(
	"/",
	doc({
		tag: "Map",
		summary: "Make a short link to a view",
		description:
			"Saves a view (dimension, position, zoom, optionally a revision and the layers shown) and answers a short `url` that opens it. A revision is kept as the upload it names, so the link keeps its moment when revision numbers shift. The same view always gets the same link. Anyone may make links, a limited number per minute.",
		ok: { 200: "The view already had a link", 201: "Link created" },
		fails: [400, 429],
	}),
	validate("json", shareViewSchema),
	async (c) => {
		const { db, env, map, svc, user } = c.var;
		if (!svc.linkLimiter.hit(user?.id ?? clientKey(c)))
			return c.json({ error: "too many links, slow down" }, 429);
		const view = c.req.valid("json");
		if (!dimensionBySlug(db, view.dim))
			return c.json({ error: "unknown dimension" }, 400);
		const pinned =
			view.rev !== undefined && view.rev <= map.headRev
				? await seqOfRev(db, view.rev)
				: undefined;
		const { code, created } = findOrCreate(
			db,
			viewQuery(view, pinned),
			user?.id ?? null,
		);
		const url = new URL(`/s/${code}`, env.PUBLIC_URL).toString();
		return c.json({ code, url }, created ? 201 : 200);
	},
);

/** /s/<code>: opens the saved view. */
export const shortLinkRedirect = new Hono<AppEnv>().get("/:code", (c) => {
	const code = c.req.param("code");
	const link = CODE_RE.test(code)
		? c.var.db
				.select({ query: shortLinks.query })
				.from(shortLinks)
				.where(eq(shortLinks.code, code))
				.get()
		: undefined;
	if (!link) return c.text("This link does not exist.", 404);
	// The moment a link was made at is the upload it pinned, whichever revision number that has now.
	const query = new URLSearchParams(
		[...new URLSearchParams(link.query)].map(([key, value]) =>
			key === "seq"
				? ["rev", String(revOfSeq(c.var.db, Number(value)))]
				: [key, value],
		),
	);
	return c.redirect(`/v2/?${query}`, 302);
});
