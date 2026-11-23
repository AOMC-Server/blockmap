import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import * as paths from "../server/src/paths";

/**
 * One-off: permanently deletes every layer and every feature with all of its revisions (history
 * included). The layers' members and invites go with them (cascade). Map invites are kept.
 * Run a backup first: `bun run backup <dir>`.
 */
const { values } = parseArgs({
	args: Bun.argv.slice(2),
	options: {
		data: { type: "string", default: process.env.DATA_DIR ?? "./data" },
		yes: { type: "boolean", default: false },
	},
});

const dbFile = paths.dbFile(values.data as string);
if (!existsSync(dbFile)) {
	console.error(`no database at ${dbFile}`);
	process.exit(1);
}

const db = new Database(dbFile, { strict: true });
db.run("PRAGMA foreign_keys = ON");
db.run("PRAGMA busy_timeout = 5000");

const count = (table: string) =>
	(db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
const features = count("features");
const revisions = count("feature_revisions");
const layers = count("layers");

console.log(
	`${dbFile}: ${layers} layers, ${features} features, ${revisions} revisions`,
);
if (!values.yes) {
	console.log("dry run; pass --yes to delete them permanently");
	process.exit(0);
}

db.transaction(() => {
	db.run("DELETE FROM feature_revisions");
	db.run("DELETE FROM features");
	db.run("DELETE FROM layers");
})();
db.run("PRAGMA wal_checkpoint(TRUNCATE)");
db.run("VACUUM");
db.close();

console.log(
	`deleted ${layers} layers, ${features} features and ${revisions} revisions`,
);
