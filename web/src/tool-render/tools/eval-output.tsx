import type { ReactNode } from "react";
import { Markdown } from "../../components/transcript/Markdown";
import { Output } from "../parts";
import { isRecord } from "../util";

interface EvalTableColumn {
	head: string;
	numeric: boolean;
}

/** A pretty view of part of a cell's printed output (mirrors the tool's `EvalView`). */
type EvalView =
	| { kind: "table"; columns: EvalTableColumn[]; rows: string[][] }
	| { kind: "json"; value: unknown }
	| { kind: "markdown"; text: string };

export interface EvalViewEntry {
	text: string;
	view: EvalView;
}

type EvalOutputPart = { kind: "text"; text: string } | { kind: "view"; view: EvalView };

function viewOf(raw: unknown): EvalView | null {
	if (!isRecord(raw)) return null;
	switch (raw.kind) {
		case "table": {
			if (!Array.isArray(raw.columns) || !Array.isArray(raw.rows)) return null;
			const columns: EvalTableColumn[] = [];
			for (const col of raw.columns) {
				if (!isRecord(col) || typeof col.head !== "string") return null;
				columns.push({ head: col.head, numeric: col.numeric === true });
			}
			const rows: string[][] = [];
			for (const row of raw.rows) {
				if (!Array.isArray(row)) return null;
				rows.push(row.map(cell => (typeof cell === "string" ? cell : String(cell))));
			}
			return { kind: "table", columns, rows };
		}
		case "json":
			return "value" in raw ? { kind: "json", value: raw.value } : null;
		case "markdown":
			return typeof raw.text === "string" ? { kind: "markdown", text: raw.text } : null;
		default:
			return null;
	}
}

export function viewsOf(raw: unknown): EvalViewEntry[] {
	if (!Array.isArray(raw)) return [];
	const out: EvalViewEntry[] = [];
	for (const item of raw) {
		if (!isRecord(item) || typeof item.text !== "string") continue;
		const view = viewOf(item.view);
		if (view) out.push({ text: item.text, view });
	}
	return out;
}

/** Same split as pi-tui's `splitEvalOutput`: views in order via a moving `indexOf` cursor; unmatched skipped. */
function splitEvalOutput(output: string, views: readonly EvalViewEntry[]): EvalOutputPart[] {
	const parts: EvalOutputPart[] = [];
	const pushText = (chunk: string, trimStart: boolean, trimEnd: boolean): void => {
		let text = chunk;
		if (trimStart) text = text.replace(/^\n+/, "");
		if (trimEnd) text = text.replace(/\n+$/, "");
		if (text.trim().length > 0) parts.push({ kind: "text", text });
	};
	let cursor = 0;
	for (const entry of views) {
		if (!entry.text) continue;
		const at = output.indexOf(entry.text, cursor);
		if (at < 0) continue;
		pushText(output.slice(cursor, at), cursor > 0, true);
		parts.push({ kind: "view", view: entry.view });
		cursor = at + entry.text.length;
	}
	pushText(output.slice(cursor), cursor > 0, cursor > 0);
	return parts;
}

function jsonText(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

function ViewBlock({ view }: { view: EvalView }): ReactNode {
	switch (view.kind) {
		case "table":
			return (
				<div className="tr-md">
					<table>
						<thead>
							<tr>
								{view.columns.map((col, c) => (
									<th key={`h${c}`} style={col.numeric ? { textAlign: "right" } : undefined}>
										{col.head}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{view.rows.map((row, r) => (
								<tr key={`r${r}`}>
									{row.map((cell, c) => (
										<td key={`c${c}`} style={view.columns[c]?.numeric ? { textAlign: "right" } : undefined}>
											{cell}
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>
			);
		case "json":
			return <Output text={jsonText(view.value)} lang="json" variant="code" maxLines={12} />;
		case "markdown":
			return <Markdown text={view.text} />;
	}
}

export function CellOutput({ cell }: { cell: { output: string; status: string; views: EvalViewEntry[] } }): ReactNode {
	const error = cell.status === "error";
	const parts = splitEvalOutput(cell.output, cell.views);
	return parts.map((part, i) =>
		part.kind === "text" ? (
			<Output key={`p${i}`} text={part.text} maxLines={12} error={error} />
		) : (
			<ViewBlock key={`p${i}`} view={part.view} />
		),
	);
}
