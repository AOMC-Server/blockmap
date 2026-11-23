import { toast } from "@aomc-server/block-ui";

/**
 * Puts text on the clipboard with the old `execCommand("copy")`, which also works where the
 * clipboard API does not exist (a page that is not https) or refuses (an embedded frame).
 */
function copyWithSelection(text: string): boolean {
	if (typeof document === "undefined") return false;
	const before = document.activeElement as HTMLElement | null;
	// Inside an open dialog, so that its focus trap does not take the focus away again.
	const host = before?.closest?.('[role="dialog"]') ?? document.body;
	const field = document.createElement("textarea");
	field.value = text;
	field.setAttribute("readonly", "");
	field.setAttribute("aria-hidden", "true");
	field.style.cssText =
		"position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none";
	host.appendChild(field);
	try {
		field.focus({ preventScroll: true });
		field.select();
		return document.execCommand("copy");
	} catch {
		return false;
	} finally {
		field.remove();
		before?.focus?.({ preventScroll: true });
	}
}

/** Copies text and tells the user whether it worked, using whichever way the browser allows. */
export async function copyText(text: string, done: string) {
	let copied = false;
	try {
		await navigator.clipboard.writeText(text);
		copied = true;
	} catch {
		copied = copyWithSelection(text);
	}
	if (copied) toast(done, "ok");
	else toast("Could not copy; select the text and copy it manually.", "error");
}
