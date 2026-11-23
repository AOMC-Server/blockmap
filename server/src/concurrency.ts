/**
 * Runs `fn` over `items` with at most `limit` calls in flight, and returns the results in input
 * order. On the first error no new calls start; it is thrown once the running ones have settled,
 * so nothing keeps working in the background after the caller has given up.
 */
export async function mapLimit<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	let failure: { error: unknown } | null = null;
	const lane = async () => {
		while (failure === null && next < items.length) {
			const i = next++;
			try {
				results[i] = await fn(items[i] as T, i);
			} catch (error) {
				failure ??= { error };
			}
		}
	};
	const lanes = Math.max(1, Math.min(limit, items.length));
	await Promise.all(Array.from({ length: lanes }, lane));
	if (failure) throw (failure as { error: unknown }).error;
	return results;
}

/** Runs tasks with at most `limit` of them in flight, across all the callers that share it. */
export type Limiter = {
	/**
	 * Waits for a free slot and starts `fn` in it, without waiting for it to finish: the caller
	 * gets the running task (`done`) once it has started. Waiting for the slot is what keeps a
	 * fast producer from piling up work (and the memory it holds).
	 */
	start<T>(fn: () => Promise<T>): Promise<{ done: Promise<T> }>;
};

export function createLimiter(limit: number): Limiter {
	let active = 0;
	const waiting: (() => void)[] = [];
	const release = () => {
		const next = waiting.shift();
		if (next) next();
		else active--;
	};
	return {
		async start(fn) {
			if (active < limit) active++;
			else await new Promise<void>((resolve) => waiting.push(resolve));
			const done = Promise.resolve().then(fn).finally(release);
			// Failures are seen by whoever awaits the task; until then they are not "unhandled".
			done.catch(() => {});
			return { done };
		},
	};
}
