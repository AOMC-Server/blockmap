import { Panel } from "@aomc-server/block-ui";
import type { Dye } from "@blockmap/shared/colors";
import { curveOf, resolveStyle } from "@blockmap/shared/featureStyle";
import {
	cleanStyle,
	type FeatureInput,
	type FeatureStyle,
	type FeatureType,
	MAX_NAME,
	MAX_POPUP,
} from "@blockmap/shared/features";
import { MAX_BUILDERS, type Player } from "@blockmap/shared/players";
import { useEffect, useRef, useState } from "preact/hooks";
import { showNotice } from "../api";
import { pathsOf, TYPE_LABEL } from "../featureInfo";
import { createFeature, deleteFeature, updateFeature } from "../layers";
import { panelResize } from "../settings";
import {
	draftLook,
	editor,
	isLayerFull,
	isLayerHidden,
	lastEditLayer,
	layersData,
	popup,
	setLayersHidden,
} from "../state";
import {
	type DrawState,
	drawing,
	drawnGeometry,
	drawReady,
	finishDraw,
	minPoints,
	resumeDraw,
	setDrawType,
	startDraw,
	stopDraw,
	undoPoint,
} from "../tools/draw";
import { DyePicker } from "./DyePicker";
import { Banner } from "./icons";
import { LayersPicker } from "./LayersPicker";
import { BuildersPicker, OwnerPicker } from "./PlayerPicker";
import { PointsList, ShapeStats } from "./PointsList";
import { StyleControls } from "./StyleControls";

const TYPES: FeatureType[] = ["pin", "line", "polygon"];

const closeEditor = () => {
	stopDraw();
	editor.value = null;
};

function drawHint(d: DrawState | null, type: FeatureType): string {
	const mode = d?.mode ?? "draw";
	const count = d?.points.length ?? 0;
	if (type === "pin")
		return mode === "placed"
			? "Drag the marker to move it, or enter coordinates below."
			: "Click the map to place the pin.";
	if (type === "line") {
		if (mode === "placed")
			return "Drag a point to move it (drop onto another point to merge), or drag a + handle to insert a point. Click a point to continue drawing or branch from it. Right-click a point to delete it.";
		if (count === 0)
			return "Click the map to start drawing. Hold Shift to snap to 45° angles.";
		if (d?.selected === null)
			return "Click an existing point to continue from it, or click the map to start a separate segment.";
		return "Click to add points. Click another point to connect to it, or click the selected point (or press Enter/Esc) to finish. Hold Shift to snap to 45° angles.";
	}
	if (mode === "placed")
		return "Drag a point to move it, or drag a + handle on an edge to insert a point. Right-click a point to delete it.";
	const need = minPoints(type);
	if (count < need)
		return `Click the map to add points (${count}/${need} minimum). Hold Shift to snap to 45° angles.`;
	return "Click to add more points. Click the first point or press Enter/Esc to close the shape.";
}

