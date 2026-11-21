import type { Db } from "./db/client";
import { mapInfo } from "./db/schema";

const DEFAULT_SITE_NAME = "Blockmap";

/** A map name as shown in titles; neutral when it is blank. */
export const displayName = (name: string | undefined) =>
	name?.trim() || DEFAULT_SITE_NAME;

/** The map's name (the admin's "Map name" setting) for page titles and docs; neutral before setup. */
export const siteName = (db: Db) =>
	displayName(db.select().from(mapInfo).get()?.name);
