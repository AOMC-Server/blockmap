import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { parseArgs } from "node:util";
import { mapLimit } from "../server/src/concurrency";
import * as paths from "../server/src/paths";
import { createBlobStore } from "../server/src/tiles/blobstore";
import { emptyTile, loadTile, storeTile } from "../server/src/tiles/compose";
import { orExit, positiveNumber } from "./args";

export type ResizeResult = {
	from: number;
	to: number;
	patchesBefore: number;
	patchesAfter: number;
	blobsSplit: number;
};

/**
 * Changes the map's tile size to a divisor of it (1024 to 512, say). Every upload's patches are
 * cut into pieces of the new size (fully transparent pieces are dropped), the tile history is
 * cleared, and a rebuild from the new patches is queued for the next server start. Nothing is
 * resampled, so no detail is lost.
 *
 * Run with the server stopped. The old patch images stay on disk until the blob cleanup
 * (Manage → Statistics) removes them.
 */
export async function resizeTiles(opts: {
	dataDir: string;
	to: number;
	concurrency?: number;
	dryRun?: boolean;
	onProgress?: (done: number, total: number) => void;
}): Promise<ResizeResult> {
	const dbFile = paths.dbFile(opts.dataDir);
	if (!existsSync(dbFile)) throw new Error(`no database at ${dbFile}`);
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

		const patches = db
			.query(
				"SELECT revision_id AS revisionId, tile_x AS x, tile_y AS y, blob_hash AS hash FROM upload_patches",
			)
			.all() as { revisionId: number; x: number; y: number; hash: string }[];
		const k = from / to;
		const hashes = [...new Set(patches.map((p) => p.hash))];
		if (opts.dryRun) {
			return {
				from,
				to,
				patchesBefore: patches.length,
				patchesAfter: 0,
				blobsSplit: hashes.length,
			};
		}

		const insertBlob = db.prepare(
			"INSERT INTO blobs (hash, bytes, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
		);
		const blobs = createBlobStore(paths.blobsDir(opts.dataDir), (hash, bytes) =>
			insertBlob.run(hash, bytes, Date.now()),
		);

		// Each image is cut once, however many patches share it: piece (i, j) is at index j * k + i.
		const pieces = new Map<string, (string | null)[]>();
		let done = 0;
		await mapLimit(
			hashes,
			opts.concurrency ?? Math.min(availableParallelism(), 16),
			async (hash) => {
				const src = await loadTile(blobs, hash, from);
				const out: (string | null)[] = [];
				for (let j = 0; j < k; j++) {
					for (let i = 0; i < k; i++) {
						const piece = emptyTile(to);
						for (let y = 0; y < to; y++) {
							const s = ((j * to + y) * from + i * to) * 4;
							src.copy(piece, y * to * 4, s, s + to * 4);
						}
						out.push(await storeTile(blobs, piece, to));
					}
				}
				pieces.set(hash, out);
				opts.onProgress?.(++done, hashes.length);
			},
		);

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

		const insertPatch = db.prepare(
			"INSERT INTO upload_patches (revision_id, tile_x, tile_y, blob_hash) VALUES (?, ?, ?, ?)",
		);
		db.transaction(() => {
			const now = db
				.query("SELECT tile_size AS tileSize FROM map_info")
				.get() as {
				tileSize: number;
			};
			if (now.tileSize !== from) throw new Error("the map changed meanwhile");
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
		db.run("PRAGMA wal_checkpoint(TRUNCATE)");

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
			yes: { type: "boolean", default: false },
		},
	});
	if (!values.to) {
		console.error(
			"usage: bun scripts/resize-tiles.ts --to 512 [--data ./data] [--concurrency N] [--yes]",
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
	try {
		const result = await resizeTiles({
			dataDir: values.data as string,
			to,
			concurrency,
			dryRun,
			onProgress: (done, total) => {
				if (done % 100 === 0 || done === total)
					process.stdout.write(`\rsplitting images: ${done}/${total}`);
			},
		});
		if (dryRun) {
			console.log(
				`tile size ${result.from} → ${result.to}: ${result.patchesBefore} patches (${result.blobsSplit} images) to split`,
			);
			console.log(
				"dry run; stop the server, back up (bun run backup <dir>), then pass --yes",
			);
		} else {
			console.log();
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
