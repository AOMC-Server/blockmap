import { normalizeUuid } from "@blockmap/shared";
import sharp from "sharp";

const NAME_API = "https://api.mojang.com/users/profiles/minecraft/";
const PROFILE_API =
	"https://sessionserver.mojang.com/session/minecraft/profile/";
/** Mojang answers each lookup the same for a while; this spares its rate limit while someone types. */
const CACHE_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 8000;

/** Mojang could not be reached or did not answer properly; worth trying again later. */
export class MojangUnavailable extends Error {}

export type MojangProfile = {
	/** Dashed lowercase UUID. */
	uuid: string;
	name: string;
	/** The skin's texture URL; null for a default skin. */
	skinUrl: string | null;
};

export type Mojang = ReturnType<typeof createMojang>;

export function createMojang(fetchFn: typeof fetch = fetch) {
	const cache = new Map<string, { at: number; value: unknown }>();

	async function get(url: string, fresh = false): Promise<unknown | null> {
		const hit = cache.get(url);
		if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.value;
		let res: Response;
		try {
			res = await fetchFn(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
		} catch (err) {
			throw new MojangUnavailable(String(err));
		}
		let value: unknown | null;
		if (res.status === 204 || res.status === 404) value = null;
		else if (res.ok) value = await res.json().catch(() => null);
		else throw new MojangUnavailable(`Mojang answered ${res.status}`);
		if (cache.size > 1000) cache.clear();
		cache.set(url, { at: Date.now(), value });
		return value;
	}

	/** The profile with the given UUID, or null if there is no such account. `fresh` skips the cache. */
	async function byUuid(
		uuid: string,
		fresh = false,
	): Promise<MojangProfile | null> {
		const body = (await get(
			PROFILE_API + normalizeUuid(uuid).replaceAll("-", ""),
			fresh,
		)) as {
			id?: string;
			name?: string;
			properties?: { name: string; value: string }[];
		} | null;
		if (!body?.id || !body.name) return null;
		return {
			uuid: normalizeUuid(body.id),
			name: body.name,
			skinUrl: skinUrlOf(body.properties ?? []),
		};
	}

	/** The account that has the name now, or null if nobody has it. */
	async function byName(name: string): Promise<MojangProfile | null> {
		const body = (await get(NAME_API + encodeURIComponent(name))) as {
			id?: string;
		} | null;
		if (!body?.id) return null;
		return byUuid(body.id);
	}

	/** The skin PNG at `url`. */
	async function skin(url: string): Promise<Buffer> {
		let res: Response;
		try {
			res = await fetchFn(url.replace(/^http:/, "https:"), {
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
		} catch (err) {
			throw new MojangUnavailable(String(err));
		}
		if (!res.ok) throw new MojangUnavailable(`skin answered ${res.status}`);
		return Buffer.from(await res.arrayBuffer());
	}

	return { byUuid, byName, skin };
}

function skinUrlOf(properties: { name: string; value: string }[]) {
	const textures = properties.find((p) => p.name === "textures");
	if (!textures) return null;
	try {
		const decoded = JSON.parse(
			Buffer.from(textures.value, "base64").toString("utf8"),
		) as { textures?: { SKIN?: { url?: string } } };
		const url = decoded.textures?.SKIN?.url;
		return typeof url === "string" &&
			/^https?:\/\/textures\.minecraft\.net\//.test(url)
			? url
			: null;
	} catch {
		return null;
	}
}

/**
 * The 8x8 face of a skin (64x64, or 64x32 from before 1.8) with the hat layer over it, as a PNG.
 */
export async function headFromSkin(skin: Buffer): Promise<Buffer> {
	const img = sharp(skin).ensureAlpha();
	const meta = await img.metadata();
	if (meta.width !== 64 || (meta.height !== 64 && meta.height !== 32))
		throw new Error(`unexpected skin size ${meta.width}x${meta.height}`);
	const face = await sharp(skin)
		.ensureAlpha()
		.extract({ left: 8, top: 8, width: 8, height: 8 })
		.png()
		.toBuffer();
	const hat = await sharp(skin)
		.ensureAlpha()
		.extract({ left: 40, top: 8, width: 8, height: 8 })
		.raw()
		.toBuffer();
	// Some old skins fill the hat area with an opaque colour; Minecraft then ignores it.
	let opaque = true;
	for (let i = 3; i < hat.length; i += 4) if (hat[i] !== 255) opaque = false;
	if (opaque) return face;
	return sharp(face)
		.composite([
			{
				input: hat,
				raw: { width: 8, height: 8, channels: 4 },
				left: 0,
				top: 0,
			},
		])
		.png()
		.toBuffer();
}

// Steve's face, for players whose skin is a default one or has not been fetched yet.
const S = "c49a6c"; // skin
const H = "2f1f0f"; // hair
const E = "ffffff"; // eye white
const P = "523d89"; // pupil
const M = "6a4030"; // mouth
const N = "946644"; // nose
// biome-ignore format: a picture
const STEVE = [
	H, H, H, H, H, H, H, H,
	H, H, H, H, H, H, H, H,
	H, S, S, S, S, S, S, H,
	S, S, S, S, S, S, S, S,
	S, E, P, S, S, P, E, S,
	S, S, S, N, N, S, S, S,
	S, S, M, S, S, M, S, S,
	S, S, M, M, M, M, S, S,
];

let steve: Promise<Buffer> | undefined;
/** The face shown when a player's own head is not known. */
export function defaultHead(): Promise<Buffer> {
	steve ??= sharp(
		Buffer.from(
			STEVE.flatMap((hex) => [
				Number.parseInt(hex.slice(0, 2), 16),
				Number.parseInt(hex.slice(2, 4), 16),
				Number.parseInt(hex.slice(4, 6), 16),
			]),
		),
		{ raw: { width: 8, height: 8, channels: 3 } },
	)
		.png()
		.toBuffer();
	return steve;
}
