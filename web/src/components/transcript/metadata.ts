export type MessageMetadataPart = { type: "text"; text: string } | { type: "metadata"; tag: string; text: string };

// These are emitted by OMP's IRC, steering, notification and task-result paths.
// Other system-* tags can be ordinary prompt prose, not transcript metadata.
const METADATA_TAGS =
	"irc|system-notice|system-reminder|system-notification|system-injection|system-interrupt|task-result";
const TAG = new RegExp(`^<(\\/?)(?:${METADATA_TAGS})(?=[\\s>])`);
const OPEN_TAG = new RegExp(
	`^<(${METADATA_TAGS})(?:\\s+[A-Za-z_:][\\w:.-]*\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s"'=<>\x60]+))*\\s*>$`,
);
const CLOSE_TAG = new RegExp(`^<\\/(${METADATA_TAGS})\\s*>$`);
const FENCE_PREFIX = String.raw`(?:(?:[ \t]*>)|(?:[ \t]*(?:[-+*]|\d+[.)])(?=[ \t])))*[ \t]*`;

/** Split complete envelopes only; Markdown examples and incomplete input stay visible. */
export function splitMessageMetadata(text: string): MessageMetadataPart[] {
	const parts: MessageMetadataPart[] = [];
	const stack: string[] = [];
	let start = 0;
	let rootStart = 0;
	let valid = true;
	// Consume code before looking for tags, including variable-length code spans.
	// Generic tags are consumed whole so quoted attribute examples are not envelopes.
	const tokens = new RegExp(
		[
			String.raw`^${FENCE_PREFIX}(\x60{3,})[^\x60\r\n]*(?:\r?\n|$)`,
			String.raw`^${FENCE_PREFIX}(~{3,})[^\r\n]*(?:\r?\n|$)`,
			String.raw`^(?: {4}|\t)[^\r\n]*(?:\r?\n|$)|\x60+|\\[^\r\n]|<!--[\s\S]*?(?:-->|$)|<\/?[A-Za-z][\w:-]*(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>`,
		].join("|"),
		"gm",
	);
	let token: RegExpExecArray | null;
	while ((token = tokens.exec(text)) !== null) {
		const raw = token[0];
		const fence = token[1] ?? token[2];
		if (fence !== undefined) {
			const closing = new RegExp(`^${FENCE_PREFIX}${fence[0]}{${fence.length},}[ \\t]*\\r?$`, "gm");
			closing.lastIndex = tokens.lastIndex;
			const end = closing.exec(text);
			tokens.lastIndex = end === null ? text.length : closing.lastIndex;
			continue;
		}
		if (raw.startsWith("`")) {
			const closing = /`+/g;
			closing.lastIndex = tokens.lastIndex;
			let end: RegExpExecArray | null;
			while ((end = closing.exec(text)) !== null) {
				if (end[0].length !== raw.length) continue;
				tokens.lastIndex = closing.lastIndex;
				break;
			}
			continue;
		}
		if (!TAG.test(raw)) continue;
		const open = OPEN_TAG.exec(raw);
		if (open !== null) {
			if (stack.length === 0) {
				rootStart = token.index;
				valid = true;
			}
			stack.push(open[1]!);
			continue;
		}
		const close = CLOSE_TAG.exec(raw);
		if (close === null) {
			if (stack.length > 0) valid = false;
			continue;
		}
		if (stack.length === 0) continue;
		const matching = stack.lastIndexOf(close[1]!);
		if (matching === -1) {
			valid = false;
			continue;
		}
		if (matching !== stack.length - 1) valid = false;
		const rootTag = stack[0]!;
		stack.length = matching;
		if (stack.length !== 0 || !valid) continue;
		if (rootStart > start) parts.push({ type: "text", text: text.slice(start, rootStart) });
		parts.push({ type: "metadata", tag: rootTag, text: text.slice(rootStart, tokens.lastIndex) });
		start = tokens.lastIndex;
	}
	if (start < text.length) parts.push({ type: "text", text: text.slice(start) });
	return parts;
}
