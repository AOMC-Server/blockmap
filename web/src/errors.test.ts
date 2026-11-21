import { expect, test } from "bun:test";
import { inviteProblem } from "./errors";

const fail = (status: number, reason?: string) => ({
	status,
	error: "server text",
	detail: reason ? { reason } : null,
});

test("410 explains why the invite cannot be used", () => {
	expect(inviteProblem(fail(410, "expired"))).toMatch(/expired/);
	expect(inviteProblem(fail(410, "exhausted"))).toMatch(/used up/);
	expect(inviteProblem(fail(410, "revoked"))).toMatch(/withdrawn/);
});

test("410 without a known reason, or gone, is simply no longer valid", () => {
	expect(inviteProblem(fail(410, "gone"))).toBe(
		"This invite link is no longer valid.",
	);
	expect(inviteProblem(fail(410))).toBe("This invite link is no longer valid.");
});

test("other failures keep the server's message, unknown links say so", () => {
	expect(inviteProblem(fail(403))).toBe("server text");
	expect(inviteProblem(fail(404))).toBe("This invite link is not valid.");
});
