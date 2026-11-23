/** Layers a revision added the feature to and took it out of, compared with the revision before. */
export function alsoInChange(
	older: number[] | undefined,
	newer: number[],
): { added: number[]; removed: number[] } | null {
	if (!older) return null;
	const added = newer.filter((id) => !older.includes(id));
	const removed = older.filter((id) => !newer.includes(id));
	return added.length > 0 || removed.length > 0 ? { added, removed } : null;
}
