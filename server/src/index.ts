import { mkdirSync } from "node:fs";
import { createApp } from "./app";
import { createDb, runMigrations } from "./db/client";
import { parseEnv } from "./env";
import { usedHashes } from "./files/library";
import { queueRebuildIfPending } from "./jobs/rebuildHistory";
import { blobsDir, dbFile } from "./paths";
import { createServices } from "./services";
import { runSetup } from "./setup";
import { recordMissingBlobSizes, recordStorage } from "./storage";

const env = parseEnv();
mkdirSync(env.DATA_DIR, { recursive: true });

const db = createDb(dbFile(env.DATA_DIR));
runMigrations(db);
runSetup(db, env);
if (queueRebuildIfPending(db)) console.log("the tile history will be rebuilt");

const services = createServices(db, env);
await recordMissingBlobSizes(db, blobsDir(env.DATA_DIR));
recordStorage(db, "boot");
await services.files.sweep(usedHashes(db));
services.traffic.start();
services.worker.start();
services.playerRefresher.start();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		services.worker.stop();
		services.traffic.stop();
		services.playerRefresher.stop();
		process.exit(0);
	});
}
const app = createApp({ db, env, services });

export default {
	port: env.PORT,
	fetch: app.fetch,
	// Each route checks its own limit; this is only the largest of them.
	maxRequestBodySize: Math.max(env.MAX_UPLOAD_BYTES, env.MAX_FILE_BYTES),
	idleTimeout: 60, // seconds; SSE pings every 20s keep progress streams open
};
console.log(`listening on :${env.PORT}`);
