import { useAsync, useDebounced } from "@aomc-server/block-ui/hooks";
import { MAX_BUILDERS, type Player } from "@blockmap/shared/players";
import { useEffect, useId, useMemo, useRef, useState } from "preact/hooks";
import { api, attempt } from "../api";
import { loadRecentPlayers, rememberPlayer } from "../settings";
import { NewPlayerDialog } from "./NewPlayerDialog";
import { PlayerHead } from "./PlayerHead";

const SUGGESTIONS = 8;

type Option =
	| { kind: "player"; player: Player }
	| { kind: "new"; text: string };

/** A text field that searches the players of the map as you type and ends with "New player…". */
export function PlayerSearch(props: {
	label: string;
	placeholder: string;
	/** Offer "New player…" for a name that is not found (default true); off where only known players make sense. */
	allowNew?: boolean;
	/** Players that are not offered (already chosen). */
	exclude?: number[];
	onPick: (player: Player) => void;
}) {
	const [text, setText] = useState("");
	const [open, setOpen] = useState(false);
	const [active, setActive] = useState(0);
	const [creating, setCreating] = useState<string | null>(null);
	const root = useRef<HTMLDivElement>(null);
	const listId = useId();
	const query = useDebounced(text.trim(), 200);
	// With nothing typed, the players picked lately come first (when there are any).
	const recent = useMemo(() => (open ? loadRecentPlayers() : []), [open]);
	const typed = text.trim();
	const showRecent =
		typed === "" && recent.some((p) => !props.exclude?.includes(p.id));
	const state = useAsync(
		open && !showRecent
			? async () => {
					const res = await attempt(() =>
						api.api.players.$get({
							query: {
								q: query,
								limit: String(SUGGESTIONS + (props.exclude?.length ?? 0)),
							},
						}),
					);
					if (!res.ok) throw new Error(res.error);
					return res.body.players;
				}
			: null,
		[query, open, showRecent],
	);

	useEffect(() => {
		if (!open) return;
		const onDown = (e: PointerEvent) => {
			if (!root.current?.contains(e.target as Node)) setOpen(false);
		};
		document.addEventListener("pointerdown", onDown);
		return () => document.removeEventListener("pointerdown", onDown);
	}, [open]);

	const found = showRecent ? recent : (state.data ?? []);
	const exact = found.some((p) => p.name.toLowerCase() === typed.toLowerCase());
	const options: Option[] = [
		...found
			.filter((p) => !props.exclude?.includes(p.id))
			.slice(0, SUGGESTIONS)
			.map((player): Option => ({ kind: "player", player })),
		...(exact || props.allowNew === false
			? []
			: [{ kind: "new", text: typed } as Option]),
	];
	const settled = showRecent || (query === typed && !state.loading);

	// A new list starts at its first entry.
	useEffect(() => setActive(0), [state.data, typed]);

	const choose = (o: Option | undefined) => {
		if (!o) return;
		setOpen(false);
		if (o.kind === "new") {
			setCreating(o.text);
			return;
		}
		setText("");
		pick(o.player);
	};

	const pick = (player: Player) => {
		rememberPlayer(player);
		props.onPick(player);
	};

	const onKeyDown = (e: KeyboardEvent) => {
		if (e.key === "Escape") {
			if (!open) return;
			e.preventDefault();
			e.stopPropagation();
			setOpen(false);
		} else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			if (!open) {
				setOpen(true);
				return;
			}
			if (options.length === 0) return;
			const step = e.key === "ArrowDown" ? 1 : -1;
			setActive((active + step + options.length) % options.length);
		} else if (e.key === "Enter" && open) {
			e.preventDefault();
			choose(options[active]);
		}
	};

	return (
		<div class="player-search" ref={root}>
			<input
				type="text"
				role="combobox"
				aria-label={props.label}
				aria-expanded={open}
				aria-controls={listId}
				aria-autocomplete="list"
				aria-activedescendant={open ? `${listId}-${active}` : undefined}
				autocomplete="off"
				spellcheck={false}
				value={text}
				maxLength={40}
				placeholder={props.placeholder}
				onFocus={() => setOpen(true)}
				onInput={(e) => {
					setText(e.currentTarget.value);
					setOpen(true);
				}}
				onKeyDown={onKeyDown}
			/>
			{open && (
				<div class="player-options" role="listbox" id={listId}>
					{showRecent && (
						<div class="player-option-note muted" role="presentation">
							Recent
						</div>
					)}
					{options.map((o, i) => (
						<div
							key={o.kind === "player" ? o.player.id : "new"}
							id={`${listId}-${i}`}
							role="option"
							tabIndex={-1}
							aria-selected={i === active}
							class={`player-option ${i === active ? "active" : ""} ${o.kind === "new" ? "new" : ""}`}
							onPointerDown={(e) => e.preventDefault()}
							onMouseEnter={() => setActive(i)}
							onClick={() => choose(o)}
							onKeyDown={(e) => {
								if (e.key === "Enter") choose(o);
							}}
						>
							{o.kind === "player" ? (
								<>
									<PlayerHead player={o.player} size={20} />
									<span class="player-option-name">{o.player.name}</span>
								</>
							) : (
								<span class="player-option-name">
									{o.text ? `New player “${o.text}”…` : "New player…"}
								</span>
							)}
						</div>
					))}
					{state.error && (
						<div class="player-option-note error-text">{state.error}</div>
					)}
					{!state.error &&
						!settled &&
						!options.some((o) => o.kind === "player") && (
							<div class="player-option-note muted">Searching…</div>
						)}
					{!state.error && settled && options.length === 0 && (
						<div class="player-option-note muted">No players found.</div>
					)}
				</div>
			)}
			{creating !== null && (
				<NewPlayerDialog
					initial={creating}
					onPicked={pick}
					onClose={() => setCreating(null)}
				/>
			)}
		</div>
	);
}

