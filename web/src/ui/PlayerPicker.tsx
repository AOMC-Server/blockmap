import { useAsync, useDebounced } from "@aomc-server/block-ui/hooks";
import { MAX_BUILDERS, type Player } from "@blockmap/shared/players";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import { api, attempt } from "../api";
import { NewPlayerDialog } from "./NewPlayerDialog";
import { PlayerHead } from "./PlayerHead";

const SUGGESTIONS = 8;

type Option =
	| { kind: "player"; player: Player }
	| { kind: "new"; text: string };

/** A text field that searches the players of the map as you type and ends with "New player…". */
function PlayerSearch(props: {
	label: string;
	placeholder: string;
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
	const state = useAsync(
		open
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
		[query, open],
	);

	useEffect(() => {
		if (!open) return;
		const onDown = (e: PointerEvent) => {
			if (!root.current?.contains(e.target as Node)) setOpen(false);
		};
		document.addEventListener("pointerdown", onDown);
		return () => document.removeEventListener("pointerdown", onDown);
	}, [open]);

	const typed = text.trim();
	const found = state.data ?? [];
	const exact = found.some((p) => p.name.toLowerCase() === typed.toLowerCase());
	const options: Option[] = [
		...found
			.filter((p) => !props.exclude?.includes(p.id))
			.slice(0, SUGGESTIONS)
			.map((player): Option => ({ kind: "player", player })),
		...(exact ? [] : [{ kind: "new", text: typed } as Option]),
	];
	const settled = query === typed && !state.loading;

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
		props.onPick(o.player);
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
					{!state.error && !settled && options.length === 1 && (
						<div class="player-option-note muted">Searching…</div>
					)}
				</div>
			)}
			{creating !== null && (
				<NewPlayerDialog
					initial={creating}
					onPicked={props.onPick}
					onClose={() => setCreating(null)}
				/>
			)}
		</div>
	);
}

function PlayerChip(props: {
	player: Player;
	/** Without it the chip cannot be removed. */
	onRemove?: () => void;
	title?: string;
}) {
	return (
		<span class="chip player-chip" title={props.title}>
			<PlayerHead player={props.player} size={18} />
			<span class="player-chip-name">{props.player.name}</span>
			{props.onRemove && (
				<button
					type="button"
					class="plain player-chip-remove"
					aria-label={`Remove ${props.player.name}`}
					onClick={props.onRemove}
				>
					×
				</button>
			)}
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

/**
 * Picks the builders of a feature: any number of players, up to `MAX_BUILDERS`. The owner is
 * always one of them, so their chip stays until they are no longer the owner.
 */
export function BuildersPicker(props: {
	value: Player[];
	owner: Player | null;
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
							title={
								p.id === props.owner?.id
									? "The owner is always a builder"
									: undefined
							}
							onRemove={
								p.id === props.owner?.id
									? undefined
									: () => props.onChange(value.filter((b) => b.id !== p.id))
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
