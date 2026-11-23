import { Modal } from "@aomc-server/block-ui";
import { useDebounced } from "@aomc-server/block-ui/hooks";
import {
	isPlayerName,
	isUuid,
	normalizeUuid,
	type Player,
} from "@blockmap/shared/players";
import { useEffect, useState } from "preact/hooks";
import { api, attempt } from "../api";
import { copyText } from "../clipboard";
import { LookupHead } from "./PlayerHead";

type Existing = Player & { owned: number; built: number };

type Lookup =
	| { phase: "loading" }
	| { phase: "notFound"; text: string }
	| { phase: "failed"; error: string; retryable: boolean }
	| { phase: "found"; uuid: string; name: string; existing: Existing | null };

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/**
 * Asks Mojang for the account with a name or UUID, and adds it to the map after confirming.
 * `onPicked` gets the player, whether it was added now or was on the map already.
 */
export function NewPlayerDialog(props: {
	initial?: string;
	onPicked: (player: Player) => void;
	onClose: () => void;
}) {
	const [text, setText] = useState(props.initial ?? "");
	const [attempts, setAttempts] = useState(0);
	const [lookup, setLookup] = useState<Lookup>({ phase: "loading" });
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const current = text.trim();
	const query = useDebounced(current, 400);
	const valid = isUuid(current) || isPlayerName(current);
	// The lookup is for the text as it was a moment ago while the user is still typing.
	const typing = current !== query;

	useEffect(() => {
		if (!isUuid(query) && !isPlayerName(query)) return;
		let cancelled = false;
		setLookup({ phase: "loading" });
		void attempt(() =>
			api.api.players.lookup.$get({ query: { q: query } }),
		).then((res) => {
			if (cancelled) return;
			if (res.ok) {
				setLookup({ phase: "found", ...res.body });
				return;
			}
			setLookup(
				res.status === 404
					? {
							phase: "notFound",
							text: isUuid(query)
								? `No Minecraft account has the UUID ${normalizeUuid(query)}`
								: `No Minecraft account named “${query}”`,
						}
					: {
							phase: "failed",
							error: res.status === 502 ? "Could not reach Mojang." : res.error,
							retryable: res.status === 502 || res.status === 0,
						},
			);
		});
		return () => {
			cancelled = true;
		};
	}, [query, attempts]);

	useEffect(() => setError(null), [query]);

	const settled = valid && !typing;
	const found = settled && lookup.phase === "found" ? lookup : null;

	const submit = async (e?: Event) => {
		e?.preventDefault();
		if (!found || saving) return;
		setSaving(true);
		setError(null);
		try {
			const res = await attempt(() =>
				api.api.players.$post({ json: { uuid: found.uuid } }),
			);
			if (!res.ok) {
				setError(res.error);
				return;
			}
			props.onPicked(res.body.player);
			props.onClose();
		} finally {
			setSaving(false);
		}
	};

	return (
		<Modal
			title="Add player"
			onClose={props.onClose}
			footer={
				<>
					<button type="button" class="btn" onClick={props.onClose}>
						Cancel
					</button>
					<button
						type="submit"
						form="new-player-form"
						class="btn primary"
						disabled={!found || saving}
					>
						{saving
							? "Saving…"
							: found?.existing
								? "Use this player"
								: "Add player"}
					</button>
				</>
			}
		>
			<form id="new-player-form" class="new-player" onSubmit={submit}>
				<label class="field">
					<span class="label">Minecraft name or UUID</span>
					<input
						type="text"
						value={text}
						maxLength={40}
						autocomplete="off"
						spellcheck={false}
						placeholder="Notch"
						onInput={(e) => setText(e.currentTarget.value)}
					/>
				</label>
				<div class="new-player-result" aria-live="polite">
					{current === "" && (
						<p class="muted">
							Enter a Minecraft name or UUID. The name and head come from
							Mojang.
						</p>
					)}
					{current !== "" && !valid && (
						<p class="muted">That isn't a Minecraft name or UUID.</p>
					)}
					{valid && (typing || lookup.phase === "loading") && (
						<p class="muted">Looking up…</p>
					)}
					{settled && lookup.phase === "notFound" && (
						<p class="error-text">{lookup.text}</p>
					)}
					{settled && lookup.phase === "failed" && (
						<>
							<p class="error-text">{lookup.error}</p>
							{lookup.retryable && (
								<button
									type="button"
									class="btn small"
									onClick={() => setAttempts(attempts + 1)}
								>
									Retry
								</button>
							)}
						</>
					)}
					{found && (
						<div class="new-player-found">
							<LookupHead uuid={found.uuid} name={found.name} size={96} />
							<div class="new-player-info">
								<div class="new-player-name">{found.name}</div>
								<div class="copy-row">
									<code class="uuid">{found.uuid}</code>
									<button
										type="button"
										class="btn small"
										onClick={() => void copyText(found.uuid, "UUID copied")}
									>
										Copy
									</button>
								</div>
								{found.existing && (
									<p class="muted">
										Already on the map as <b>{found.existing.name}</b> (
										{count(found.existing.owned, "feature")} owned,{" "}
										{count(found.existing.built, "feature")} built).
									</p>
								)}
							</div>
						</div>
					)}
					{error && <p class="error-text">{error}</p>}
				</div>
			</form>
		</Modal>
	);
}
