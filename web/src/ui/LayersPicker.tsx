import type { Dye } from "@blockmap/shared/colors";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import { type LayerPick, makePrimary, matchLayers } from "../layerPick";
import { Banner } from "./icons";

export type LayerOption = { id: number; name: string; color: Dye };

const unknownName = "another layer";

/**
 * Picks the layers of a feature: any number of them, searchable, one of them primary (the layer
 * the feature belongs to, which sets its colour and style). `options` are the layers that can be
 * picked; layers in the pick that are not among them (ones the user cannot edit) are kept and
 * shown, but cannot be taken out. `primaryOptions` are the ones that can be made primary (from the list).
 */
export function LayersPicker(props: {
	options: LayerOption[];
	primaryOptions: number[];
	/** Names of layers in the pick that are not among the options, by id. */
	otherNames: Map<number, string>;
	value: LayerPick;
	onChange: (pick: LayerPick) => void;
}) {
	const { value } = props;
	const [text, setText] = useState("");
	const [open, setOpen] = useState(false);
	const [active, setActive] = useState(0);
	const root = useRef<HTMLDivElement>(null);
	const listId = useId();

	useEffect(() => {
		if (!open) return;
		const onDown = (e: PointerEvent) => {
			if (!root.current?.contains(e.target as Node)) setOpen(false);
		};
		document.addEventListener("pointerdown", onDown);
		return () => document.removeEventListener("pointerdown", onDown);
	}, [open]);

	const byId = new Map(props.options.map((l) => [l.id, l]));
	const picked = (id: number) =>
		id === value.primary || value.also.includes(id);
	const shown = matchLayers(props.options, text);
	useEffect(() => setActive(0), [text]);

	const toggle = (id: number) => {
		if (id === value.primary) return;
		props.onChange(
			value.also.includes(id)
				? { ...value, also: value.also.filter((x) => x !== id) }
				: { ...value, also: [...value.also, id] },
		);
	};
	const primary = (id: number) => props.onChange(makePrimary(value, id));

	const onKeyDown = (e: KeyboardEvent) => {
		if (e.key === "Escape") {
			if (!open) return;
			e.preventDefault();
			e.stopPropagation();
			setOpen(false);
		} else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			if (!open) return setOpen(true);
			if (shown.length === 0) return;
			const step = e.key === "ArrowDown" ? 1 : -1;
			setActive((active + step + shown.length) % shown.length);
		} else if (e.key === "Enter") {
			// Not a submit; picks the highlighted layer and keeps the list open for the next.
			e.preventDefault();
			const l = shown[active];
			if (open && l) toggle(l.id);
		}
	};

	const chip = (id: number) => {
		const l = byId.get(id);
		const name = l?.name ?? props.otherNames.get(id) ?? unknownName;
		const isPrimary = id === value.primary;
		return (
			<span
				key={id}
				class={`chip layer-chip ${isPrimary ? "primary" : ""}`}
				title={
					isPrimary
						? "Primary layer: sets the colour and style, and who can edit"
						: undefined
				}
			>
				{l ? <Banner dye={l.color} /> : null}
				<span class="layer-chip-name">{name}</span>
				{isPrimary && <span class="badge">primary</span>}
				{!isPrimary && l && (
					<button
						type="button"
						class="plain layer-chip-remove"
						aria-label={`Remove ${name}`}
						onClick={() => toggle(id)}
					>
						×
					</button>
				)}
			</span>
		);
	};

	return (
		<div class="layers-picker" ref={root}>
			<div class="layer-chips">{[value.primary, ...value.also].map(chip)}</div>
			<div class="layer-search">
				<input
					type="text"
					role="combobox"
					aria-label="Search layers"
					aria-expanded={open}
					aria-controls={listId}
					aria-autocomplete="list"
					aria-activedescendant={
						open && shown.length > 0 ? `${listId}-${active}` : undefined
					}
					autocomplete="off"
					spellcheck={false}
					value={text}
					placeholder="Search layers"
					onFocus={() => setOpen(true)}
					onInput={(e) => {
						setText(e.currentTarget.value);
						setOpen(true);
					}}
					onKeyDown={onKeyDown}
				/>
				{open && (
					<div
						class="layer-options"
						role="listbox"
						aria-multiselectable="true"
						id={listId}
					>
						{shown.map((l, i) => {
							const on = picked(l.id);
							return (
								<div
									key={l.id}
									id={`${listId}-${i}`}
									role="option"
									tabIndex={-1}
									aria-selected={on}
									class={`layer-option ${i === active ? "active" : ""} ${on ? "picked" : ""}`}
									onPointerDown={(e) => e.preventDefault()}
									onMouseEnter={() => setActive(i)}
									onClick={() => toggle(l.id)}
									onKeyDown={(e) => {
										if (e.key === "Enter") toggle(l.id);
									}}
								>
									<span class="layer-option-mark">{on ? "✓" : ""}</span>
									<Banner dye={l.color} />
									<span class="layer-option-name">{l.name}</span>
									{l.id === value.primary && <span class="badge">primary</span>}
									{on &&
										l.id !== value.primary &&
										props.primaryOptions.includes(l.id) && (
											<button
												type="button"
												class="plain link"
												onClick={(e) => {
													e.stopPropagation();
													primary(l.id);
												}}
											>
												make primary
											</button>
										)}
								</div>
							);
						})}
						{shown.length === 0 && (
							<div class="layer-option-note muted">No layers match.</div>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
