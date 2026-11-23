import { join } from "node:path";
import type { Db } from "./db/client";
import { blobFiles } from "./db/schema";
import type { Env } from "./env";
import { createEventHub } from "./events";
import { createFileStore } from "./files/store";
import { createWorker } from "./jobs/worker";
import { createMojang } from "./mojang";
import { blobsDir, filesDir, previewCacheDir } from "./paths";
import { createPlayerRefresher } from "./players";
import { createPreviewService } from "./preview";
import {
	createRateLimiter,
	PREVIEW_RATE_LIMIT,
	SHORT_LINK_RATE_LIMIT,
	WRITE_RATE_LIMIT,
} from "./ratelimit";
import { createBlobStore } from "./tiles/blobstore";
import { createTraffic } from "./traffic";

export type Services = ReturnType<typeof createServices>;

/** `fetchFn` is how the server reaches Mojang; tests pass a fake one. */
export function createServices(
	db: Db,
	env: Env,
	fetchFn: typeof fetch = fetch,
) {
	const blobs = createBlobStore(blobsDir(env.DATA_DIR), (hash, bytes) => {
		db.insert(blobFiles).values({ hash, bytes }).onConflictDoNothing().run();
	});
	const events = createEventHub();
	const worker = createWorker({ db, env, blobs, events });
	const limiter = createRateLimiter(env.UPLOAD_RATE_LIMIT);
	const writeLimiter = createRateLimiter(WRITE_RATE_LIMIT);
	const previewLimiter = createRateLimiter(PREVIEW_RATE_LIMIT);
	const linkLimiter = createRateLimiter(SHORT_LINK_RATE_LIMIT);
	const preview = createPreviewService({
		cacheDir: previewCacheDir(env.DATA_DIR),
		maxCached: env.PREVIEW_CACHE_MAX,
		iconDirs: [
			join(
				env.WEB_DIST ?? `${import.meta.dir}/../../web/dist`,
				"static/markers",
			),
			join(import.meta.dir, "../../web/public/static/markers"),
		],
	});
	const traffic = createTraffic(db, env);
	const files = createFileStore(filesDir(env.DATA_DIR));
	const mojang = createMojang(fetchFn);
	const playerRefresher = createPlayerRefresher(db, mojang);
	return {
		mojang,
		playerRefresher,
		blobs,
		files,
		events,
		worker,
		limiter,
		writeLimiter,
		previewLimiter,
		linkLimiter,
		preview,
		traffic,
	};
}
