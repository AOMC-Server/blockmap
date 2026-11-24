import {
	Badge,
	Count,
	Empty,
	ErrorBox,
	Loading,
	Segmented,
} from "@aomc-server/block-ui";
import { formatTime } from "@aomc-server/block-ui/format";
import { useAsync } from "@aomc-server/block-ui/hooks";
import type { Dye } from "@blockmap/shared/colors";
import type { Player } from "@blockmap/shared/players";
import { useState } from "preact/hooks";
import { api, attempt } from "../api";
import { copyText } from "../clipboard";
import { TYPE_LABEL } from "../featureInfo";
import {
	featureMapUrl,
	groupPlayerFeatures,
	type PlayerFeature,
	type PlayerFeatureSort,
	playerPageUrl,
} from "../players";
import { currentMap, isModerator, readOnly } from "../state";
import { Banner } from "./icons";
import { LoadFailed, Page, usePageLoad } from "./Page";
import { PlayerHead } from "./PlayerHead";

/** The player of /players/<id or UUID>. */
export const playerKeyFromPath = (path: string) =>
	/^\/players\/([^/]+)\/?$/.exec(path)?.[1] ?? null;

const SORT_NAMES: Record<PlayerFeatureSort, string> = {
	owned: "Most owned",
	built: "Most built",
	name: "Name",
};

/** The features a player owns or built, searchable, in groups by layer. */
function PlayerFeatures(props: {
	playerId: number;
	owned: PlayerFeature[];
	built: PlayerFeature[];
	players: ReadonlyMap<number, Player>;
}) {
	const [text, setText] = useState("");
	const [sort, setSort] = useState<PlayerFeatureSort>("owned");
	const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(new Set());
	const dimensions = currentMap.value?.dimensions ?? [];
	const dimensionName = (slug: string) =>
		dimensions.find((d) => d.slug === slug)?.name ?? slug;
	const query = text.trim();
	const groups = groupPlayerFeatures({
		playerId: props.playerId,
		owned: props.owned,
		built: props.built,
		players: props.players,
		query,
		sort,
		dimensionName,
	});
	const total = new Set([...props.owned, ...props.built].map((f) => f.id)).size;
	const toggle = (id: number) =>
		setCollapsed((c) => {
			const next = new Set(c);
			if (!next.delete(id)) next.add(id);
			return next;
		});

	if (total === 0)
		return (
			<Empty>
				Doesn't own and hasn't helped build any features you can see.
			</Empty>
		);
	return (
		<>
			<div class="toolbar players-tools">
				<input
					type="search"
					value={text}
					placeholder="Search features, layers and players"
					aria-label="Search features, layers and players"
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
				<Segmented
					small
					label="Sort by"
					value={sort}
					options={["owned", "built", "name"] as const}
					names={SORT_NAMES}
					onChange={setSort}
				/>
			</div>
			{groups.length === 0 && <Empty>No features match “{query}”.</Empty>}
			<ul class="layers">
				{groups.map((g) => {
					const layerDye = g.layerColor as Dye;
					// Searching opens every layer with a match.
					const open = query !== "" || !collapsed.has(g.layerId);
					return (
						<li key={g.layerId} class={`layer ${open ? "open" : ""}`}>
							<div class="layer-head">
								<Banner dye={layerDye} />
								<button
									type="button"
									class="plain layer-name"
									aria-expanded={open}
									onClick={() => toggle(g.layerId)}
								>
									<span class="layer-title">{g.layerName}</span>
									<span class="badge">{dimensionName(g.dimension)}</span>
									<span class="player-layer-counts">
										{g.owned > 0 && <Count>{g.owned} owned</Count>}
										{g.built > 0 && <Count>{g.built} built</Count>}
									</span>
									<span class="chevron" aria-hidden="true">
										{open ? "▼" : "▶"}
									</span>
								</button>
							</div>
							{open && (
								<div class="layer-body">
									<ul class="features">
										{g.features.map((f) => (
											<li key={f.id}>
												<a class="feature-link" href={featureMapUrl(f)}>
													<Banner dye={(f.color ?? layerDye) as Dye} />
													<span class="type">{TYPE_LABEL[f.type]}</span>
													<span class="feature-name">
														{f.name || <em>unnamed</em>}
													</span>
													{f.owns && <Badge>owner</Badge>}
													{f.built && <Badge>builder</Badge>}
												</a>
												{f.others.length > 0 && (
													<span class="player-feature-others">
														{f.others.map((o) => (
															<a
																key={`${o.role}:${o.player.id}`}
																href={playerPageUrl(o.player)}
															>
																<PlayerHead
																	player={o.player}
																	size={18}
																	title={`${o.role === "owner" ? "Owner" : "Builder"}: ${o.player.name}`}
																/>
															</a>
														))}
													</span>
												)}
											</li>
										))}
									</ul>
								</div>
							)}
						</li>
					);
				})}
			</ul>
		</>
	);
}

