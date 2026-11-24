/** The filter language as the help in the filter panel explains it. */

export const FILTER_FIELDS: readonly { term: string; text: string }[] = [
	{
		term: "word",
		text: "In the name, description, a player's name, the type (pin, line, area) or a layer's name. “quotes” match a phrase.",
	},
	{ term: "type:pin,line,area", text: "Only these kinds of feature." },
	{
		term: "player: owner: builder:",
		text: "A player's name: the owner or a builder, only the owner, only a builder.",
	},
	{
		term: "color:red",
		text: "The feature's own colour, or its layer's if it has none.",
	},
	{ term: "layer:Bases", text: "In a layer with this name." },
	{
		term: "has:owner,builders,name,description",
		text: "Has an owner, builders, a name or a description.",
	},
	{
		term: "edited:30d",
		text: "Edited in the last 30 days: min, h, d, w, m or y for minutes, hours, days, weeks, months, years.",
	},
	{
		term: "area>5000",
		text: "Areas bigger (>) or smaller (<) than this, in blocks².",
	},
	{
		term: "- ,",
		text: "- in front of a term means not; a comma lists alternatives in one field (color:red,blue).",
	},
];

export const FILTER_EXAMPLES: readonly { text: string; note: string }[] = [
	{ text: "type:area -has:owner", note: "Unclaimed areas" },
	{ text: "type:area -has:builders", note: "Areas nobody built" },
	{ text: "type:pin -has:name", note: "Unnamed pins" },
	{ text: "type:pin edited:30d", note: "Pins edited this month" },
	{ text: "edited:2h", note: "Changed in the last two hours" },
	{ text: "area>5000", note: "Big areas" },
	{
		text: "area<500",
		note: "Small areas (-area>500 would keep pins and lines too)",
	},
	{ text: "type:line color:red,blue", note: "Red or blue lines" },
	{ text: "has:owner -edited:1y", note: "Stale claims" },
	{ text: "player:Steve", note: "Someone's builds" },
	{ text: "-layer:Bases", note: "Not in the Bases layer" },
];
