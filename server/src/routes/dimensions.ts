import {
	createDimensionSchema,
	guessDimensionTheme,
	guessXaeroDimension,
	updateDimensionSchema,
} from "@blockmap/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { announceMap } from "../announce";
import { requireUser } from "../auth/session";
import { dimensions, jobs } from "../db/schema";
import { dimensionBySlug } from "../dimensionLookup";
import { doc } from "../openapi";
import { nextSortOrder } from "../order";
import { canDeleteDimension, canManage, canModerate } from "../permissions";
import type { AppEnv } from "../types";
import { validate } from "../validate";
import { tileRoutes } from "./tiles";
import { uploadRoutes } from "./uploads";

export const dimensionRoutes = new Hono<AppEnv>()
	.post(
		"/",
		doc({
			tag: "Map",
			summary: "Create a dimension",
			description: "Moderators.",
			ok: { 201: "Dimension created" },
			fails: [400, 403, 409],
			login: true,
		}),
		requireUser,
		validate("json", createDimensionSchema),
		async (c) => {
			const { db } = c.var;
			if (!canModerate(c.var.role)) return c.json({ error: "forbidden" }, 403);

			const body = c.req.valid("json");
			const existing = await db
				.select({ sortOrder: dimensions.sortOrder })
				.from(dimensions);
			if (existing.length >= 50)
				return c.json({ error: "too many dimensions" }, 400);
			const theme = body.theme ?? guessDimensionTheme(body.slug);
			try {
				const [dimension] = await db
					.insert(dimensions)
					.values({
						slug: body.slug,
						name: body.name,
						scale: body.scale ?? null,
						theme,
						preload: body.preload,
						xaeroDimension: body.xaeroDimension ?? guessXaeroDimension(theme),
						sortOrder: nextSortOrder(existing),
					})
					.returning();
				announceMap(c);
				return c.json({ dimension }, 201);
			} catch {
				return c.json({ error: "dimension slug already in use" }, 409);
			}
		},
	)
	.patch(
		"/:dim",
		doc({
			tag: "Map",
			summary: "Update a dimension",
			description: "Moderators. `dim` is the slug.",
			fails: [400, 403, 404],
			login: true,
			params: { dim: "Dimension slug" },
		}),
		requireUser,
		validate("json", updateDimensionSchema),
		async (c) => {
			if (!canModerate(c.var.role)) return c.json({ error: "forbidden" }, 403);

			const body = c.req.valid("json");
			const [dimension] = await c.var.db
				.update(dimensions)
				.set(body)
				.where(eq(dimensions.slug, c.req.param("dim")))
				.returning();
			if (!dimension) return c.json({ error: "not found" }, 404);
			announceMap(c);
			return c.json({ dimension });
		},
	)
	.delete(
		"/:dim",
		doc({
			tag: "Map",
			summary: "Delete a dimension for good",
			description:
				"Owners, and only for an archived dimension (409 otherwise). Queues a job that deletes the dimension with its uploads, tile history, layers and features, and the short links to it; the uploads that are left are renumbered without the gap and the map `epoch` changes. The images are left for *Delete the images nothing uses*. This cannot be undone. `dim` is the slug.",
			ok: { 202: "Queued" },
			fails: [403, 404, 409],
			login: true,
			params: { dim: "Dimension slug" },
		}),
		requireUser,
		(c) => {
			const { db, svc } = c.var;
			if (!canManage(c.var.role)) return c.json({ error: "forbidden" }, 403);
			const dimension = dimensionBySlug(db, c.req.param("dim"));
			if (!dimension) return c.json({ error: "not found" }, 404);
			if (!canDeleteDimension(c.var.role, dimension))
				return c.json({ error: "archive the dimension first" }, 409);
			const queued = db
				.select({ id: jobs.id })
				.from(jobs)
				.where(
					and(
						eq(jobs.type, "delete_dimension"),
						inArray(jobs.status, ["pending", "processing"]),
						sql`json_extract(${jobs.payload}, '$.dimensionId') = ${dimension.id}`,
					),
				)
				.get();
			if (queued)
				return c.json(
					{ error: "this dimension is already being deleted" },
					409,
				);
			db.insert(jobs)
				.values({
					type: "delete_dimension",
					payload: { dimensionId: dimension.id },
				})
				.run();
			svc.worker.kick();
			return c.json({ ok: true }, 202);
		},
	)
	.route("/:dim/tiles", tileRoutes)
	.route("/:dim/uploads", uploadRoutes);
