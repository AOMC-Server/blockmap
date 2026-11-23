import type { JobProgress, RevisionEvent } from "../events";

/**
 * Tells the people waiting on a job what it is doing. A job moves through numbered steps
 * (`step`), counts its way through each (`advance`) and states facts about the work (`fact`).
 * New steps go out at once; counting and facts at most every `ms`, so a job that reports
 * every tile does not flood the streams following it.
 */
export type Progress = {
	/** How many steps there are, once that is known (or changes). */
	steps(n: number): void;
	/**
	 * Starts the next step, or step `at`. `total` and `unit` say what it counts, when it does.
	 */
	step(
		message: string,
		opts?: { at?: number; total?: number; unit?: string },
	): void;
	/** How many of the step's `total` are done. */
	advance(done: number): void;
	/** Sets (or replaces) the fact under `key`; facts keep the order they were first set in. */
	fact(key: string, text: string): void;
};

/** Progress for a job run outside the worker (tests, scripts): goes nowhere. */
export const noProgress: Progress = {
	steps() {},
	step() {},
	advance() {},
	fact() {},
};

/** Rates are only told after this long in a step, so the first few items don't skew them. */
const RATE_AFTER_MS = 1000;

export function createProgress(
	emit: (p: JobProgress) => void,
	opts: { ms?: number; now?: () => number } = {},
): Progress {
	const ms = opts.ms ?? 250;
	const now = opts.now ?? Date.now;
	const startedAt = now();
	let step = 0;
	let steps = 1;
	let message = "";
	let unit: string | undefined;
	let done: number | undefined;
	let total: number | undefined;
	let stepAt = startedAt;
	let lastAt = Number.NEGATIVE_INFINITY;
	const facts = new Map<string, string>();

	const send = (force: boolean) => {
		// Facts stated before the first step go out with it.
		if (step === 0) return;
		const t = now();
		if (!force && done !== total && t - lastAt < ms) return;
		lastAt = t;
		const elapsed = t - stepAt;
		const p: JobProgress = {
			step,
			steps: Math.max(steps, step),
			message,
			facts: [...facts.values()],
			startedAt,
		};
		if (total !== undefined) {
			p.done = done ?? 0;
			p.total = total;
		}
		if (unit) p.unit = unit;
		if (done && elapsed >= RATE_AFTER_MS)
			p.rate = Math.round((done / elapsed) * 10_000) / 10;
		emit(p);
	};

	return {
		steps(n) {
			steps = n;
		},
		step(text, o = {}) {
			step = o.at ?? step + 1;
			message = text;
			total = o.total;
			unit = o.unit;
			done = o.total === undefined ? undefined : 0;
			stepAt = now();
			send(true);
		},
		advance(n) {
			done = n;
			send(false);
		},
		fact(key, text) {
			if (facts.get(key) === text) return;
			facts.set(key, text);
			send(false);
		},
	};
}

/** A revision event for a running job's progress; the same object for events and snapshots. */
export const progressEvent = (p: JobProgress): RevisionEvent => {
	const e: RevisionEvent = { status: "processing", message: p.message };
	if (p.total !== undefined) {
		e.done = p.done;
		e.total = p.total;
	}
	e.progress = p;
	return e;
};
