import { decodeJson, InvalidJsonError } from "./decode";

/**
 * Incremental JSONL parsing for streamed subagent transcripts.
 *
 * Transcript bytes arrive in arbitrary chunks; the trailing partial line is
 * returned as `carry` and prepended to the next chunk by the caller.
 * Unparseable complete lines are skipped (tolerant decode).
 */
export function parseJsonl(text: string, carry: string): { items: unknown[]; carry: string } {
	const lines = (carry + text).split("\n");
	const nextCarry = lines.pop() ?? "";
	const items: unknown[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			items.push(decodeJson(trimmed, "Decode streamed transcript JSONL line"));
		} catch (error) {
			if (!(error instanceof InvalidJsonError)) throw error;
		}
	}
	return { items, carry: nextCarry };
}
