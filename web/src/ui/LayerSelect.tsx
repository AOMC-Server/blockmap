import { PreviewSelect } from "@aomc-server/block-ui";
import type { Dye } from "@blockmap/shared/colors";
import { dyeScope } from "../theme";
import { Banner } from "./icons";

export type LayerOption = { id: number; name: string; color: Dye };

/** A drop-down list of layers, each with its coloured banner. */
export function LayerSelect(props: {
	options: LayerOption[];
	value: number;
	onChange: (id: number) => void;
}) {
	return (
		<PreviewSelect
			label="Layer"
			value={props.value}
			onChange={props.onChange}
			options={props.options.map((l) => ({
				value: l.id,
				label: l.name,
				scope: dyeScope(l.color),
				preview: <Banner dye={l.color} size={24} />,
			}))}
		/>
	);
}
