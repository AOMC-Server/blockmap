import { Progress } from "@aomc-server/block-ui";
import { formatElapsed } from "@aomc-server/block-ui/format";
import { useEffect, useState } from "preact/hooks";
import { describeCount, describeStep, type JobProgress as Info } from "../jobs";

/** The time now, again every `ms`, for durations that keep growing between updates. */
function useNow(ms = 1000) {
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), ms);
		return () => clearInterval(timer);
	}, [ms]);
	return now;
}

/**
 * What a running job is doing: its step of how many, a bar for the step, how far and how fast,
 * how long it has run, and the facts it states about the work. `prefix` goes before the step
 * ("Export 2 of 3").
 */
export function JobProgress(props: { progress: Info; prefix?: string }) {
	const p = props.progress;
	const now = useNow();
	const count = describeCount(p);
	const elapsed = formatElapsed((now - p.startedAt) / 1000);
	return (
		<div class="job-progress">
			<div class="job-progress-step">
				{props.prefix && `${props.prefix} · `}
				{describeStep(p)}
			</div>
			<Progress
				value={p.total ? (p.done ?? 0) / p.total : null}
				ariaLabel={p.message}
				label={count ? `${count} · running ${elapsed}` : `Running ${elapsed}`}
			/>
			{p.facts.length > 0 && (
				<ul class="job-facts muted">
					{p.facts.map((fact) => (
						<li key={fact}>{fact}</li>
					))}
				</ul>
			)}
		</div>
	);
}
