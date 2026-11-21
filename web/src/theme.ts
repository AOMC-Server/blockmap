import { paletteScope } from "@aomc-server/block-ui/theme";
import type { DimensionTheme } from "@blockmap/shared/schemas";

/**
 * The look of the interface is the library's three attributes on <html> (see block-ui's theme
 * module): data-mode and data-style are the user's choices; data-palette follows the dimension
 * being viewed. This file has what is blockmap's own: the names of the dimension palettes (their
 * colours, and those of the dyes, are in styles.css) and the palette remembered for first paint.
 */

export const DIMENSION_THEME_NAMES: Record<DimensionTheme, string> = {
	overworld: "Overworld",
	nether: "Nether",
	end: "The End",
	unknown: "Unknown",
};

/** Attributes that give an element the palette of a dye (`dye-<name>`), in the mode and style in use. */
export const dyeScope = (dye: string | undefined) =>
	paletteScope(dye ? `dye-${dye}` : undefined);

/**
 * The palette last shown on the map, for the inline script in index.html (see prepaint.ts): it
 * applies the appearance before the first paint, when the map (and so the dimension's theme) is
 * not loaded yet.
 */
export const PALETTE_KEY = "blockmap.palette";

export type SavedPalette = { dim: string; palette: DimensionTheme };

export function savePalette(saved: SavedPalette) {
	try {
		globalThis.localStorage?.setItem(PALETTE_KEY, JSON.stringify(saved));
	} catch {}
}
