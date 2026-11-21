import "@aomc-server/block-ui/css";
import {
	initToggleDrag,
	installFontScale,
	Toasts,
} from "@aomc-server/block-ui";
import {
	applyAppearance,
	prefersLight,
	resolveMode,
} from "@aomc-server/block-ui/theme";
import { effect } from "@preact/signals";
import { render } from "preact";
import { settings } from "./settings";
import { currentDimensionTheme, currentMap, dimSlug } from "./state";
import { savePalette } from "./theme";
import { App } from "./ui/App";
import { FilesPage } from "./ui/FilesPage";
import { InvitePage, inviteTokenFromPath } from "./ui/InvitePage";
import { ManagePage } from "./ui/ManagePage";
import { PrivacyPage } from "./ui/PrivacyPage";
import { SettingsPage } from "./ui/SettingsPage";
import { StatsPage } from "./ui/StatsPage";
import "./styles.css";

initToggleDrag();
// Browser zoom changes the pixel ratio, so keep the pixel font of the headings crisp as it changes.
installFontScale();

const inviteToken = inviteTokenFromPath(location.pathname);
const path = location.pathname.replace(/\/+$/, "");
const onFiles = path === "/files" || path.startsWith("/files/");
const onMap =
	!inviteToken &&
	!onFiles &&
	path !== "/settings" &&
	path !== "/manage" &&
	path !== "/stats" &&
	path !== "/privacy";

effect(() => {
	const s = settings.value;
	const dim = onMap ? dimSlug.value : null;
	// Only the map follows a dimension; the other pages use the overworld colours.
	const palette =
		dim && s.dimensionColours ? currentDimensionTheme.value : "overworld";
	applyAppearance({
		mode: resolveMode(s.mode, prefersLight.value),
		palette,
		style: s.style,
	});
	if (dim && currentMap.value) savePalette({ dim, palette });
});

// The server puts the map's name in the title; follow it when an owner renames the map.
effect(() => {
	const name = currentMap.value?.map.name.trim();
	if (name) document.title = name;
});

render(
	<>
		{inviteToken ? (
			<InvitePage token={inviteToken} />
		) : path === "/settings" ? (
			<SettingsPage />
		) : path === "/manage" ? (
			<ManagePage />
		) : path === "/stats" ? (
			<StatsPage />
		) : path === "/privacy" ? (
			<PrivacyPage />
		) : onFiles ? (
			<FilesPage />
		) : (
			<App />
		)}
		<Toasts />
	</>,
	document.getElementById("app") as HTMLElement,
);
