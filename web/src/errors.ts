const GONE: Record<string, string> = {
	revoked: "This invite was withdrawn.",
	expired: "This invite has expired.",
	exhausted: "This invite has already been used up.",
};

/** What to tell the user about an invite the server refused: 410 means it can no longer be used. */
export function inviteProblem(failure: {
	status: number;
	error: string;
	detail: { reason?: string } | null;
}): string {
	if (failure.status === 404) return "This invite link is not valid.";
	if (failure.status !== 410) return failure.error;
	return (
		GONE[failure.detail?.reason ?? ""] ?? "This invite link is no longer valid."
	);
}
