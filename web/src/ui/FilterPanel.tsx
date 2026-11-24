import { Panel, Segmented, Toggle } from "@aomc-server/block-ui";
import {
	type AgeUnit,
	MAX_FILTER_LENGTH,
} from "@blockmap/shared/featureFilter";
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import {
	activeFilter,
	clearFilter,
	filterCounts,
	filterError,
	filterIsShared,
	filterText,
	setFilterText,
} from "../filter";
import { FILTER_EXAMPLES, FILTER_FIELDS } from "../filterHelp";
import {
	EDITED_UNITS,
	type Edited,
	PLAYER_MODES,
	type PlayerMode,
	PRESENCES,
	type Presence,
	readColour,
	readEdited,
	readHas,
	readPlayers,
	readTypes,
	readUnnamed,
	TYPE_VALUES,
	writeColour,
	writeEdited,
	writeHas,
	writePlayers,
	writeTypes,
	writeUnnamed,
} from "../filterQuick";
import { panelResize } from "../settings";
import { sidePanel } from "../state";
import { DyePicker } from "./DyePicker";
import { PlayerSearch } from "./PlayerPicker";

const TYPE_NAMES = { pin: "Pins", line: "Lines", area: "Areas" } as const;
const PLAYER_MODE_NAMES: Record<PlayerMode, string> = {
	either: "Either",
	owner: "Owner",
	builder: "Builder",
};

/** Why a control is switched off. While the text is broken the error above says it. */
const customHint = () =>
	filterError.value ? undefined : "Set in the text above.";

/** One quick control with its title; it is disabled, with a hint, when the text sets that field in a way it can't show. */
function Quick(props: {
	title: string;
	custom: boolean;
	children: ComponentChildren;
}) {
	return (
		<fieldset class="filter-quick" disabled={props.custom}>
			<legend class="section-title">{props.title}</legend>
			{props.children}
			{props.custom && !filterError.value && <p class="hint">{customHint()}</p>}
		</fieldset>
	);
}

function TypeControl(props: { text: string }) {
	const { text } = props;
	const types = readTypes(text);
	const chosen = types === "custom" ? [] : types;
	return (
		<Quick title="Type" custom={types === "custom"}>
			<div class="group">
				{TYPE_VALUES.map((t) => {
					const on = chosen.includes(t);
					return (
						<button
							key={t}
							type="button"
							class={`btn small ${on ? "active" : ""}`}
							aria-pressed={on}
							onClick={() =>
								setFilterText(
									writeTypes(
										text,
										on ? chosen.filter((x) => x !== t) : [...chosen, t],
									),
								)
							}
						>
							{TYPE_NAMES[t]}
						</button>
					);
				})}
			</div>
		</Quick>
	);
}

function PlayerControl(props: { text: string }) {
	const { text } = props;
	const players = readPlayers(text);
	// Without names there is nothing in the text to say which field they go to.
	const [chosenMode, setChosenMode] = useState<PlayerMode>("either");
	const names = players === "custom" ? [] : players.names;
	const mode =
		players !== "custom" && names.length > 0 ? players.mode : chosenMode;
	return (
		<Quick title="Player" custom={players === "custom"}>
			<Segmented
				small
				label="Player's role"
				value={mode}
				options={PLAYER_MODES}
				names={PLAYER_MODE_NAMES}
				onChange={(m) => {
					setChosenMode(m);
					if (names.length > 0) setFilterText(writePlayers(text, m, names));
				}}
			/>
			{names.length > 0 && (
				<div class="player-chips">
					{names.map((name) => (
						<span key={name} class="chip player-chip">
							<span class="player-chip-name">{name}</span>
							<button
								type="button"
								class="plain player-chip-remove"
								aria-label={`Remove ${name}`}
								onClick={() =>
									setFilterText(
										writePlayers(
											text,
											mode,
											names.filter((n) => n !== name),
										),
									)
								}
							>
								×
							</button>
						</span>
					))}
				</div>
			)}
			<PlayerSearch
				label="Add a player to filter by"
				placeholder="Search players"
				allowNew={false}
				onPick={(p) => {
					if (names.some((n) => n.toLowerCase() === p.name.toLowerCase()))
						return;
					setFilterText(writePlayers(text, mode, [...names, p.name]));
				}}
			/>
			<p class="hint">
				The owner is who the feature belongs to; builders are the players
				credited with building it.
			</p>
		</Quick>
	);
}

function ColourControl(props: { text: string }) {
	const { text } = props;
	const colour = readColour(text);
	return (
		<Quick title="Colour" custom={colour === "custom"}>
			<DyePicker
				label="Colour"
				value={colour === "custom" ? null : colour}
				onChange={(d) => setFilterText(writeColour(text, d))}
			/>
			<div class="filter-quick-foot">
				<span class="hint">The feature's own colour, or its layer's.</span>
				<button
					type="button"
					class="plain link"
					disabled={colour === null}
					onClick={() => setFilterText(writeColour(text, null))}
				>
					Any colour
				</button>
			</div>
		</Quick>
	);
}

function PresenceControl(props: {
	title: string;
	names: Record<Presence, string>;
	value: Presence | "custom";
	onChange: (p: Presence) => void;
}) {
	return (
		<Quick title={props.title} custom={props.value === "custom"}>
			<Segmented
				small
				label={props.title}
				value={props.value === "custom" ? "any" : props.value}
				options={PRESENCES}
				names={props.names}
				onChange={props.onChange}
			/>
		</Quick>
	);
}