/** /players/<id or UUID>: one player, and the features they own and built. */
export function PlayerPage(props: { playerKey: string }) {
	const { status, retry } = usePageLoad();
	const [busy, setBusy] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);
	const state = useAsync(async () => {
		const res = await attempt(() =>
			api.api.players[":id"].$get({ param: { id: props.playerKey } }),
		);
		if (!res.ok)
			throw new Error(res.status === 404 ? "Player not found." : res.error);
		return res.body;
	}, [props.playerKey]);
	const data = state.data;
	const player = data?.player;

	const act = async (
		call: () => Promise<{
			ok: boolean;
			status: number;
			json(): Promise<unknown>;
		}>,
		done: () => void,
	) => {
		setBusy(true);
		setActionError(null);
		try {
			const res = await attempt(call);
			if (res.ok) done();
			else setActionError(res.error);
		} finally {
			setBusy(false);
		}
	};

	const refresh = () =>
		player &&
		act(
			() =>
				api.api.players[":id"].refresh.$post({
					param: { id: String(player.id) },
				}),
			state.reload,
		);

	const remove = () => {
		if (!player || !confirm(`Delete ${player.name}?`)) return;
		void act(
			() =>
				api.api.players[":id"].$delete({ param: { id: String(player.id) } }),
			() => {
				location.href = "/players";
			},
		);
	};

	const names = new Map(
		Object.entries(data?.players ?? {}).map(([id, p]) => [Number(id), p]),
	);
	const featureIds = new Map(
		[...(data?.owned ?? []), ...(data?.built ?? [])].map((f) => [f.id, f]),
	);
	const who = (id: number | null) => {
		const p = id === null ? undefined : names.get(id);
		return p ? (
			<a class="player-name" href={playerPageUrl(p)}>
				<PlayerHead player={p} size={16} />
				<span class="player-label">{p.name}</span>
			</a>
		) : (
			<em>nobody</em>
		);
	};

	return (
		<Page title={player?.name ?? "Player"}>
			{status === "failed" && <LoadFailed retry={retry} />}
			{status !== "failed" && state.error && !data && (
				<ErrorBox message={state.error} onRetry={state.reload} />
			)}
			{!data && !state.error && <Loading />}
			{player && data && (
				<>
					<div class="player-card">
						<PlayerHead player={player} size={96} />
						<div class="player-card-info">
							<h2>{player.name}</h2>
							<div class="copy-row">
								<code class="uuid">{player.uuid}</code>
								<button
									type="button"
									class="btn small"
									onClick={() => void copyText(player.uuid, "UUID copied")}
								>
									Copy
								</button>
							</div>
							<p class="muted hint">
								Added {formatTime(data.addedAt)}
								{data.checkedAt !== null &&
									` · Checked with Mojang ${formatTime(data.checkedAt)}`}
							</p>
							{isModerator.value && !readOnly.value && (
								<div class="group">
									<button
										type="button"
										class="btn small"
										disabled={busy}
										onClick={refresh}
									>
										Refresh from Mojang
									</button>
									<button
										type="button"
										class="btn small danger"
										disabled={busy}
										onClick={remove}
									>
										Delete
									</button>
								</div>
							)}
							{actionError && <p class="error-text">{actionError}</p>}
						</div>
					</div>

					<section class="page-section">
						<h2>Features</h2>
						<PlayerFeatures
							playerId={player.id}
							owned={data.owned}
							built={data.built}
							players={names}
						/>
					</section>

					<section class="page-section">
						<h2>Ownership changes</h2>
						{data.ownership.length === 0 ? (
							<Empty>No changes of owner involve this player yet.</Empty>
						) : (
							<ul class="player-changes">
								{data.ownership.map((o) => {
									const feature = featureIds.get(o.featureId);
									const name = o.featureName || "unnamed";
									return (
										<li key={o.revisionId}>
											<div>
												{feature ? (
													<a href={featureMapUrl(feature)}>{name}</a>
												) : (
													name
												)}
												: {who(o.from)} → {who(o.to)}
											</div>
											<div class="muted">
												{o.by} · {formatTime(o.at)}
											</div>
										</li>
									);
								})}
							</ul>
						)}
					</section>
				</>
			)}
		</Page>
	);
}
