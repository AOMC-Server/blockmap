import { Empty, ErrorBox, Loading, SortTh } from "@aomc-server/block-ui";
import { useAsync, useDebounced } from "@aomc-server/block-ui/hooks";
import { useState } from "preact/hooks";
import { api, attempt } from "../api";
import { playerPageUrl } from "../players";
import { canEditMap, user } from "../state";
import { NewPlayerDialog } from "./NewPlayerDialog";
import { LoadFailed, Page, usePageLoad } from "./Page";
import { PlayerHead } from "./PlayerHead";

type SortKey = "name" | "owned" | "built";

/** /players: the Minecraft players that features are attributed to. */
export function PlayersPage() {
	const { status, retry } = usePageLoad();
	const [text, setText] = useState("");
	const [sort, setSort] = useState<{ col: SortKey; dir: "asc" | "desc" }>({
		col: "name",
		dir: "asc",
	});
	const [adding, setAdding] = useState(false);
	const q = useDebounced(text.trim(), 250);
	const state = useAsync(async () => {
		const res = await attempt(() =>
			api.api.players.$get({ query: { q, limit: "500" } }),
		);
		if (!res.ok) throw new Error(res.error);
		return res.body.players;
	}, [q]);

	const rows = [...(state.data ?? [])].sort((a, b) => {
		const by =
			sort.col === "name"
				? a.name.localeCompare(b.name)
				: a[sort.col] - b[sort.col];
		return (sort.dir === "asc" ? by : -by) || a.name.localeCompare(b.name);
	});
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
				<>
					<p class="muted">
						Minecraft players that features are attributed to, as owners or
						builders. Counts only include features you can see.
					</p>
					<div class="players-tools">
						<input
							type="text"
							class="players-search"
							value={text}
							placeholder="Search by name or UUID"
							aria-label="Search players"
							autocomplete="off"
							spellcheck={false}
							onInput={(e) => setText(e.currentTarget.value)}
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
							<table class="table plain compact">
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
											hint="Features owned"
										/>
										<SortTh
											label="Built"
											col="built"
											sort={sort.col}
											dir={sort.dir}
											onSort={onSort}
											num
											hint="Features built"
										/>
									</tr>
								</thead>
								<tbody>
									{rows.map((p) => (
										<tr key={p.id}>
											<td>
												<a class="player-name" href={playerPageUrl(p)}>
													<PlayerHead player={p} size={24} />
													<span class="player-label">{p.name}</span>
												</a>
											</td>
											<td class="num">{p.owned}</td>
											<td class="num">{p.built}</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
				</>
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
