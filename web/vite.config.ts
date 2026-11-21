import { prepaintScript } from "@aomc-server/block-ui/theme";
import preact from "@preact/preset-vite";
import { defineConfig } from "vite";
import { prepaint } from "./src/prepaint";

const backend = process.env.BACKEND_URL ?? "http://localhost:3000";

export default defineConfig({
	plugins: [
		preact(),
		{
			// Applies the saved look before the first paint (see src/prepaint.ts).
			name: "prepaint",
			transformIndexHtml: () => [
				{
					tag: "script",
					injectTo: "head-prepend",
					children: prepaintScript(prepaint),
				},
			],
		},
	],
	// The library ships TS source and takes its preact from here: there must be one copy.
	resolve: { dedupe: ["preact", "@preact/signals"] },
	server: {
		proxy: {
			"/api": backend,
			"/blobs": backend,
			"^/map/": backend,
			"/auth": backend,
			"/scalar": backend,
			// Files are downloaded from the server; folders (ending in /) are pages of the app.
			"/files": {
				target: backend,
				bypass: (req) => {
					const path = req.url?.split("?")[0] ?? "";
					return path === "/files" || path.endsWith("/")
						? "/index.html"
						: undefined;
				},
			},
		},
	},
});
