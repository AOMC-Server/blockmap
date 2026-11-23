import { lookupHeadUrl, playerHeadUrl, playerPageUrl } from "../players";

/** The face of a player (an 8x8 picture, scaled up without smoothing). */
export function PlayerHead(props: {
	player: { id: number; name: string };
	size?: number;
}) {
	const size = props.size ?? 20;
	return (
		<img
			class="player-head"
			src={playerHeadUrl(props.player.id)}
			alt={props.player.name}
			title={props.player.name}
			width={size}
			height={size}
		/>
	);
}

/** The face of a Minecraft account the map does not have yet. */
export function LookupHead(props: {
	uuid: string;
	name: string;
	size?: number;
}) {
	const size = props.size ?? 20;
	return (
		<img
			class="player-head"
			src={lookupHeadUrl(props.uuid)}
			alt={props.name}
			title={props.name}
			width={size}
			height={size}
		/>
	);
}

/** A player's head and name, as a link to their page. */
export function PlayerLink(props: {
	player: { id: number; name: string };
	size?: number;
	newTab?: boolean;
}) {
	return (
		<a
			class="player-link"
			href={playerPageUrl(props.player)}
			target={props.newTab ? "_blank" : undefined}
			rel={props.newTab ? "noopener" : undefined}
		>
			<PlayerHead player={props.player} size={props.size} />
			<span class="player-link-name">{props.player.name}</span>
		</a>
	);
}
