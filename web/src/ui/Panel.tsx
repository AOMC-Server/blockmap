import { Panel as BasePanel } from "@aomc-server/block-ui";
import type { ComponentProps } from "preact";
import { panelWidth } from "../settings";

/** The library's side panel, with the width that is kept in the settings (dragged at its left edge). */
export function Panel(props: Omit<ComponentProps<typeof BasePanel>, "resize">) {
	return (
		<BasePanel
			{...props}
			resize={{
				width: panelWidth.width.value,
				min: panelWidth.min,
				max: panelWidth.max(),
				onChange: panelWidth.set,
				onReset: panelWidth.reset,
			}}
		/>
	);
}
