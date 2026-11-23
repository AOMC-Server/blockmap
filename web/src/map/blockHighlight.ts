import {
	blockToScreen,
	type Size,
	scaleOf,
	screenToBlock,
	type View,
} from "@blockmap/shared/view";

/** A block texture is 16×16 pixels; the outline is measured in those. */
const TEXTURE_PIXELS = 16;
/**
 * Below this many css px per block a single block is too small to point at, and a texture pixel
 * (the outline's width) less than half a screen pixel.
 */
export const MIN_HIGHLIGHT_SCALE = 8;

/** The screen rectangle (css px) of the block under (sx, sy), or null when blocks are too small. */
export function hoveredBlockRect(
	view: View,
	size: Size,
	sx: number,
	sy: number,
): { x: number; y: number; size: number } | null {
	const s = scaleOf(view.zoom);
	if (s < MIN_HIGHLIGHT_SCALE) return null;
	const b = screenToBlock(view, size, sx, sy);
	const p = blockToScreen(view, size, Math.floor(b.x), Math.floor(b.z));
	return { x: p.x, y: p.y, size: s };
}

/**
 * Outlines the block under (sx, sy) inside its edges: a light ring around a dark one, each one
 * texture pixel (a sixteenth of the block) wide at every zoom, like a slot highlight in game.
 */
export function drawBlockHighlight(
	ctx: CanvasRenderingContext2D,
	view: View,
	size: Size,
	sx: number,
	sy: number,
) {
	const r = hoveredBlockRect(view, size, sx, sy);
	if (!r) return;
	const w = r.size / TEXTURE_PIXELS;
	ctx.save();
	ring(ctx, r.x, r.y, r.size, w, "rgba(255,255,255,0.55)");
	ring(ctx, r.x + w, r.y + w, r.size - 2 * w, w, "rgba(0,0,0,0.3)");
	ctx.restore();
}

/** A square ring `w` wide inside the square at (x, y). */
function ring(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	size: number,
	w: number,
	color: string,
) {
	ctx.beginPath();
	ctx.rect(x, y, size, size);
	ctx.rect(x + w, y + w, size - 2 * w, size - 2 * w);
	ctx.fillStyle = color;
	ctx.fill("evenodd");
}