/** Side panel for creating or editing one feature. Geometry is placed on the map with the draw tool. */
export function FeatureEditor() {
	const target = editor.value;
	const layer = layersData.value.find((l) => l.id === target?.layerId);
	const existing =
		target?.mode === "edit"
			? layer?.features.find((f) => f.id === target.featureId)
			: undefined;

	const shape = target?.mode === "create" ? target.shape : undefined;
	// The primary layer the feature is going to; `layer` stays the one it is in now.
	const [destId, setDestId] = useState(target?.layerId);
	const dest = layersData.value.find((l) => l.id === destId) ?? layer;

	const [type, setType] = useState<FeatureType>(
		existing?.type ?? shape?.type ?? "pin",
	);
	const [name, setName] = useState(existing?.name ?? "");
	const [text, setText] = useState(existing?.popup ?? "");
	const [color, setColor] = useState<Dye | null>(existing?.color ?? null);
	const [style, setStyle] = useState<FeatureStyle>(existing?.style ?? {});
	const [owner, setOwner] = useState<Player | null>(existing?.owner ?? null);
	const [builders, setBuilders] = useState<Player[]>(existing?.builders ?? []);
	const [alsoIn, setAlsoIn] = useState<number[]>(existing?.alsoIn ?? []);
	const [saving, setSaving] = useState(false);
	// The revision the edit is based on; moves forward only when a conflict is reported.
	const [baseRevision, setBaseRevision] = useState<number | undefined>(
		existing?.revisionId,
	);
	const popupField = useRef<HTMLTextAreaElement>(null);

	const cancelEditing = () => {
		editor.value = null;
	};

	useEffect(() => {
		const at = target?.mode === "create" ? target.at : undefined;
		startDraw(
			existing?.type ?? shape?.type ?? "pin",
			existing ? pathsOf(existing) : shape ? shape.paths : at ? [[at]] : [],
			cancelEditing,
		);
		return () => stopDraw();
	}, []);

	// What the map previews while editing.
	useEffect(() => {
		const own = type === "pin" ? null : cleanStyle(style);
		draftLook.value = {
			color,
			style: own,
			curve:
				type === "pin"
					? null
					: curveOf(resolveStyle(own, type === "polygon", dest?.style)),
		};
		return () => {
			draftLook.value = null;
		};
	}, [color, style, type, dest?.style]);

	if (!target || !layer) return null;
	const d = drawing.value;
	const points = d?.points ?? [];
	const ready = !!d && drawReady(d);
	const homeId = dest?.id ?? layer.id;
	// The layers that can be picked: ones that can be edited and have room, or are picked already.
	const options = layersData.value.filter(
		(l) =>
			l.canEdit &&
			(l.id === layer.id ||
				l.id === homeId ||
				alsoIn.includes(l.id) ||
				!isLayerFull(l)),
	);
	const primaryOptions = options
		.filter((l) => l.id === layer.id || !isLayerFull(l))
		.map((l) => l.id);
	// Layers the feature is shown in that cannot be picked here are kept as they are.
	const otherNames = new Map(
		alsoIn.flatMap((id) => {
			const l = layersData.value.find((x) => x.id === id);
			return l ? [[id, l.name] as const] : [];
		}),
	);
	const pick = {
		primary: homeId,
		also: alsoIn.filter((id) => id !== homeId),
	};
	const moving = target.mode === "edit" && dest && dest.id !== layer.id;

	const changeType = (next: FeatureType) => {
		setType(next);
		setDrawType(next);
	};

	/** `another`: stay in the editor with a blank feature (same type and colour) for the next one. */
	const save = async (another = false) => {
		if (!ready || saving) return;
		if (!d) return;
		const input = {
			name: name.trim(),
			popup: text,
			color,
			type,
			style: type === "pin" ? null : cleanStyle(style),
			geometry: drawnGeometry(d),
			owner: owner?.id ?? null,
			builders: builders.map((b) => b.id),
			alsoIn: alsoIn.filter((id) => id !== homeId),
		} as FeatureInput;
		setSaving(true);
		let saved = false;
		try {
			if (target.mode === "create") {
				saved = (await createFeature(homeId, input)) !== null;
			} else {
				const out = await updateFeature(
					target.featureId,
					moving && dest ? { ...input, layerId: dest.id } : input,
					baseRevision,
				);
				saved = out.saved;
				if (!out.saved && out.conflict)
					setBaseRevision(out.conflict.revisionId);
			}
		} finally {
			setSaving(false);
		}
		if (!saved) return;
		const finalLayer = dest ?? layer;
		lastEditLayer.value = finalLayer.id;
		if (finalLayer !== layer && isLayerHidden(finalLayer))
			setLayersHidden([finalLayer], false);
		if (another && target.mode === "create") {
			setName("");
			setText("");
			startDraw(type, [], cancelEditing);
			showNotice("Feature added.");
			return;
		}
		closeEditor();
		popup.value = null;
	};

	/** Puts the selected popup text between `before` and `after` (or a placeholder if nothing is selected). */
	const wrapSelection = (
		before: string,
		after: string,
		placeholder: string,
	) => {
		const el = popupField.current;
		if (!el) return;
		const from = el.selectionStart;
		const to = el.selectionEnd;
		const selected = text.slice(from, to) || placeholder;
		const next =
			text.slice(0, from) + before + selected + after + text.slice(to);
		if (next.length > MAX_POPUP) return;
		setText(next);
		requestAnimationFrame(() => {
			el.focus();
			el.setSelectionRange(
				from + before.length,
				from + before.length + selected.length,
			);
		});
	};

	const remove = async () => {
		if (target.mode !== "edit" || !confirm("Delete this feature?")) return;
		if (await deleteFeature(target.featureId)) closeEditor();
	};

	return (
		<Panel
			resize={panelResize}
			title={target.mode === "create" ? "New feature" : "Edit feature"}
			onClose={closeEditor}
			closeText="Cancel"
			class="editor"
			footer={
				<>
					{target.mode === "edit" && (
						<button type="button" class="btn danger" onClick={remove}>
							Delete
						</button>
					)}
					<span class="spacer" />
					{target.mode === "create" && (
						<button
							type="button"
							class="btn"
							disabled={!ready || saving}
							title="Save this feature and start a new one in the same layer"
							onClick={() => save(true)}
						>
							Save & add another
						</button>
					)}
					<button
						type="button"
						class="btn primary"
						disabled={!ready || saving}
						onClick={() => save()}
					>
						{saving ? "Saving…" : "Save"}
					</button>
				</>
			}
		>
			{options.length > 1 || alsoIn.length > 0 ? (
				<div class="field flow editor-layer-pick">
					<span class="label">Layers</span>
					<LayersPicker
						options={options}
						primaryOptions={primaryOptions}
						otherNames={otherNames}
						value={pick}
						onChange={(next) => {
							setAlsoIn(next.also);
							if (next.primary === homeId) return;
							setDestId(next.primary);
							const to = layersData.value.find((l) => l.id === next.primary);
							if (to && target.mode === "create" && isLayerHidden(to))
								setLayersHidden([to], false);
						}}
					/>
				</div>
			) : (
				<p class="editor-layer">
					<Banner dye={layer.color} /> {layer.name}
				</p>
			)}

			<div class="field flow">
				<span class="label">Type</span>
				<div class="segmented">
					{TYPES.map((t) => (
						<button
							key={t}
							type="button"
							class={`btn ${type === t ? "active" : ""}`}
							aria-pressed={type === t}
							onClick={() => changeType(t)}
						>
							{TYPE_LABEL[t]}
						</button>
					))}
				</div>
			</div>

			<div class="field flow draw-controls">
				<span class="label">Location</span>
				<p class="hint">{drawHint(d, type)}</p>
				<ShapeStats />
				<div class="group">
					{d?.mode === "draw" && type !== "pin" && (
						<button
							type="button"
							class="btn small"
							disabled={!ready}
							onClick={() => finishDraw()}
						>
							Finish
						</button>
					)}
					{d?.mode === "placed" && (
						<button type="button" class="btn small" onClick={resumeDraw}>
							{type === "pin" ? "Place again" : "Add points"}
						</button>
					)}
					{type !== "pin" && points.length > 0 && (
						<button type="button" class="btn small" onClick={undoPoint}>
							{d?.selected != null
								? `Remove point ${d.selected + 1}`
								: "Undo last"}
						</button>
					)}
				</div>
				<PointsList />
			</div>

			<label class="field flow">
				<span class="label">Name</span>
				<input
					type="text"
					value={name}
					maxLength={MAX_NAME}
					onInput={(e) => setName(e.currentTarget.value)}
					placeholder="Shown on hover"
				/>
			</label>

			<div class="field flow">
				<span class="label">
					Popup{" "}
					<small>
						({text.length}/{MAX_POPUP})
					</small>
				</span>
				<div class="format-bar">
					<button
						type="button"
						class="btn small"
						title="Bold (Ctrl+B)"
						onClick={() => wrapSelection("**", "**", "bold text")}
					>
						<b>B</b>
					</button>
					<button
						type="button"
						class="btn small"
						title="Insert link"
						onClick={() => wrapSelection("[", "](https://)", "link text")}
					>
						Link
					</button>
				</div>
				<textarea
					ref={popupField}
					rows={4}
					value={text}
					maxLength={MAX_POPUP}
					aria-label="Popup text"
					onInput={(e) => setText(e.currentTarget.value)}
					onKeyDown={(e) => {
						if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
							e.preventDefault();
							wrapSelection("**", "**", "bold text");
						}
					}}
					placeholder="Supports **bold** and [links](https://example.com)"
				/>
			</div>

			<div class="field flow">
				<span class="label">Owner</span>
				<OwnerPicker
					value={owner}
					onChange={(next) => {
						setOwner(next);
						if (next && !builders.some((b) => b.id === next.id))
							setBuilders([next, ...builders]);
					}}
				/>
			</div>

			<div class="field flow">
				<span class="label">
					Builders{" "}
					<small>
						({builders.length}/{MAX_BUILDERS})
					</small>
				</span>
				<BuildersPicker value={builders} onChange={setBuilders} />
			</div>

			{type !== "pin" && (
				<div class="field flow">
					<span class="label">Style</span>
					<StyleControls
						kind={type}
						style={style}
						inherited={dest?.style ?? layer.style}
						color={color ?? dest?.color ?? layer.color}
						onChange={setStyle}
					/>
				</div>
			)}

			<div class="field flow">
				<span class="label">Colour</span>
				<DyePicker
					label="Colour"
					value={color}
					fallback={dest?.color ?? layer.color}
					onChange={setColor}
				/>
			</div>
		</Panel>
	);
}