function DetailControls(props: { text: string }) {
	const { text } = props;
	const unnamed = readUnnamed(text);
	return (
		<>
			<PresenceControl
				title="Owner"
				names={{ any: "Any", some: "Has one", none: "None" }}
				value={readHas(text, "owner")}
				onChange={(p) => setFilterText(writeHas(text, "owner", p))}
			/>
			<PresenceControl
				title="Builders"
				names={{ any: "Any", some: "Some", none: "None" }}
				value={readHas(text, "builders")}
				onChange={(p) => setFilterText(writeHas(text, "builders", p))}
			/>
			<h4 class="section-title">Details</h4>
			<Toggle
				inline
				checked={unnamed === true}
				disabled={unnamed === "custom"}
				onChange={(on) => setFilterText(writeUnnamed(text, on))}
				label="Unnamed"
				hint={unnamed === "custom" ? customHint() : undefined}
			/>
		</>
	);
}

function EditedControl(props: { text: string }) {
	const { text } = props;
	const edited = readEdited(text);
	const shown = edited === "custom" ? null : edited;
	// The choices made while no number is typed, so they apply once one is.
	const [unit, setUnit] = useState<AgeUnit>("d");
	const [neg, setNeg] = useState(false);
	const current = { neg: shown?.neg ?? neg, unit: shown?.unit ?? unit };
	const write = (next: Edited | null) => setFilterText(writeEdited(text, next));
	return (
		<Quick title="Edited" custom={edited === "custom"}>
			<div class="toolbar filter-edited">
				<select
					aria-label="Edited within, or not"
					value={current.neg ? "not" : "within"}
					onChange={(e) => {
						const not = e.currentTarget.value === "not";
						setNeg(not);
						if (shown) write({ ...shown, neg: not });
					}}
				>
					<option value="within">within</option>
					<option value="not">not within</option>
				</select>
				<input
					type="number"
					min={1}
					step={1}
					inputMode="numeric"
					aria-label="How long ago"
					placeholder="any"
					value={shown?.n ?? ""}
					onInput={(e) => {
						const n = Number(e.currentTarget.value);
						write(Number.isInteger(n) && n > 0 ? { ...current, n } : null);
					}}
				/>
				<select
					aria-label="Unit of time"
					value={current.unit}
					onChange={(e) => {
						const next = e.currentTarget.value as AgeUnit;
						setUnit(next);
						if (shown) write({ ...shown, unit: next });
					}}
				>
					{EDITED_UNITS.map((u) => (
						<option key={u.unit} value={u.unit}>
							{u.name}
						</option>
					))}
				</select>
				{shown && (
					<button type="button" class="plain link" onClick={() => write(null)}>
						Any time
					</button>
				)}
			</div>
		</Quick>
	);
}

function Help() {
	return (
		<details class="filter-help">
			<summary>Help: what you can search for</summary>
			<dl class="filter-fields">
				{FILTER_FIELDS.map((f) => (
					<div key={f.term}>
						<dt>
							<code>{f.term}</code>
						</dt>
						<dd>{f.text}</dd>
					</div>
				))}
			</dl>
			<h4 class="section-title">Examples</h4>
			<ul class="filter-examples">
				{FILTER_EXAMPLES.map((e) => (
					<li key={e.text}>
						<button
							type="button"
							class="plain link"
							title="Use this filter"
							onClick={() => setFilterText(e.text)}
						>
							<code>{e.text}</code>
						</button>
						<span class="hint">{e.note}</span>
					</li>
				))}
			</ul>
		</details>
	);
}

/** Picks which features the map shows: a search-style text, and quick controls that edit the same text. */
export function FilterPanel() {
	const text = filterText.value;
	const error = filterError.value;
	const { shown, total } = filterCounts.value;

	return (
		<Panel
			title="Filter"
			resize={panelResize}
			onClose={() => (sidePanel.value = null)}
		>
			<div class="filter-tools">
				<div class="filter-row">
					<input
						type="text"
						class="filter-input"
						value={text}
						maxLength={MAX_FILTER_LENGTH}
						placeholder="Filter features, e.g. type:area player:Notch"
						aria-label="Filter features"
						aria-invalid={error !== null}
						autocomplete="off"
						autocapitalize="off"
						spellcheck={false}
						onInput={(e) => setFilterText(e.currentTarget.value)}
						onKeyDown={(e) => {
							if (e.key !== "Escape") return;
							if (text) {
								e.stopPropagation();
								clearFilter();
							} else e.currentTarget.blur();
						}}
					/>
					<button
						type="button"
						class="btn small"
						disabled={text === ""}
						onClick={clearFilter}
					>
						Clear
					</button>
				</div>
				{error && (
					<p class="error-text" role="alert">
						{error.error} (character {error.at + 1})
					</p>
				)}
				<p
					class="hint"
					title="Counts the features in the layers that are switched on"
				>
					Showing {shown} of {total} feature{total === 1 ? "" : "s"}
					{error &&
						activeFilter.value &&
						" · The last valid filter still applies"}
				</p>
				{filterIsShared.value && (
					<p class="hint">
						This filter comes from a link. Change it and it becomes your own,
						replacing the one you saved.
					</p>
				)}
			</div>
			<TypeControl text={text} />
			<PlayerControl text={text} />
			<ColourControl text={text} />
			<DetailControls text={text} />
			<EditedControl text={text} />
			<Help />
		</Panel>
	);
}
