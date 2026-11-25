import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { parseArgs } from "node:util";
import { mapLimit } from "../server/src/concurrency";
import * as paths from "../server/src/paths";
import { createBlobStore } from "../server/src/tiles/blobstore";
import {
	decodeRaw,
	emptyTile,
	encodeTile,
	imageLibrary,
} from "../server/src/tiles/compose";
import { orExit, positiveNumber } from "./args";

export type ResizeResult = {
	from: number;
	to: number;
	patchesBefore: number;
	patchesAfter: number;
	blobsSplit: number;
};

/** How often the progress line is printed, and how long without a finished image is worth a warning. */
const PROGRESS_MS = 5_000;
const STALL_MS = 30_000;

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const duration = (ms: number) => {
	const s = Math.round(ms / 1000);
	return s < 60
		? `${s}s`
		: `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
};

/**
 * Changes the map's tile size to a divisor of it (1024 to 512, say). Every upload's patches are
 * cut into pieces of the new size (fully transparent pieces are dropped), the tile history is
 * cleared, and a rebuild from the new patches is queued for the next server start. Nothing is
 * resampled, so no detail is lost.
 *
 * Nothing in the database changes until the very end, in one transaction: stopping it before
 * then only leaves new image files that nothing points to, which the blob cleanup removes.
 *
 * Run with the server stopped. The old patch images stay on disk until the blob cleanup
 * (Manage → Statistics) removes them.
 */
export async function resizeTiles(opts: {
	dataDir: string;
	to: number;
	concurrency?: number;
	dryRun?: boolean;
	log?: (message: string) => void;
	/** Logs every step of every image too. */
	verbose?: boolean;
	/** Called once the database has been changed; from then on the run must not be interrupted. */
	onCommitting?: () => void;
}): Promise<ResizeResult> {
	const started = Date.now();
	const log = (message: string) =>
		opts.log?.(`[${seconds(Date.now() - started)}] ${message}`);

	const dbFile = paths.dbFile(opts.dataDir);
	if (!existsSync(dbFile)) throw new Error(`no database at ${dbFile}`);
	log(`opening ${dbFile}`);
	const db = new Database(dbFile, { strict: true });
	try {
		db.run("PRAGMA foreign_keys = ON");
		db.run("PRAGMA busy_timeout = 5000");

		const map = db
			.query("SELECT tile_size AS tileSize FROM map_info")
			.get() as {
			tileSize: number;
		} | null;
		if (!map) throw new Error("the map has not been created yet");
		const from = map.tileSize;
		const to = opts.to;
		if (to === from) throw new Error(`the tile size already is ${to}`);
		if (to % 2 !== 0) throw new Error("the new tile size must be even");
		if (from % to !== 0)
			throw new Error(
				`the new tile size must divide the current one (${from}), got ${to}`,
			);
		const busy = db
			.query(
				"SELECT count(*) AS n FROM jobs WHERE status IN ('pending', 'processing')",
			)
			.get() as { n: number };
		if (busy.n > 0)
			throw new Error(
				`${busy.n} job(s) are pending or running; let them finish (with the server running) first`,
			);
		const unpublished = db
			.query(
				"SELECT count(*) AS n FROM revisions WHERE status IN ('pending', 'processing')",
			)
			.get() as { n: number };
		if (unpublished.n > 0)
			throw new Error(`${unpublished.n} upload(s) are still being processed`);
		log(`tile size ${from} → ${to}; no jobs or uploads in progress`);

		const patches = db
			.query(
				"SELECT revision_id AS revisionId, tile_x AS x, tile_y AS y, blob_hash AS hash FROM upload_patches",
			)
			.all() as { revisionId: number; x: number; y: number; hash: string }[];
		const k = from / to;
		const hashes = [...new Set(patches.map((p) => p.hash))];
		log(
			`${patches.length} patches use ${hashes.length} distinct images; each becomes up to ${k * k} pieces`,
		);
		if (opts.dryRun) {
			return {
				from,
				to,
				patchesBefore: patches.length,
				patchesAfter: 0,
				blobsSplit: hashes.length,
			};
		}

		// Recorded in the final transaction rather than one write (and disk sync) per image.
		const stored = new Map<string, number>();
		const blobsDir = paths.blobsDir(opts.dataDir);
		const blobs = createBlobStore(blobsDir, (hash, bytes) =>
			stored.set(hash, bytes),
		);

		// Each image is cut once, however many patches share it: piece (i, j) is at index j * k + i.
		const pieces = new Map<string, (string | null)[]>();
		const concurrency =
			opts.concurrency ?? Math.min(availableParallelism(), 16);
		const inFlight = new Map<string, { since: number; step: string }>();
		let done = 0;
		let kept = 0;
		let empty = 0;
		let lastDone = Date.now();
		const splitStart = Date.now();
		log(`splitting images into ${blobsDir} (${concurrency} at a time)`);
		const trace = opts.verbose ? log : () => {};
		trace(`image library: ${imageLibrary()}`);

		const report = () => {
			const elapsed = Date.now() - splitStart;
			const rate = done / (elapsed / 1000);
			const left = rate > 0 ? ((hashes.length - done) / rate) * 1000 : 0;
			log(
				`split ${done}/${hashes.length} images (${((done / hashes.length) * 100).toFixed(1)}%), ` +
					`${rate.toFixed(1)}/s, ~${duration(left)} left; ${kept} pieces stored, ${empty} empty`,
			);
			const idle = Date.now() - lastDone;
			if (idle >= STALL_MS && inFlight.size > 0) {
				log(`no image finished for ${duration(idle)}; working on:`);
				for (const [hash, f] of inFlight)
					log(
						`  ${blobs.path(hash)}: ${f.step} for ${duration(Date.now() - f.since)}`,
					);
			}
		};
		const timer = setInterval(report, PROGRESS_MS);
		try {
			await mapLimit(hashes, concurrency, async (hash) => {
				const state = { since: Date.now(), step: "reading" };
				inFlight.set(hash, state);
				const file = blobs.path(hash);
				const step = (name: string) => {
					state.step = name;
					trace(`${hash.slice(0, 12)}: ${name}`);
				};
				let src: Buffer;
				try {
					step(`reading ${file}`);
					const data = await blobs.read(hash);
					step(`decoding ${data.length} bytes`);
					const img = await decodeRaw(data, from);
					if (img.width !== from || img.height !== from)
						throw new Error(
							`it is ${img.width}x${img.height}, expected ${from}x${from}`,
						);
					src = img.data;
				} catch (err) {
					throw new Error(
						`cannot read ${file}: ${err instanceof Error ? err.message : err}`,
					);
				}
				const out: (string | null)[] = [];
				for (let j = 0; j < k; j++) {
					for (let i = 0; i < k; i++) {
						const n = `${j * k + i + 1}/${k * k}`;
						const piece = emptyTile(to);
						for (let y = 0; y < to; y++) {
							const s = ((j * to + y) * from + i * to) * 4;
							src.copy(piece, y * to * 4, s, s + to * 4);
						}
						step(`encoding piece ${n}`);
						const webp = await encodeTile(piece, to);
						let h: string | null = null;
						if (webp) {
							step(`writing piece ${n} (${webp.length} bytes)`);
							h = await blobs.put(webp);
							kept++;
						} else empty++;
						out.push(h);
					}
				}
				trace(`${hash.slice(0, 12)}: done`);
				pieces.set(hash, out);
				inFlight.delete(hash);
				done++;
				lastDone = Date.now();
			});
		} finally {
			clearInterval(timer);
		}
		report();

		const rows: [number, number, number, string][] = [];
		for (const p of patches) {
			const out = pieces.get(p.hash) as (string | null)[];
			for (let j = 0; j < k; j++) {
				for (let i = 0; i < k; i++) {
					const hash = out[j * k + i];
					if (hash) rows.push([p.revisionId, p.x * k + i, p.y * k + j, hash]);
				}
			}
		}

		log(
			`writing ${rows.length} patches and ${stored.size} image records to the database`,
		);
		opts.onCommitting?.();
		const insertPatch = db.prepare(
			"INSERT INTO upload_patches (revision_id, tile_x, tile_y, blob_hash) VALUES (?, ?, ?, ?)",
		);
		const insertBlob = db.prepare(
			"INSERT INTO blobs (hash, bytes, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
		);
		db.transaction(() => {
			const now = db
				.query("SELECT tile_size AS tileSize FROM map_info")
				.get() as {
				tileSize: number;
			};
			if (now.tileSize !== from) throw new Error("the map changed meanwhile");
			const at = Date.now();
			for (const [hash, bytes] of stored) insertBlob.run(hash, bytes, at);
			db.run("DELETE FROM upload_patches");
			for (const r of rows) insertPatch.run(...r);
			// The old versions are of the old size; the rebuild queued on boot makes the new ones.
			db.run("DELETE FROM tile_versions");
			db.run("DELETE FROM tile_versions_rebuild");
			db.run(
				"UPDATE map_info SET tile_size = ?, recompute_pending = 1, epoch = epoch + 1",
				[to],
			);
		})();
		log("committed; checkpointing the database");
		db.run("PRAGMA wal_checkpoint(TRUNCATE)");
		log("done");

		return {
			from,
			to,
			patchesBefore: patches.length,
			patchesAfter: rows.length,
			blobsSplit: hashes.length,
		};
	} finally {
		db.close();
	}
}

if (import.meta.main) {
	const { values } = parseArgs({
		args: Bun.argv.slice(2),
		options: {
			data: { type: "string", default: process.env.DATA_DIR ?? "./data" },
			to: { type: "string" },
			concurrency: { type: "string" },
			verbose: { type: "boolean", default: false },
			yes: { type: "boolean", default: false },
		},
	});
	if (!values.to) {
		console.error(
			"usage: bun scripts/resize-tiles.ts --to 512 [--data ./data] [--concurrency N] [--verbose] [--yes]",
		);
		process.exit(2);
	}
	const to = orExit(() =>
		positiveNumber("to", values.to as string, { integer: true }),
	);
	const concurrency =
		values.concurrency === undefined
			? undefined
			: orExit(() =>
					positiveNumber("concurrency", values.concurrency as string, {
						integer: true,
					}),
				);
	const dryRun = !values.yes;

	// Until the final transaction nothing in the database has changed, so stopping is harmless.
	let committing = false;
	const onSignal = (signal: string) => {
		if (committing) {
			console.error(
				`${signal}: the database is being written, which takes a few seconds; letting it finish`,
			);
			return;
		}
		console.error(
			`${signal}: stopped before changing the database; the map is as it was. ` +
				"The images written so far are unused and go with the next blob cleanup. Run the script again to start over.",
		);
		process.exit(130);
	};
	process.on("SIGINT", () => onSignal("SIGINT"));
	process.on("SIGTERM", () => onSignal("SIGTERM"));

	try {
		const result = await resizeTiles({
			dataDir: values.data as string,
			to,
			concurrency,
			dryRun,
			verbose: values.verbose as boolean,
			log: (message) => console.log(message),
			onCommitting: () => {
				committing = true;
			},
		});
		if (dryRun) {
			console.log(
				"dry run; stop the server, back up (bun run backup <dir>), then pass --yes",
			);
		} else {
			console.log(
				`tile size ${result.from} → ${result.to}: ${result.patchesBefore} patches became ${result.patchesAfter}`,
			);
			console.log(
				"start the server to rebuild the tile history, then run the blob cleanup (Manage → Statistics)",
			);
			console.log(
				`consider raising MAX_ZOOM by ${Math.log2(result.from / result.to)} to keep the same zoomed-out view`,
			);
		}
	} catch (err) {
		console.error(err instanceof Error ? err.message : err);
		process.exit(1);
	}
}
