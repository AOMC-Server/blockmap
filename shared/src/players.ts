import * as z from "zod/mini";

/** Most builders one feature can list. */
export const MAX_BUILDERS = 50;

/** A Minecraft player that features can be attributed to; always a real (online mode) account. */
export type Player = {
	id: number;
	/** Dashed lowercase UUID. */
	uuid: string;
	/** The name as of the last check with Mojang. */
	name: string;
};

const UUID =
	/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
/** Minecraft names: letters, digits and underscores, at most 16 (some old accounts have 1 or 2). */
const NAME = /^[A-Za-z0-9_]{1,16}$/;

export const isUuid = (s: string) => UUID.test(s.trim());
export const isPlayerName = (s: string) => NAME.test(s.trim());

/** A UUID with or without dashes, as a dashed lowercase one. */
export function normalizeUuid(s: string): string {
	const hex = s.trim().replaceAll("-", "").toLowerCase();
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const uuidSchema = z
	.string()
	.check(
		z.regex(UUID, "not a UUID"),
		z.overwrite(normalizeUuid),
		z.describe("Minecraft UUID, with or without dashes"),
	);

export const playerNameSchema = z
	.string()
	.check(
		z.trim(),
		z.regex(NAME, "not a Minecraft name"),
		z.describe("Minecraft name"),
	);

/**
 * Who a feature is attributed to: a player id, or `{uuid, name}` (as in an export), which adds the
 * player if the map does not know the UUID yet.
 */
export const playerRefSchema = z.union([
	z.int().check(z.positive(), z.describe("Player id")),
	z.object({
		uuid: uuidSchema,
		name: playerNameSchema,
	}),
]);
export type PlayerRef = z.infer<typeof playerRefSchema>;

export const playerLookupQuerySchema = z.object({
	q: z
		.string()
		.check(
			z.trim(),
			z.minLength(1),
			z.maxLength(40),
			z.describe("Minecraft name or UUID, with or without dashes"),
		),
});

export const playerSearchQuerySchema = z.object({
	q: z._default(
		z
			.string()
			.check(
				z.trim(),
				z.maxLength(40),
				z.describe("Part of the name; empty lists everyone"),
			),
		"",
	),
	limit: z
		._default(
			z.pipe(z.coerce.number(), z.int().check(z.minimum(1), z.maximum(500))),
			50,
		)
		.check(z.describe("Most players to return, at most 500, default 50")),
});

export const createPlayerSchema = z.object({
	uuid: uuidSchema,
});
