import { Count, Empty, ErrorBox, Loading, SortTh } from "@aomc-server/block-ui";
import { useAsync, useDebounced } from "@aomc-server/block-ui/hooks";
import { useState } from "preact/hooks";
import { api, attempt } from "../api";
import { playerPageUrl } from "../players";
import { canEditMap, user } from "../state";
import { NewPlayerDialog } from "./NewPlayerDialog";
import { LoadFailed, Page, usePageLoad } from "./Page";
import { PlayerHead } from "./PlayerHead";

type SortKey = "name" | "owned" | "built";

/** Most players listed at once. */
const LIMIT = 500;

/** A count in the table: zero is muted, so the players who have something stand out. */
const CountCell = (props: { n: number }) => (
	<td class={`num ${props.n === 0 ? "faint" : ""}`}>{props.n}</td>
);

/** /players: the Minecraft players that features are attributed to. */
export function PlayersPage() {
	const { status, retry } = usePageLoad();
	const [text, setText] = useState("");
	const [sort, setSort] = useState<{ col: SortKey; dir: "asc" | "desc" }>({
		col: "owned",
		dir: "desc",
	});
	const [adding, setAdding] = useState(false);
	const q = useDebounced(text.trim(), 250);
	// The server picks which players make the list (the top ones for this column); the direction
	// only orders them.
	const state = useAsync(async () => {
		const res = await attempt(() =>
			api.api.players.$get({
				query: { q, limit: String(LIMIT), sort: sort.col },
			}),
		);
		if (!res.ok) throw new Error(res.error);
		return res.body;
	}, [q, sort.col]);

	const rows = [...(state.data?.players ?? [])].sort((a, b) => {
		const byName = a.name.localeCompare(b.name, undefined, {
			sensitivity: "base",
		});
		const by =
			sort.col === "name"
				? byName
				: a[sort.col] - b[sort.col] ||
					a[sort.col === "owned" ? "built" : "owned"] -
						b[sort.col === "owned" ? "built" : "owned"];
		return (sort.dir === "asc" ? by : -by) || byName;
	});
	const total = state.data?.total ?? 0;
	const onSort = (col: string) =>
		setSort((s) =>
			s.col === col
				? { col: s.col, dir: s.dir === "asc" ? "desc" : "asc" }
				: { col: col as SortKey, dir: col === "name" ? "asc" : "desc" },
		);

	return (
		<Page title="Players">
			{status === "failed" && <LoadFailed retry={retry} />}
			{status !== "failed" && (
				<section class="page-section">
					<h2>Players {state.data && <Count>{total}</Count>}</h2>
					<p class="muted">
						Minecraft players that features are attributed to, as owners or
						builders. Counts only include features you can see.
					</p>
					<div class="toolbar players-tools">
						<input
							type="search"
							value={text}
							placeholder="Search by name or UUID"
							aria-label="Search players"
							autocomplete="off"
							spellcheck={false}
							onInput={(e) => setText(e.currentTarget.value)}
							onKeyDown={(e) => {
								if (e.key === "Escape" && text) {
									e.stopPropagation();
									setText("");
								}
							}}
						/>
						{user.value && canEditMap.value && (
							<button
								type="button"
								class="btn primary"
								onClick={() => setAdding(true)}
							>
								Add player
							</button>
						)}
					</div>
					{state.error && (
						<ErrorBox
							message={`Failed to load players: ${state.error}`}
							onRetry={state.reload}
						/>
					)}
					{!state.data && !state.error && <Loading />}
					{state.data && rows.length === 0 && (
						<Empty>
							{q
								? `No players match “${q}”.`
								: "No players have been added yet."}
						</Empty>
					)}
					{rows.length > 0 && (
						<div class={`table-wrap flush ${state.loading ? "fade" : ""}`}>
							<table class="table middle compact players-table">
								<thead>
									<tr>
										<SortTh
											label="Player"
											col="name"
											sort={sort.col}
											dir={sort.dir}
											onSort={onSort}
										/>
										<SortTh
											label="Owned"
											col="owned"
											sort={sort.col}
											dir={sort.dir}
											onSort={onSort}
											num
											hint="Features they own"
										/>
										<SortTh
											label="Built"
											col="built"
											sort={sort.col}
											dir={sort.dir}
											onSort={onSort}
											num
											hint="Features they helped build"
										/>
									</tr>
								</thead>
								<tbody>
									{rows.map((p) => (
										<tr
											key={p.id}
											class="click"
											onClick={(e) => {
												// The name is a link of its own (new tabs, keyboard).
												if (!(e.target as Element).closest("a"))
													location.href = playerPageUrl(p);
											}}
										>
											<td>
												<a class="player-name" href={playerPageUrl(p)}>
													<PlayerHead player={p} size={24} />
													<span class="player-label">{p.name}</span>
												</a>
											</td>
											<CountCell n={p.owned} />
											<CountCell n={p.built} />
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
					{rows.length > 0 && total > rows.length && (
						<p class="hint">
							Showing {rows.length} of {total} players. Search to find the
							others.
						</p>
					)}
				</section>
			)}
			{adding && (
				<NewPlayerDialog
					onPicked={() => state.reload()}
					onClose={() => setAdding(false)}
				/>
			)}
		</Page>
	);
}
