import { layerMemberRoleSchema, layerMemberSchema } from "@blockmap/shared";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { announceLayers } from "../announce";
import { requireUser, userOf } from "../auth/session";
import { layerMembers, users } from "../db/schema";
import { doc } from "../openapi";
import { canManageLayer } from "../permissions";
import type { AppEnv } from "../types";
import { validate } from "../validate";
import { findUser, layerFor, mayRemove, UNKNOWN_USER_ERROR } from "./util";

const CREATOR_ERROR = "the layer's creator always has editor access";

/** /api/layers/:id/members: who may see and edit a private layer. */
export const layerMemberRoutes = new Hono<AppEnv>()
	.use(requireUser)
	.get(
		"/",
		doc({
			tag: "Sharing",
			summary: "List a layer's members",
			description:
				"The layer's creator or a moderator. Returns each member's `userId`, `role`, `username` and `avatarUrl`.",
			params: { id: "Layer id" },
			fails: [403, 404],
			login: true,
		}),
		async (c) => {
			const found = await layerFor(c, c.req.param("id"));
			if (!found) return c.json({ error: "not found" }, 404);
			if (!canManageLayer(c.var.user, c.var.role, found.layer))
				return c.json({ error: "forbidden" }, 403);
			const members = await c.var.db
				.select({
					userId: layerMembers.userId,
					role: layerMembers.role,
					username: users.username,
					avatarUrl: users.avatarUrl,
				})
				.from(layerMembers)
				.innerJoin(users, eq(users.id, layerMembers.userId))
				.where(eq(layerMembers.layerId, found.layer.id));
			return c.json({ members });
		},
	)
	.post(
		"/",
		doc({
			tag: "Sharing",
			summary: "Add a layer member or change their role",
			description:
				"The layer's creator or a moderator. The user must have logged in at least once (404 otherwise). The layer's creator always has editor access and cannot be changed (409).",
			params: { id: "Layer id" },
			ok: { 201: "Role set" },
			fails: [400, 403, 404, 409, 429],
			login: true,
		}),
		validate("json", layerMemberSchema),
		async (c) => {
			const { db } = c.var;
			const found = await layerFor(c, c.req.param("id"));
			if (!found) return c.json({ error: "not found" }, 404);
			if (!canManageLayer(c.var.user, c.var.role, found.layer))
				return c.json({ error: "forbidden" }, 403);

			const body = c.req.valid("json");
			const target = findUser(db, body.userId);
			if (!target) return c.json({ error: UNKNOWN_USER_ERROR }, 404);
			if (target.id === found.layer.createdBy)
				return c.json({ error: CREATOR_ERROR }, 409);

			await db
				.insert(layerMembers)
				.values({ layerId: found.layer.id, userId: target.id, role: body.role })
				.onConflictDoUpdate({
					target: [layerMembers.layerId, layerMembers.userId],
					set: { role: body.role },
				});
			announceLayers(c, found.layer.dimensionId);
			return c.json({ ok: true }, 201);
		},
	)
	.patch(
		"/:userId",
		doc({
			tag: "Sharing",
			summary: "Change a layer member's role",
			description:
				"The layer's creator or a moderator. 404 if the user is not a member. The layer's creator always has editor access and cannot be changed (409).",
			params: {
				id: "Layer id",
				userId: "Discord user id of the member",
			},
			fails: [400, 403, 404, 409, 429],
			login: true,
		}),
		validate("json", layerMemberRoleSchema),
		async (c) => {
			const found = await layerFor(c, c.req.param("id"));
			if (!found) return c.json({ error: "not found" }, 404);
			if (!canManageLayer(c.var.user, c.var.role, found.layer))
				return c.json({ error: "forbidden" }, 403);

			const userId = c.req.param("userId") ?? "";
			if (userId === found.layer.createdBy)
				return c.json({ error: CREATOR_ERROR }, 409);

			const rows = await c.var.db
				.update(layerMembers)
				.set({ role: c.req.valid("json").role })
				.where(
					and(
						eq(layerMembers.layerId, found.layer.id),
						eq(layerMembers.userId, userId),
					),
				)
				.returning({ userId: layerMembers.userId });
			if (rows.length === 0) return c.json({ error: "not found" }, 404);
			announceLayers(c, found.layer.dimensionId);
			return c.json({ ok: true });
		},
	)
	.delete(
		"/:userId",
		doc({
			tag: "Sharing",
			summary: "Remove a layer member",
			description:
				"The layer's creator or a moderator may remove anyone; members may always remove themselves. The layer's creator cannot be removed (409). 404 if the user is not a member.",
			params: {
				id: "Layer id",
				userId: "Discord user id of the member",
			},
			fails: [403, 404, 409, 429],
			login: true,
		}),
		async (c) => {
			const found = await layerFor(c, c.req.param("id"));
			if (!found) return c.json({ error: "not found" }, 404);
			const userId = c.req.param("userId") ?? "";
			if (
				!mayRemove(
					userOf(c),
					userId,
					canManageLayer(c.var.user, c.var.role, found.layer),
				)
			) {
				return c.json({ error: "forbidden" }, 403);
			}
			if (userId === found.layer.createdBy)
				return c.json({ error: CREATOR_ERROR }, 409);
			const rows = await c.var.db
				.delete(layerMembers)
				.where(
					and(
						eq(layerMembers.layerId, found.layer.id),
						eq(layerMembers.userId, userId),
					),
				)
				.returning({ userId: layerMembers.userId });
			if (rows.length === 0) return c.json({ error: "not found" }, 404);
			announceLayers(c, found.layer.dimensionId);
			return c.json({ ok: true });
		},
	);
