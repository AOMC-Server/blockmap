import * as z from "zod/mini";

/** Longest name of a file or folder in the file library. */
export const MAX_FILE_NAME = 200;
export const MAX_FOLDER_DESCRIPTION = 2000;

/**
 * Why a file or folder name is unusable, or null when it is fine. Names are single path segments:
 * no slashes, no control characters, not "." or "..", and no spaces at either end.
 */
export function fileNameProblem(name: string): string | null {
	if (name.length === 0) return "the name is empty";
	if (name.length > MAX_FILE_NAME)
		return `the name is longer than ${MAX_FILE_NAME} characters`;
	if (name !== name.trim()) return "the name starts or ends with a space";
	if (name === "." || name === "..") return 'the name cannot be "." or ".."';
	if (/[/\\]/.test(name)) return "the name cannot contain / or \\";
	if (/\p{Cc}/u.test(name)) return "the name contains a control character";
	return null;
}

/** The name as stored: Unicode NFC, so names that look the same are the same. */
export const normalizeFileName = (name: string) => name.normalize("NFC");

/** Two names clash when they differ only in case (Windows and macOS would merge them). */
export const fileNameKey = (name: string) =>
	normalizeFileName(name).toLowerCase();

export const fileNameSchema = z
	.pipe(
		z.pipe(z.string(), z.transform(normalizeFileName)),
		z.string().check(
			z.superRefine((name, ctx) => {
				const problem = fileNameProblem(name);
				if (problem) ctx.addIssue({ code: "custom", message: problem });
			}),
		),
	)
	.check(
		z.describe(
			`Name, a single path segment of at most ${MAX_FILE_NAME} characters: no slashes or control characters, not \`.\` or \`..\`, and no spaces at either end`,
		),
	);

/** "world.zip" numbered: "world (2).zip". A leading dot is part of the name, not an extension. */
export function numberedFileName(name: string, n: number): string {
	const dot = name.lastIndexOf(".");
	return dot > 0
		? `${name.slice(0, dot)} (${n})${name.slice(dot)}`
		: `${name} (${n})`;
}

/**
 * What an upload does when the folder already has something of that name:
 * - fail: refuse it (409)
 * - replace: the file gets the new content, and keeps its link and download count
 * - rename: keep both; the new one is numbered, like "world (2).zip"
 */
export const FILE_CONFLICT_MODES = ["fail", "replace", "rename"] as const;
export type FileConflictMode = (typeof FILE_CONFLICT_MODES)[number];

/** A folder path, "/" for the top: names separated by slashes. */
export const filePathSchema = z._default(
	z.string().check(z.maxLength(4000)),
	"/",
);
const folderPathSchema = (what: string) =>
	filePathSchema.check(
		z.describe(
			`Path to the ${what}, as slash-separated names like \`/voxy/world\`; \`/\` (default) is the top`,
		),
	);

/** The names in a path such as "/voxy/world 1/"; empty for the top. */
export const splitFilePath = (path: string) =>
	path
		.split("/")
		.filter((s) => s !== "")
		.map(normalizeFileName);

/** The address a file or folder is downloaded or browsed at: /files/<names>, each encoded. */
export function fileUrl(names: readonly string[], folder = false): string {
	const encoded = names.map(encodeURIComponent).join("/");
	return `/files${encoded ? `/${encoded}` : ""}${folder ? "/" : ""}`;
}

export const fileTreeQuerySchema = z.object({
	path: folderPathSchema("folder to list (case-insensitive)"),
});

export const fileUploadQuerySchema = z.object({
	path: folderPathSchema(
		"folder to upload into, which must exist (case-insensitive)",
	),
	name: fileNameSchema.check(z.describe("Name of the file")),
	onConflict: z
		._default(z.enum(FILE_CONFLICT_MODES), "fail")
		.check(
			z.describe(
				"What to do when the folder already has an item with that name (case-insensitive): `fail` (default) answers 409, `replace` gives the existing file the new content, `rename` keeps both and numbers the new one",
			),
		),
});

const descriptionSchema = z
	.string()
	.check(z.trim(), z.maxLength(MAX_FOLDER_DESCRIPTION));
const folderDescription = descriptionSchema.check(
	z.describe(
		`Folder description, at most ${MAX_FOLDER_DESCRIPTION} characters, default empty`,
	),
);

export const createFileFolderSchema = z.object({
	parentId: z
		.nullable(z.int().check(z.positive()))
		.check(
			z.describe(
				"Id of the folder to create it in; `null` is the top of the library",
			),
		),
	name: fileNameSchema.check(z.describe("Name of the folder")),
	description: z._default(folderDescription, ""),
});

export const updateFileFolderSchema = z
	.object({
		name: z.optional(
			fileNameSchema.check(z.describe("New name of the folder")),
		),
		description: z.optional(
			descriptionSchema.check(
				z.describe(
					`New folder description, at most ${MAX_FOLDER_DESCRIPTION} characters`,
				),
			),
		),
		parentId: z.optional(
			z
				.nullable(z.int().check(z.positive()))
				.check(
					z.describe(
						"Id of the folder to move it into; `null` is the top of the library",
					),
				),
		),
	})
	.check(z.refine((o) => Object.keys(o).length > 0, "nothing to update"));

export const updateFileEntrySchema = z
	.object({
		name: z.optional(fileNameSchema.check(z.describe("New name of the file"))),
		folderId: z.optional(
			z
				.nullable(z.int().check(z.positive()))
				.check(
					z.describe(
						"Id of the folder to move it into; `null` is the top of the library",
					),
				),
		),
	})
	.check(z.refine((o) => Object.keys(o).length > 0, "nothing to update"));

export const fileGrantSchema = z.object({
	userId: z
		.string()
		.check(
			z.minLength(1),
			z.describe(
				"Id of the user to give access to the folder, who must have logged in at least once",
			),
		),
});