function PlayerChip(props: { player: Player; onRemove: () => void }) {
	return (
		<span class="chip player-chip">
			<PlayerHead player={props.player} size={18} />
			<span class="player-chip-name">{props.player.name}</span>
			<button
				type="button"
				class="plain player-chip-remove"
				aria-label={`Remove ${props.player.name}`}
				onClick={props.onRemove}
			>
				×
			</button>
		</span>
	);
}

/** Picks the owner of a feature: one player or nobody. */
export function OwnerPicker(props: {
	value: Player | null;
	onChange: (player: Player | null) => void;
}) {
	return props.value ? (
		<div class="player-chips">
			<PlayerChip player={props.value} onRemove={() => props.onChange(null)} />
		</div>
	) : (
		<PlayerSearch
			label="Owner"
			placeholder="Search players"
			onPick={props.onChange}
		/>
	);
}

/** Picks the builders of a feature: any number of players, up to `MAX_BUILDERS`. */
export function BuildersPicker(props: {
	value: Player[];
	onChange: (players: Player[]) => void;
}) {
	const { value } = props;
	const full = value.length >= MAX_BUILDERS;
	return (
		<>
			{value.length > 0 && (
				<div class="player-chips">
					{value.map((p) => (
						<PlayerChip
							key={p.id}
							player={p}
							onRemove={() =>
								props.onChange(value.filter((b) => b.id !== p.id))
							}
						/>
					))}
				</div>
			)}
			{full ? (
				<p class="hint">A feature can have at most {MAX_BUILDERS} builders.</p>
			) : (
				<PlayerSearch
					label="Add a builder"
					placeholder="Search players"
					exclude={value.map((p) => p.id)}
					onPick={(p) =>
						props.onChange(
							value.some((b) => b.id === p.id) ? value : [...value, p],
						)
					}
				/>
			)}
		</>
	);
}
