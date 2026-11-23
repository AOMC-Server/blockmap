import * as z from "zod/mini";
import { userIdSchema } from "./schemas";

export const MAX_INVITE_HOURS = 24 * 365;
export const DEFAULT_INVITE_HOURS = 24 * 7;
export const MAX_INVITE_USES = 1000;

export const layerRoleSchema = z.enum(["viewer", "editor"]);
export type LayerRole = z.infer<typeof layerRoleSchema>;

/** What an invite grants: a layer role, or moderator for a map invite. */
export const inviteRoleSchema = z.enum([
	...layerRoleSchema.options,
	"moderator",
]);
export type InviteRole = z.infer<typeof inviteRoleSchema>;

const expiry = z
	._default(
		z.nullable(z.int().check(z.minimum(1), z.maximum(MAX_INVITE_HOURS))),
		DEFAULT_INVITE_HOURS,
	)
	.check(
		z.describe(
			`Hours until the invite expires, default ${DEFAULT_INVITE_HOURS}; \`null\` never expires`,
		),
	);
const maxUses = z
	._default(
		z.nullable(z.int().check(z.minimum(1), z.maximum(MAX_INVITE_USES))),
		null,
	)
	.check(
		z.describe(
			"How many times the invite can be accepted; `null` (default) is without limit",
		),
	);

/** Map invites make moderators; owners are added explicitly from the members panel. */
export const createMapInviteSchema = z.object({
	expiresInHours: expiry,
	maxUses,
});

export type CreateMapInvite = z.infer<typeof createMapInviteSchema>;

export const createLayerInviteSchema = z.object({
	role: layerRoleSchema.check(
		z.describe("Role granted by the invite on the layer"),
	),
	expiresInHours: expiry,
	maxUses,
});

export const layerMemberSchema = z.object({
	userId: userIdSchema,
	role: layerRoleSchema.check(z.describe("Role to assign on the layer")),
});

export const layerMemberRoleSchema = z.object({
	role: layerRoleSchema.check(z.describe("New role on the layer")),
});
