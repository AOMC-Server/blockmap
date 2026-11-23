import { Empty, ErrorBox, Loading } from "@aomc-server/block-ui";
import { formatTime } from "@aomc-server/block-ui/format";
import { useAsync } from "@aomc-server/block-ui/hooks";
import type { Dye } from "@blockmap/shared/colors";
import { useState } from "preact/hooks";
import { api, attempt } from "../api";
import { copyText } from "../clipboard";
import { TYPE_LABEL } from "../featureInfo";
import { featureMapUrl, playerPageUrl } from "../players";
import { currentMap, isModerator, readOnly } from "../state";
import { Banner } from "./icons";
import { LoadFailed, Page, usePageLoad } from "./Page";
import { PlayerHead } from "./PlayerHead";

/** The player of /players/<id or UUID>. */
export const playerKeyFromPath = (path: string) =>
	/^\/players\/([^/]+)\/?$/.exec(path)?.[1] ?? null;

function FeatureList(props: {
	features: {
		id: number;
		layerName: string;
		dimension: string;
		type: "pin" | "line" | "polygon";
		name: string;
		color: string | null;
		center: [number, number];
	}[];
	empty: string;
}) {
	const dimensions = currentMap.value?.dimensions ?? [];
	if (props.features.length === 0) return <Empty>{props.empty}</Empty>;
	return (
		<ul class="player-features">
			{props.features.map((f) => (
				<li key={f.id}>
					<a class="player-feature" href={featureMapUrl(f)}>
						<Banner dye={(f.color ?? "white") as Dye} />
						<span class="type">{TYPE_LABEL[f.type]}</span>
						<span class="feature-name">{f.name || <em>unnamed</em>}</span>
						<span class="muted player-feature-where">
							{f.layerName} ·{" "}
							{dimensions.find((d) => d.slug === f.dimension)?.name ??
								f.dimension}
						</span>
					</a>
				</li>
			))}
		</ul>
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
						<h2>Owns ({data.owned.length})</h2>
						<FeatureList
							features={data.owned}
							empty="Doesn't own any features you can see."
						/>
					</section>

					<section class="page-section">
						<h2>Built ({data.built.length})</h2>
						<FeatureList
							features={data.built}
							empty="Hasn't built any features you can see."
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
