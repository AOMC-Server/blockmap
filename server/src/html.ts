export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

export type PageMeta = {
	/** The map's name, for og:site_name. */
	siteName: string;
	title: string;
	description: string;
	url: string;
	/** Absolute URL of a preview image, or null for a text-only card. */
	image: string | null;
};

const tag = (attr: "name" | "property", key: string, value: string) =>
	`<meta ${attr}="${key}" content="${escapeHtml(value)}">`;

/** Sets the page title of index.html, escaped. */
export function injectTitle(html: string, title: string): string {
	return html.replace(
		/<title>[\s\S]*?<\/title>/i,
		() => `<title>${escapeHtml(title)}</title>`,
	);
}

/** Adds the title and Open Graph / Twitter tags to index.html. Every value is HTML-escaped. */
export function injectMeta(html: string, meta: PageMeta): string {
	const lines = [
		tag("name", "description", meta.description),
		tag("property", "og:site_name", meta.siteName),
		tag("property", "og:type", "website"),
		tag("property", "og:title", meta.title),
		tag("property", "og:description", meta.description),
		tag("property", "og:url", meta.url),
		tag("name", "twitter:card", meta.image ? "summary_large_image" : "summary"),
		tag("name", "twitter:title", meta.title),
		tag("name", "twitter:description", meta.description),
	];
	if (meta.image) {
		lines.push(
			tag("property", "og:image", meta.image),
			tag("property", "og:image:width", "1200"),
			tag("property", "og:image:height", "630"),
			tag("name", "twitter:image", meta.image),
		);
	}
	// Function replacers: the escaped text may contain "$&" and friends.
	return injectTitle(html, meta.title).replace(
		/<\/head>/i,
		() => `\t\t${lines.join("\n\t\t")}\n\t</head>`,
	);
}
